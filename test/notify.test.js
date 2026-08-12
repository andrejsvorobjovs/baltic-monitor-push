// Protected endpoint called by baltic-monitor's scan.yml after a WATCH/WARN
// (or a recovery to QUIET). Covers auth, the actual send/prune/skip
// decision per subscription, and that a malformed stored entry gets
// pruned rather than crashing the whole batch.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis, fakeRedisConstructor, makeRes } from "./helpers.js";

const fakeRedis = new FakeRedis();
mock.module("@upstash/redis", {
  namedExports: { Redis: fakeRedisConstructor(fakeRedis) },
});

const fakeWebPush = {
  setVapidDetails: () => {},
  sendNotification: async () => {
    throw new Error("sendNotification not configured for this test");
  },
};
mock.module("web-push", { defaultExport: fakeWebPush });

const { default: handler } = await import("../api/notify.js");

const ENV_KEYS = ["WEB_PUSH_NOTIFY_SECRET"];
let savedEnv;

beforeEach(() => {
  fakeRedis.reset();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.WEB_PUSH_NOTIFY_SECRET = "notify-secret-123";
  fakeWebPush.sendNotification = async () => {
    throw new Error("sendNotification not configured for this test");
  };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function authedReq(body) {
  return { method: "POST", headers: { authorization: "Bearer notify-secret-123" }, body };
}

async function seedSubscription(id, { ageDays = 1, endpoint = `https://push.example.com/${id}` } = {}) {
  const createdAt = new Date(Date.now() - ageDays * 86400000).toISOString();
  await fakeRedis.hset("subscriptions", {
    [id]: JSON.stringify({ endpoint, keys: { p256dh: "p", auth: "a" }, createdAt }),
  });
}

test("rejects a non-POST method with 405", async () => {
  const res = makeRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test("rejects a missing Authorization header with 401", async () => {
  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: { title: "x", body: "y" } }, res);
  assert.equal(res.statusCode, 401);
});

test("rejects the wrong secret with 401", async () => {
  const res = makeRes();
  await handler(
    { method: "POST", headers: { authorization: "Bearer wrong-secret" }, body: { title: "x", body: "y" } },
    res
  );
  assert.equal(res.statusCode, 401);
});

test("rejects a request missing title or body with 400", async () => {
  const res = makeRes();
  await handler(authedReq({ title: "only title" }), res);
  assert.equal(res.statusCode, 400);
});

test("no stored subscriptions: sends nothing, reports zero counts", async () => {
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "something happened" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, sent: 0, pruned: 0, failed: 0, total: 0 });
});

test("a fresh, deliverable subscription gets sent to and counted", async () => {
  await seedSubscription("sub1", { ageDays: 1 });
  fakeWebPush.sendNotification = async () => ({});
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "x" }), res);
  assert.equal(res.body.sent, 1);
  assert.equal(res.body.pruned, 0);
  assert.equal(res.body.failed, 0);
  assert.equal(await fakeRedis.hlen("subscriptions"), 1, "a successfully-sent subscription must stay stored");
});

test("a subscription older than 365 days is pruned without attempting a send", async () => {
  await seedSubscription("old-sub", { ageDays: 400 });
  let sendAttempted = false;
  fakeWebPush.sendNotification = async () => {
    sendAttempted = true;
    return {};
  };
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "x" }), res);
  assert.equal(res.body.pruned, 1);
  assert.equal(res.body.sent, 0);
  assert.equal(sendAttempted, false, "an expired subscription must not get a send attempt at all");
  assert.equal(await fakeRedis.hlen("subscriptions"), 0);
});

test("a 410 Gone send failure prunes the subscription", async () => {
  await seedSubscription("dead-sub", { ageDays: 1 });
  fakeWebPush.sendNotification = async () => {
    const err = new Error("gone");
    err.statusCode = 410;
    throw err;
  };
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "x" }), res);
  assert.equal(res.body.pruned, 1);
  assert.equal(res.body.sent, 0);
  assert.equal(res.body.failed, 0);
  assert.equal(await fakeRedis.hlen("subscriptions"), 0);
});

test("a 404 send failure also prunes the subscription", async () => {
  await seedSubscription("gone-sub", { ageDays: 1 });
  fakeWebPush.sendNotification = async () => {
    const err = new Error("not found");
    err.statusCode = 404;
    throw err;
  };
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "x" }), res);
  assert.equal(res.body.pruned, 1);
  assert.equal(await fakeRedis.hlen("subscriptions"), 0);
});

test("a non-410/404 send failure (e.g. 429) is counted as failed but NOT pruned", async () => {
  await seedSubscription("flaky-sub", { ageDays: 1 });
  fakeWebPush.sendNotification = async () => {
    const err = new Error("rate limited");
    err.statusCode = 429;
    throw err;
  };
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "x" }), res);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.pruned, 0);
  assert.equal(await fakeRedis.hlen("subscriptions"), 1, "a transient failure must not delete the subscription");
});

test("a malformed (non-JSON) stored entry is pruned, not crashed on", async () => {
  await fakeRedis.hset("subscriptions", { "corrupt-entry": "{not valid json" });
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "x" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pruned, 1);
});

test("mixed batch: correctly separates sent, pruned (expired), and failed", async () => {
  await seedSubscription("good", { ageDays: 1 });
  await seedSubscription("expired", { ageDays: 400 });
  await seedSubscription("dead", { ageDays: 1 });
  fakeWebPush.sendNotification = async (sub) => {
    if (sub.endpoint.includes("dead")) {
      const err = new Error("gone");
      err.statusCode = 410;
      throw err;
    }
    return {};
  };
  const res = makeRes();
  await handler(authedReq({ title: "WATCH", body: "x" }), res);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.sent, 1);
  assert.equal(res.body.pruned, 2); // expired (age) + dead (410)
});
