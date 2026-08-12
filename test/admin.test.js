// Password-protected admin view. Covers auth (a separate secret from
// notify/prune's), the list/delete-one/delete-all actions, and that no
// raw endpoint/key material ever appears in the rendered HTML -- that's
// the one thing this page explicitly promises not to leak.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis, fakeRedisConstructor, makeRes } from "./helpers.js";

const fakeRedis = new FakeRedis();
mock.module("@upstash/redis", {
  namedExports: { Redis: fakeRedisConstructor(fakeRedis) },
});
const { default: handler } = await import("../api/admin.js");

const ENV_KEYS = ["ADMIN_SECRET"];
let savedEnv;

beforeEach(() => {
  fakeRedis.reset();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ADMIN_SECRET = "admin-secret-xyz";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function seedSubscription(id, { endpoint = `https://push.example.com/${id}`, ageDays = 1 } = {}) {
  const createdAt = new Date(Date.now() - ageDays * 86400000).toISOString();
  await fakeRedis.hset("subscriptions", { [id]: JSON.stringify({ endpoint, createdAt }) });
}

test("wrong key returns 401 and an Unauthorized page", async () => {
  const res = makeRes();
  await handler({ method: "GET", query: { key: "wrong" } }, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Unauthorized/);
});

test("missing key returns 401", async () => {
  const res = makeRes();
  await handler({ method: "GET", query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test("correct key on GET renders the subscription list", async () => {
  await seedSubscription("sub1");
  const res = makeRes();
  await handler({ method: "GET", query: { key: "admin-secret-xyz" } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Push subscriptions/);
  assert.match(res.body, /1 stored right now/);
});

test("empty subscription list renders a 'None stored' row, not an error", async () => {
  const res = makeRes();
  await handler({ method: "GET", query: { key: "admin-secret-xyz" } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /None stored/);
});

test("never renders the raw endpoint URL of a stored subscription", async () => {
  await seedSubscription("sub1", { endpoint: "https://push.googleapis.com/wp/super-secret-token-abc123" });
  const res = makeRes();
  await handler({ method: "GET", query: { key: "admin-secret-xyz" } }, res);
  assert.doesNotMatch(res.body, /super-secret-token-abc123/);
});

test("POST action=delete removes exactly the one named subscription", async () => {
  await seedSubscription("sub1");
  await seedSubscription("sub2");
  const res = makeRes();
  await handler({ method: "POST", query: {}, body: { key: "admin-secret-xyz", action: "delete", id: "sub1" } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(await fakeRedis.hlen("subscriptions"), 1);
  const remaining = await fakeRedis.hgetall("subscriptions");
  assert.ok(remaining.sub2);
  assert.ok(!remaining.sub1);
});

test("POST action=clear removes every stored subscription", async () => {
  await seedSubscription("sub1");
  await seedSubscription("sub2");
  await seedSubscription("sub3");
  const res = makeRes();
  await handler({ method: "POST", query: {}, body: { key: "admin-secret-xyz", action: "clear" } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(await fakeRedis.hlen("subscriptions"), 0);
});

test("POST with the wrong key does not delete anything", async () => {
  await seedSubscription("sub1");
  const res = makeRes();
  await handler({ method: "POST", query: {}, body: { key: "wrong", action: "clear" } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(await fakeRedis.hlen("subscriptions"), 1, "a wrong-key POST must not clear anything");
});

test("POST redirects back to the admin page carrying the key", async () => {
  const res = makeRes();
  await handler({ method: "POST", query: {}, body: { key: "admin-secret-xyz", action: "clear" } }, res);
  assert.equal(res.statusCode, 302);
  assert.match(res.redirectLocation, /^\/api\/admin\?key=/);
});

test("rejects a non-GET/POST method with 405 once authorized", async () => {
  const res = makeRes();
  await handler({ method: "DELETE", query: {}, body: { key: "admin-secret-xyz" } }, res);
  assert.equal(res.statusCode, 405);
});
