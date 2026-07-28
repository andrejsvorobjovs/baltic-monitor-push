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

  await Promise.allSettled(
    entries.map(async ([key, raw]) => {
      let sub;
      try {
        sub = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        await redis.hdel("subscriptions", key);
        pruned++;
        return;
      }
      const createdAt = sub.createdAt ? new Date(sub.createdAt).getTime() : 0;
      if (!createdAt || Date.now() - createdAt > MAX_SUBSCRIPTION_AGE_MS) {
        await redis.hdel("subscriptions", key);
        pruned++;
        return;
      }
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        const statusCode = err && err.statusCode;
        // 404/410 = permanently dead (uninstalled, permission revoked,
        // endpoint expired) — anything else (400/413/429/etc.) is not
        // proof of death, so it's logged and skipped, not deleted.
        if (statusCode === 404 || statusCode === 410) {
          await redis.hdel("subscriptions", key);
          pruned++;
        } else {
          failed++;
          console.error(`push send failed (status ${statusCode}):`, err && err.body);
        }
      }
    })
  );

  res.status(200).json({ ok: true, sent, pruned, failed, total: entries.length });
}
