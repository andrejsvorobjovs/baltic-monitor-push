// Password-protected admin view: lets the project's owner see how many
// Web Push subscriptions are stored, and clear one or all of them,
// without needing to open the Vercel/Upstash dashboard directly.
//
// Deliberately a SEPARATE secret from WEB_PUSH_NOTIFY_SECRET: this one
// only ever travels in a browser URL (typed or bookmarked), which is a
// weaker place to keep a secret than an Authorization header — keeping
// it separate means a leaked admin URL can't also be used to trigger
// the automated notify/prune endpoints.
//
// No raw endpoint/keys are ever shown here — there's nothing a name or
// identity could be attached to in this data, but there's still no
// reason to display the actual delivery address when an id and a
// creation date are all that's useful for deciding what to keep.
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function isAuthorized(key) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const a = Buffer.from(String(key || ""));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function page(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Baltic Signal Monitor — Push Admin</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; background: #10161f; color: #e9edec; }
  h1 { font-size: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 16px; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #232b38; text-align: left; }
  .btn { display: inline-block; padding: 8px 14px; background: #a4433a; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-size: 13px; }
  .btn.small { padding: 3px 8px; font-size: 12px; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .muted { color: #8b93a3; font-size: 13px; }
  a { color: #4db8b0; }
</style></head><body>${body}</body></html>`;
}

export default async function handler(req, res) {
  const key = req.method === "GET" ? req.query.key : (req.body && req.body.key);

  if (!isAuthorized(key)) {
    res.status(401).setHeader("Content-Type", "text/html").send(
      page("<h1>Unauthorized</h1><p class=\"muted\">Missing or incorrect key.</p>")
    );
    return;
  }

  if (req.method === "POST") {
    const action = req.body && req.body.action;
    if (action === "clear") {
      const all = (await redis.hgetall("subscriptions")) || {};
      const ids = Object.keys(all);
      if (ids.length) await redis.hdel("subscriptions", ...ids);
    } else if (action === "delete" && req.body.id) {
      await redis.hdel("subscriptions", req.body.id);
    }
    res.writeHead(302, { Location: `/api/admin?key=${encodeURIComponent(key)}` });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const all = (await redis.hgetall("subscriptions")) || {};
  const entries = Object.entries(all).map(([id, raw]) => {
    let sub = {};
    try { sub = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { /* malformed, no createdAt */ }
    return { id, createdAt: sub.createdAt || null };
  });
  entries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const now = Date.now();
  const rows = entries.map((e) => {
    const ageDays = e.createdAt ? Math.floor((now - new Date(e.createdAt).getTime()) / 86400000) : "?";
    return `<tr><td>${escapeHtml(e.id.slice(0, 12))}…</td><td>${escapeHtml(e.createdAt || "unknown")}</td><td>${ageDays}</td>
      <td><form method="POST" style="display:inline" onsubmit="return confirm('Delete this one subscription?');">
        <input type="hidden" name="key" value="${escapeHtml(key)}">
        <input type="hidden" name="action" value="delete">
        <input type="hidden" name="id" value="${escapeHtml(e.id)}">
        <button class="btn small" type="submit">Delete</button>
      </form></td></tr>`;
  }).join("");

  const body = `
    <h1>Push subscriptions</h1>
    <p class="muted">${entries.length} stored right now. Anything older than 365 days is pruned
    automatically (checked on every scan and health check); a subscription that stops working
    (browser uninstalled, permission revoked) is pruned the next time a push to it fails.</p>
    <form method="POST" onsubmit="return confirm('Delete ALL stored subscriptions? This cannot be undone.');">
      <input type="hidden" name="key" value="${escapeHtml(key)}">
      <input type="hidden" name="action" value="clear">
      <button class="btn" type="submit" ${entries.length ? "" : "disabled"}>Delete all subscriptions</button>
    </form>
    <table>
      <tr><th>ID</th><th>Created</th><th>Age (days)</th><th></th></tr>
      ${rows || '<tr><td colspan="4" class="muted">None stored.</td></tr>'}
    </table>
  `;
  res.status(200).setHeader("Content-Type", "text/html").send(page(body));
}
