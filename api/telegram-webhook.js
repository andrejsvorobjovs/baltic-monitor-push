// Instant replacement for the polling-based /scan /mute /ignore /quietmode
// command listener that main.py used to run itself (removed -- see the
// main baltic-monitor repo's README changelog -- because polling on
// GitHub Actions' best-effort schedule averaged ~1.8h of lag, too slow to
// be worth the complexity). Telegram delivers webhook updates instantly;
// this endpoint is the receiving end, running on Vercel instead of inside
// a scheduled scan since GitHub Actions has no way to receive an inbound
// request at all.
//
// This function can trigger a workflow run and commit file changes in
// the main baltic-monitor repo -- real write access, so it is deliberately
// defended in two independent layers before doing anything:
//   1. Telegram's own webhook secret token (X-Telegram-Bot-Api-Secret-Token
//      header, set via setWebhook's secret_token param) -- proves the
//      request actually came from Telegram, not just anyone who found
//      this URL.
//   2. The sender's chat id must match TELEGRAM_OWNER_CHAT_ID exactly --
//      proves the command came from the owner's own chat with the bot,
//      not some other user who messaged it. Anything else is silently
//      ignored (still 200s back to Telegram so it doesn't retry -- see
//      handler() below -- but takes no action and sends no reply, so a
//      stranger probing the bot learns nothing about its command surface).
import crypto from "node:crypto";

const GITHUB_API = "https://api.github.com";
const REPO_OWNER = "andrejsvorobjovs";
const REPO_NAME = "baltic-monitor";
const SCAN_WORKFLOW_FILE = "scan.yml";

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function githubRequest(path, options = {}) {
  const resp = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  return resp;
}

async function triggerScan(extraInputs = {}) {
  const resp = await githubRequest(
    `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${SCAN_WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: extraInputs }),
    }
  );
  if (resp.status !== 204) {
    throw new Error(`workflow dispatch failed: ${resp.status} ${await resp.text()}`);
  }
}

// Reads a JSON file from the repo's default branch, returning both the
// parsed content and the blob sha the Contents API requires for the
// follow-up PUT (GitHub rejects a write that doesn't name the exact
// current sha -- this is what stops two concurrent edits from silently
// clobbering each other).
async function readRepoJson(path) {
  const resp = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`);
  if (!resp.ok) throw new Error(`failed to read ${path}: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const content = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
  return { content, sha: data.sha };
}

async function writeRepoJson(path, content, sha, commitMessage) {
  const body = Buffer.from(JSON.stringify(content)).toString("base64");
  const resp = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: commitMessage,
      content: body,
      sha,
      branch: "main",
      committer: { name: "baltic-monitor-bot", email: "actions@github.com" },
    }),
  });
  if (!resp.ok) throw new Error(`failed to write ${path}: ${resp.status} ${await resp.text()}`);
}

async function replyToTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return; // can trigger actions without this, just can't confirm back
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {}); // best-effort -- a failed confirmation reply must never
                        // surface as a webhook error back to Telegram, which
                        // would make it retry-deliver the original command
}

// /mute and /ignore both append-if-absent into the same small config file
// shape ({"muted_keywords": [...], "ignored_sources": [...]}) that
// main.py's load_mute_config()/is_muted() already read every scan --
// nothing on the Python side needs to change for this to take effect on
// the very next scan.
async function handleMuteOrIgnore(field, value, chatId) {
  if (!value) {
    await replyToTelegram(chatId, `Usage: /${field === "muted_keywords" ? "mute <keyword>" : "ignore <source name>"}`);
    return;
  }
  const { content, sha } = await readRepoJson("mute_config.json");
  content[field] = content[field] || [];
  if (content[field].includes(value)) {
    await replyToTelegram(chatId, `Already ${field === "muted_keywords" ? "muted" : "ignored"}: "${value}"`);
    return;
  }
  content[field].push(value);
  await writeRepoJson("mute_config.json", content, sha,
    `Add "${value}" to ${field} [skip ci]`);
  await replyToTelegram(chatId, `Added "${value}" to ${field === "muted_keywords" ? "muted keywords" : "ignored sources"}. Takes effect on the next scan.`);
}

async function handleQuietMode(chatId) {
  const { content, sha } = await readRepoJson("settings.json");
  content.escalation_only = !content.escalation_only;
  await writeRepoJson("settings.json", content, sha,
    `Toggle escalation_only to ${content.escalation_only} [skip ci]`);
  await replyToTelegram(
    chatId,
    content.escalation_only
      ? "Quiet mode ON -- your private chat now only gets WATCH/WARN and problems, no more routine QUIET digests. The public channel is unaffected (QUIET never reached it anyway)."
      : "Quiet mode OFF -- your private chat is back to getting every scan's digest, same as before."
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // Layer 1: prove this request actually came from Telegram.
  // The explicit env-var guard matters: without it, an unset
  // TELEGRAM_WEBHOOK_SECRET (deploy misconfiguration, accidentally
  // cleared env var) makes timingSafeEqual compare two empty buffers --
  // 0 === 0 passes -- so a request that simply OMITS the secret header
  // would pass this layer entirely. admin.js/notify.js/prune.js already
  // guard the same way; this closes the one place that didn't.
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secretHeader, process.env.TELEGRAM_WEBHOOK_SECRET)) {
    // Deliberately 401, not 200 -- unlike an unauthorized *sender* below,
    // a bad secret token means this isn't even a genuine Telegram
    // delivery, so there's no "don't make Telegram retry" concern.
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const message = req.body?.message;
  const text = (message?.text || "").trim();
  const chatId = message?.chat?.id;

  // Always 200 from here on, even when silently ignoring an unauthorized
  // sender or a message with no text -- a non-200 makes Telegram retry
  // the same update repeatedly, which is not what we want for "someone
  // who isn't the owner said something to the bot."
  if (!text || chatId === undefined) {
    res.status(200).json({ ok: true });
    return;
  }

  // Layer 2: prove the sender is the owner's own chat with the bot.
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!ownerChatId || String(chatId) !== String(ownerChatId)) {
    res.status(200).json({ ok: true }); // silently ignored, see comment above
    return;
  }

  try {
    if (text === "/scan") {
      await triggerScan();
      await replyToTelegram(chatId, "Scan triggered. It'll post here (and to the channel, if relevant) in about a minute.");
    } else if (text === "/gpsjam") {
      // Phase 1 only (see baltic-monitor's README for the full design
      // discussion): informational, on-demand, never touches scoring or
      // alerting. Reuses the same scan.yml dispatch mechanism as /scan,
      // just with the gpsjam_check input set instead of a full scan --
      // main.py's send_gpsjam_status() does the actual fetch/format/send,
      // private chat only, so nothing further happens here beyond
      // triggering it and confirming receipt.
      await triggerScan({ gpsjam_check: "true" });
      await replyToTelegram(chatId, "Checking GPSJam's current Baltic picture -- reply coming in about 30 seconds.");
    } else if (text === "/ais") {
      // Phase 1 only, same shape as /gpsjam above (see baltic-monitor's
      // own README for the full design discussion): informational,
      // on-demand, never touches scoring or alerting. main.py's
      // send_ais_status() connects to aisstream.io for a short listen
      // window and does the actual fetch/format/send, private chat
      // only -- replies "not configured" if AISSTREAM_API_KEY isn't set
      // yet, rather than failing silently.
      await triggerScan({ ais_check: "true" });
      await replyToTelegram(chatId, "Checking a live AIS snapshot of the Baltic -- reply coming in about 30-40 seconds.");
    } else if (text === "/military") {
      // Phase 1 only, same shape as /gpsjam and /ais above (see
      // baltic-monitor's own README for the full design discussion):
      // informational, on-demand, never touches scoring or alerting.
      // main.py's send_military_status() queries adsb.lol's free
      // military ADS-B feed and does the actual fetch/format/send,
      // private chat only -- no API key needed, so no "not configured"
      // case the way /ais has.
      await triggerScan({ military_check: "true" });
      await replyToTelegram(chatId, "Checking a live military aircraft snapshot of the Baltic -- reply coming in about 30-40 seconds.");
    } else if (text === "/notam") {
      // Phase 1 only, Latvia only (see baltic-monitor's own README for
      // the full design discussion): informational, on-demand, never
      // touches scoring or alerting. main.py's send_notam_status()
      // queries ais.lgs.lv (Latvia's official AIS, no login/API key
      // needed) and does the actual fetch/format/send, filtered to
      // military-relevant NOTAMs, private chat only.
      await triggerScan({ notam_check: "true" });
      await replyToTelegram(chatId, "Checking current Latvia NOTAMs -- reply coming in about 20-30 seconds.");
    } else if (text === "/notmar") {
      // Phase 1 only, Estonia and Latvia only (Lithuania's official site
      // blocks automated access, same gap as its aviation NOTAM feed) --
      // informational, on-demand, never touches scoring or alerting.
      // main.py's send_notmar_status() fetches both countries' free
      // official monthly PDF bulletins and does the actual fetch/parse/
      // format/send, filtered to security-relevant keyword matches
      // (military, submarine cable, restricted areas, etc.), private
      // chat only. See baltic-monitor's own module comment above
      // NOTMAR_ESTONIA_LISTING_URL for why this shows raw keyword-
      // matched excerpts rather than individually parsed notices.
      await triggerScan({ notmar_check: "true" });
      await replyToTelegram(chatId, "Checking current Baltic Notices to Mariners -- reply coming in about 20-30 seconds.");
    } else if (text === "/mute" || text.startsWith("/mute ")) {
      // Was text.startsWith("/mute") with no word boundary, so a typo
      // like "/mutedecision" (no space) parsed as /mute with keyword
      // "decision" instead of falling through to "unrecognized, no
      // action" -- exact-match style, same as every other command here.
      await handleMuteOrIgnore("muted_keywords", text.slice("/mute".length).trim(), chatId);
    } else if (text === "/ignore" || text.startsWith("/ignore ")) {
      await handleMuteOrIgnore("ignored_sources", text.slice("/ignore".length).trim(), chatId);
    } else if (text === "/quietmode") {
      await handleQuietMode(chatId);
    } else if (text === "/help" || text === "/start") {
      await replyToTelegram(chatId,
        "Commands:\n/scan -- trigger a scan now\n/gpsjam -- check today's Baltic GPS-jamming picture (informational only, never an alert)\n" +
        "/ais -- short live AIS ship snapshot of the Baltic (informational only, never an alert)\n" +
        "/military -- live military aircraft snapshot of the Baltic (informational only, never an alert)\n" +
        "/notam -- current Latvia NOTAMs filtered to military-relevant ones (informational only, never an alert)\n" +
        "/notmar -- current Estonia/Latvia Notices to Mariners filtered to security-relevant keywords (informational only, never an alert)\n" +
        "/mute <keyword> -- mute a keyword\n" +
        "/ignore <source name> -- ignore a source\n/quietmode -- toggle quiet mode for this chat");
    }
    // Anything else: no reply, matches the old polling listener's behavior
    // of only responding to recognized commands.
  } catch (err) {
    console.error("telegram-webhook: command handling failed:", err);
    await replyToTelegram(chatId, "Something went wrong running that command -- check the Vercel function logs.");
  }

  res.status(200).json({ ok: true });
}
