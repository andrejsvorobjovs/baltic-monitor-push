# Baltic Signal Monitor — Push Backend

This repo holds only the server side of Baltic Signal Monitor's browser
push alerts: four small Vercel serverless functions.

- `api/subscribe.js` — a visitor's browser POSTs its push subscription
  here after clicking "Enable Browser Alerts" on the landing page.
- `api/notify.js` — called only by the main project's scheduled scan
  (authenticated with a shared secret) to send a short push to every
  stored subscription when the scan result is WATCH, WARN, or a
  recovery back to QUIET. Also prunes any subscription past the
  365-day age limit before attempting to send to it.
- `api/prune.js` — called by the main project's health check (runs
  twice daily regardless of alert level) to delete any subscription
  older than 365 days, even if it's still technically deliverable.
  This exists as a separate call because `notify.js` only ever runs on
  an actual WATCH/WARN/recovery — during a long quiet stretch, expiry
  would otherwise never get a chance to run.
- `api/admin.js` — a password-protected browser page (separate secret
  from the two above) showing how many subscriptions are stored and
  letting the project owner delete one or all of them, without needing
  to open the Vercel/Upstash dashboard directly.
- `api/status.js` — a public, documented read-only API for the same
  live data shown on the landing page: `GET
  https://baltic-monitor-push.vercel.app/api/status`. No auth, no rate
  limit, `Access-Control-Allow-Origin: *` — this mirrors data that's
  already fully public on the site. Meant for anyone who wants to build
  on this data (a script, another site, a bot) without scraping HTML or
  depending on `status.json`'s exact shape, which is the landing page's
  own internal plumbing and can change whenever that page's UI needs
  something new. Response shape (`schema_version: 1`):
  ```json
  {
    "schema_version": 1,
    "level": "QUIET | WATCH | WARN",
    "status": "operating_normally | attention_needed",
    "generated_at": "...", "tracking_since": "...",
    "scans": { "total": 0, "quiet": 0, "watch": 0, "warn": 0 },
    "sources": { "total": 0, "tier1": 0, "tier2": 0, "tier3": 0 },
    "corrections_count": 0,
    "recent_scans": [ { "ts", "level", "flagged_count", "failed_count",
      "sources_scanned", "gdelt_ran", "new_items_count", "stale_count",
      "tier3_tracked_count" } ],
    "recent_items": [ { "title", "link", "source", "tier", "level", "ts",
      "categories", "gdelt": { "category", "subcategory", "event_code",
      "goldstein" } | null } ],
    "recent_corrections": [ { "ts", "context", "text" } ],
    "recent_updates": [ { "ts", "title", "text" } ]
  }
  ```
  A future breaking change bumps `schema_version` rather than silently
  reshaping the response. Cached at the edge for 5 minutes
  (`s-maxage=300`) since the underlying data only changes on a scan or
  health check, not continuously.

Subscriptions are stored in Upstash Redis (connected via Vercel's
Storage tab). No personal data is collected — a push subscription is
just an opaque per-browser endpoint URL issued by the browser vendor's
own push service (Google/Mozilla/Apple), not tied to any account here.
Every subscription is deleted automatically once it's either dead (a
send to it fails permanently) or a year old, whichever comes first.

This exists as a Telegram-independent alert channel, for people who
don't want a Telegram account/app in the loop at all — the browser talks
directly to this backend and to the browser vendor's own push service,
nothing else.

## Environment variables (set in Vercel project settings)

- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — generated once via
  `npx web-push generate-vapid-keys`. The public key also needs to be
  copied into the landing page's `push.js`.
- `WEB_PUSH_NOTIFY_SECRET` — a random shared secret (e.g.
  `openssl rand -hex 32`), matching the same value stored as a GitHub
  Actions secret on the main project's repo. Protects both
  `api/notify.js` and `api/prune.js`.
- `ADMIN_SECRET` — a separate random secret (e.g. `openssl rand -hex 32`,
  don't reuse `WEB_PUSH_NOTIFY_SECRET`) that only you know, used to open
  `api/admin.js` in a browser: `https://baltic-monitor-push.vercel.app/api/admin?key=<ADMIN_SECRET>`.
  Bookmark that full URL somewhere private — treat it like a password,
  since anyone who has it can view and clear the subscription list (which
  contains no personal data, but is still not something to hand out).
  Until this is set, the admin page always returns "Unauthorized" to
  everyone, including you.
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — auto-injected by Vercel when
  you connect an Upstash Redis database via the Storage tab (Vercel's
  marketplace integration uses this naming, not the plain
  `UPSTASH_REDIS_REST_*` names the `@upstash/redis` SDK's `fromEnv()`
  helper looks for by default — that's why the client is constructed
  explicitly in every function instead of using `fromEnv()`).
