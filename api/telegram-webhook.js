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

// Verdicts on individual alerts, appended to alert_judgements.json in the
// main repo. main.py's compute_alert_accuracy() joins them against the
// scans that actually alerted to produce the accuracy figure published on
// the site.
//
// The whole point of this file is that a keyword scorer cannot grade its
// own output. A human says genuine or noise; the number is published with
// its sample size and a plain statement of who judged it.
const MAX_JUDGEMENTS = 2000;   // ~3 years of alerts at the current rate

async function recordJudgement(alertId, verdict, chatId, { quiet = false } = {}) {
  if (!/^[0-9]{4}-[0-9]{4}$/.test(alertId || "")) {
    if (!quiet) await replyToTelegram(chatId, `That does not look like an alert id: "${alertId}". They look like 0906-1153.`);
    return false;
  }
  const { content, sha } = await readRepoJson("alert_judgements.json");
  content.judgements = Array.isArray(content.judgements) ? content.judgements : [];
  // Re-judging is allowed and overwrites: a mistap should be correctable
  // by simply tapping the other button, not by editing a file by hand.
  const existing = content.judgements.find((j) => j && j.id === alertId);
  const previous = existing ? existing.verdict : null;
  if (existing) {
    existing.verdict = verdict;
    existing.judged_at = new Date().toISOString();
  } else {
    content.judgements.push({ id: alertId, verdict, judged_at: new Date().toISOString() });
  }
  if (content.judgements.length > MAX_JUDGEMENTS) {
    content.judgements = content.judgements.slice(-MAX_JUDGEMENTS);
  }
  await writeRepoJson("alert_judgements.json", content, sha,
    `Judge alert ${alertId}: ${verdict} [skip ci]`);
  if (!quiet) {
    await replyToTelegram(chatId,
      previous && previous !== verdict
        ? `Alert ${alertId} changed from ${previous} to ${verdict}.`
        : `Alert ${alertId} recorded as ${verdict}. It reaches the site on the next scan.`);
  }
  return true;
}

// Telegram expects every callback query to be answered, otherwise the
// button keeps spinning on the user's phone.
async function answerCallback(callbackId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  }).catch(() => {});
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

  // Button taps arrive as callback_query, not message. Handled first and
  // separately: it is the path that actually gets used, since one tap is
  // the difference between judging alerts daily and never doing it.
  const callback = req.body?.callback_query;
  if (callback) {
    const cbChat = callback.message?.chat?.id;
    const ownerId = process.env.TELEGRAM_OWNER_CHAT_ID;
    // Same owner check as commands — a stranger who somehow got the
    // callback data must not be able to grade this project's accuracy.
    if (!ownerId || String(cbChat) !== String(ownerId)) {
      res.status(200).json({ ok: true });
      return;
    }
    const m = /^judge:(genuine|noise):([0-9]{4}-[0-9]{4})$/.exec(callback.data || "");
    if (!m) {
      await answerCallback(callback.id, "");
      res.status(200).json({ ok: true });
      return;
    }
    try {
      await recordJudgement(m[2], m[1], cbChat, { quiet: true });
      await answerCallback(callback.id, m[1] === "genuine" ? "Recorded: genuine" : "Recorded: noise");
    } catch (err) {
      console.error("telegram-webhook: judgement failed:", err);
      await answerCallback(callback.id, "Could not save that — try again");
    }
    res.status(200).json({ ok: true });
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
    } else if (text === "/firms") {
      // Phase 1 only, same shape as /gpsjam, /ais, /military, /notam,
      // /notmar above (see baltic-monitor's own README for the full
      // design discussion): informational, on-demand, never touches
      // scoring or alerting. main.py's send_firms_status() queries NASA
      // FIRMS's free satellite thermal-hotspot feed (VIIRS_SNPP_NRT) and
      // does the actual fetch/format/send, private chat only -- replies
      // "not configured" if FIRMS_MAP_KEY isn't set yet, same pattern as
      // /ais. Raw satellite heat data, not confirmed military activity --
      // wildfires and agricultural burning trigger it too.
      await triggerScan({ firms_check: "true" });
      await replyToTelegram(chatId, "Checking NASA FIRMS satellite thermal hotspots for the Baltic -- reply coming in about 20-30 seconds.");
    } else if (text === "/gridoutage") {
      // Phase 1 only, same shape as /firms/gpsjam/ais/military/notam/
      // notmar above: informational, on-demand, never touches scoring or
      // alerting. main.py's send_entsoe_outage_status() queries the
      // ENTSO-E Transparency Platform (the EU's official REMIT-mandated
      // outage-reporting system) for forced generation-unit outages
      // across Estonia/Latvia/Lithuania -- replies "not configured" if
      // ENTSOE_API_KEY isn't set yet, same pattern as /firms. Generation
      // outages only, not transmission/interconnector lines (a
      // documented gap, see baltic-monitor's own ENTSOE_API_KEY block
      // comment) -- and a forced outage is usually ordinary equipment
      // failure, not sabotage.
      await triggerScan({ entsoe_check: "true" });
      await replyToTelegram(chatId, "Checking Baltic power grid outages via ENTSO-E -- reply coming in about 20-30 seconds.");
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
    } else if (text.startsWith("/genuine") || text.startsWith("/noise")) {
      // Typed fallback for when the buttons are unavailable — an old
      // message whose keyboard Telegram has dropped, or a desktop client
      // being awkward.
      const verdict = text.startsWith("/genuine") ? "genuine" : "noise";
      const arg = text.split(/\s+/)[1] || "";
      await recordJudgement(arg, verdict, chatId);
    } else if (text === "/unjudged") {
      const { content } = await readRepoJson("alert_judgements.json");
      const n = Array.isArray(content.judgements) ? content.judgements.length : 0;
      await replyToTelegram(chatId,
        `${n} alert(s) judged so far. The site publishes a precision figure once 10 are in, always alongside how many are still unjudged.`);
    } else if (text === "/help" || text === "/start") {
      await replyToTelegram(chatId,
        "Commands:\n/scan -- trigger a scan now\n/gpsjam -- check today's Baltic GPS-jamming picture (informational only, never an alert)\n" +
        "/ais -- short live AIS ship snapshot of the Baltic (informational only, never an alert)\n" +
        "/military -- live military aircraft snapshot of the Baltic (informational only, never an alert)\n" +
        "/notam -- current Latvia NOTAMs filtered to military-relevant ones (informational only, never an alert)\n" +
        "/notmar -- current Estonia/Latvia Notices to Mariners filtered to security-relevant keywords (informational only, never an alert)\n" +
        "/firms -- NASA satellite thermal hotspot snapshot of the Baltic (informational only, not confirmed activity, never an alert)\n" +
        "/gridoutage -- forced power-generation outages across Estonia/Latvia/Lithuania via ENTSO-E (informational only, generation only, never an alert)\n" +
        "/mute <keyword> -- mute a keyword\n" +
        "/ignore <source name> -- ignore a source\n/quietmode -- toggle quiet mode for this chat\n" +
        "/genuine <id> -- mark an alert as a real signal (or just tap the button under it)\n" +
        "/noise <id> -- mark an alert as noise\n" +
        "/unjudged -- how many alerts have been judged so far");
    }
    // Anything else: no reply, matches the old polling listener's behavior
    // of only responding to recognized commands.
  } catch (err) {
    console.error("telegram-webhook: command handling failed:", err);
    await replyToTelegram(chatId, "Something went wrong running that command -- check the Vercel function logs.");
  }

  res.status(200).json({ ok: true });
}
