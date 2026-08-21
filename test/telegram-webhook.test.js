// This endpoint has real write access to the main baltic-monitor repo
// (commits mute_config.json/settings.json, triggers scan.yml) via a
// GitHub PAT -- its two auth layers (Telegram's webhook secret, then the
// owner's chat id) are the only thing standing between "someone found
// this URL" and "someone can push commits to the repo." That risk is
// exactly why this has tests at all, despite the rest of this project
// having none yet -- it's the highest-value place to start.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/telegram-webhook.js";

const ENV_KEYS = ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_BOT_TOKEN", "GITHUB_PAT"];
let savedEnv;
let savedFetch;
let calls;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.TELEGRAM_WEBHOOK_SECRET = "wh-secret-123";
  process.env.TELEGRAM_OWNER_CHAT_ID = "999888";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token-abc";
  process.env.GITHUB_PAT = "gh-pat-xyz";

  savedFetch = global.fetch;
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/dispatches")) {
      return { status: 204, text: async () => "" };
    }
    if (url.includes("/contents/mute_config.json")) {
      if (opts?.method === "PUT") return { ok: true, status: 200, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: Buffer.from(JSON.stringify({ muted_keywords: [], ignored_sources: [] })).toString("base64"),
          sha: "abc123",
        }),
      };
    }
    if (url.includes("/contents/settings.json")) {
      if (opts?.method === "PUT") return { ok: true, status: 200, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: Buffer.from(JSON.stringify({ escalation_only: false })).toString("base64"),
          sha: "def456",
        }),
      };
    }
    if (url.includes("api.telegram.org")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error("unexpected fetch: " + url);
  };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = savedFetch;
});

function makeReq(body, secret) {
  return { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body };
}
function makeRes() {
  return {
    statusCode: undefined,
    body: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}
function fetchUrls() {
  return calls.map((c) => c.url);
}

test("rejects a non-POST method", async () => {
  const res = makeRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(calls.length, 0);
});

test("rejects the wrong webhook secret with 401, touches no APIs", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/scan" } }, "wrong-secret"), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("rejects a missing webhook secret header with 401", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/scan" } }, undefined), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("rejects a request with no secret header when TELEGRAM_WEBHOOK_SECRET itself is unset -- must not fail open", async () => {
  // Real bug: without an explicit env-var guard, an unset
  // TELEGRAM_WEBHOOK_SECRET made timingSafeEqual compare two empty
  // buffers (0 === 0 passes), so a request that simply omitted the
  // secret header would pass layer 1 entirely.
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/scan" } }, undefined), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("silently ignores a correct secret but wrong sender chat id -- 200, no API calls, no reply", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 111111 }, text: "/scan" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0, "an unauthorized sender must never trigger a GitHub call or a Telegram reply");
});

test("/scan triggers a workflow dispatch and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/scan" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const urls = fetchUrls();
  assert.ok(urls.some((u) => u.includes("/actions/workflows/scan.yml/dispatches")));
  assert.ok(urls.some((u) => u.includes("api.telegram.org")));
});

test("/gpsjam triggers a workflow dispatch with gpsjam_check set and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/gpsjam" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { gpsjam_check: "true" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
});

test("/ais triggers a workflow dispatch with ais_check set and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/ais" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { ais_check: "true" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
});

test("/military triggers a workflow dispatch with military_check set and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/military" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { military_check: "true" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
});

test("/notam triggers a workflow dispatch with notam_check set and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/notam" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { notam_check: "true" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
});

test("/notmar triggers a workflow dispatch with notmar_check set and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/notmar" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { notmar_check: "true" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
});

test("/firms triggers a workflow dispatch with firms_check set and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/firms" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { firms_check: "true" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
});

test("/satellite with no site sends satellite_check=list and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/satellite" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { satellite_check: "list" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
  const replyText = JSON.parse(reply.opts.body).text;
  assert.match(replyText, /available satellite imagery sites/);
});

test("/satellite <site> passes the site key through as satellite_check and replies", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/satellite baltiysk" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall, "expected a workflow dispatch call");
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, { satellite_check: "baltiysk" });
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply, "expected a confirmation reply");
  const replyText = JSON.parse(reply.opts.body).text;
  assert.match(replyText, /"baltiysk"/);
});

test("/scan's workflow dispatch still sends empty inputs (unchanged behavior)", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/scan" } }, "wh-secret-123"), res);
  const dispatchCall = calls.find((c) => c.url.includes("/actions/workflows/scan.yml/dispatches"));
  assert.ok(dispatchCall);
  const body = JSON.parse(dispatchCall.opts.body);
  assert.deepEqual(body.inputs, {});
});

test("/mute <keyword> reads, appends, and writes mute_config.json", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/mute wildfire" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  const putCall = calls.find((c) => c.url.includes("/contents/mute_config.json") && c.opts?.method === "PUT");
  assert.ok(putCall, "expected a PUT to mute_config.json");
  const body = JSON.parse(putCall.opts.body);
  const decoded = JSON.parse(Buffer.from(body.content, "base64").toString("utf-8"));
  assert.deepEqual(decoded.muted_keywords, ["wildfire"]);
  assert.deepEqual(decoded.ignored_sources, []);
});

test("/mute with no argument sends a usage reply and writes nothing", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/mute" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  assert.ok(!calls.some((c) => c.opts?.method === "PUT"));
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply);
  assert.match(JSON.parse(reply.opts.body).text, /Usage/);
});

test("a mistyped command like /mutedecision (no space) is treated as unrecognized, not /mute", async () => {
  // Real bug: text.startsWith("/mute") with no word boundary parsed
  // "/mutedecision" as /mute with keyword "decision" instead of falling
  // through to "unrecognized, no action" -- exact-match style, same as
  // every other command here.
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/mutedecision" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0, "an unrecognized command must trigger no API calls at all");
});

test("/mute on an already-muted keyword does not duplicate it", async () => {
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes("/contents/mute_config.json") && opts?.method !== "PUT") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: Buffer.from(JSON.stringify({ muted_keywords: ["wildfire"], ignored_sources: [] })).toString("base64"),
          sha: "abc123",
        }),
      };
    }
    return origFetch(url, opts);
  };
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/mute wildfire" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  assert.ok(!calls.some((c) => c.opts?.method === "PUT"), "must not write when the keyword is already present");
});

test("/ignore <source> reads, appends, and writes mute_config.json's ignored_sources", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/ignore Some Source" } }, "wh-secret-123"), res);
  const putCall = calls.find((c) => c.url.includes("/contents/mute_config.json") && c.opts?.method === "PUT");
  assert.ok(putCall);
  const body = JSON.parse(putCall.opts.body);
  const decoded = JSON.parse(Buffer.from(body.content, "base64").toString("utf-8"));
  assert.deepEqual(decoded.ignored_sources, ["Some Source"]);
});

test("/quietmode toggles escalation_only and replies with the new state", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/quietmode" } }, "wh-secret-123"), res);
  const putCall = calls.find((c) => c.url.includes("/contents/settings.json") && c.opts?.method === "PUT");
  assert.ok(putCall);
  const body = JSON.parse(putCall.opts.body);
  const decoded = JSON.parse(Buffer.from(body.content, "base64").toString("utf-8"));
  assert.equal(decoded.escalation_only, true);
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.match(JSON.parse(reply.opts.body).text, /Quiet mode ON/);
});

test("unrecognized text triggers no action at all", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "hello there" } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
});

test("/help replies with the command list", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 }, text: "/help" } }, "wh-secret-123"), res);
  const reply = calls.find((c) => c.url.includes("api.telegram.org"));
  assert.ok(reply);
  const helpText = JSON.parse(reply.opts.body).text;
  assert.match(helpText, /\/scan/);
  assert.match(helpText, /\/gpsjam/);
  assert.match(helpText, /\/ais/);
  assert.match(helpText, /\/military/);
  assert.match(helpText, /\/notam/);
  assert.match(helpText, /\/notmar/);
  assert.match(helpText, /\/firms/);
  assert.match(helpText, /\/satellite/);
});

test("a message with no text is ignored without error", async () => {
  const res = makeRes();
  await handler(makeReq({ message: { chat: { id: 999888 } } }, "wh-secret-123"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
});
