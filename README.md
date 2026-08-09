# Baltic Signal Monitor — Push Backend

This repo holds the server side of Baltic Signal Monitor's browser push
alerts, plus a couple of related integrations that ended up living here
since they're also small Vercel serverless functions: six in total.

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
- `api/telegram-webhook.js` — instant replacement for the old polling-
  based `/scan`, `/mute`, `/ignore`, `/quietmode` command listener that
  used to run inside the scheduled scan itself (removed for averaging
  ~1.8h of lag on GitHub's best-effort schedule). Telegram delivers
  webhook updates instantly; this is the receiving end, since GitHub
  Actions has no way to receive an inbound request at all. Two
  independent checks before it acts on anything: Telegram's own webhook
  secret token (proves the request came from Telegram), then the
  sender's chat id must match `TELEGRAM_OWNER_CHAT_ID` exactly (proves
  it's you, not some other user who messaged the bot) — anything else
  is silently ignored, still 200-ing back to Telegram so it doesn't
  retry, but taking no action and sending no reply. `/scan` triggers a
  `scan.yml` workflow dispatch via the GitHub API; `/gpsjam` triggers
  the same workflow with its `gpsjam_check` input set instead, which
  runs `python main.py gpsjam_status` in the main repo — an on-demand,
  informational-only check of GPSJam's current Baltic GPS-jamming
  picture (see that repo's own README for the full design discussion;
  private chat only, never wired into scoring or alerting); `/ais` is
  the same pattern again with `ais_check` set, running `python main.py
  ais_status` — a short live AIS ship-tracking snapshot of the Baltic
  Sea via aisstream.io (also private chat only, informational only,
  see the main repo's README for the full design discussion including
  why this needs its own `AISSTREAM_API_KEY`); `/mute
  <keyword>` and `/ignore <source>` commit an update to the main repo's
  `mute_config.json`; `/quietmode` toggles `escalation_only` in
  `settings.json`. All commit/dispatch paths use the same GitHub
  Contents/Actions API the old in-repo code touched, just called from
  here instead of from inside a scan.

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
- `TELEGRAM_WEBHOOK_SECRET` — a random secret (e.g. `openssl rand -hex
  32`) that only Telegram and this function know. Set here, then passed
  to Telegram's `setWebhook` call (see Setup below) as `secret_token` —
  Telegram echoes it back on every webhook delivery as the
  `X-Telegram-Bot-Api-Secret-Token` header, which `api/telegram-webhook.js`
  checks before doing anything else.
- `TELEGRAM_BOT_TOKEN` — same bot token already used by the main repo.
  Needed here to send confirmation replies (e.g. "Scan triggered").
  Commands still work without it, just silently, with no reply.
- `TELEGRAM_OWNER_CHAT_ID` — same value as the main repo's
  `TELEGRAM_CHAT_ID` secret (your own private chat with the bot). This is
  the second auth layer above — any command from a different chat id is
  ignored.
- `GITHUB_PAT` — a GitHub **fine-grained** personal access token, scoped
  to **only** the `baltic-monitor` repository, with exactly two
  permissions: Contents (Read and write) and Actions (Read and write).
  Nothing else — this token can commit files and trigger workflow runs in
  that one repo and nothing more. Generate at
  github.com/settings/personal-access-tokens/new.

### Setup — Telegram webhook commands
1. Set `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_OWNER_CHAT_ID`, and `GITHUB_PAT` in Vercel (see above).
2. Register the webhook with Telegram — run this once, filling in your
   own bot token and the exact `TELEGRAM_WEBHOOK_SECRET` value from step 1
   (this project has no access to your bot token, so this step can't be
   automated — it's a one-time call you make yourself):
   ```
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -d url="https://baltic-monitor-push.vercel.app/api/telegram-webhook" \
     -d secret_token="<YOUR_TELEGRAM_WEBHOOK_SECRET>"
   ```
   A `{"ok":true,"result":true,...}` response confirms it's registered.
3. That's it — `/scan`, `/gpsjam`, `/ais`, `/mute <keyword>`, `/ignore
   <source name>`, and `/quietmode` sent to the bot from your own chat
   now respond within a couple seconds (or ~30-40s for `/gpsjam`,
   `/ais`, and `/scan`, which wait on a real workflow run) instead of
   up to ~1.8h.
4. To undo: `curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`
   goes back to however the bot behaved before (no automatic commands).

## Tests

`npm test` (Node's built-in test runner, no extra dependency) runs
`test/telegram-webhook.test.js` — 16 tests covering the endpoint with
real write access to the main repo: both auth layers (wrong/missing
webhook secret, wrong sender chat id — each must produce zero API calls,
not just a rejected response), every command (`/scan`, `/gpsjam`,
`/ais`, `/mute`, `/ignore`, `/quietmode`, `/help`), and edge cases
(no-argument usage text, an already-muted keyword not duplicating,
`/gpsjam` and `/ais`'s dispatches actually carry their own
`gpsjam_check`/`ais_check` input while `/scan`'s still dispatches with
no extra inputs). Runs on every push via `.github/workflows/tests.yml`,
same pattern as the main `baltic-monitor` repo's `tests.yml`.

The other five functions (`subscribe`/`notify`/`prune`/`admin`/`status`)
don't have automated tests yet — `telegram-webhook.js` came first since
it's the one with real write access to another repo, the highest-value
place to have regression coverage. Worth adding to the others over time.
