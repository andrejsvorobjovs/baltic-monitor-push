// Public, unauthenticated read API that reshapes the landing page's own
// status.json into a versioned schema. Covers the upstream-fetch failure
// path (the one thing this endpoint's own comment says is worth logging,
// since nothing else would notice it breaking) and that the reshaping
// actually does what its field-mapping comments claim.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/status.js";
import { makeRes } from "./helpers.js";

let savedFetch;

beforeEach(() => {
  savedFetch = global.fetch;
});

afterEach(() => {
  global.fetch = savedFetch;
});

function mockUpstream(json, ok = true, status = 200) {
  global.fetch = async () => ({
    ok,
    status,
    json: async () => json,
  });
}

test("OPTIONS preflight returns 204", async () => {
  const res = makeRes();
  await handler({ method: "OPTIONS" }, res);
  assert.equal(res.statusCode, 204);
});

test("rejects a non-GET/OPTIONS method with 405", async () => {
  const res = makeRes();
  await handler({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
});

test("upstream fetch failure (network error) returns 502, not a crash", async () => {
  global.fetch = async () => {
    throw new Error("network unreachable");
  };
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 502);
});

test("upstream non-OK response returns 502", async () => {
  mockUpstream({}, false, 500);
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 502);
});

test("reshapes a healthy upstream status.json into the documented schema", async () => {
  mockUpstream({
    last_level: "QUIET",
    status_text: "Operating normally",
    generated_at: "2026-08-12 16:20 UTC",
    since: "2026-07-19",
    total_scans: 163,
    quiet_count: 144,
    watch_count: 19,
    warn_count: 0,
    total_sources: 136,
    tier1_sources: 31,
    tier2_sources: 94,
    tier3_sources: 11,
    correction_count: 2,
    recent_history: [{ ts: "t1", level: "QUIET", count: 0, failed_count: 0, sources_scanned: 136, gdelt_ran: true }],
    recent_items: [{ title: "x", link: "https://x", source: "y", tier: "tier1", level: "WATCH", ts: "t2", categories: ["a"] }],
    recent_corrections: [{ ts: "t3", context: "c", text: "fixed" }],
    recent_updates: [{ ts: "t4", title: "New source", text: "added" }],
  });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.schema_version, 1);
  assert.equal(res.body.level, "QUIET");
  assert.equal(res.body.status, "operating_normally");
  assert.equal(res.body.scans.total, 163);
  assert.equal(res.body.sources.total, 136);
  assert.equal(res.body.corrections_count, 2);
  assert.equal(res.body.recent_scans.length, 1);
  assert.equal(res.body.recent_scans[0].flagged_count, 0);
  assert.equal(res.body.recent_items.length, 1);
  assert.equal(res.body.recent_items[0].title, "x");
  assert.equal(res.body.recent_corrections[0].text, "fixed");
  assert.equal(res.body.recent_updates[0].title, "New source");
});

test("status_text other than 'Operating normally' maps to attention_needed", async () => {
  mockUpstream({ last_level: "WATCH", status_text: "Attention needed" });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.body.status, "attention_needed");
});

test("missing last_level falls back to UNKNOWN rather than throwing", async () => {
  mockUpstream({ status_text: "Operating normally" });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.level, "UNKNOWN");
});

test("a GDELT-sourced item includes its classification detail, a non-GDELT item's gdelt field is null", async () => {
  mockUpstream({
    recent_items: [
      { title: "gdelt item", gdelt_category: "POLITICAL", gdelt_subcategory: "sub", gdelt_event_code: "036", goldstein: 4 },
      { title: "regular item" },
    ],
  });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.body.recent_items[0].gdelt.category, "POLITICAL");
  assert.equal(res.body.recent_items[0].gdelt.goldstein, 4);
  assert.equal(res.body.recent_items[1].gdelt, null);
});

test("sets CORS headers and a cache-control header on a successful response", async () => {
  mockUpstream({});
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.match(res.headers["Cache-Control"], /s-maxage=300/);
});
