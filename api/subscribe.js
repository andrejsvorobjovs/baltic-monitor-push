// Public endpoint: a browser POSTs its PushSubscription here after the
// visitor clicks "Enable Browser Alerts" on the landing page. Bounded by
// a per-IP rate limit and a sanity ceiling on total stored subscriptions
// — the worst case for a garbage/fake subscription is just a failed send
// later, pruned like any other dead entry, since sending push is free
// and rate-limited by the push services themselves, not billed per-send.
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const redis = Redis.fromEnv();

const ALLOWED_ORIGIN = "https://balticsignalmonitor.com";
const RATE_LIMIT_PER_HOUR = 5;
const MAX_SUBSCRIPTIONS = 50000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isValidSubscription(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.endpoint !== "string" || !body.endpoint.startsWith("https://")) return false;
  const keys = body.keys;
  if (!keys || typeof keys !== "object") return false;
  if (typeof keys.p256dh !== "string" || keys.p256dh.length < 20) return false;
  if (typeof keys.auth !== "string" || keys.auth.length < 10) return false;
  return true;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  const rateLimitKey = `ratelimit:subscribe:${ip}`;
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, 3600);
  }
  if (count > RATE_LIMIT_PER_HOUR) {
    res.status(429).json({ error: "too many subscribe attempts, try again later" });
    return;
  }

  if (!isValidSubscription(req.body)) {
    res.status(400).json({ error: "invalid subscription" });
    return;
  }

  const totalCount = await redis.hlen("subscriptions");
  if (totalCount >= MAX_SUBSCRIPTIONS) {
    res.status(503).json({ error: "at capacity, try again later" });
    return;
  }

  // Keying by a hash of the endpoint makes dead-subscription cleanup an
  // O(1) HDEL and naturally de-dupes a browser that subscribes twice.
  const key = crypto.createHash("sha256").update(req.body.endpoint).digest("hex");
  const record = {
    endpoint: req.body.endpoint,
    keys: { p256dh: req.body.keys.p256dh, auth: req.body.keys.auth },
    createdAt: new Date().toISOString(),
  };
  await redis.hset("subscriptions", { [key]: JSON.stringify(record) });

  res.status(200).json({ ok: true });
}
