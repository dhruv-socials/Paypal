"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { config: null, data: null, mandateId: null };

const PRESETS = [
  { label: "Kitchen restock", task: "Restock my kitchen: basmati rice, toor dal and cooking oil. Pick well-rated options." },
  { label: "Cheapest rice", task: "Find me the cheapest basmati rice and buy one pack." },
  { label: "Cleaning supplies", task: "I need kitchen towels and dish soap for the month." },
  { label: "Laptop upgrade", task: "Upgrade my laptop if there's a good deal today." },
];

const THUMBS = { rice: "🍚", dal: "🫘", oil: "🫒", coffee: "☕", detergent: "🧴", dishwash: "🧽", tissue: "🧻", earbuds: "🎧", laptop: "💻", giftcard: "🎁" };

const ICONS = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  view: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  budget: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg>',
  purchase: '<svg viewBox="0 0 24 24"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/></svg>',
  thought: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
};

// ------------------------------------------------------------------ helpers
const money = (v, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(Number(v || 0));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const shortId = (s, n = 10) => (s && s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s || "");

const titleCase = (s) => String(s).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

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
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

// ------------------------------------------------------------------ verdict rendering
const VERDICT = {
  captured: { cls: "is-captured", stamp: "Paid with PayPal" },
  awaiting_approval: { cls: "is-waiting", stamp: "Allowed: waiting for your PayPal approval" },
  step_up_required: { cls: "is-waiting", stamp: "Above your threshold: needs your approval" },
  duplicate: { cls: "is-waiting", stamp: "Already submitted, not charged again" },
  denied: { cls: "is-denied", stamp: "Blocked by your mandate" },
  error: { cls: "is-denied", stamp: "PayPal error" },
};

function verdictHTML(r, fallbackName = "") {
  const v = VERDICT[r.status] || VERDICT.error;
  const name = r.product || fallbackName;
  const reasons = r.status === "denied" || r.status === "error" ? r.reasons || [] : [];
  const pay = r.approve_url && (r.status === "awaiting_approval" || r.status === "step_up_required")
    ? `<a class="btn btn-pay btn-sm" href="${esc(r.approve_url)}">Approve on PayPal</a>` : "";
  return `<div class="verdict ${v.cls}">
      <div class="verdict-row"><span class="verdict-item">${esc(name)}</span>${r.amount ? `<span class="verdict-amount">${money(r.amount)}</span>` : ""}</div>
      <span class="stamp">${v.stamp}</span>
      ${reasons.length ? `<ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${pay}
    </div>`;
}

// ------------------------------------------------------------------ mandate
function currentMandate() {
  return state.data?.mandates.find((m) => m.id === state.mandateId) || null;
}

function renderMandate() {
  const mandates = state.data?.mandates || [];
  if (!state.mandateId || !mandates.some((m) => m.id === state.mandateId)) {
    state.mandateId = mandates.find((m) => m.budget.status === "active")?.id || mandates[0]?.id || null;
  }
  const m = currentMandate();
  $("#mandate-empty").hidden = !!m || !$("#mandate-form").hidden;
  $("#mandate-card").hidden = !m;
  if (!mandates.length && $("#mandate-form").hidden) showForm();
  if (!m) return;

  const c = m.constraints;
  const b = m.budget;
  const total = Number(b.total_max), captured = Number(b.captured), pending = Math.max(Number(b.committed) - captured, 0);
  $("#m-desc").textContent = m.description;
  const status = $("#m-status");
  status.textContent = b.status === "active"
    ? `Active · ${b.wallet_saved ? "PayPal wallet saved for in-limit purchases" : "every payment approved on PayPal"}`
    : "Revoked: the agent can no longer spend";
  status.classList.toggle("is-revoked", b.status !== "active");
  $("#m-remaining").textContent = money(b.remaining);
  $("#m-total").textContent = money(total);
  $("#m-captured").textContent = money(captured);
  $("#m-pending").textContent = money(pending);
  $("#m-bar-captured").style.width = `${Math.min(100, (captured / total) * 100)}%`;
  $("#m-bar-pending").style.width = `${Math.min(100, (pending / total) * 100)}%`;
  $("#m-meter").setAttribute("aria-label", `${money(b.committed)} of ${money(total)} used`);
  $("#m-per-txn").textContent = money(c.per_txn_max);
  $("#m-stepup").textContent = money(c.step_up_above);
  $("#m-qty").textContent = `${c.max_quantity_per_item} per item`;
  $("#m-exp").textContent = new Date(m.valid_until).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  $("#m-cats").innerHTML = (c.allowed_categories.length ? c.allowed_categories : ["Any category"]).map((x) => `<span class="chip">${esc(titleCase(x))}</span>`).join("");
  $("#m-blocked").innerHTML = c.blocked_categories.map((x) => `<span class="chip chip-stop">${esc(titleCase(x))}</span>`).join("");
  $("#m-id").textContent = `${m.id} · agent ${shortId(m.agent, 14)}`;
  $("#btn-revoke").hidden = b.status !== "active";

  const sel = $("#mandate-select");
  sel.hidden = mandates.length < 2;
  sel.innerHTML = mandates.map((x) => `<option value="${x.id}" ${x.id === m.id ? "selected" : ""}>${esc(shortId(x.id, 8))}${x.budget.status !== "active" ? " (revoked)" : ""}</option>`).join("");
}

function showForm() {
  $("#mandate-form").hidden = false;
  $("#mandate-empty").hidden = true;
  $("#btn-cancel-form").hidden = !(state.data?.mandates.length);
}

function renderCategoryOptions() {
  const blocked = ["gift_cards", "crypto", "money_transfer", "prepaid_cards"];
  const cats = state.config.categories.filter((c) => !blocked.includes(c));
  const defaults = ["groceries", "household"];
  $("#cat-options").innerHTML = cats.map((c) =>
    `<label><input type="checkbox" name="cat" value="${c}" ${defaults.includes(c) ? "checked" : ""}> ${esc(titleCase(c))}</label>`).join("");
}

// ------------------------------------------------------------------ orders, ledger
function renderOrders() {
  const orders = (state.data?.orders || []).filter((o) => o.mandate_id === state.mandateId);
  $("#orders-empty").hidden = orders.length > 0;
  $("#orders").innerHTML = orders.map((o) => `
    <li>
      <div class="order-top">
        <div>
          <p class="order-name">${esc(o.product)} <span class="order-meta">× ${o.quantity}</span></p>
          <p class="order-meta">PayPal order ${esc(o.paypal_order_id)}</p>
        </div>
        <span class="order-amount">${money(o.amount, o.currency)}</span>
      </div>
      <span class="status status-${o.status}">${{ captured: "Paid", awaiting_approval: o.step_up ? "Above your threshold: needs approval" : "Waiting for you on PayPal", cancelled: "Cancelled", failed: "Failed", reserved: "Reserved" }[o.status] || o.status}</span>
      <div class="order-actions">
        ${o.approve_url ? `<a class="btn btn-pay btn-sm" href="${esc(o.approve_url)}">Approve on PayPal</a>
           <button class="link" data-cancel="${esc(o.paypal_order_id)}">Cancel</button>` : ""}
        <a class="link" href="/api/evidence/${encodeURIComponent(o.paypal_order_id)}" target="_blank" rel="noopener">Dispute evidence</a>
      </div>
    </li>`).join("");
}

function renderLedger() {
  const chain = state.data?.chain;
  const badge = $("#chain-badge");
  if (chain) {
    badge.textContent = chain.valid ? `Audit log intact · ${chain.events} events` : `Audit log broken at #${chain.broken_at_seq}`;
    badge.className = `badge ${chain.valid ? "badge-ok" : "badge-stop"}`;
    $("#ledger-count").textContent = `(${chain.events})`;
  }
  $("#events").innerHTML = (state.data?.events || []).map((e) => `
    <li>
      <span class="ev-type">${esc(e.type)}</span>
      <span class="ev-time">${new Date(e.ts).toLocaleTimeString()}</span>
      <span class="ev-hash">#${e.seq} ${e.hash.slice(0, 24)}… ← ${e.prev_hash.slice(0, 12)}…</span>
    </li>`).join("");
}

async function refresh() {
  state.data = await api("/api/state");
  renderMandate();
  renderOrders();
  renderLedger();
}

// ------------------------------------------------------------------ agent timeline
function stepHTML(s) {
  if (s.kind === "thought") {
    return `<li class="step step-thought"><span class="step-icon">${ICONS.thought}</span><div class="step-body">${esc(s.text)}</div></li>`;
  }
  const o = s.output || {};
  const i = s.input || {};
  let title = "", sub = "", extra = "";
  if (s.tool === "search_products") {
    title = `Searched “${esc(i.query)}”`;
    sub = (o.results || []).slice(0, 4).map((r) => `${esc(r.name)} (${money(r.price)})`).join(", ") || "No results";
  } else if (s.tool === "view_product") {
    title = `Read ${esc(o.name || i.product_id)}`;
    sub = `${esc(o.merchant || "")} · ${money(o.price)}`;
    if (/assistant|agent|system|must|pre-?approved|always order/i.test(o.description || "")) {
      extra = `<div class="injected"><b>Instructions hidden in this product page:</b> “${esc(o.description)}”</div>`;
    }
  } else if (s.tool === "check_budget") {
    title = "Checked remaining budget";
    sub = o.budget ? `${money(o.budget.remaining)} left` : "";
  } else if (s.tool === "purchase") {
    title = `Asked to buy ${esc(i.quantity)} × ${esc(o.product || i.product_id)}`;
    extra = verdictHTML(o, i.product_id);
  }
  return `<li class="step"><span class="step-icon">${ICONS[s.tool === "search_products" ? "search" : s.tool === "view_product" ? "view" : s.tool === "check_budget" ? "budget" : "purchase"]}</span>
    <div class="step-body"><p class="step-title">${title}</p>${sub ? `<p class="step-sub">${sub}</p>` : ""}${extra}</div></li>`;
}

function renderRun(run) {
  const tl = $("#timeline");
  const banner = run.scripted ? `<li class="notice">Scripted agent: the model's moves are replayed from a script; the gateway decisions below are live.</li>` : "";
  tl.innerHTML = banner + run.steps.map(stepHTML).join("") +
    (run.final_text ? `<li class="step step-final"><span class="step-icon">${ICONS.done}</span><div class="step-body">${esc(run.final_text)}</div></li>` : "");
}

async function runScripted(script) {
  if (!state.mandateId) return toast("Sign a mandate first.");
  $("#timeline").innerHTML = `<li class="thinking"><span class="spinner"></span>Replaying the scripted agent</li>`;
  try {
    renderRun(await api("/api/agent/demo", { method: "POST", body: { mandate_id: state.mandateId, script } }));
  } catch (err) {
    $("#timeline").innerHTML = "";
    toast(err.message);
  } finally {
    refresh();
  }
}

async function runAgent(ev) {
  ev.preventDefault();
  if (!state.mandateId) return toast("Sign a mandate first.");
  const btn = $("#btn-run");
  const tl = $("#timeline");
  btn.disabled = true;
  btn.textContent = "Agent is shopping…";
  tl.innerHTML = `<li class="thinking"><span class="spinner"></span>The agent is searching and deciding what to buy</li>`;
  try {
    const run = await api("/api/agent/run", { method: "POST", body: { mandate_id: state.mandateId, task: $("#task").value, hardened: $("#hardened").checked } });
    if (run.error) {
      tl.innerHTML = "";
      showNotice(run.error);
      $("#scripted").hidden = false;
    } else {
      renderRun(run);
    }
  } catch (err) {
    tl.innerHTML = "";
    showNotice(`The agent run failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run agent";
    refresh();
  }
}

function showNotice(text) {
  const n = $("#agent-notice");
  n.textContent = text;
  n.hidden = false;
}

// ------------------------------------------------------------------ manual purchase
async function loadProducts(q = "") {
  const { products } = await api(`/api/products?q=${encodeURIComponent(q)}`);
  $("#product-list").innerHTML = products.map((p) => `
    <li class="product" data-id="${esc(p.product_id)}">
      <div class="product-top"><span class="thumb" aria-hidden="true">${THUMBS[p.image] || "🛒"}</span>
        <div><p class="product-name">${esc(p.name)}</p><p class="product-meta">${esc(p.merchant)} · ${esc(titleCase(p.category))}</p></div></div>
      <div class="product-foot"><span class="price">${money(p.price)}</span>
        <span><input class="qty" type="number" min="1" value="1" aria-label="Quantity"> <button class="btn btn-primary btn-sm" data-buy>Buy</button></span></div>
      <div class="product-result"></div>
    </li>`).join("");
}

async function manualBuy(li) {
  if (!state.mandateId) return toast("Sign a mandate first.");
  const btn = $("[data-buy]", li);
  btn.disabled = true;
  try {
    const r = await api("/api/purchase", { method: "POST", body: { mandate_id: state.mandateId, product_id: li.dataset.id, quantity: Number($(".qty", li).value || 1) } });
    $(".product-result", li).innerHTML = verdictHTML(r, $(".product-name", li).textContent);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    refresh();
  }
}

// ------------------------------------------------------------------ attacks
async function runAttacks() {
  const btn = $("#btn-attacks");
  btn.disabled = true;
  btn.textContent = "Attacking…";
  try {
    const r = await api("/api/attacks/run", { method: "POST" });
    const allBlocked = r.blocked === r.total && Number(r.money_outside_mandate) === 0;
    $("#attack-result").innerHTML = `
      <div class="score"><span class="score-big ${allBlocked ? "" : "is-bad"}">${money(r.money_outside_mandate)}</span>
        <span class="score-sub">moved outside a mandate · ${r.blocked} of ${r.total} attacks stopped</span></div>
      <ul class="attacks">${r.attacks.map((a) => `
        <li><span class="${a.blocked ? "ok" : "bad"}">${a.blocked ? "✓" : "✗"}</span>
          <div><p class="a-name">${esc(a.name)}</p><p class="a-sub">${esc(a.owasp)} · ${esc(a.description)}</p></div>
          <span class="a-out">${esc(a.outcome)}<br>${esc((a.rules || [])[0] || "")}</span></li>`).join("")}</ul>`;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run again";
    refresh();
  }
}

// ------------------------------------------------------------------ wiring
function bind() {
  $("#presets").innerHTML = PRESETS.map((p, i) => `<button type="button" class="preset" data-preset="${i}">${esc(p.label)}</button>`).join("");
  $("#presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (b) $("#task").value = PRESETS[Number(b.dataset.preset)].task;
  });
  $("#agent-form").addEventListener("submit", runAgent);

  $$(".tab").forEach((t) => t.addEventListener("click", () => {
    $$(".tab").forEach((x) => { x.classList.toggle("is-active", x === t); x.setAttribute("aria-selected", x === t); });
    $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
    if (t.dataset.tab === "manual" && !$("#product-list").children.length) loadProducts();
  }));

  let searchTimer;
  $("#product-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadProducts(e.target.value), 200);
  });
  $("#product-list").addEventListener("click", (e) => {
    if (e.target.closest("[data-buy]")) manualBuy(e.target.closest(".product"));
  });

  $("#btn-new-mandate").addEventListener("click", showForm);
  $("#btn-cancel-form").addEventListener("click", () => { $("#mandate-form").hidden = true; renderMandate(); });
  $("#mandate-select").addEventListener("change", (e) => { state.mandateId = e.target.value; renderMandate(); renderOrders(); });

  $("#mandate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
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
      $("#mandate-form").hidden = true;
      toast("Mandate signed. The agent can now shop within it.");
      refresh();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#btn-revoke").addEventListener("click", async () => {
    if (!confirm("Revoke this mandate? The agent will not be able to spend under it again.")) return;
    await api(`/api/mandates/${state.mandateId}/revoke`, { method: "POST" });
    toast("Mandate revoked.");
    refresh();
  });

  $("#orders").addEventListener("click", async (e) => {
    const id = e.target.closest("[data-cancel]")?.dataset.cancel;
    if (!id) return;
    await api(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    toast("Order cancelled. Its amount is back in your budget.");
    refresh();
  });

  $("#btn-attacks").addEventListener("click", runAttacks);
  $("#scripted").addEventListener("click", (e) => {
    const s = e.target.closest("[data-script]")?.dataset.script;
    if (s) runScripted(s);
  });
}

function handleReturn() {
  const p = new URLSearchParams(location.search);
  const status = p.get("paypal");
  if (!status) return;
  const msg = { captured: "Payment approved and captured on PayPal.", cancelled: "You cancelled on PayPal. Nothing was charged.", denied: "That order can no longer be paid.", error: "PayPal returned an error. See the audit log." }[status] || `PayPal: ${status}`;
  toast(msg);
  history.replaceState(null, "", "/");
}

async function init() {
  bind();
  state.config = await api("/api/config");
  const mode = $("#mode-badge");
  mode.textContent = state.config.paypal_mode === "sandbox" ? "PayPal sandbox" : "Offline mock (no PayPal calls)";
  mode.title = `Agent model: ${state.config.model}${state.config.agent_ready ? "" : " (no API key set)"}`;
  if (!state.config.agent_ready) {
    showNotice("No ANTHROPIC_API_KEY is set, so the live LLM agent is off. Add one to .env, or use the scripted replays below.");
    $("#scripted").hidden = false;
    $("#btn-run").disabled = true;
  }
  renderCategoryOptions();
  await refresh();
  handleReturn();
}

init().catch((err) => toast(`Could not load: ${err.message}`));
