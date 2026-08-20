// Public endpoint: a browser POSTs its PushSubscription here after the
// visitor clicks "Enable Browser Alerts" on the landing page. Bounded by
// a per-IP rate limit and a sanity ceiling on total stored subscriptions
// — the worst case for a garbage/fake subscription is just a failed send
// later, pruned like any other dead entry, since sending push is free
// and rate-limited by the push services themselves, not billed per-send.
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

// Vercel's Upstash marketplace integration names these KV_REST_API_URL /
// KV_REST_API_TOKEN, not the UPSTASH_REDIS_REST_* names Redis.fromEnv()
// looks for by default — so the client is constructed explicitly instead.
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const ALLOWED_ORIGIN = "https://balticsignalmonitor.com";
const RATE_LIMIT_PER_HOUR = 5;
const MAX_SUBSCRIPTIONS = 50000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Real values are short and fixed-shape: endpoint URLs from the major push
// services run well under 512 chars, a P-256 public key (p256dh) is 65
// raw bytes (~88 base64url chars), and the auth secret is 16 raw bytes
// (~24 base64url chars). Upper bounds here are generous multiples of
// that, not exact — just enough to stop an arbitrarily large string being
// stored verbatim in every one of up to MAX_SUBSCRIPTIONS Redis entries.
const MAX_ENDPOINT_LENGTH = 512;
const MAX_P256DH_LENGTH = 128;
const MAX_AUTH_LENGTH = 64;

function isValidSubscription(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.endpoint !== "string" || !body.endpoint.startsWith("https://")) return false;
  if (body.endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  const keys = body.keys;
  if (!keys || typeof keys !== "object") return false;
  if (typeof keys.p256dh !== "string" || keys.p256dh.length < 20 || keys.p256dh.length > MAX_P256DH_LENGTH) return false;
  if (typeof keys.auth !== "string" || keys.auth.length < 10 || keys.auth.length > MAX_AUTH_LENGTH) return false;
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

  // The LAST entry in X-Forwarded-For is the one Vercel's own edge
  // appends (the real client IP) -- every entry before it is whatever
  // the client itself sent, so reading the FIRST entry (the old code)
  // let anyone bypass the per-IP rate limit below just by sending a
  // fresh fake leading IP on every request, no proxy or botnet needed.
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwardedFor === "string" && forwardedFor.split(",").pop().trim()) ||
    req.headers["x-real-ip"] ||
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
