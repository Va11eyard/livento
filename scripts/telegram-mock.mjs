#!/usr/bin/env node
// Local Telegram Bot API mock for the Livento bot (no dependencies). TEST HARNESS ONLY.
//
// Records every Bot API call and answers like Telegram does, keeping per-chat messages and
// pins so getChat returns the pinned profile card with its reply_markup. Point the app at it
// (dev only; ignored in production) with
//   TELEGRAM_BOT_TOKEN=123:local
//   TELEGRAM_BOT_USERNAME=livento_help_bot
//   TELEGRAM_WEBHOOK_SECRET=local-secret
//   TELEGRAM_API_BASE=http://127.0.0.1:<port>
// Usage: node scripts/telegram-mock.mjs [port]      (default 8790)
//
// Bot API (POST /bot<token>/<method>, JSON or multipart):
//   sendMessage, editMessageText, editMessageReplyMarkup, pinChatMessage, unpinChatMessage,
//   getChat, answerCallbackQuery, deleteMessage, sendChatAction, getMe, setWebhook,
//   getWebhookInfo, deleteWebhook, setMyCommands, setMyDescription, setMyShortDescription,
//   setChatMenuButton, setMyProfilePhoto. Like Telegram it checks HTML tags, text length,
//   callback_data (1-64 bytes), web_app (HTTPS), "message is not modified" and double answers.
// Test controls (JSON, no auth):
//   POST /__mock/message  { chat_id, text, reply_to_message_id? }  → a webhook Update (user message)
//   POST /__mock/callback { chat_id, message_id, data }             → a webhook Update (button press;
//                                                                     the button must exist)
//   GET  /__mock/calls?since=<n>                                    → { total, calls: [{ n, method, params }] }
//   GET  /__mock/chat?chat_id=<id>                                  → { messages, pinned }
//   POST /__mock/reset
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || process.env.PORT || 8790);
const BOT = { id: 7000000001, is_bot: true, first_name: "Livento", username: "livento_help_bot" };
const HTML_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span", "tg-spoiler",
  "a", "code", "pre", "blockquote", "tg-emoji",
]);

let calls = [];
let chats = new Map(); // chatId → { nextId, messages: Map<id, Message>, pinned: id[] }
let answered = new Set();
let updateId = 100;
let queryId = 1;
const state = { webhook: null, commands: [], description: "", shortDescription: "", menuButton: null, photo: null };

const now = () => Math.floor(Date.now() / 1000);
const ok = (result) => ({ status: 200, body: { ok: true, result } });
const bad = (description, code = 400) => ({ status: code, body: { ok: false, error_code: code, description } });

function chat(id) {
  const key = String(id);
  if (!chats.has(key)) chats.set(key, { nextId: 1, messages: new Map(), pinned: [] });
  return chats.get(key);
}

function chatInfo(id) {
  return { id: Number(id), first_name: "Tester", username: "tester", type: "private" };
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Telegram-like HTML check; returns [plainText, error]. */
function parseHtml(text) {
  const tag = /<\/?([a-zA-Z][\w-]*)(\s[^<>]*)?>/g;
  for (const m of text.matchAll(tag)) {
    if (!HTML_TAGS.has(m[1].toLowerCase())) return [null, `Bad Request: can't parse entities: Unsupported start tag "${m[1]}"`];
  }
  const stripped = text.replace(tag, "");
  if (stripped.includes("<")) return [null, "Bad Request: can't parse entities: Unsupported start tag at byte offset " + stripped.indexOf("<")];
  return [decodeEntities(stripped), null];
}

function checkText(text, parseMode) {
  if (typeof text !== "string") return [null, "Bad Request: message text is empty"];
  const [plain, error] = parseMode === "HTML" ? parseHtml(text) : [text, null];
  if (error) return [null, error];
  if (!plain.trim()) return [null, "Bad Request: message text is empty"];
  if ([...plain].length > 4096) return [null, "Bad Request: message is too long"];
  return [plain, null];
}

/** Validates reply_markup; returns [inlineKeyboardOrUndefined, error]. */
function checkMarkup(markup) {
  if (markup === undefined || markup === null) return [undefined, null];
  if (typeof markup !== "object") return [null, "Bad Request: can't parse reply keyboard markup JSON object"];
  if (markup.force_reply) {
    const p = markup.input_field_placeholder;
    if (p !== undefined && (typeof p !== "string" || p.length < 1 || p.length > 64)) return [null, "Bad Request: invalid input field placeholder"];
    return [undefined, null];
  }
  if (!Array.isArray(markup.inline_keyboard)) return [null, "Bad Request: can't parse inline keyboard"];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) return [null, "Bad Request: can't parse inline keyboard row"];
    for (const b of row) {
      if (!b || typeof b.text !== "string" || !b.text) return [null, "Bad Request: text buttons are unallowed in the inline keyboard"];
      const kinds = ["callback_data", "url", "web_app"].filter((k) => b[k] !== undefined);
      if (kinds.length !== 1) return [null, "Bad Request: BUTTON_TYPE_INVALID"];
      if (b.callback_data !== undefined) {
        const bytes = Buffer.byteLength(String(b.callback_data));
        if (typeof b.callback_data !== "string" || bytes < 1 || bytes > 64) return [null, "Bad Request: BUTTON_DATA_INVALID"];
      }
      if (b.web_app !== undefined && !/^https:\/\//.test(b.web_app?.url ?? "")) return [null, "Bad Request: BUTTON_URL_INVALID"];
      if (b.url !== undefined) {
        let host = "";
        try {
          const u = new URL(b.url);
          if (!/^(https?|tg):$/.test(u.protocol)) throw new Error();
          host = u.hostname;
        } catch {
          return [null, `Bad Request: inline keyboard button URL '${b.url}' is invalid: Wrong HTTP URL`];
        }
        if (host === "localhost" || /^[\d.]+$/.test(host)) return [null, `Bad Request: inline keyboard button URL '${b.url}' is invalid: Wrong HTTP URL`];
      }
    }
  }
  return [markup.inline_keyboard.length ? { inline_keyboard: markup.inline_keyboard } : undefined, null];
}

function botMessage(chatId, id) {
  const m = chat(chatId).messages.get(Number(id));
  return m && m.from.is_bot ? m : null;
}

function addMessage(chatId, fields) {
  const c = chat(chatId);
  const message = { message_id: c.nextId++, date: now(), chat: chatInfo(chatId), ...fields };
  c.messages.set(message.message_id, message);
  return message;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function editMessage(p, { text }) {
  const m = botMessage(p.chat_id, p.message_id);
  if (!m) return bad("Bad Request: message to edit not found");
  const [markup, markupError] = checkMarkup(p.reply_markup);
  if (markupError) return bad(markupError);
  let plain = m.text;
  if (text) {
    const [t, textError] = checkText(p.text, p.parse_mode);
    if (textError) return bad(textError);
    plain = t;
  }
  if (plain === m.text && same(markup, m.reply_markup)) {
    return bad("Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
  }
  m.text = plain;
  m.html = text ? p.text : m.html;
  if (markup) m.reply_markup = markup;
  else delete m.reply_markup;
  m.edit_date = now();
  return ok(publicMessage(m));
}

/** What Telegram returns: no private test fields. */
function publicMessage(m) {
  const rest = { ...m };
  for (const key of ["html", "force_reply", "service"]) delete rest[key];
  return rest;
}

const methods = {
  getMe: () => ok({ ...BOT, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }),
  sendMessage(p) {
    if (p.chat_id === undefined) return bad("Bad Request: chat_id is empty");
    const [plain, textError] = checkText(p.text, p.parse_mode);
    if (textError) return bad(textError);
    const [markup, markupError] = checkMarkup(p.reply_markup);
    if (markupError) return bad(markupError);
    const m = addMessage(p.chat_id, { from: BOT, text: plain, html: p.text, ...(markup ? { reply_markup: markup } : {}) });
    if (p.reply_markup?.force_reply) m.force_reply = true;
    return ok(publicMessage(m));
  },
  editMessageText: (p) => editMessage(p, { text: true }),
  editMessageReplyMarkup: (p) => editMessage(p, { text: false }),
  pinChatMessage(p) {
    const c = chat(p.chat_id);
    const m = c.messages.get(Number(p.message_id));
    if (!m || m.service) return bad("Bad Request: message to pin not found");
    if (!c.pinned.includes(m.message_id)) c.pinned.push(m.message_id);
    // Like Telegram, pinning adds a service message to the chat.
    addMessage(p.chat_id, { from: BOT, service: true, pinned_message: publicMessage(m) });
    return ok(true);
  },
  unpinChatMessage(p) {
    const c = chat(p.chat_id);
    const id = p.message_id !== undefined ? Number(p.message_id) : Math.max(...c.pinned);
    if (!c.pinned.includes(id)) return bad("Bad Request: message to unpin not found");
    c.pinned = c.pinned.filter((x) => x !== id);
    return ok(true);
  },
  getChat(p) {
    if (p.chat_id === undefined) return bad("Bad Request: chat not found");
    const c = chat(p.chat_id);
    const latest = c.pinned.length ? c.messages.get(Math.max(...c.pinned)) : null; // by sending date
    return ok({
      ...chatInfo(p.chat_id),
      accent_color_id: 0,
      max_reaction_count: 11,
      accepted_gift_types: { unlimited_gifts: false, limited_gifts: false, unique_gifts: false, premium_subscription: false },
      ...(latest ? { pinned_message: publicMessage(latest) } : {}),
    });
  },
  answerCallbackQuery(p) {
    if (!p.callback_query_id || answered.has(p.callback_query_id)) {
      return bad("Bad Request: query is too old and response timeout expired or query ID is invalid");
    }
    if (p.text !== undefined && String(p.text).length > 200) return bad("Bad Request: MESSAGE_TOO_LONG");
    answered.add(p.callback_query_id);
    return ok(true);
  },
  deleteMessage(p) {
    const c = chat(p.chat_id);
    if (!c.messages.delete(Number(p.message_id))) return bad("Bad Request: message to delete not found");
    c.pinned = c.pinned.filter((x) => x !== Number(p.message_id));
    return ok(true);
  },
  sendChatAction: () => ok(true),
  setWebhook(p) {
    if (!/^https:\/\//.test(p.url ?? "")) return bad("Bad Request: bad webhook: An HTTPS URL must be provided for webhook");
    if (p.secret_token !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(p.secret_token)) return bad("Bad Request: secret token contains unallowed characters");
    state.webhook = { url: p.url, allowed_updates: p.allowed_updates ?? [], has_secret: Boolean(p.secret_token) };
    return ok(true);
  },
  deleteWebhook: () => ((state.webhook = null), ok(true)),
  getWebhookInfo: () =>
    ok({ url: state.webhook?.url ?? "", has_custom_certificate: false, pending_update_count: 0, allowed_updates: state.webhook?.allowed_updates }),
  setMyCommands(p) {
    const list = Array.isArray(p.commands) ? p.commands : null;
    if (!list || list.length > 100) return bad("Bad Request: commands must be an array");
    for (const c of list) {
      if (!/^[a-z0-9_]{1,32}$/.test(c?.command ?? "")) return bad("Bad Request: BOT_COMMAND_INVALID");
      if (typeof c.description !== "string" || c.description.length < 1 || c.description.length > 256) return bad("Bad Request: BOT_COMMAND_DESCRIPTION_INVALID");
    }
    state.commands = list;
    return ok(true);
  },
  setMyDescription(p) {
    if ((p.description ?? "").length > 512) return bad("Bad Request: description is too long");
    state.description = p.description ?? "";
    return ok(true);
  },
  setMyShortDescription(p) {
    if ((p.short_description ?? "").length > 120) return bad("Bad Request: short description is too long");
    state.shortDescription = p.short_description ?? "";
    return ok(true);
  },
  setChatMenuButton(p) {
    const b = p.menu_button;
    if (b?.type === "web_app" && !/^https:\/\//.test(b.web_app?.url ?? "")) return bad("Bad Request: BUTTON_URL_INVALID");
    state.menuButton = b ?? { type: "default" };
    return ok(true);
  },
  setMyProfilePhoto(p, files) {
    let photo = p.photo;
    try {
      if (typeof photo === "string") photo = JSON.parse(photo);
    } catch {
      return bad("Bad Request: can't parse InputProfilePhoto JSON object");
    }
    const attach = /^attach:\/\/(.+)$/.exec(photo?.photo ?? "");
    const file = attach ? files[attach[1]] : null;
    if (photo?.type !== "static" || !file) return bad("Bad Request: photo must be uploaded as a new file");
    if (file.data[0] !== 0xff || file.data[1] !== 0xd8) return bad("Bad Request: PHOTO_INVALID_DIMENSIONS");
    state.photo = { bytes: file.data.length, contentType: file.contentType };
    return ok(true);
  },
};

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const fields = {};
  const files = {};
  if (!boundary) return { fields, files };
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let start = buffer.indexOf(delimiter);
  while (start >= 0) {
    const next = buffer.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;
    const part = buffer.subarray(start + delimiter.length + 2, next - 2); // skip CRLF after delimiter / before next
    const split = part.indexOf("\r\n\r\n");
    if (split > 0) {
      const head = part.subarray(0, split).toString("utf8");
      const data = part.subarray(split + 4);
      const name = /name="([^"]+)"/.exec(head)?.[1];
      const isFile = /filename="/.test(head);
      if (name && isFile) files[name] = { data, contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "" };
      else if (name) fields[name] = data.toString("utf8");
    }
    start = next;
  }
  return { fields, files };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function control(req, url, body) {
  const json = () => (body.length ? JSON.parse(body.toString("utf8")) : {});
  if (req.method === "POST" && url.pathname === "/__mock/reset") {
    calls = [];
    chats = new Map();
    answered = new Set();
    return [200, { ok: true }];
  }
  if (req.method === "GET" && url.pathname === "/__mock/calls") {
    const since = Number(url.searchParams.get("since") || 0);
    return [200, { total: calls.length, calls: calls.slice(since) }];
  }
  if (req.method === "GET" && url.pathname === "/__mock/chat") {
    const c = chat(url.searchParams.get("chat_id"));
    return [200, { messages: [...c.messages.values()], pinned: c.pinned, state }];
  }
  if (req.method === "POST" && url.pathname === "/__mock/message") {
    const p = json();
    const user = { id: Number(p.chat_id), is_bot: false, first_name: "Tester", username: "tester", language_code: "en" };
    const replyTo = p.reply_to_message_id ? chat(p.chat_id).messages.get(Number(p.reply_to_message_id)) : undefined;
    const entities = /^\/\w+/.exec(p.text ?? "") ? [{ offset: 0, length: /^\/\S+/.exec(p.text)[0].length, type: "bot_command" }] : undefined;
    const m = addMessage(p.chat_id, { from: user, text: p.text, ...(entities ? { entities } : {}), ...(replyTo ? { reply_to_message: publicMessage(replyTo) } : {}) });
    return [200, { update_id: ++updateId, message: m }];
  }
  if (req.method === "POST" && url.pathname === "/__mock/callback") {
    const p = json();
    const m = botMessage(p.chat_id, p.message_id);
    const exists = m?.reply_markup?.inline_keyboard.some((row) => row.some((b) => b.callback_data === p.data));
    if (!exists) return [400, { ok: false, description: `no button with callback_data "${p.data}" on message ${p.message_id}` }];
    const from = { id: Number(p.chat_id), is_bot: false, first_name: "Tester", username: "tester", language_code: "en" };
    return [200, { update_id: ++updateId, callback_query: { id: String(9000 + queryId++), from, message: publicMessage(m), chat_instance: "-1", data: p.data } }];
  }
  return [404, { ok: false, description: "unknown mock control" }];
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await readBody(req);
  try {
    if (url.pathname.startsWith("/__mock/")) {
      const [status, out] = control(req, url, body);
      return send(res, status, out);
    }
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!match) return send(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    const [, token, method] = match;
    if (!/^\d+:[\w-]+$/.test(token)) return send(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const type = req.headers["content-type"] ?? "";
    let params = {};
    let files = {};
    if (type.startsWith("multipart/form-data")) ({ fields: params, files } = parseMultipart(body, type));
    else if (body.length) params = JSON.parse(body.toString("utf8"));
    const handler = methods[method];
    const out = handler ? handler(params, files) : bad("Not Found: method not found", 404);
    calls.push({ n: calls.length + 1, method, params, ...(Object.keys(files).length ? { files: Object.keys(files) } : {}), ok: out.body.ok, ...(out.body.ok ? {} : { error: out.body.description }) });
    send(res, out.status, out.body);
  } catch (error) {
    send(res, 400, { ok: false, error_code: 400, description: `Bad Request: ${error.message}` });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`telegram mock on http://127.0.0.1:${PORT}`));
