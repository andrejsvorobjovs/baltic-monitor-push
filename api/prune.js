// Housekeeping-only endpoint: deletes any Web Push subscription older
// than a year, regardless of whether it's still deliverable. Called from
// baltic-monitor's run_health() (twice daily, unconditionally) rather
// than relying on notify.js alone — notify.js only runs on an actual
// WATCH/WARN/recovery, so during a long quiet stretch expiry would
// otherwise never get a chance to run. Sends nothing; only prunes.
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const MAX_SUBSCRIPTION_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// See notify.js's identical helper: Promise.allSettled around each
// entry's handler stops one bad subscription from failing the batch, but
// the hdel call itself wasn't individually guarded -- a transient
// Upstash error mid-batch silently dropped that one task with no log
// line, and `pruned` could quietly undercount with no visibility why.
async function safeHdel(key, reason) {
  try {
    await redis.hdel("subscriptions", key);
    return true;
  } catch (err) {
    console.error(`failed to delete subscription ${key} (${reason}):`, err);
    return false;
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

  const all = (await redis.hgetall("subscriptions")) || {};
  const now = Date.now();
  let pruned = 0;

  await Promise.allSettled(
    Object.entries(all).map(async ([key, raw]) => {
      let sub;
      try {
        sub = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        if (await safeHdel(key, "unparseable")) pruned++;
        return;
      }
      // No createdAt at all shouldn't happen (subscribe.js always sets
      // it), but if it's ever missing there's no way to prove the entry
      // isn't stale — safer to prune an unverifiable entry than keep it
      // forever.
      const createdAt = sub.createdAt ? new Date(sub.createdAt).getTime() : 0;
      if (!createdAt || now - createdAt > MAX_SUBSCRIPTION_AGE_MS) {
        if (await safeHdel(key, "expired")) pruned++;
      }
    })
  );

  res.status(200).json({ ok: true, pruned, remaining: Object.keys(all).length - pruned });
}
