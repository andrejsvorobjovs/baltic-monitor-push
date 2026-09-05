// Protected endpoint: called only by baltic-monitor's scan.yml (via
// send_web_push() in main.py) after a scan computes WATCH/WARN, or on a
// WATCH/WARN -> QUIET recovery. Sends a short push to every stored
// browser subscription and prunes any that come back permanently dead.
import { Redis } from "@upstash/redis";
import webpush from "web-push";
import crypto from "node:crypto";

// Vercel's Upstash marketplace integration names these KV_REST_API_URL /
// KV_REST_API_TOKEN, not the UPSTASH_REDIS_REST_* names Redis.fromEnv()
// looks for by default — so the client is constructed explicitly instead.
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

webpush.setVapidDetails(
  "https://balticsignalmonitor.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Same 365-day cutoff api/prune.js enforces on its own schedule — checked
// here too so a notify call doesn't waste a send attempt on something
// already past expiry, and so expiry still happens even on a notify-only
// run if prune.js were ever skipped.
const MAX_SUBSCRIPTION_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// Promise.allSettled around each entry's whole handler already stops one
// bad subscription from failing the batch, but the hdel calls inside
// weren't individually guarded -- a transient Upstash error mid-batch
// silently dropped that one task with no log line, and pruned/sent/failed
// could quietly stop summing to total with no visibility into why.
async function safeHdel(key, reason) {
  try {
    await redis.hdel("subscriptions", key);
    return true;
  } catch (err) {
    console.error(`failed to delete subscription ${key} (${reason}):`, err);
    return false;
  }
}

// A push service returning 429/500/502/503/504 is busy or briefly broken,
// not refusing the message. Before this, one such response meant that
// subscriber silently missed the alert entirely — no retry, and the only
// record was a `failed` count printed into a GitHub Actions log nobody
// reads. For a warning system that is the wrong failure mode: the whole
// point is that the alert arrives.
//
// One retry, short delay. Deliberately not more: this runs in a
// serverless function with a wall-clock limit, and every subscription is
// retried in parallel, so a long backoff risks timing out the batch and
// losing the sends that would otherwise have succeeded.
const RETRYABLE_PUSH_STATUS = new Set([429, 500, 502, 503, 504]);
const PUSH_RETRY_DELAY_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWithOneRetry(sub, payload) {
  try {
    await webpush.sendNotification(sub, payload);
    return { ok: true, retried: false };
  } catch (err) {
    if (!RETRYABLE_PUSH_STATUS.has(err && err.statusCode)) throw err;
    await sleep(PUSH_RETRY_DELAY_MS);
    await webpush.sendNotification(sub, payload);
    return { ok: true, retried: true };
  }
}

function isAuthorized(req) {
  const secret = process.env.WEB_PUSH_NOTIFY_SECRET;
  if (!secret) return false;
  const header = req.headers["authorization"] || "";
  const expected = `Bearer ${secret}`;
  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (headerBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(headerBuf, expectedBuf);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { title, body } = req.body || {};
  if (!title || !body) {
    res.status(400).json({ error: "title and body required" });
    return;
  }

  const payload = JSON.stringify({
    title,
    body,
    url: "https://balticsignalmonitor.com/#status",
  });

  const all = (await redis.hgetall("subscriptions")) || {};
  const entries = Object.entries(all);

  let sent = 0;
  let pruned = 0;
  let failed = 0;
  let retried = 0;

  await Promise.allSettled(
    entries.map(async ([key, raw]) => {
      let sub;
      try {
        sub = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        if (await safeHdel(key, "unparseable")) pruned++;
        return;
      }
      const createdAt = sub.createdAt ? new Date(sub.createdAt).getTime() : 0;
      if (!createdAt || Date.now() - createdAt > MAX_SUBSCRIPTION_AGE_MS) {
        if (await safeHdel(key, "expired")) pruned++;
        return;
      }
      try {
        const result = await sendWithOneRetry(sub, payload);
        sent++;
        if (result.retried) retried++;
      } catch (err) {
        const statusCode = err && err.statusCode;
        // 404/410 = permanently dead (uninstalled, permission revoked,
        // endpoint expired) — anything else (400/413/429/etc.) is not
        // proof of death, so it's logged and skipped, not deleted.
        if (statusCode === 404 || statusCode === 410) {
          if (await safeHdel(key, `dead: ${statusCode}`)) pruned++;
        } else {
          failed++;
          console.error(`push send failed (status ${statusCode}):`, err && err.body);
        }
      }
    })
  );

  // `retried` is reported so a push service degrading shows up as a
  // trend before it starts costing deliveries outright.
  res
    .status(200)
    .json({ ok: true, sent, pruned, failed, retried, total: entries.length });
}
