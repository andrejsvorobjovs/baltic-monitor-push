// Public, documented read API for Baltic Signal Monitor's live status —
// a stable contract for anyone who wants to build on this data (a
// researcher's script, another site, a bot), separate from status.json
// on the landing page, which is that page's own internal plumbing and
// free to change shape whenever the site's UI needs something new.
// Renames/reshapes status.json's fields into a versioned schema and
// deliberately drops fields that are presentation detail rather than
// data (raw English status_text/freshness_msg -- see the `status` enum
// below instead; per-scan `items` arrays inside history, already
// available in full under `recent_items`).
//
// Read-only, no auth, no rate limit -- this mirrors data that's already
// fully public on the landing page, so there's nothing here that needs
// gating the way api/subscribe.js does.
const SOURCE_URL = "https://balticsignalmonitor.com/status.json";
const SCHEMA_VERSION = 1;
const FETCH_TIMEOUT_MS = 5000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function mapScanEntry(h) {
  return {
    ts: h.ts,
    level: h.level,
    flagged_count: h.count,
    failed_count: h.failed_count || 0,
    sources_scanned: typeof h.sources_scanned === "number" ? h.sources_scanned : null,
    gdelt_ran: !!h.gdelt_ran,
    new_items_count: typeof h.new_items_count === "number" ? h.new_items_count : null,
    stale_count: h.stale_count || 0,
    tier3_tracked_count: h.tier3_count || 0,
  };
}

function mapItem(it) {
  return {
    title: it.title || null,
    link: it.link || null,
    source: it.source || null,
    tier: it.tier || null,
    level: it.level || null,
    ts: it.ts || null,
    categories: it.categories || [],
    gdelt: it.gdelt_category
      ? {
          category: it.gdelt_category,
          subcategory: it.gdelt_subcategory || null,
          event_code: it.gdelt_event_code || null,
          goldstein: typeof it.goldstein === "number" ? it.goldstein : null,
        }
      : null,
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let upstream;
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(SOURCE_URL, { signal: controller.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`upstream responded ${r.status}`);
    upstream = await r.json();
  } catch (err) {
    // The one thing worth logging here: this endpoint being broken is
    // silent otherwise, since nothing else calls it to notice.
    console.error("status.js: failed to fetch upstream status.json:", err);
    res.status(502).json({ error: "upstream status temporarily unavailable" });
    return;
  } finally {
    // Was only cleared on the success path before -- if fetch() itself
    // rejected (network error, not just a non-OK response), this timer
    // was left dangling for the rest of FETCH_TIMEOUT_MS. Harmless in
    // production (the serverless invocation ends anyway), but real: it's
    // exactly the kind of resource leak this project treats as a bug
    // wherever it's found. finally guarantees it's cleared every path.
    clearTimeout(timeout);
  }

  const d = upstream;
  const body = {
    schema_version: SCHEMA_VERSION,
    level: d.last_level || "UNKNOWN",
    status: d.status_text === "Operating normally" ? "operating_normally" : "attention_needed",
    generated_at: d.generated_at || null,
    tracking_since: d.since || null,
    scans: {
      total: d.total_scans ?? null,
      quiet: d.quiet_count ?? null,
      watch: d.watch_count ?? null,
      warn: d.warn_count ?? null,
    },
    sources: {
      total: d.total_sources ?? null,
      tier1: d.tier1_sources ?? null,
      tier2: d.tier2_sources ?? null,
      tier3: d.tier3_sources ?? null,
    },
    corrections_count: d.correction_count ?? null,
    recent_scans: (d.recent_history || []).map(mapScanEntry),
    recent_items: (d.recent_items || []).map(mapItem),
    recent_corrections: (d.recent_corrections || []).map((c) => ({
      ts: c.ts || null,
      context: c.context || null,
      text: c.text || null,
    })),
    recent_updates: (d.recent_updates || []).map((u) => ({
      ts: u.ts || null,
      title: u.title || null,
      text: u.text || null,
    })),
  };

  // Underlying data only changes on a scan (~every 4h) or a health check,
  // so a short edge cache cuts down on redundant origin fetches without
  // ever serving data more than a few minutes stale.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
  res.status(200).json(body);
}
