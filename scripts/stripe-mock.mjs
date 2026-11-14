#!/usr/bin/env node
// Local Stripe mock for the Livento wallet (no dependencies). TEST HARNESS ONLY.
//
// Implements just the Stripe REST endpoints Livento calls, with API 2024-06-20 field
// names, plus a fake hosted Checkout page. Point the app at it with
//   STRIPE_SECRET_KEY=sk_test_local_mock
//   STRIPE_API_BASE=http://127.0.0.1:<port>
// Usage: node scripts/stripe-mock.mjs [port]      (default 12111)
//
// Like Stripe it rejects unknown parameters (400 "Received unknown parameter"), and it
// also requires the pinned `Stripe-Version: 2024-06-20` header and a test key.
//
// Stripe endpoints:
//   POST /v1/customers                 GET/POST /v1/customers/:id      GET /v1/customers/search
//   POST /v1/checkout/sessions         GET /v1/checkout/sessions/:id
//   GET/POST /v1/payment_intents       POST /v1/payment_intents/:id
//   GET/POST /v1/refunds
// Fake hosted checkout:
//   GET /pay/:sessionId                pays (card 4242, saved when setup_future_usage) and 303s to success_url
//   GET /pay/:sessionId?cancel=1       303s to cancel_url
//   GET /pay/:sessionId?card=decline   pays now, but later off-session charges on that card are declined
// Test controls (JSON, no auth):
//   POST /__mock/due      { customer?, envelope?, date? }   set auto-save nextDate (default: today, UTC)
//   POST /__mock/decline  { customer?, pm?, on? }           decline future off-session charges
//   GET  /__mock/state                                       counts + objects, for debugging
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

const PORT = Number(process.argv[2] || process.env.PORT || 12111);
const API_VERSION = "2024-06-20";
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const db = {
  customers: new Map(),
  sessions: new Map(),
  paymentIntents: new Map(),
  charges: new Map(),
  refunds: new Map(),
  paymentMethods: new Map(),
  idempotency: new Map(),
};
let seq = 0;
const now = () => Math.floor(Date.now() / 1000);
const rid = (prefix, n = 14) => `${prefix}_${randomBytes(n).toString("base64url").replace(/[-_]/g, "x").slice(0, n + 6)}`;
const stamp = (obj) => Object.defineProperty(obj, "_seq", { value: ++seq, enumerable: false });
const newestFirst = (a, b) => b.created - a.created || b._seq - a._seq;

// ---------------------------------------------------------------------------
// Form / query decoding: a[b][c]=v, a[0]=v, a[]=v  ->  nested objects and arrays
// ---------------------------------------------------------------------------
function decodeForm(text) {
  const root = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const parts = [];
    const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(rawKey);
    if (!m) continue;
    parts.push(m[1]);
    for (const p of m[2].matchAll(/\[([^[\]]*)\]/g)) parts.push(p[1]);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i] === "" ? String(Object.keys(node).length) : parts[i];
      if (i === parts.length - 1) node[key] = value;
      else node = node[key] ??= {};
    }
  }
  return arrayify(root);
}
function arrayify(node) {
  if (node === null || typeof node !== "object") return node;
  const keys = Object.keys(node);
  for (const k of keys) node[k] = arrayify(node[k]);
  if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => node[k]);
  return node;
}

// ---------------------------------------------------------------------------
// Responses and errors (Stripe error shape)
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, type, message, extra = {}) {
    super(message);
    this.status = status;
    this.body = { error: { type, message, ...extra } };
  }
}
const badRequest = (message, extra) => new ApiError(400, "invalid_request_error", message, extra);
const missing = (kind, id) =>
  new ApiError(404, "invalid_request_error", `No such ${kind}: '${id}'`, { code: "resource_missing", param: "id" });

function allow(params, allowed, prefix = "") {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw badRequest(`Received unknown parameter: ${prefix}${key}`, { param: `${prefix}${key}` });
  }
}
function int(v, name, min = 0) {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(String(v)) || Number(v) < min) throw badRequest(`Invalid integer: ${v}`, { param: name });
  return Number(v);
}
function bool(v, name) {
  if (v === undefined) return undefined;
  if (v !== "true" && v !== "false") throw badRequest(`Invalid boolean: ${v}`, { param: name });
  return v === "true";
}
function metadataOf(v, name = "metadata") {
  if (v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw badRequest("Invalid object", { param: name });
  for (const [k, val] of Object.entries(v)) {
    if (k.length > 40) throw badRequest(`Metadata keys can be at most 40 characters: ${k}`, { param: `${name}[${k}]` });
    if (String(val).length > 500) throw badRequest("Metadata values can be at most 500 characters", { param: `${name}[${k}]` });
  }
  return v;
}
function mergeMetadata(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === "") delete target[k];
    else target[k] = String(v);
  }
  if (Object.keys(target).length > 50) throw badRequest("Metadata can have at most 50 keys", { param: "metadata" });
}
function list(items, url, params) {
  const limit = Math.min(100, Math.max(1, int(params.limit, "limit", 1) ?? 10));
  let start = 0;
  if (params.starting_after) {
    const i = items.findIndex((x) => x.id === params.starting_after);
    if (i < 0) throw badRequest(`Invalid starting_after id: ${params.starting_after}`, { param: "starting_after" });
    start = i + 1;
  }
  const data = items.slice(start, start + limit);
  return { object: "list", data, has_more: start + limit < items.length, url };
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------
function chargeView(ch) {
  return { ...ch, refunded: ch.amount_refunded >= ch.amount };
}
function piView(pi, expand = []) {
  const out = { ...pi };
  if (expand.includes("latest_charge") && pi.latest_charge) out.latest_charge = chargeView(db.charges.get(pi.latest_charge));
  return out;
}
function sessionView(s, expand = []) {
  const out = { ...s };
  if (expand.includes("payment_intent") && s.payment_intent) out.payment_intent = piView(db.paymentIntents.get(s.payment_intent));
  return out;
}

function createPaymentIntent({ amount, customer, pm, metadata, description, setupFutureUsage, status = "succeeded", offSession = false }) {
  const created = now();
  const pi = stamp({
    id: rid("pi", 18),
    object: "payment_intent",
    amount,
    amount_capturable: 0,
    amount_received: status === "succeeded" ? amount : 0,
    capture_method: "automatic_async",
    confirmation_method: "automatic",
    created,
    currency: "usd",
    customer,
    description: description ?? null,
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata: { ...metadata },
    payment_method: pm,
    payment_method_types: ["card"],
    setup_future_usage: setupFutureUsage ?? null,
    status,
    off_session: offSession || undefined,
  });
  if (status === "succeeded") {
    const ch = stamp({
      id: rid("ch", 18),
      object: "charge",
      amount,
      amount_captured: amount,
      amount_refunded: 0,
      captured: true,
      created,
      currency: "usd",
      customer,
      paid: true,
      payment_intent: pi.id,
      payment_method: pm,
      status: "succeeded",
    });
    db.charges.set(ch.id, ch);
    pi.latest_charge = ch.id;
  }
  db.paymentIntents.set(pi.id, pi);
  return pi;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  ["POST", /^\/v1\/customers$/, (p) => {
    allow(p, ["description", "metadata", "email", "name"]);
    const c = stamp({
      id: rid("cus", 14),
      object: "customer",
      created: now(),
      description: p.description ?? null,
      email: p.email ?? null,
      livemode: false,
      metadata: {},
      name: p.name ?? null,
    });
    mergeMetadata(c.metadata, metadataOf(p.metadata));
    db.customers.set(c.id, c);
    return c;
  }],
  ["GET", /^\/v1\/customers\/search$/, (p) => {
    allow(p, ["query", "limit", "page", "expand"]);
    const m = /^metadata\['([^']+)'\]:'([^']*)'$/.exec(String(p.query ?? "").trim());
    if (!m) throw badRequest("This mock supports only queries like metadata['key']:'value'", { param: "query" });
    const matches = [...db.customers.values()].filter((c) => !c.deleted && c.metadata[m[1]] === m[2]).sort(newestFirst);
    const limit = Math.min(100, Math.max(1, int(p.limit, "limit", 1) ?? 10));
    const offset = p.page ? Number(Buffer.from(String(p.page), "base64url").toString()) || 0 : 0;
    const data = matches.slice(offset, offset + limit);
    const more = offset + limit < matches.length;
    return {
      object: "search_result",
      data,
      has_more: more,
      next_page: more ? Buffer.from(String(offset + limit)).toString("base64url") : null,
      url: "/v1/customers/search",
    };
  }],
  ["GET", /^\/v1\/customers\/(cus_\w+)$/, (p, [id]) => {
    allow(p, ["expand"]);
    const c = db.customers.get(id);
    if (!c) throw missing("customer", id);
    return c.deleted ? { id: c.id, object: "customer", deleted: true } : c;
  }],
  ["POST", /^\/v1\/customers\/(cus_\w+)$/, (p, [id]) => {
    allow(p, ["metadata", "description"]);
    const c = db.customers.get(id);
    if (!c || c.deleted) throw missing("customer", id);
    mergeMetadata(c.metadata, metadataOf(p.metadata));
    if (p.description !== undefined) c.description = p.description;
    return c;
  }],
  ["POST", /^\/v1\/checkout\/sessions$/, (p) => {
    allow(p, ["mode", "customer", "payment_method_types", "line_items", "payment_intent_data", "metadata", "success_url", "cancel_url"]);
    if (p.mode !== "payment") throw badRequest("This mock supports mode=payment only", { param: "mode" });
    if (!db.customers.has(p.customer) || db.customers.get(p.customer).deleted) throw missing("customer", p.customer);
    if (!Array.isArray(p.payment_method_types) || p.payment_method_types.join() !== "card") {
      throw badRequest("Expected payment_method_types[0]=card", { param: "payment_method_types" });
    }
    if (!Array.isArray(p.line_items) || p.line_items.length !== 1) throw badRequest("Expected one line item", { param: "line_items" });
    const li = p.line_items[0];
    allow(li, ["quantity", "price_data"], "line_items[0][");
    allow(li.price_data ?? {}, ["currency", "unit_amount", "product_data"], "line_items[0][price_data][");
    allow(li.price_data?.product_data ?? {}, ["name", "description"], "line_items[0][price_data][product_data][");
    if (li.price_data?.currency !== "usd") throw badRequest("currency must be usd here", { param: "line_items[0][price_data][currency]" });
    const unit = int(li.price_data?.unit_amount, "line_items[0][price_data][unit_amount]", 50);
    const qty = int(li.quantity, "line_items[0][quantity]", 1);
    if (!li.price_data?.product_data?.name) throw badRequest("Missing required param: product_data[name]", { param: "line_items[0][price_data][product_data][name]" });
    const pid = p.payment_intent_data ?? {};
    allow(pid, ["description", "metadata", "setup_future_usage"], "payment_intent_data[");
    if (pid.setup_future_usage !== undefined && !["off_session", "on_session"].includes(pid.setup_future_usage)) {
      throw badRequest("Invalid setup_future_usage", { param: "payment_intent_data[setup_future_usage]" });
    }
    for (const u of ["success_url", "cancel_url"]) {
      if (!/^https?:\/\//.test(p[u] ?? "")) throw badRequest(`Not a valid URL: ${u}`, { param: u });
    }
    const id = `cs_test_${randomBytes(24).toString("base64url").replace(/[-_]/g, "x")}`;
    const s = stamp({
      id,
      object: "checkout.session",
      amount_subtotal: unit * qty,
      amount_total: unit * qty,
      cancel_url: p.cancel_url,
      created: now(),
      currency: "usd",
      customer: p.customer,
      expires_at: now() + 24 * 3600,
      livemode: false,
      metadata: { ...metadataOf(p.metadata) },
      mode: "payment",
      payment_intent: null,
      payment_method_types: ["card"],
      payment_status: "unpaid",
      status: "open",
      success_url: p.success_url,
      url: `${ORIGIN}/pay/${id}`,
    });
    Object.defineProperty(s, "_pi", { value: { ...pid, metadata: metadataOf(pid.metadata, "payment_intent_data[metadata]") }, enumerable: false });
    Object.defineProperty(s, "_product", { value: li.price_data.product_data, enumerable: false });
    db.sessions.set(id, s);
    return s;
  }],
  ["GET", /^\/v1\/checkout\/sessions\/(cs_\w+)$/, (p, [id]) => {
    allow(p, ["expand"]);
    const s = db.sessions.get(id);
    if (!s) throw missing("checkout.session", id);
    return sessionView(s, p.expand ?? []);
  }],
  ["GET", /^\/v1\/payment_intents$/, (p) => {
    allow(p, ["customer", "limit", "starting_after", "expand"]);
    const items = [...db.paymentIntents.values()].filter((pi) => !p.customer || pi.customer === p.customer).sort(newestFirst);
    const out = list(items, "/v1/payment_intents", p);
    const expand = (p.expand ?? []).filter((e) => e.startsWith("data.")).map((e) => e.slice(5));
    out.data = out.data.map((pi) => piView(pi, expand));
    return out;
  }],
  ["POST", /^\/v1\/payment_intents$/, (p) => {
    allow(p, ["amount", "currency", "customer", "payment_method", "payment_method_types", "off_session", "confirm", "description", "metadata"]);
    if (!Array.isArray(p.payment_method_types) || p.payment_method_types.join() !== "card") {
      // Real Stripe (2023-08-16+) would default to automatic payment methods and then need a return_url.
      throw badRequest("You must provide a return_url (or payment_method_types[0]=card) when confirming server-side.", { param: "return_url" });
    }
    const amount = int(p.amount, "amount", 50);
    if (p.currency !== "usd") throw badRequest("currency must be usd here", { param: "currency" });
    if (bool(p.confirm, "confirm") !== true || bool(p.off_session, "off_session") !== true) {
      throw badRequest("This mock supports confirm=true&off_session=true only");
    }
    const customer = db.customers.get(p.customer);
    if (!customer || customer.deleted) throw missing("customer", p.customer);
    const pm = db.paymentMethods.get(p.payment_method);
    if (!pm) throw missing("payment_method", p.payment_method);
    if (pm.customer !== customer.id) {
      throw badRequest("The PaymentMethod is not attached to this Customer (save it with setup_future_usage first).", { param: "payment_method" });
    }
    const metadata = metadataOf(p.metadata);
    if (pm._decline) {
      const pi = createPaymentIntent({ amount, customer: customer.id, pm: pm.id, metadata, description: p.description, status: "requires_payment_method", offSession: true });
      pi.last_payment_error = { code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." };
      throw new ApiError(402, "card_error", "Your card was declined.", {
        code: "card_declined",
        decline_code: "generic_decline",
        payment_intent: piView(pi),
      });
    }
    return piView(createPaymentIntent({ amount, customer: customer.id, pm: pm.id, metadata, description: p.description, offSession: true }));
  }],
  ["POST", /^\/v1\/payment_intents\/(pi_\w+)$/, (p, [id]) => {
    allow(p, ["metadata", "description"]);
    const pi = db.paymentIntents.get(id);
    if (!pi) throw missing("payment_intent", id);
    mergeMetadata(pi.metadata, metadataOf(p.metadata));
    if (p.description !== undefined) pi.description = p.description;
    return piView(pi);
  }],
  ["GET", /^\/v1\/refunds$/, (p) => {
    allow(p, ["payment_intent", "charge", "limit", "starting_after"]);
    const items = [...db.refunds.values()]
      .filter((r) => (!p.payment_intent || r.payment_intent === p.payment_intent) && (!p.charge || r.charge === p.charge))
      .sort(newestFirst);
    return list(items, "/v1/refunds", p);
  }],
  ["POST", /^\/v1\/refunds$/, (p) => {
    allow(p, ["payment_intent", "amount", "reason", "metadata"]);
    const pi = db.paymentIntents.get(p.payment_intent);
    if (!pi) throw missing("payment_intent", p.payment_intent);
    if (pi.status !== "succeeded" || !pi.latest_charge) throw badRequest("This PaymentIntent has no successful charge to refund.");
    if (p.reason !== undefined && !["duplicate", "fraudulent", "requested_by_customer"].includes(p.reason)) {
      throw badRequest("Invalid reason", { param: "reason" });
    }
    const ch = db.charges.get(pi.latest_charge);
    const left = ch.amount - ch.amount_refunded;
    const amount = int(p.amount, "amount", 1) ?? left;
    if (amount > left) {
      throw badRequest(`Refund amount ($${(amount / 100).toFixed(2)}) is greater than unrefunded amount on charge ($${(left / 100).toFixed(2)})`, {
        code: "amount_too_large",
        param: "amount",
      });
    }
    ch.amount_refunded += amount;
    const r = stamp({
      id: rid("re", 18),
      object: "refund",
      amount,
      charge: ch.id,
      created: now(),
      currency: "usd",
      metadata: { ...metadataOf(p.metadata) },
      payment_intent: pi.id,
      reason: p.reason ?? null,
      status: "succeeded",
    });
    db.refunds.set(r.id, r);
    return r;
  }],
];

// ---------------------------------------------------------------------------
// Fake hosted checkout + test controls
// ---------------------------------------------------------------------------
function payPage(id, query, res) {
  const s = db.sessions.get(id);
  if (!s) return send(res, 404, { error: "unknown session" });
  if (query.get("cancel")) return redirect(res, s.cancel_url);
  if (s.status === "open") {
    const pm = stamp({
      id: rid("pm", 18),
      object: "payment_method",
      type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2034 },
      customer: null,
      created: now(),
    });
    if (query.get("card") === "decline") Object.defineProperty(pm, "_decline", { value: true, writable: true });
    if (s._pi.setup_future_usage) pm.customer = s.customer; // saved for later off-session use
    db.paymentMethods.set(pm.id, pm);
    const pi = createPaymentIntent({
      amount: s.amount_total,
      customer: s.customer,
      pm: pm.id,
      metadata: s._pi.metadata ?? {},
      description: s._pi.description,
      setupFutureUsage: s._pi.setup_future_usage,
    });
    s.payment_intent = pi.id;
    s.payment_status = "paid";
    s.status = "complete";
  }
  return redirect(res, s.success_url.replace("{CHECKOUT_SESSION_ID}", s.id));
}

function control(path, body) {
  if (path === "/__mock/due") {
    const date = body.date || new Date().toISOString().slice(0, 10);
    const changed = [];
    for (const c of db.customers.values()) {
      if (body.customer && c.id !== body.customer) continue;
      for (const [k, v] of Object.entries(c.metadata)) {
        if (!k.startsWith("as_") || (body.envelope && k !== `as_${body.envelope}`)) continue;
        const parts = v.split("|");
        parts[1] = date;
        c.metadata[k] = parts.join("|");
        changed.push({ customer: c.id, key: k, value: c.metadata[k] });
      }
    }
    return { changed };
  }
  if (path === "/__mock/decline") {
    const on = body.on !== false;
    const changed = [];
    for (const pm of db.paymentMethods.values()) {
      if ((body.pm && pm.id !== body.pm) || (body.customer && pm.customer !== body.customer)) continue;
      Object.defineProperty(pm, "_decline", { value: on, writable: true });
      changed.push(pm.id);
    }
    return { changed, on };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}
const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;
  const raw = req.method === "POST" ? await readBody(req) : "";
  let status = 200;
  try {
    if (req.method === "GET" && path.startsWith("/pay/")) {
      status = 303;
      return payPage(decodeURIComponent(path.slice(5)), url.searchParams, res);
    }
    if (path === "/__mock/state") {
      return send(res, 200, {
        counts: Object.fromEntries(Object.entries(db).map(([k, m]) => [k, m.size])),
        customers: [...db.customers.values()],
        paymentIntents: [...db.paymentIntents.values()].map((pi) => piView(pi, ["latest_charge"])),
        refunds: [...db.refunds.values()],
      });
    }
    if (path.startsWith("/__mock/")) {
      const out = control(path, raw ? JSON.parse(raw) : {});
      return out ? send(res, 200, out) : send(res, 404, { error: "unknown control" });
    }

    const auth = req.headers.authorization ?? "";
    if (!/^Bearer (sk|rk)_test_\S+$/.test(auth)) {
      throw new ApiError(401, "invalid_request_error", "Invalid API Key provided (this mock accepts test keys only).");
    }
    if (req.headers["stripe-version"] !== API_VERSION) {
      throw badRequest(`This mock expects Stripe-Version: ${API_VERSION} (got ${req.headers["stripe-version"] ?? "none"}).`);
    }
    if (req.method === "POST" && !/^application\/x-www-form-urlencoded/.test(req.headers["content-type"] ?? "")) {
      throw badRequest("Expected a form-encoded body (application/x-www-form-urlencoded).");
    }
    const params = req.method === "POST" ? decodeForm(raw) : decodeForm(url.search.slice(1));

    const key = req.method === "POST" ? req.headers["idempotency-key"] : undefined;
    const fingerprint = createHash("sha256").update(`${req.method} ${path} ${raw}`).digest("hex");
    if (key) {
      const prior = db.idempotency.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new ApiError(400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
        }
        status = prior.status;
        return send(res, prior.status, prior.body, { "Idempotent-Replayed": "true" });
      }
    }

    for (const [method, pattern, handler] of routes) {
      if (method !== req.method) continue;
      const m = pattern.exec(path);
      if (!m) continue;
      let body;
      try {
        body = handler(params, m.slice(1));
      } catch (err) {
        if (key && err instanceof ApiError) db.idempotency.set(key, { fingerprint, status: err.status, body: err.body });
        throw err;
      }
      if (key) db.idempotency.set(key, { fingerprint, status: 200, body });
      return send(res, 200, body);
    }
    throw new ApiError(404, "invalid_request_error", `Unrecognized request URL (${req.method}: ${path}).`);
  } catch (err) {
    if (err instanceof ApiError) {
      status = err.status;
      return send(res, err.status, err.body);
    }
    status = 500;
    console.error(err);
    return send(res, 500, { error: { type: "api_error", message: "Mock crashed" } });
  } finally {
    if (!path.startsWith("/__mock/state")) console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${path} -> ${status || res.statusCode}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Stripe mock (API ${API_VERSION}) on ${ORIGIN}`);
});
