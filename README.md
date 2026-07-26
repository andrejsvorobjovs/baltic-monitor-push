# Baltic Signal Monitor — Push Backend

This repo holds only the server side of Baltic Signal Monitor's browser
push alerts: two small Vercel serverless functions.

- `api/subscribe.js` — a visitor's browser POSTs its push subscription
  here after clicking "Enable Browser Alerts" on the landing page.
- `api/notify.js` — called only by the main project's scheduled scan
  (authenticated with a shared secret) to send a short push to every
  stored subscription when the scan result is WATCH, WARN, or a
  recovery back to QUIET.

Subscriptions are stored in Upstash Redis (connected via Vercel's
Storage tab). No personal data is collected — a push subscription is
just an opaque per-browser endpoint URL issued by the browser vendor's
own push service (Google/Mozilla/Apple), not tied to any account here.

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
  Actions secret on the main project's repo.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — auto-injected
  by Vercel when you connect an Upstash Redis database via the Storage
  tab.
