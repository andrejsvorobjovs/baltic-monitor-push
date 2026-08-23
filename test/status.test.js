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

// Discriminates by URL -- used for tests that need status.json,
// chart_data.json, and map_data.json to each return distinct payloads,
// unlike mockUpstream() above which returns the same body to all three.
function mockMultiUpstream({ status: statusJson, chart, map }) {
  global.fetch = async (url) => {
    if (url.includes("chart_data.json")) {
      if (chart === undefined) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => chart };
    }
    if (url.includes("map_data.json")) {
      if (map === undefined) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => map };
    }
    return { ok: true, status: 200, json: async () => statusJson || {} };
  };
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

test("escalation_index reflects the latest point from chart_data.json", async () => {
  mockMultiUpstream({
    status: { last_level: "WATCH" },
    chart: {
      escalation_index_points: [
        { ts: "t1", deviation_pct: 10, sources_included: 2, band: "normal" },
        { ts: "t2", deviation_pct: 42.5, sources_included: 3, band: "elevated" },
      ],
    },
  });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.escalation_index, {
    ts: "t2", deviation_pct: 42.5, sources_included: 3, band: "elevated",
  });
});

test("escalation_index is null when chart_data.json fetch fails, without breaking the rest of the response", async () => {
  mockMultiUpstream({ status: { last_level: "QUIET", total_scans: 5 } });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.escalation_index, null);
  assert.equal(res.body.level, "QUIET");
  assert.equal(res.body.scans.total, 5);
});

test("escalation_index is null when no scan has produced a point yet", async () => {
  mockMultiUpstream({ status: {}, chart: { escalation_index_points: [] } });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.body.escalation_index, null);
});

test("map_summary reflects per-layer counts from map_data.json, not raw positions", async () => {
  mockMultiUpstream({
    status: {},
    map: {
      generated_at: "2026-08-22T15:00:00Z",
      window_hours: 72,
      ais: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }],
      military_aircraft: [{ lat: 3, lon: 3 }],
      gpsjam_cells: [],
      firms: [{ lat: 4, lon: 4 }, { lat: 5, lon: 5 }, { lat: 6, lon: 6 }],
    },
  });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.deepEqual(res.body.map_summary, {
    generated_at: "2026-08-22T15:00:00Z",
    window_hours: 72,
    ais_count: 2,
    military_aircraft_count: 1,
    gpsjam_cells_count: 0,
    firms_count: 3,
  });
  // The raw per-vessel/aircraft arrays must not leak into this summary.
  assert.equal(res.body.map_summary.ais, undefined);
});

test("map_summary is null when map_data.json fetch fails, without breaking the rest of the response", async () => {
  mockMultiUpstream({ status: { last_level: "WARN" } });
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.map_summary, null);
  assert.equal(res.body.level, "WARN");
});
