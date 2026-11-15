#!/usr/bin/env node
// One-time Telegram bot setup for Livento, run after deploy (no dependencies).
//
// Reads from the environment (the token and secret are never printed):
//   TELEGRAM_BOT_TOKEN       the BotFather token (the deployed app needs the same one)
//   TELEGRAM_WEBHOOK_SECRET  1-256 chars of A-Z a-z 0-9 _ -, the same value as in the deployed env
//   SITE_URL                 the deployed HTTPS origin, e.g. https://livento-lilac.vercel.app
//   TELEGRAM_API_BASE        optional, only for testing against scripts/telegram-mock.mjs
//
// Calls getMe, setWebhook (${SITE_URL}/api/telegram, message + callback_query updates),
// setMyCommands, setMyDescription, setMyShortDescription, setChatMenuButton ("Open Livento"
// Mini App) and getWebhookInfo. With --avatar it also uploads
// public/assets/telegram/bot-avatar.jpg through setMyProfilePhoto (each run adds a new photo).
//
// Usage (PowerShell):
//   $env:TELEGRAM_BOT_TOKEN="<token>"; $env:TELEGRAM_WEBHOOK_SECRET="<secret>";
//   $env:SITE_URL="https://livento-lilac.vercel.app"; node scripts/telegram-setup.mjs --avatar
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AVATAR = path.join(ROOT, "public", "assets", "telegram", "bot-avatar.jpg");

const COMMANDS = [
  { command: "start", description: "Set up your city and interests" },
  { command: "picks", description: "Top picks near you" },
  { command: "profile", description: "Your profile and a quote" },
  { command: "quote", description: "A little motivation" },
  { command: "stop", description: "Remove your profile and alerts" },
];

// Shown in the empty chat ("What can this bot do?"), 0-512 characters.
const DESCRIPTION = [
  "Spend on memories, not impulses.",
  "",
  "Livento finds concerts, shows, sports and trips near you and shows the full cost: tickets, fees, travel and a hotel if you need one.",
  "",
  "Pick what you love and the Livento wallet can save for it automatically, a little each week.",
  "",
  "Get your top picks right here in the chat, plus a quote when you need a nudge.",
  "",
  "Tap Start to set your city and interests.",
].join("\n");

// Shown on the bot's profile and in shared links, 0-120 characters.
const SHORT_DESCRIPTION =
  "Spend on memories, not impulses. Events near you with the full cost, and a wallet that saves for them.";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
const site = (process.env.SITE_URL ?? "").trim().replace(/\/+$/, "");
const base = (process.env.TELEGRAM_API_BASE ?? "").trim().replace(/\/+$/, "") || "https://api.telegram.org";
const withAvatar = process.argv.includes("--avatar");

/** Never let the token reach the console. */
const safe = (value) => (token ? String(value).split(token).join("***") : String(value));

function fail(message) {
  console.error(`✗ ${safe(message)}`);
  process.exit(1);
}

if (!/^\d+:[\w-]{20,}$/.test(token) && !(base !== "https://api.telegram.org" && /^\d+:[\w-]+$/.test(token))) {
  fail("TELEGRAM_BOT_TOKEN is missing or doesn't look like a BotFather token.");
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  fail("TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, _ or -.");
}
if (!/^https:\/\/[^/]+$/.test(site)) fail("SITE_URL must be the deployed HTTPS origin, e.g. https://livento-lilac.vercel.app");
if (DESCRIPTION.length > 512) fail(`description is ${DESCRIPTION.length} characters (max 512)`);
if (SHORT_DESCRIPTION.length > 120) fail(`short description is ${SHORT_DESCRIPTION.length} characters (max 120)`);

async function call(method, params, form) {
  let res;
  try {
    res = await fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      ...(form
        ? { body: form }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(params ?? {}) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    fail(`${method}: request failed (${error?.cause?.code ?? error?.message ?? "network error"})`);
  }
  const data = await res.json().catch(() => null);
  if (!data?.ok) fail(`${method}: ${data?.description ?? `HTTP ${res.status}`}`);
  return data.result;
}

const me = await call("getMe");
console.log(`Bot: @${me.username} (${me.first_name})`);

await call("setWebhook", {
  url: `${site}/api/telegram`,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
});
console.log(`✓ setWebhook → ${site}/api/telegram (message, callback_query)`);

await call("setMyCommands", { commands: COMMANDS });
console.log(`✓ setMyCommands → ${COMMANDS.map((c) => `/${c.command}`).join(" ")}`);

await call("setMyDescription", { description: DESCRIPTION });
console.log(`✓ setMyDescription (${DESCRIPTION.length}/512)`);

await call("setMyShortDescription", { short_description: SHORT_DESCRIPTION });
console.log(`✓ setMyShortDescription (${SHORT_DESCRIPTION.length}/120)`);

await call("setChatMenuButton", { menu_button: { type: "web_app", text: "Open Livento", web_app: { url: site } } });
console.log(`✓ setChatMenuButton → "Open Livento" Mini App at ${site}`);

if (withAvatar) {
  const jpg = await readFile(AVATAR).catch(() => fail(`missing ${path.relative(ROOT, AVATAR)}`));
  const form = new FormData();
  form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
  form.append("avatar", new Blob([jpg], { type: "image/jpeg" }), "bot-avatar.jpg");
  await call("setMyProfilePhoto", null, form);
  console.log("✓ setMyProfilePhoto ← public/assets/telegram/bot-avatar.jpg");
} else {
  console.log("· Profile photo skipped (add --avatar to upload public/assets/telegram/bot-avatar.jpg).");
}

const info = await call("getWebhookInfo");
console.log(
  `Webhook: ${info.url || "(none)"} · pending updates: ${info.pending_update_count ?? 0}` +
    (info.last_error_message ? ` · last error: ${safe(info.last_error_message)}` : ""),
);
console.log("Description picture: set it in @BotFather → /mybots → Edit Bot → Edit Description Picture (no Bot API method).");
