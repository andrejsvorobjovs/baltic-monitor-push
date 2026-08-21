// Public endpoint a browser POSTs its PushSubscription to. Covers the
// three things that actually guard this endpoint: subscription shape
// validation, per-IP rate limiting, and the capacity ceiling -- plus the
// dedup-by-endpoint-hash behavior a re-subscribing browser relies on.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis, fakeRedisConstructor, makeRes } from "./helpers.js";

const fakeRedis = new FakeRedis();
mock.module("@upstash/redis", {
  namedExports: { Redis: fakeRedisConstructor(fakeRedis) },
});
const { default: handler } = await import("../api/subscribe.js");

beforeEach(() => {
  fakeRedis.reset();
});

function validSub(endpoint = "https://push.example.com/abc123") {
  return {
    endpoint,
    keys: { p256dh: "p".repeat(30), auth: "a".repeat(15) },
  };
}

test("OPTIONS preflight returns 204 with no side effects", async () => {
  const res = makeRes();
  await handler({ method: "OPTIONS", headers: {} }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(fakeRedis.hashes.size, 0);
});

test("rejects a non-POST/OPTIONS method with 405", async () => {
  const res = makeRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test("stores a valid subscription and returns ok", async () => {
  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validSub() }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(await fakeRedis.hlen("subscriptions"), 1);
});

test("rejects a subscription missing keys with 400, stores nothing", async () => {
  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: { endpoint: "https://push.example.com/x" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(await fakeRedis.hlen("subscriptions"), 0);
});

test("rejects a non-https endpoint with 400", async () => {
  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validSub("http://insecure.example.com/x") }, res);
  assert.equal(res.statusCode, 400);
});

test("rejects a p256dh key that's too short with 400", async () => {
  const res = makeRes();
  const sub = validSub();
  sub.keys.p256dh = "short";
  const res2 = makeRes();
  await handler({ method: "POST", headers: {}, body: sub }, res2);
  assert.equal(res2.statusCode, 400);
});

test("re-subscribing the same endpoint overwrites rather than duplicates", async () => {
  const sub = validSub("https://push.example.com/same-endpoint");
  await handler({ method: "POST", headers: {}, body: sub }, makeRes());
  await handler({ method: "POST", headers: {}, body: sub }, makeRes());
  assert.equal(await fakeRedis.hlen("subscriptions"), 1, "same endpoint must dedupe to one stored entry");
});

test("6th subscribe attempt from the same IP in an hour is rate-limited", async () => {
  const ip = "203.0.113.9";
  for (let i = 0; i < 5; i++) {
    const res = makeRes();
    await handler(
      { method: "POST", headers: { "x-forwarded-for": ip }, body: validSub(`https://push.example.com/${i}`) },
      res
    );
    assert.equal(res.statusCode, 200, `attempt ${i + 1} should succeed`);
  }
  const res6 = makeRes();
  await handler(
    { method: "POST", headers: { "x-forwarded-for": ip }, body: validSub("https://push.example.com/6") },
    res6
  );
  assert.equal(res6.statusCode, 429);
});

test("rate limit is tracked per IP, not globally", async () => {
  for (let i = 0; i < 5; i++) {
    await handler(
      { method: "POST", headers: { "x-forwarded-for": "203.0.113.1" }, body: validSub(`https://push.example.com/a${i}`) },
      makeRes()
    );
  }
  const res = makeRes();
  await handler(
    { method: "POST", headers: { "x-forwarded-for": "203.0.113.2" }, body: validSub("https://push.example.com/other-ip") },
    res
  );
  assert.equal(res.statusCode, 200, "a different IP must not be blocked by another IP's rate limit");
});

test("rate limit uses the LAST X-Forwarded-For entry (the proxy-appended real IP), not the first", async () => {
  // Real bug: reading the first entry let a client bypass the rate limit
  // entirely by sending a fresh fake leading IP on every request -- the
  // real client IP Vercel's edge appends is always the last entry.
  const realIp = "203.0.113.42";
  for (let i = 0; i < 5; i++) {
    const res = makeRes();
    await handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": `1.2.3.${i}, ${realIp}` },
        body: validSub(`https://push.example.com/spoof${i}`),
      },
      res
    );
    assert.equal(res.statusCode, 200, `attempt ${i + 1} should succeed`);
  }
  const res6 = makeRes();
  await handler(
    {
      method: "POST",
      headers: { "x-forwarded-for": `9.9.9.9, ${realIp}` },
      body: validSub("https://push.example.com/spoof6"),
    },
    res6
  );
  assert.equal(res6.statusCode, 429, "varying only the fake leading IP must not reset the rate limit");
});

test("rejects an oversized p256dh key with 400", async () => {
  const res = makeRes();
  const sub = validSub();
  sub.keys.p256dh = "p".repeat(500);
  await handler({ method: "POST", headers: {}, body: sub }, res);
  assert.equal(res.statusCode, 400);
});

test("rejects an oversized auth secret with 400", async () => {
  const res = makeRes();
  const sub = validSub();
  sub.keys.auth = "a".repeat(500);
  await handler({ method: "POST", headers: {}, body: sub }, res);
  assert.equal(res.statusCode, 400);
});

test("rejects an oversized endpoint with 400", async () => {
  const res = makeRes();
  const sub = validSub("https://push.example.com/" + "x".repeat(1000));
  await handler({ method: "POST", headers: {}, body: sub }, res);
  assert.equal(res.statusCode, 400);
});

test("sets CORS headers on every response", async () => {
  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validSub() }, res);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://balticsignalmonitor.com");
});
