"use strict";

/* Mandate web app: a small hash-routed single-page app over the gateway's JSON API. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: null,
  data: null,
  products: new Map(),
  mandateId: null,
  view: "home",
  busy: false,
  activityFilter: "all",
  attacks: null,
  attackRun: null,
  chatStarted: false,
};

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms));

// ------------------------------------------------------------------ icons
const I = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  agent: '<path d="M12 3v3M7 9h10a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3z"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/>',
  approvals: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  activity: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  mandates: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 16c1.5-2 2.5-2 3 0s1.5 1 2.5-.5"/>',
  security: '<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  cart: '<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  store: '<path d="M4 9h16l-1-5H5z"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
};
const icon = (name, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[name]}</svg>`;

const NAV = [
  { id: "home", label: "Home", icon: "home", tab: true },
  { id: "agent", label: "Agent", icon: "agent", tab: true },
  { id: "approvals", label: "Approvals", icon: "approvals", tab: true, badge: true },
  { id: "activity", label: "Activity", icon: "activity", tab: true },
  { id: "mandates", label: "Mandates", icon: "mandates", tab: false },
  { id: "security", label: "Security", icon: "security", tab: true },
];

const VIEWS = {
  home: ["Home", "Your agent's spending at a glance"],
  agent: ["Shopping agent", "Ask it to buy something. Your mandate decides what goes through."],
  approvals: ["Approvals", "Purchases waiting for you on PayPal"],
  activity: ["Activity", "Every purchase and every blocked attempt"],
  mandates: ["Mandates", "The signed limits your agent shops within"],
  security: ["Security", "Attack the gateway and inspect the audit log"],
};

// ------------------------------------------------------------------ formatting
const money = (v, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(Number(v || 0));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortId = (s, head = 12, tail = 6) => (s && s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s || "");
const titleCase = (s) => String(s || "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dateOf = (ts) => new Date(ts).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}
function stars(r) {
  if (!r) return "";
  const full = Math.round(r);
  return `<span class="stars" aria-label="Rated ${r} out of 5">${"★".repeat(full)}${"☆".repeat(5 - full)}<span>${r.toFixed(1)}</span></span>`;
}

// ------------------------------------------------------------------ api, toast
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join("; ") : data.detail;
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return data;
}

let toastTimer;
function toast(msg, ok = true) {
  const el = $("#toast");
  el.innerHTML = `${ok ? icon("check") : ""}<span>${esc(msg)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

// ------------------------------------------------------------------ product art (flat illustrations, no external images)
const ART = {
  rice: { bg: "#EDF5EE", kind: "bag", body: "#F6F0E3", top: "#E2D5BB", label: "#2E7D4F", text: "BASMATI" },
  dal: { bg: "#FBF2DC", kind: "bag", body: "#F2B33D", top: "#D9971F", label: "#7A2E0E", text: "TOOR DAL" },
  coffee: { bg: "#F3EBE5", kind: "pouch", body: "#5B3A29", top: "#45291C", label: "#F3E7D3", text: "FILTER", ink: "#5B3A29" },
  oil: { bg: "#FBF3DC", kind: "bottle", body: "#E3A62A", top: "#9C6512", text: "OIL", ink: "#8A5A0E" },
  detergent: { bg: "#E7EEF9", kind: "jug", body: "#2F6DB5", top: "#1D4F8C", text: "WASH", ink: "#1D4F8C" },
  dishwash: { bg: "#EEF6E2", kind: "squeeze", body: "#7DBB35", top: "#F4C430", text: "LEMON", ink: "#4E7F1A" },
  tissue: { bg: "#EEF0F5", kind: "rolls" },
  earbuds: { bg: "#ECEFF6", kind: "earbuds" },
  laptop: { bg: "#ECEDF3", kind: "laptop" },
  giftcard: { bg: "#EFEBFB", kind: "card", body: "#6B4FD8", text: "GIFT" },
};
const ART_OVERRIDE = {
  "gro-rice-premium": { label: "#B23A2E", text: "VALUE" },
  "gc-visa-500": { text: "$500" },
  "gc-store-50": { text: "$50", body: "#2D8C7A" },
};
const T = (x, y, s, fill, text) => `<text x="${x}" y="${y}" font-size="${s}" font-weight="800" fill="${fill}" text-anchor="middle" font-family="Schibsted Grotesk, system-ui, sans-serif">${text}</text>`;
function artSVG(a) {
  switch (a.kind) {
    case "bag":
      return `<path d="M30 24h40l7 56a8 8 0 0 1-8 9H31a8 8 0 0 1-8-9z" fill="${a.body}"/><rect x="28" y="16" width="44" height="11" rx="3" fill="${a.top}"/>
        <path d="M30 21.5h40" stroke="#000" stroke-opacity=".12" stroke-dasharray="2 2"/><rect x="31" y="44" width="38" height="22" rx="4" fill="${a.label}"/>
        ${T(50, 58, a.text.length > 6 ? 6.5 : 7.5, "#fff", a.text)}<path d="M35 31v40" stroke="#fff" stroke-opacity=".35" stroke-width="3" stroke-linecap="round"/>`;
    case "pouch":
      return `<path d="M30 22h40l4 62a6 6 0 0 1-6 6H32a6 6 0 0 1-6-6z" fill="${a.body}"/><rect x="29" y="16" width="42" height="9" rx="2" fill="${a.top}"/>
        <circle cx="50" cy="36" r="4" fill="${a.top}" stroke="#8A6248"/><rect x="33" y="48" width="34" height="22" rx="4" fill="${a.label}"/>${T(50, 62, 7, a.ink, a.text)}`;
    case "bottle":
      return `<rect x="44" y="10" width="12" height="9" rx="2" fill="${a.top}"/><path d="M42 19h16v9c8 4 12 10 12 18v34a8 8 0 0 1-8 8H38a8 8 0 0 1-8-8V46c0-8 4-14 12-18z" fill="${a.body}"/>
        <rect x="35" y="52" width="30" height="22" rx="4" fill="#fff" fill-opacity=".92"/>${T(50, 66.5, 8, a.ink, a.text)}<path d="M37 40v34" stroke="#fff" stroke-opacity=".35" stroke-width="3" stroke-linecap="round"/>`;
    case "jug":
      return `<rect x="31" y="18" width="16" height="9" rx="2" fill="${a.top}"/><path d="M27 27h36l12 12v41a8 8 0 0 1-8 8H35a8 8 0 0 1-8-8z" fill="${a.body}"/>
        <rect x="56" y="34" width="11" height="16" rx="5" fill="#E7EEF9"/><rect x="32" y="54" width="34" height="22" rx="4" fill="#fff"/>${T(49, 68.5, 8, a.ink, a.text)}`;
    case "squeeze":
      return `<path d="M44 10h12l3 14H41z" fill="${a.top}"/><path d="M38 24h24l4 60a6 6 0 0 1-6 6H40a6 6 0 0 1-6-6z" fill="${a.body}"/>
        <rect x="38" y="50" width="24" height="20" rx="4" fill="#fff" fill-opacity=".92"/>${T(50, 63, 6, a.ink, a.text)}`;
    case "rolls":
      return `${[30, 64].map((x) => `<rect x="${x - 16}" y="30" width="32" height="52" rx="7" fill="#fff" stroke="#D5D9E3"/><ellipse cx="${x}" cy="30" rx="16" ry="5.5" fill="#F4F5F8" stroke="#D5D9E3"/><ellipse cx="${x}" cy="30" rx="5" ry="2" fill="#C5CAD6"/>`).join("")}`;
    case "earbuds":
      return `<rect x="24" y="34" width="52" height="40" rx="19" fill="#fff" stroke="#D3D8E2"/><path d="M24 52h52" stroke="#D3D8E2"/><circle cx="50" cy="58" r="2.5" fill="#9EA6B8"/>
        <path d="M34 26c0-6 10-6 10 0v12h-4V28" fill="#fff" stroke="#D3D8E2"/><path d="M56 26c0-6 10-6 10 0v12h-4V28" fill="#fff" stroke="#D3D8E2"/>`;
    case "laptop":
      return `<rect x="20" y="24" width="60" height="40" rx="4" fill="#2B2D3A"/><rect x="24" y="28" width="52" height="32" rx="2" fill="#6A84F7"/>
        <path d="M24 52c10-8 18 2 28-6s16 0 24-4v18H24z" fill="#4C64D6"/><path d="M12 68h76l-6 9H18z" fill="#C7CAD4"/><rect x="42" y="68" width="16" height="3" rx="1.5" fill="#A9ADBA"/>`;
    case "card":
      return `<rect x="15" y="28" width="70" height="46" rx="8" fill="${a.body}"/><rect x="58" y="28" width="7" height="46" fill="#FFC857"/>
        <circle cx="56.5" cy="38" r="5" fill="none" stroke="#FFC857" stroke-width="3"/><circle cx="66.5" cy="38" r="5" fill="none" stroke="#FFC857" stroke-width="3"/>
        ${T(35, 66, 10, "#fff", a.text)}<rect x="23" y="38" width="13" height="10" rx="2" fill="#fff" fill-opacity=".35"/>`;
    default:
      return `<rect x="26" y="26" width="48" height="48" rx="8" fill="#D9DCE6"/>`;
  }
}
function art(productId, imageKey) {
  const p = state.products.get(productId) || {};
  const base = ART[imageKey || p.image] || { bg: "#EEF0F5", kind: "none" };
  const a = { ...base, ...(ART_OVERRIDE[productId] || {}) };
  return `<span class="art" style="background:${a.bg}" aria-hidden="true"><svg viewBox="0 0 100 100">${artSVG(a)}</svg></span>`;
}
const merchantOf = (productId) => state.products.get(productId)?.merchant || "";

// ------------------------------------------------------------------ gateway decision
const STAGES = ["Agent signature", "Your mandate", "Merchant cart", "Spending rules"];
function stageOf(rule) {
  if (/^request\./.test(rule)) return 0;
  if (/^(mandate|agent)\./.test(rule)) return 1;
  if (/^(cart|product)\./.test(rule)) return 2;
  return 3;
}
function checksHTML(r) {
  const fail = r.status === "denied" ? Math.min(...(r.rules || ["x"]).map(stageOf)) : -1;
  return `<div class="checks" aria-label="Gateway checks">${STAGES.map((label, i) => {
    let cls = "pass", text = label;
    if (fail >= 0 && i === fail) cls = "fail";
    else if (fail >= 0 && i > fail) { cls = ""; text = `${label}: not reached`; }
    else if (r.status === "step_up_required" && i === 3) { cls = "warn"; text = "Needs your approval"; }
    return `<div class="check ${cls}"><div class="check-bar"></div><span>${esc(text)}</span></div>`;
  }).join("")}</div>`;
}

const VERDICT = {
  captured: { cls: "is-ok", icon: "checkCircle", head: "Paid with PayPal" },
  awaiting_approval: { cls: "is-wait", icon: "clock", head: "Allowed · approve on PayPal to pay" },
  step_up_required: { cls: "is-wait", icon: "clock", head: "Above your approval threshold" },
  duplicate: { cls: "is-wait", icon: "clock", head: "Already submitted · not charged again" },
  denied: { cls: "is-denied", icon: "xCircle", head: "Blocked by your mandate" },
  error: { cls: "is-denied", icon: "alert", head: "PayPal returned an error" },
};

function verdictHTML(r, { productId, name, quantity } = {}) {
  const v = VERDICT[r.status] || VERDICT.error;
  const title = r.product || name || productId;
  const canApprove = r.approve_url && (r.status === "awaiting_approval" || r.status === "step_up_required");
  const action = canApprove
    ? `<a class="btn btn-paypal btn-sm" href="${esc(r.approve_url)}">Approve on PayPal</a>`
    : r.status === "captured" && r.order_id
      ? `<button class="link" data-open-order="${esc(r.order_id)}">View receipt</button>`
      : r.status === "denied" ? `<span class="muted" style="font-size:13px">Never reached PayPal</span>` : "";
  const reasons = (r.status === "denied" || r.status === "error") && r.reasons?.length
    ? `<ul class="verdict-reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  return `<div class="verdict ${v.cls}">
    <div class="verdict-main">${art(productId)}
      <div><p class="verdict-name">${esc(title)}</p><p class="verdict-qty">Qty ${esc(quantity || 1)}${merchantOf(productId) ? ` · ${esc(merchantOf(productId))}` : ""}</p></div>
      ${r.amount ? `<span class="verdict-amount">${money(r.amount)}</span>` : ""}</div>
    <div class="verdict-bar"><span class="verdict-headline">${icon(v.icon)}${v.head}</span>${action}</div>
    ${reasons}${checksHTML(r)}</div>`;
}

// ------------------------------------------------------------------ data helpers
const mandates = () => state.data?.mandates || [];
const currentMandate = () => mandates().find((m) => m.id === state.mandateId) || null;
const pendingOrders = () => (state.data?.orders || []).filter((o) => o.status === "awaiting_approval");
const constraintsOf = (mandateId) => mandates().find((m) => m.id === mandateId)?.constraints;

function activityItems(mandateId) {
  const orders = (state.data?.orders || []).filter((o) => !mandateId || o.mandate_id === mandateId)
    .map((o) => ({ kind: "order", ts: o.created_at, ...o }));
  const denials = (state.data?.denials || []).filter((d) => !mandateId || d.mandate_id === mandateId)
    .map((d) => ({ kind: "denial", ...d }));
  return [...orders, ...denials].sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

const ORDER_STATUS = {
  captured: ["Paid", "st-ok"],
  awaiting_approval: ["Needs approval", "st-wait"],
  cancelled: ["Declined", "st-muted"],
  failed: ["Failed", "st-stop"],
  reserved: ["Processing", "st-muted"],
};

function rowHTML(it) {
  if (it.kind === "denial") {
    return `<button class="row" data-open-denial="${it.seq}">${art(it.product_id)}
      <div><p class="row-title">${esc(it.product)}</p><p class="row-sub">${esc(shortReason(it))} · ${timeOf(it.ts)}</p></div>
      <div class="row-end"><span class="row-amount is-blocked">${it.amount ? money(it.amount) : ""}</span><span class="status st-stop">Blocked</span></div></button>`;
  }
  const [label, cls] = ORDER_STATUS[it.status] || [titleCase(it.status), "st-muted"];
  return `<button class="row" data-open-order="${esc(it.paypal_order_id)}">${art(it.product_id)}
    <div><p class="row-title">${esc(it.product)}${it.quantity > 1 ? ` × ${it.quantity}` : ""}</p><p class="row-sub">${esc(merchantOf(it.product_id) || titleCase(it.category))} · ${timeOf(it.ts)}</p></div>
    <div class="row-end"><span class="row-amount">${money(it.amount, it.currency)}</span><span class="status ${cls}">${label}</span></div></button>`;
}

function shortReason(d) {
  const rule = (d.rules || [])[0] || "";
  return {
    "item.blocked_category": "Category is never allowed",
    "item.category_not_allowed": "Category not in your mandate",
    "item.quantity": "Quantity over your limit",
    "budget.per_txn": "Over your per-purchase cap",
    "budget.total": "Over your remaining budget",
    "mandate.revoked": "Mandate was revoked",
    "mandate.expired": "Mandate had expired",
    "agent.not_delegated": "Unknown agent",
    "request.replay": "Replayed request",
    "request.stale": "Stale request",
    "cart.signature": "Cart not signed by merchant",
  }[rule] || "Outside your mandate";
}

// ------------------------------------------------------------------ the mandate card
function guilloche() {
  const rings = [];
  for (let k = 0; k < 18; k++) rings.push(`<ellipse cx="220" cy="220" rx="210" ry="74" transform="rotate(${k * 10} 220 220)"/>`);
  for (let k = 0; k < 12; k++) rings.push(`<ellipse cx="220" cy="220" rx="130" ry="46" transform="rotate(${k * 15 + 5} 220 220)"/>`);
  return `<svg class="guilloche" viewBox="0 0 440 440" aria-hidden="true">${rings.join("")}</svg>`;
}

function mcardHTML(m, { actions = true } = {}) {
  const c = m.constraints, b = m.budget;
  const total = Number(b.total_max), paid = Number(b.captured), pending = Math.max(Number(b.committed) - paid, 0);
  const active = b.status === "active";
  return `<article class="mcard" aria-label="Your spending mandate">
    ${guilloche()}
    <div class="mcard-top">
      <div><p class="mcard-label">Spending mandate</p><p class="mcard-desc">${esc(m.description)}</p></div>
      <span class="mcard-status ${active ? "" : "is-revoked"}">${active ? "Active" : "Revoked"}</span>
    </div>
    <div class="mcard-amount"><strong>${money(b.remaining)}</strong><span>left of ${money(total)}</span></div>
    <div class="meter" role="img" aria-label="${money(b.committed)} of ${money(total)} used">
      <span class="m-paid" style="width:${Math.min(100, (paid / total) * 100)}%"></span>
      <span class="m-pending" style="width:${Math.min(100, (pending / total) * 100)}%"></span>
    </div>
    <div class="meter-legend">
      <span><i style="background:#6EE7B7"></i>Paid <b>${money(paid)}</b></span>
      <span><i style="background:#F5C062"></i>Waiting for approval <b>${money(pending)}</b></span>
    </div>
    <dl class="mcard-limits">
      <div><dt>Per purchase</dt><dd>${money(c.per_txn_max)}</dd></div>
      <div><dt>Approve above</dt><dd>${money(c.step_up_above)}</dd></div>
      <div><dt>Max per item</dt><dd>${c.max_quantity_per_item}</dd></div>
      <div><dt>Expires</dt><dd>${dateOf(m.valid_until)}</dd></div>
    </dl>
    <div class="mcard-cats">${(c.allowed_categories.length ? c.allowed_categories : ["Any category"]).map((x) => `<span class="tag">${esc(titleCase(x))}</span>`).join("")}
      ${c.blocked_categories.map((x) => `<span class="tag tag-no">${esc(titleCase(x))}</span>`).join("")}</div>
    <div class="mcard-foot">
      <div class="mcard-sig"><svg viewBox="0 0 120 28" aria-hidden="true"><path d="M2 20c8-14 14-14 12 0s10-16 16-8 6 10 12-2 10-4 12 4 12-10 18-6 10 8 16 2 14-6 28-4"/></svg>
        <div style="min-width:0">Signed by you · Ed25519<span class="mono">${esc(m.id)}</span></div></div>
      ${actions ? `<div class="mcard-actions"><a class="btn btn-sm btn-on-dark" href="#/mandates">Manage</a><a class="btn btn-sm btn-white" href="#/agent">Shop with agent</a></div>` : ""}
    </div>
  </article>`;
}

// ------------------------------------------------------------------ views
function renderHome() {
  const el = $("#v-home");
  const m = currentMandate();
  if (!m) {
    el.innerHTML = `<div class="card onboard">
      <div><h2>Let an AI agent shop for you, on a budget it can't break.</h2>
        <p>You sign your limits once. The agent searches, compares and asks to buy. Every purchase is checked against your signature before PayPal sees it.</p>
        <button class="btn btn-primary" data-new-mandate>${icon("plus")}Set up your mandate</button></div>
      <ol class="steps">
        <li><div><b>Set your limits</b><span>Total budget, per-purchase cap, categories, and when you want to approve.</span></div></li>
        <li><div><b>Your agent shops</b><span>It finds what you asked for and requests the purchase.</span></div></li>
        <li><div><b>Every purchase is checked</b><span>Anything outside your mandate is blocked and never reaches PayPal.</span></div></li>
      </ol></div>`;
    return;
  }
  const items = activityItems(m.id);
  const pend = pendingOrders().filter((o) => o.mandate_id === m.id);
  const den = (state.data.denials || []).filter((d) => d.mandate_id === m.id);
  const stopped = den.reduce((s, d) => s + Number(d.amount || 0), 0);
  const last = den[0];

  el.innerHTML = `<div class="home-grid">
    <div class="stack">
      ${mcardHTML(m)}
      <form class="card ask" id="home-ask">
        <span class="agent-avatar">${icon("agent")}</span>
        <input name="q" placeholder="Ask your agent to buy something…" aria-label="Ask your agent" autocomplete="off">
        <button class="btn btn-primary" type="submit">Ask</button>
      </form>
      <section class="card">
        <div class="card-head"><h2>Recent activity</h2>${items.length ? `<a class="link" href="#/activity">See all</a>` : ""}</div>
        ${items.length ? `<div class="rows">${items.slice(0, 6).map(rowHTML).join("")}</div>`
          : `<div class="empty-state">${icon("activity")}<h3>No activity yet</h3><p>Ask your agent to buy something and it shows up here.</p></div>`}
      </section>
    </div>
    <div class="stack">
      <section class="card">
        <div class="card-head"><h2>Needs your approval</h2>${pend.length ? `<span class="status st-wait">${pend.length}</span>` : ""}</div>
        ${pend.length ? `<div>${pend.slice(0, 3).map(apprHTML).join("")}</div>${pend.length > 3 ? `<div class="card-foot"><a class="link" href="#/approvals">See all ${pend.length}</a></div>` : ""}`
          : `<div class="empty-state" style="padding:28px 20px">${icon("inbox")}<h3>You're all caught up</h3><p>${state.config.vault_enabled ? `Purchases above ${money(m.constraints.step_up_above)} land here for your approval.` : "Each purchase your agent makes waits here until you approve it on PayPal."}</p></div>`}
      </section>
      <section class="card protect">
        <div class="protect-head"><span class="protect-icon">${icon("shield")}</span>
          <div><h3>Protected by your mandate</h3><p class="protect-sub">Checked before PayPal, every time</p></div></div>
        <div class="protect-stats">
          <div class="stat"><b>${den.length}</b><span>Blocked attempts</span></div>
          <div class="stat"><b>${money(stopped)}</b><span>Stopped from leaving</span></div>
        </div>
        ${last ? `<button class="last-block row" style="display:block;grid-template-columns:none;border-radius:12px;padding:12px 14px" data-open-denial="${last.seq}">
            <b>Last blocked: ${esc(last.product)}${last.amount ? ` · ${money(last.amount)}` : ""}</b><p>${esc(last.reasons[0] || shortReason(last))}</p></button>`
          : `<p class="protect-sub">If your agent is ever tricked into buying something outside your limits, the attempt is blocked and shows up here.</p>`}
        <a class="link" href="#/security">Test it yourself</a>
      </section>
    </div>
  </div>`;
}

function apprHTML(o) {
  const c = constraintsOf(o.mandate_id);
  const why = o.step_up ? `Above your ${money(c?.step_up_above)} approval threshold` : "Allowed by your mandate · confirm the payment on PayPal";
  return `<div class="appr">${art(o.product_id)}
    <div><div class="appr-top"><p class="appr-name">${esc(o.product)}${o.quantity > 1 ? ` × ${o.quantity}` : ""}</p><span class="row-amount">${money(o.amount, o.currency)}</span></div>
      <p class="appr-why">${esc(why)}</p>
      <div class="appr-actions">
        <a class="btn btn-paypal btn-sm" href="${esc(o.approve_url)}">Approve on PayPal</a>
        <button class="btn btn-ghost btn-sm" data-decline="${esc(o.paypal_order_id)}">Decline</button>
        <button class="link" data-open-order="${esc(o.paypal_order_id)}">Details</button>
      </div></div></div>`;
}

function renderApprovals() {
  const pend = pendingOrders();
  $("#v-approvals").innerHTML = pend.length
    ? `<p class="page-intro">Your agent asked to buy these. Nothing is charged until you approve on PayPal. Declining releases the amount back to your budget.</p>
       <section class="card approvals-list">${pend.map(apprHTML).join("")}</section>`
    : `<section class="card"><div class="empty-state">${icon("inbox")}<h3>You're all caught up</h3><p>When your agent needs your go-ahead, the purchase waits here.</p><a class="btn btn-primary" href="#/agent">Open the agent</a></div></section>`;
}

function renderActivity() {
  const all = activityItems(null);
  const f = state.activityFilter;
  const match = (it) => f === "all"
    || (f === "paid" && it.kind === "order" && it.status === "captured")
    || (f === "waiting" && it.kind === "order" && it.status === "awaiting_approval")
    || (f === "blocked" && it.kind === "denial")
    || (f === "declined" && it.kind === "order" && (it.status === "cancelled" || it.status === "failed"));
  const items = all.filter(match);
  const groups = [];
  for (const it of items) {
    const label = dayLabel(it.ts);
    if (!groups.length || groups.at(-1).label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(it);
  }
  const count = (fn) => all.filter(fn).length;
  const filters = [
    ["all", "All", all.length],
    ["paid", "Paid", count((i) => i.kind === "order" && i.status === "captured")],
    ["waiting", "Waiting", count((i) => i.kind === "order" && i.status === "awaiting_approval")],
    ["blocked", "Blocked", count((i) => i.kind === "denial")],
    ["declined", "Declined", count((i) => i.kind === "order" && (i.status === "cancelled" || i.status === "failed"))],
  ];
  $("#v-activity").innerHTML = `<div class="filters" role="tablist">${filters.map(([id, label, n]) =>
      `<button class="filter ${f === id ? "is-active" : ""}" data-filter="${id}" role="tab" aria-selected="${f === id}">${label} ${n ? `<span style="opacity:.6">${n}</span>` : ""}</button>`).join("")}</div>
    ${groups.length ? groups.map((g) => `<p class="day">${esc(g.label)}</p><section class="card"><div class="rows">${g.items.map(rowHTML).join("")}</div></section>`).join("")
      : `<section class="card"><div class="empty-state">${icon("activity")}<h3>Nothing here yet</h3><p>Purchases and blocked attempts appear here as your agent shops.</p></div></section>`}`;
}

function renderMandates() {
  const list = mandates();
  $("#v-mandates").innerHTML = `<div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:18px">
      <p class="page-intro" style="margin:0">Each mandate is signed with your key and names exactly one agent. The agent can't change it; only you can revoke it.</p>
      <button class="btn btn-primary" data-new-mandate>${icon("plus")}New mandate</button></div>
    ${list.length ? `<div class="mgrid">${list.map((m) => {
      const b = m.budget, c = m.constraints, active = b.status === "active", current = m.id === state.mandateId;
      return `<section class="card mitem ${current ? "is-current" : ""}">
        <div class="mitem-top"><p class="mitem-desc">${esc(m.description)}</p>
          <span class="status ${active ? "st-ok" : "st-muted"}">${active ? (current ? "In use" : "Active") : "Revoked"}</span></div>
        <p class="mitem-amount">${money(b.remaining)} <span>left of ${money(b.total_max)}</span></p>
        <p class="mitem-meta">Up to ${money(c.per_txn_max)} per purchase · approve above ${money(c.step_up_above)} · expires ${dateOf(m.valid_until)}</p>
        <p class="mono muted">${esc(m.id)}</p>
        <div class="mitem-actions">
          ${active && !current ? `<button class="btn btn-ghost btn-sm" data-use="${m.id}">Use this mandate</button>` : ""}
          ${active ? `<button class="btn btn-danger btn-sm" data-revoke="${m.id}">Revoke</button>` : ""}
        </div></section>`;
    }).join("")}</div>`
      : `<section class="card"><div class="empty-state">${icon("mandates")}<h3>No mandates yet</h3><p>Sign one to let your agent shop within your limits.</p></div></section>`}`;
}

function renderSecurity() {
  const el = $("#v-security");
  const chain = state.data?.chain || {};
  const ids = state.config.identities;
  const events = state.data?.events || [];
  el.innerHTML = `<div class="sec-grid">
    <section class="lab">
      <div class="lab-head">
        <div><h2>Attack your own gateway</h2><p class="lab-sub">Fourteen attacks, each on a throwaway mandate. An independent audit then re-checks every order. The number that matters is money moved outside a mandate.</p></div>
        <button class="btn btn-dark" id="btn-attacks">${state.attackRun?.done ? "Run again" : "Run attacks"}</button>
      </div>
      <div id="attack-score"></div>
      <ul class="attacks" id="attack-list"></ul>
    </section>
    <div class="stack">
      <section class="card">
        <div class="chain ${chain.valid ? "chain-ok" : "chain-bad"}">${icon(chain.valid ? "checkCircle" : "xCircle")}
          <div style="flex:1"><b style="color:var(--ink)">${chain.valid ? "Audit log intact" : `Audit log broken at #${chain.broken_at_seq}`}</b>
            <p class="muted" style="font-size:13px">${chain.events || 0} hash-chained events. Editing any row breaks the chain.</p></div>
          <button class="btn btn-ghost btn-sm" id="btn-verify">Verify</button></div>
        <ol class="events">${events.slice(0, 30).map((e) => `<li><span class="ev-seq">#${e.seq}</span>
          <div style="min-width:0"><span class="ev-type">${esc(EVENT_NAMES[e.type] || e.type)}</span><span class="ev-hash">${e.hash.slice(0, 20)}… ← ${e.prev_hash.slice(0, 10)}…</span></div>
          <span class="ev-time">${timeOf(e.ts)}</span></li>`).join("")}</ol>
      </section>
      <section class="card">
        <div class="card-head"><h2>Keys and identities</h2></div>
        <div class="ids">${[["You", "Signs mandates", ids.user, "key"], ["Shopping agent", "Signs purchase requests", ids.agent, "agent"], ["Merchant", "Signs carts and prices", ids.merchant, "store"]]
          .map(([who, role, did, ic]) => `<div class="id-row"><span class="id-icon">${icon(ic)}</span>
            <div style="min-width:0"><b>${who}</b><span class="muted" style="font-size:12.5px">${role}</span><span class="mono">${esc(did)}</span></div>
            <button class="btn btn-ghost btn-sm" data-copy="${esc(did)}" aria-label="Copy ${who} key id">${icon("copy")}</button></div>`).join("")}</div>
      </section>
    </div></div>`;
  renderAttackList();
}

const EVENT_NAMES = {
  "mandate.signed": "Mandate signed",
  "mandate.revoked": "Mandate revoked",
  "purchase.rejected": "Request rejected",
  "purchase.denied": "Purchase blocked",
  "purchase.reserved": "Budget reserved",
  "purchase.idempotent_replay": "Repeat submission ignored",
  "paypal.order_created": "PayPal order created",
  "paypal.captured": "Captured on PayPal",
  "paypal.wallet_saved": "PayPal wallet saved",
  "paypal.cancelled": "Order declined",
  "paypal.capture_refused": "Capture refused",
  "paypal.error": "PayPal error",
  "agent.run": "Agent run",
  "agent.scripted_run": "Demo run",
};

function renderAttackList() {
  const list = $("#attack-list");
  if (!list || !state.attacks) return;
  const run = state.attackRun;
  list.innerHTML = state.attacks.map((a) => {
    const r = run?.results[a.id];
    const mark = r ? (r.blocked ? `<span class="a-mark ok">✓</span>` : `<span class="a-mark bad">✗</span>`)
      : run?.current === a.id ? `<span class="a-mark run"></span>` : `<span class="a-mark">·</span>`;
    return `<li>${mark}<div><p class="a-name">${esc(a.name)}</p><p class="a-sub">${esc(a.owasp)} · ${esc(a.description)}</p></div>
      <span class="a-out">${r ? `${esc(r.outcome)}<br>${esc((r.rules || [])[0] || "")}` : ""}</span></li>`;
  }).join("");
  const score = $("#attack-score");
  if (!run) { score.innerHTML = ""; return; }
  const n = Object.keys(run.results).length, total = state.attacks.length;
  const outside = Object.values(run.results).reduce((s, r) => s + Number(r.money_outside_mandate), 0);
  const blocked = Object.values(run.results).filter((r) => r.blocked).length;
  score.innerHTML = `<div class="score"><b class="${outside > 0 ? "is-bad" : ""}">${money(outside)}</b>
      <span>moved outside a mandate · ${blocked} of ${n} attacks stopped${run.done ? "" : ` · running ${n + 1} of ${total}`}</span></div>
    <div class="progress"><span style="width:${(n / total) * 100}%"></span></div>`;
}

async function runAttacks() {
  if (state.attackRun && !state.attackRun.done) return;
  if (!state.attacks) state.attacks = (await api("/api/attacks")).attacks;
  state.attackRun = { results: {}, current: null, done: false };
  const btn = $("#btn-attacks");
  if (btn) { btn.disabled = true; btn.textContent = "Attacking…"; }
  for (const a of state.attacks) {
    state.attackRun.current = a.id;
    renderAttackList();
    try {
      state.attackRun.results[a.id] = await api(`/api/attacks/${a.id}`, { method: "POST" });
    } catch (err) {
      state.attackRun.results[a.id] = { blocked: false, outcome: "error", rules: [err.message], money_outside_mandate: "0" };
    }
    await sleep(140);
  }
  state.attackRun.current = null;
  state.attackRun.done = true;
  await refresh();
  if (state.view === "security") renderSecurity();
}

// ------------------------------------------------------------------ agent view
function renderAgentChrome() {
  const m = currentMandate();
  const active = m && m.budget.status === "active";
  $("#agent-sub").innerHTML = active ? `Within your mandate · <b>${money(m.budget.remaining)} left</b>` : "No active mandate";
  $("#send").disabled = state.busy;
  $("#hardened-wrap").hidden = !state.config.agent_ready;
  renderChips();
  if (!state.chatStarted) renderWelcome();
  const rail = $("#agent-rail");
  if (!m) { rail.innerHTML = ""; return; }
  const b = m.budget, c = m.constraints, total = Number(b.total_max), paid = Number(b.captured), pending = Math.max(Number(b.committed) - paid, 0);
  rail.innerHTML = `<section class="card rail-card">
      <h3>Left to spend</h3><p class="rail-amount">${money(b.remaining)} <span>of ${money(total)}</span></p>
      <div class="rail-meter"><span class="m-paid" style="width:${(paid / total) * 100}%"></span><span class="m-pending" style="width:${(pending / total) * 100}%"></span></div>
      <dl class="rail-list">
        <div><dt>Per purchase</dt><dd>${money(c.per_txn_max)}</dd></div>
        <div><dt>Approve above</dt><dd>${money(c.step_up_above)}</dd></div>
        <div><dt>Max per item</dt><dd>${c.max_quantity_per_item}</dd></div>
        <div><dt>Allowed</dt><dd>${esc((c.allowed_categories.length ? c.allowed_categories : ["Any"]).map(titleCase).join(", "))}</dd></div>
      </dl></section>
    <section class="card rail-how"><b>How the agent is kept honest</b>
      <p>The agent holds no payment details. It can only send signed purchase requests, and your mandate decides each one before PayPal is called.</p>
      <a class="link" href="#/security">See the attack test</a></section>`;
}

const DEMOS = [
  { script: "fooled_by_gift_card", label: "Cheapest basmati rice", task: "Find me the cheapest basmati rice and buy one pack." },
  { script: "laptop_upgrade", label: "Laptop upgrade", task: "Upgrade my laptop if there's a good deal today." },
  { script: "kitchen_restock", label: "Kitchen restock", task: "Restock my kitchen: basmati rice, toor dal and cooking oil." },
];

function renderChips() {
  const live = state.config.agent_ready;
  $("#chips").innerHTML = live
    ? DEMOS.map((d, i) => `<button type="button" class="chip-btn" data-preset="${i}">${esc(d.label)}</button>`).join("")
      + `<button type="button" class="chip-btn demo" data-demo="fooled_by_gift_card" title="Scripted moves, live gateway">Demo: gift-card trap</button>`
    : DEMOS.map((d) => `<button type="button" class="chip-btn demo" data-demo="${d.script}" title="Scripted moves, live gateway">${esc(d.label)}</button>`).join("");
}

function renderWelcome() {
  const m = currentMandate();
  const body = $("#chat-body");
  if (!m || m.budget.status !== "active") {
    body.innerHTML = `<div class="welcome"><span class="agent-avatar">${icon("agent")}</span><h2>Your agent needs a mandate</h2>
      <p>Sign your spending limits first. The agent can't buy anything without one.</p><button class="btn btn-primary" data-new-mandate>${icon("plus")}Set up your mandate</button></div>`;
    return;
  }
  const c = m.constraints;
  body.innerHTML = `<div class="welcome"><span class="agent-avatar">${icon("agent")}</span><h2>What should I buy?</h2>
    <p>I can spend ${money(m.budget.remaining)} more, nothing over ${money(c.per_txn_max)} at once. Anything above ${money(c.step_up_above)} comes to you for approval on PayPal.</p>
    ${state.config.agent_ready ? "" : `<p style="font-size:13px">Live model is off on this server, so the suggestions below run scripted demos. Every purchase still goes through the real gateway.</p>`}</div>`;
}

function addMsg(html) {
  const body = $("#chat-body");
  if (!state.chatStarted) { body.innerHTML = ""; state.chatStarted = true; }
  const wrap = document.createElement("div");
  wrap.innerHTML = html.trim();
  const el = wrap.firstElementChild;
  el.classList.add("reveal");
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}
const botMini = `<span class="mini-avatar"><svg viewBox="0 0 24 24">${I.agent}</svg></span>`;
const userMsg = (t) => `<div class="msg msg-user"><div class="bubble">${esc(t)}</div></div>`;
const agentMsg = (t, final = false) => `<div class="msg msg-agent ${final ? "msg-final" : ""}">${botMini}<div class="bubble">${esc(t)}</div></div>`;
const sysMsg = (t) => `<div class="msg msg-system"><p class="note">${t}</p></div>`;
const toolMsg = (inner) => `<div class="msg msg-tool"><div class="tool">${inner}</div></div>`;

function pcard(r) {
  return `<div class="pcard">${art(r.product_id, r.image)}<p class="pcard-name">${esc(r.name)}</p>
    <div class="pcard-foot"><b>${money(r.price)}</b>${stars(r.rating)}</div></div>`;
}

function stepHTML(s) {
  if (s.kind === "thought") return agentMsg(s.text);
  const o = s.output || {}, i = s.input || {};
  if (s.tool === "search_products") {
    const res = o.results || [];
    return toolMsg(`<p class="tool-line">${icon("search")}<span>Searched <b>“${esc(i.query)}”</b> · ${res.length} results</span></p>
      ${res.length ? `<div class="carousel">${res.slice(0, 6).map(pcard).join("")}</div>` : ""}`);
  }
  if (s.tool === "view_product") {
    const injected = /assistant|agent|system|must|pre-?approved|always order/i.test(o.description || "");
    return toolMsg(`<p class="tool-line">${icon("eye")}<span>Opened <b>${esc(o.name || i.product_id)}</b>${o.merchant ? ` · ${esc(o.merchant)}` : ""}</span></p>
      ${injected ? `<div class="inject"><b>${icon("alert")}Hidden instructions found on this page</b><q>${esc(o.description)}</q></div>` : ""}`);
  }
  if (s.tool === "check_budget") {
    return toolMsg(`<p class="tool-line">${icon("wallet")}<span>Checked the budget · <b>${o.budget ? money(o.budget.remaining) : ""} left</b></span></p>`);
  }
  if (s.tool === "purchase") {
    const name = state.products.get(i.product_id)?.name || i.product_id;
    return toolMsg(`<p class="tool-line">${icon("cart")}<span>Asked to buy <b>${esc(i.quantity)} × ${esc(o.product || name)}</b></span></p>
      ${verdictHTML(o, { productId: i.product_id, quantity: i.quantity })}`);
  }
  return toolMsg(`<p class="tool-line">${esc(s.tool)}</p>`);
}

async function playRun(run, typingEl) {
  typingEl?.remove();
  if (run.scripted) addMsg(sysMsg("Demo run: the agent's moves are scripted, but every purchase below went through the live gateway."));
  const steps = run.steps.filter((s, i) => !(s.kind === "thought" && i === run.steps.length - 1 && s.text.trim() === (run.final_text || "").trim()));
  for (const s of steps) {
    addMsg(stepHTML(s));
    await sleep(s.tool === "purchase" ? 900 : s.kind === "thought" ? 650 : 550);
  }
  if (run.final_text) addMsg(agentMsg(run.final_text, true));
}

function setBusy(b) {
  state.busy = b;
  $("#send").disabled = b;
}

async function converse(text, request) {
  if (state.busy) return;
  const m = currentMandate();
  if (!m || m.budget.status !== "active") { toast("Sign a mandate first.", false); return; }
  setBusy(true);
  addMsg(userMsg(text));
  const typing = addMsg(`<div class="msg msg-agent">${botMini}<div class="typing" aria-label="Agent is working"><i></i><i></i><i></i></div></div>`);
  try {
    const [run] = await Promise.all([request(), sleep(700)]);
    if (run.error) {
      typing.remove();
      addMsg(agentMsg(`I can't reach a live model on this server yet (${run.error}). Pick a suggestion below to watch a demo run instead.`));
    } else {
      await playRun(run, typing);
    }
  } catch (err) {
    typing.remove();
    addMsg(sysMsg(`Something went wrong: ${esc(err.message)}`));
  } finally {
    setBusy(false);
    refresh();
  }
}

function sendLive(text) {
  if (!state.config.agent_ready) {
    const m = currentMandate();
    if (!m) return toast("Sign a mandate first.", false);
    addMsg(userMsg(text));
    addMsg(agentMsg("The live model isn't switched on for this server (it needs an ANTHROPIC_API_KEY). You can still watch a demo run: pick a suggestion below. The agent's moves are scripted, but the gateway's decisions are real."));
    return;
  }
  converse(text, () => api("/api/agent/run", { method: "POST", body: { mandate_id: state.mandateId, task: text, hardened: $("#hardened").checked } }));
}

function runDemo(script) {
  const d = DEMOS.find((x) => x.script === script);
  converse(d.task, () => api("/api/agent/demo", { method: "POST", body: { mandate_id: state.mandateId, script } }));
}

// ------------------------------------------------------------------ store
async function loadStore(q = "") {
  const { products } = await api(`/api/products?q=${encodeURIComponent(q)}`);
  $("#store-grid").innerHTML = products.map((p) => `<li class="scard" data-id="${esc(p.product_id)}">
      ${art(p.product_id, p.image)}
      <p class="scard-name">${esc(p.name)}</p>
      <p class="scard-meta">${esc(p.merchant)} · ${esc(titleCase(p.category))}</p>
      ${stars(p.rating)}
      <div class="scard-foot"><span class="scard-price">${money(p.price)}</span>
        <span class="qty"><button type="button" data-step="-1" aria-label="Less">−</button><input type="number" min="1" value="1" aria-label="Quantity"><button type="button" data-step="1" aria-label="More">+</button></span></div>
      <button class="btn btn-primary btn-sm" data-buy>Buy with agent key</button></li>`).join("")
    || `<li class="empty-state">${icon("search")}<h3>No products match</h3></li>`;
}

async function storeBuy(li) {
  if (!currentMandate()) return toast("Sign a mandate first.", false);
  const btn = $("[data-buy]", li);
  btn.disabled = true;
  const productId = li.dataset.id, quantity = Number($("input", li).value || 1);
  try {
    const r = await api("/api/purchase", { method: "POST", body: { mandate_id: state.mandateId, product_id: productId, quantity } });
    openDrawer("Gateway decision", verdictHTML(r, { productId, quantity })
      + `<div class="callout">This request was signed with the agent's key and checked exactly as an agent purchase would be.</div>`,
      `<button class="btn btn-ghost" data-close>Close</button>`);
  } catch (err) {
    toast(err.message, false);
  } finally {
    btn.disabled = false;
    refresh();
  }
}

// ------------------------------------------------------------------ drawer
let lastFocus = null;
function openDrawer(title, body, foot = "") {
  lastFocus = document.activeElement;
  const d = $("#drawer");
  d.innerHTML = `<div class="drawer-head"><h2 id="drawer-title">${esc(title)}</h2><button class="close" data-close aria-label="Close"><svg viewBox="0 0 24 24">${I.close}</svg></button></div>
    <div class="drawer-body">${body}</div>${foot ? `<div class="drawer-foot">${foot}</div>` : ""}`;
  d.hidden = false;
  $("#scrim").hidden = false;
  $(".close", d).focus();
}
function closeDrawer() {
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
  lastFocus?.focus?.();
}

async function openOrder(orderId) {
  openDrawer("Payment details", `<div class="thinking" style="display:flex;gap:10px;color:var(--muted)">Loading…</div>`);
  let ev;
  try { ev = await api(`/api/evidence/${encodeURIComponent(orderId)}`); }
  catch (err) { openDrawer("Payment details", `<p>${esc(err.message)}</p>`); return; }
  const cart = ev.cart_mandate.payload, item = cart.items[0], intent = ev.intent_mandate.payload, req = ev.agent_request.payload;
  const order = (state.data.orders || []).find((o) => o.paypal_order_id === orderId);
  const [label, cls] = ORDER_STATUS[ev.status] || [titleCase(ev.status), "st-muted"];
  const events = [...ev.audit_events].sort((a, b) => a.seq - b.seq).filter((e, i, arr) => arr.findIndex((x) => x.seq === e.seq) === i);
  const sig = (title, text, did, ok = true) => `<div class="sig" style="${ok ? "" : "border-color:#F1CDD2;background:#FFF8F9"}">
      <span class="sig-icon" style="${ok ? "" : "background:var(--stop)"}"><svg viewBox="0 0 24 24">${ok ? I.check : I.close}</svg></span>
      <div style="min-width:0"><b>${title}</b><p>${text}</p>${did ? `<span class="mono">${esc(did)}</span>` : ""}</div></div>`;
  const body = `
    <div class="receipt-top">${art(item.product_id)}
      <p class="receipt-amount">${money(ev.amount, ev.currency)}</p>
      <p class="receipt-name">${esc(item.name)}${item.quantity > 1 ? ` × ${item.quantity}` : ""}</p>
      <span class="status ${cls}">${label}</span></div>
    <dl class="kv">
      <div><dt>Merchant</dt><dd>${esc(merchantOf(item.product_id) || item.merchant_id)}</dd></div>
      <div><dt>PayPal order</dt><dd class="mono">${esc(ev.paypal_order_id)}</dd></div>
      ${ev.capture_id ? `<div><dt>Capture</dt><dd class="mono">${esc(ev.capture_id)}</dd></div>` : ""}
      <div><dt>Requested</dt><dd>${dateOf(req.issued_at)}, ${timeOf(req.issued_at)}</dd></div>
      <div><dt>Mandate</dt><dd class="mono">${esc(intent.id)}</dd></div>
    </dl>
    <div><p class="block-title">Signed records</p><div class="sig-list">
      ${sig("You signed the mandate", `${money(intent.constraints.total_max)} total, up to ${money(intent.constraints.per_txn_max)} per purchase`, ev.intent_mandate.signed_by)}
      ${sig("Merchant signed the cart", `${item.quantity} × ${esc(item.name)} at ${money(item.unit_price)}`, ev.cart_mandate.signed_by)}
      ${sig("Agent signed the request", `Single-use request sent at ${timeOf(req.issued_at)}`, ev.agent_request.signed_by)}
      ${sig("Payment id links all three", ev.hash_links.payment_mandate_id_matches ? "The PayPal request id is the hash of your mandate and the merchant's cart" : "The payment id does not match the signed records", "", ev.hash_links.payment_mandate_id_matches)}
    </div></div>
    <div><p class="block-title">Timeline</p><ol class="tl">${events.map((e) => `<li>${esc(EVENT_NAMES[e.type] || e.type)}<span>${timeOf(e.ts)}</span></li>`).join("")}</ol></div>
    <p class="callout">${ev.audit_chain.valid ? "<b>Audit log verified.</b> This bundle can be checked offline with the public keys above." : "<b>Audit log check failed.</b>"}
      <br><a class="link" href="/api/evidence/${encodeURIComponent(orderId)}" download="evidence-${esc(orderId)}.json">Download evidence file</a></p>`;
  const foot = (order?.status === "awaiting_approval" && order.approve_url
      ? `<button class="btn btn-ghost" data-decline="${esc(orderId)}">Decline</button><a class="btn btn-paypal" href="${esc(order.approve_url)}">Approve on PayPal</a>`
      : `<button class="btn btn-ghost" data-close>Close</button>`);
  openDrawer("Payment details", body, foot);
}

function openDenial(seq) {
  const d = (state.data.denials || []).find((x) => String(x.seq) === String(seq));
  if (!d) return;
  openDrawer("Blocked attempt", `
    <div class="receipt-top">${art(d.product_id)}
      <p class="receipt-amount is-blocked">${d.amount ? money(d.amount) : "—"}</p>
      <p class="receipt-name">${esc(d.product)}${d.quantity > 1 ? ` × ${d.quantity}` : ""}</p>
      <span class="status st-stop">Blocked</span></div>
    <p class="callout"><b>No money moved.</b> This attempt was stopped by your mandate before PayPal was called.</p>
    <div><p class="block-title">Why it was blocked</p><ul class="reasons">${d.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
    <div><p class="block-title">Gateway checks</p><div class="verdict" style="margin:0">${checksHTML({ status: "denied", rules: d.rules })}</div></div>
    <dl class="kv"><div><dt>When</dt><dd>${dateOf(d.ts)}, ${timeOf(d.ts)}</dd></div>
      <div><dt>Rules</dt><dd class="mono">${esc(d.rules.join(", "))}</dd></div>
      <div><dt>Mandate</dt><dd class="mono">${esc(d.mandate_id)}</dd></div></dl>`,
    `<button class="btn btn-ghost" data-close>Close</button>`);
}

function openNewMandate() {
  const blocked = ["gift_cards", "crypto", "money_transfer", "prepaid_cards"];
  const cats = state.config.categories.filter((c) => !blocked.includes(c));
  openDrawer("New mandate", `<form class="form" id="mandate-form">
      <label class="field">What may the agent buy?<input name="description" required minlength="3" maxlength="300" value="Keep my kitchen stocked with groceries and household basics"></label>
      <div class="grid-2">
        <label class="field">Total budget<span class="money-field"><input name="total_max" type="number" min="1" step="0.01" value="120" required></span></label>
        <label class="field">Per purchase<span class="money-field"><input name="per_txn_max" type="number" min="1" step="0.01" value="60" required></span></label>
        <label class="field">Ask me above<span class="money-field"><input name="step_up_above" type="number" min="0" step="0.01" value="40" required></span><small>You approve these on PayPal</small></label>
        <label class="field">Max per item<input name="max_quantity_per_item" type="number" min="1" max="100" value="5" required></label>
        <label class="field">Valid for (days)<input name="valid_days" type="number" min="1" max="365" value="30" required></label>
      </div>
      <fieldset class="field" style="border:0;padding:0;margin:0"><legend style="margin-bottom:8px">Allowed categories</legend>
        <div class="toggles">${cats.map((c) => `<label class="toggle-chip"><input type="checkbox" name="cat" value="${c}" ${["groceries", "household"].includes(c) ? "checked" : ""}><span>${esc(titleCase(c))}</span></label>`).join("")}</div></fieldset>
      <div class="never">Never allowed: ${blocked.map((b) => `<span class="chip chip-stop">${esc(titleCase(b))}</span>`).join("")}</div>
      <p class="callout">Your key signs these limits. The agent can only spend within them, and you can revoke the mandate at any time.</p>
    </form>`,
    `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="mandate-form">Sign mandate</button>`);
}

async function submitMandate(form) {
  const f = new FormData(form);
  try {
    const res = await api("/api/mandates", {
      method: "POST",
      body: {
        description: f.get("description"),
        total_max: f.get("total_max"),
        per_txn_max: f.get("per_txn_max"),
        step_up_above: f.get("step_up_above"),
        max_quantity_per_item: Number(f.get("max_quantity_per_item")),
        valid_days: Number(f.get("valid_days")),
        allowed_categories: f.getAll("cat"),
      },
    });
    state.mandateId = res.mandate_id;
    state.chatStarted = false;
    closeDrawer();
    toast("Mandate signed. Your agent can shop within it.");
    await refresh();
    if (state.view !== "agent") location.hash = "#/home";
  } catch (err) {
    toast(err.message, false);
  }
}

function confirmRevoke(id) {
  openDrawer("Revoke this mandate?", `<p>Your agent won't be able to spend under it again, and any purchase still waiting for approval can no longer be paid.</p>
    <p class="callout">Payments already made are not affected.</p>`,
    `<button class="btn btn-ghost" data-close>Keep it</button><button class="btn btn-danger" data-revoke-confirm="${esc(id)}">Revoke mandate</button>`);
}

// ------------------------------------------------------------------ chrome: nav, badges, environment
function renderNav() {
  const count = pendingOrders().length;
  const badge = (n) => (n ? `<span class="nav-badge">${n}</span>` : "");
  $("#nav").innerHTML = NAV.map((n) => `<a href="#/${n.id}" class="${state.view === n.id ? "is-active" : ""}" ${state.view === n.id ? 'aria-current="page"' : ""}>${icon(n.icon)}<span>${n.label}</span>${n.badge ? badge(count) : ""}</a>`).join("");
  $("#tabbar").innerHTML = NAV.filter((n) => n.tab).map((n) => `<a href="#/${n.id}" class="${state.view === n.id ? "is-active" : ""}" ${state.view === n.id ? 'aria-current="page"' : ""}>${icon(n.icon)}<span>${n.label}</span>${n.badge ? badge(count) : ""}</a>`).join("");
  const bell = $("#bell-count");
  bell.hidden = !count;
  bell.textContent = count;
  $("#bell").setAttribute("aria-label", count ? `${count} approvals waiting` : "Approvals");
}

function renderEnv() {
  const c = state.config;
  const sandbox = c.paypal_mode === "sandbox";
  const pill = $("#mode-pill");
  pill.hidden = false;
  pill.className = `pill ${sandbox ? "is-live" : ""}`;
  pill.innerHTML = `<i></i>${sandbox ? "PayPal sandbox" : "Offline demo"}`;
  pill.title = sandbox ? "Payments go through the PayPal sandbox" : "PayPal is simulated locally; no money moves";
  $("#env-card").innerHTML = `<div class="env">
    <div class="env-row"><b>${sandbox ? "PayPal sandbox" : "Offline demo"}</b></div>
    <span>${sandbox ? "Real sandbox checkout" : "Checkout is simulated; no money moves"}</span>
    <span>Agent: ${c.agent_ready ? "live model" : "demo runs"}</span>
    <span>Saved wallet: ${c.vault_enabled ? "on" : "off"}</span></div>`;
}

// ------------------------------------------------------------------ routing and refresh
function renderView() {
  if (!state.data) return;
  ({ home: renderHome, approvals: renderApprovals, activity: renderActivity, mandates: renderMandates, security: renderSecurity, agent: renderAgentChrome })[state.view]?.();
}

function route() {
  let v = (location.hash.replace(/^#\/?/, "") || "home").split("?")[0];
  if (!VIEWS[v]) v = "home";
  const changed = v !== state.view;
  state.view = v;
  $$(".view").forEach((s) => (s.hidden = s.dataset.view !== v));
  const [title, sub] = VIEWS[v];
  $("#page-title").textContent = title;
  $("#page-sub").textContent = sub;
  document.title = `${title} · Mandate`;
  renderNav();
  renderView();
  if (changed && v !== "agent") window.scrollTo(0, 0);
  if (v === "security" && !state.attacks) api("/api/attacks").then((r) => { state.attacks = r.attacks; renderAttackList(); });
}

async function refresh() {
  state.data = await api("/api/state");
  const ms = mandates();
  if (!state.mandateId || !ms.some((m) => m.id === state.mandateId)) {
    state.mandateId = ms.find((m) => m.budget.status === "active")?.id || ms[0]?.id || null;
  }
  renderNav();
  if (state.view === "agent") renderAgentChrome();
  else if (!(state.view === "security" && state.attackRun && !state.attackRun.done)) renderView();
}

function handleReturn() {
  const p = new URLSearchParams(location.search);
  const status = p.get("paypal");
  if (!status) return;
  const msg = {
    captured: ["Payment approved and captured on PayPal.", true],
    cancelled: ["You declined on PayPal. Nothing was charged.", true],
    denied: ["That order can no longer be paid.", false],
    error: ["PayPal returned an error. See the payment details.", false],
    unknown: ["That PayPal order wasn't found.", false],
  }[status] || [`PayPal: ${status}`, false];
  toast(...msg);
  history.replaceState(null, "", "/" + (location.hash || "#/home"));
}

// ------------------------------------------------------------------ events
function bind() {
  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", () => $(".appbar").classList.toggle("is-scrolled", window.scrollY > 4), { passive: true });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });
  $("#scrim").addEventListener("click", closeDrawer);

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a, [data-open-order], [data-open-denial]");
    if (!t) return;
    const d = t.dataset;
    if ("close" in d) return closeDrawer();
    if ("newMandate" in d) return openNewMandate();
    if (d.openOrder) return openOrder(d.openOrder);
    if (d.openDenial) return openDenial(d.openDenial);
    if (d.filter) { state.activityFilter = d.filter; return renderActivity(); }
    if (d.use) { state.mandateId = d.use; state.chatStarted = false; toast("Your agent now shops under this mandate."); return refresh().then(renderView); }
    if (d.revoke) return confirmRevoke(d.revoke);
    if (d.revokeConfirm) {
      await api(`/api/mandates/${d.revokeConfirm}/revoke`, { method: "POST" });
      closeDrawer(); toast("Mandate revoked."); return refresh();
    }
    if (d.decline) {
      await api(`/api/orders/${encodeURIComponent(d.decline)}/cancel`, { method: "POST" });
      closeDrawer(); toast("Declined. The amount is back in your budget."); return refresh();
    }
    if (d.copy) {
      try { await navigator.clipboard.writeText(d.copy); toast("Copied."); } catch { toast("Couldn't copy here.", false); }
      return;
    }
    if (d.demo) return runDemo(d.demo);
    if (d.preset) { const x = DEMOS[Number(d.preset)]; return sendLive(x.task); }
    if (d.step) {
      const input = $("input", t.closest(".qty"));
      input.value = Math.max(1, Number(input.value || 1) + Number(d.step));
      return;
    }
    if ("buy" in d) return storeBuy(t.closest(".scard"));
    if (d.seg) {
      $$(".seg").forEach((s) => { s.classList.toggle("is-active", s === t); s.setAttribute("aria-selected", s === t); });
      const store = d.seg === "store";
      $("#chat-body").hidden = store; $("#composer").hidden = store; $("#store").hidden = !store;
      if (store && !$("#store-grid").children.length) loadStore();
      return;
    }
    if (t.id === "btn-attacks") return runAttacks();
    if (t.id === "btn-verify") {
      const r = await api("/api/ledger/verify");
      toast(r.valid ? `Verified: ${r.events} events, chain intact.` : `Broken at event #${r.broken_at_seq}.`, r.valid);
      return refresh();
    }
  });

  document.addEventListener("submit", (e) => {
    if (e.target.id === "mandate-form") { e.preventDefault(); submitMandate(e.target); }
    if (e.target.id === "home-ask") {
      e.preventDefault();
      const q = new FormData(e.target).get("q").trim();
      if (!q) return;
      location.hash = "#/agent";
      setTimeout(() => sendLive(q), 50);
    }
  });

  const ta = $("#task");
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text || state.busy) return;
    ta.value = ""; grow();
    sendLive(text);
  });

  let timer;
  $("#store-search").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => loadStore(e.target.value), 200); });
}

async function init() {
  bind();
  const [config, catalog] = await Promise.all([api("/api/config"), api("/api/products")]);
  state.config = config;
  catalog.products.forEach((p) => state.products.set(p.product_id, p));
  renderEnv();
  await refresh();
  route();
  handleReturn();
}

init().catch((err) => toast(`Could not load: ${err.message}`, false));
