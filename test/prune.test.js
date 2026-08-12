// Housekeeping-only endpoint called twice daily by baltic-monitor's
// run_health(), independent of whether a WATCH/WARN ever fires -- covers
// the actual age-cutoff logic and that it sends nothing, only deletes.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis, fakeRedisConstructor, makeRes } from "./helpers.js";

const fakeRedis = new FakeRedis();
mock.module("@upstash/redis", {
  namedExports: { Redis: fakeRedisConstructor(fakeRedis) },
});
const { default: handler } = await import("../api/prune.js");

const ENV_KEYS = ["WEB_PUSH_NOTIFY_SECRET"];
let savedEnv;

beforeEach(() => {
  fakeRedis.reset();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.WEB_PUSH_NOTIFY_SECRET = "notify-secret-123";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function authedReq() {
  return { method: "POST", headers: { authorization: "Bearer notify-secret-123" } };
}

async function seedSubscription(id, ageDays) {
  const createdAt = new Date(Date.now() - ageDays * 86400000).toISOString();
  await fakeRedis.hset("subscriptions", {
    [id]: JSON.stringify({ endpoint: `https://push.example.com/${id}`, createdAt }),
  });
}

test("rejects a non-POST method with 405", async () => {
  const res = makeRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test("rejects the wrong secret with 401", async () => {
  const res = makeRes();
  await handler({ method: "POST", headers: { authorization: "Bearer wrong" } }, res);
  assert.equal(res.statusCode, 401);
});

test("a subscription under a year old survives", async () => {
  await seedSubscription("young", 30);
  const res = makeRes();
  await handler(authedReq(), res);
  assert.equal(res.body.pruned, 0);
  assert.equal(await fakeRedis.hlen("subscriptions"), 1);
});

test("a subscription over a year old is pruned", async () => {
  await seedSubscription("old", 400);
  const res = makeRes();
  await handler(authedReq(), res);
  assert.equal(res.body.pruned, 1);
  assert.equal(await fakeRedis.hlen("subscriptions"), 0);
});

test("an entry with no createdAt at all is pruned (unverifiable = treated as stale)", async () => {
  await fakeRedis.hset("subscriptions", { "no-date": JSON.stringify({ endpoint: "https://push.example.com/x" }) });
  const res = makeRes();
  await handler(authedReq(), res);
  assert.equal(res.body.pruned, 1);
});

test("a malformed (non-JSON) entry is pruned, not crashed on", async () => {
  await fakeRedis.hset("subscriptions", { corrupt: "{not json" });
  const res = makeRes();
  await handler(authedReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pruned, 1);
});

test("reports pruned and remaining counts correctly for a mixed set", async () => {
  await seedSubscription("young1", 10);
  await seedSubscription("young2", 20);
  await seedSubscription("old1", 400);
  const res = makeRes();
  await handler(authedReq(), res);
  assert.equal(res.body.pruned, 1);
  assert.equal(res.body.remaining, 2);
  assert.equal(await fakeRedis.hlen("subscriptions"), 2);
});

test("nothing stored: reports zero pruned, zero remaining", async () => {
  const res = makeRes();
  await handler(authedReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, pruned: 0, remaining: 0 });
});
