// Frontend for the Prewarning display.
//
// - Reads ?class=<id-or-name> from the URL (or localStorage fallback).
// - Opens an EventSource to /events?class=...
// - Renders rows in chronological order (oldest first); when a row is removed
//   it slides out and the rest scrolls up via CSS transform.
// - Countdown is computed client-side using prewarnAt + etaSeconds (server
//   feeds the rolling-median ETA per class+leg).

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const STATE = {
  classId: null,
  className: null,
  rows: new Map(), // splitId -> row
  classes: [],
  failover: false,
  es: null,
  // Offset (ms) between the server's clock and this browser's clock,
  // refreshed on every SSE message. All countdown math is anchored to
  // `Date.now() + clockOffset` so the display stays accurate even if the
  // PC running the F11 fullscreen has drifted from the server / DB clock.
  clockOffset: 0,
  // Default ETA shipped from the server on snapshot. The topbar Avg-ETA
  // row is shown only when at least one visible row has an etaSeconds
  // that differs from this default — i.e. the rolling average has kicked
  // in and is overriding the default.
  defaultEtaS: null,
};

function nowMs() {
  return Date.now() + STATE.clockOffset;
}

const STORAGE_KEY = "prewarning.selectedClass";

// ---- bootstrap ---------------------------------------------------------

init().catch((e) => console.error(e));

async function init() {
  startClock();
  bindClassPicker();

  const want =
    params.get("class") ||
    localStorage.getItem(STORAGE_KEY) ||
    "";
  if (want) {
    selectClass(want);
  } else {
    // No class chosen yet — open a lobby SSE so the dropdown receives the
    // class list as soon as the poller has it, plus any later refreshes /
    // failover events. A one-shot fetch would leave the dropdown empty if
    // we connect before the first poll-tick has populated the store.
    selectClass("");
    renderEmpty("Välj klass för att börja");
    openClassPicker();
  }
}

// ---- class selection / SSE ---------------------------------------------

function selectClass(idOrName) {
  if (STATE.es) {
    STATE.es.close();
    STATE.es = null;
  }
  STATE.rows.clear();
  STATE.classId = null;
  STATE.className = null;

  const url = idOrName
    ? `/events?class=${encodeURIComponent(idOrName)}`
    : `/events`;
  const es = new EventSource(url);
  STATE.es = es;
  showConn(false);

  es.onopen = () => {
    if (STATE.es !== es) return;
    showConn(false);
  };
  es.onerror = () => {
    if (STATE.es !== es) return;
    showConn(true);
    // EventSource closes permanently on a 4xx response. With a class param
    // that means we asked for a class that doesn't resolve server-side —
    // most often a stale URL/localStorage from before a class was renamed
    // or the eventclasses pivot. Drop the stale ref and re-attach to the
    // lobby so the dropdown still populates.
    if (es.readyState === EventSource.CLOSED && idOrName) {
      localStorage.removeItem(STORAGE_KEY);
      const u = new URL(location.href);
      u.searchParams.delete("class");
      history.replaceState(null, "", u.toString());
      selectClass("");
      renderEmpty("Välj klass för att börja");
      openClassPicker();
    }
  };
  es.onmessage = (ev) => {
    if (STATE.es !== es) return;
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(payload);
  };
}

function handleEvent(p) {
  if (typeof p.serverNow === "number") {
    STATE.clockOffset = p.serverNow - Date.now();
  }
  if (p.etaConfig && typeof p.etaConfig.defaultS === "number") {
    STATE.defaultEtaS = p.etaConfig.defaultS;
  }
  if (p.type === "hb") return;
  if (p.type === "snapshot") {
    STATE.classId = p.raceClassId;
    STATE.className = p.raceClassName;
    STATE.classes = p.classes || STATE.classes;
    STATE.failover = !!p.failover;
    STATE.rows.clear();
    for (const r of p.rows) STATE.rows.set(r.splitId, r);
    localStorage.setItem(STORAGE_KEY, String(p.raceClassId));
    renderAll();
    return;
  }
  if (p.type === "diff") {
    if (typeof p.failover === "boolean") STATE.failover = p.failover;
    if (Array.isArray(p.added))
      for (const r of p.added) STATE.rows.set(r.splitId, r);
    if (Array.isArray(p.updated))
      for (const r of p.updated) STATE.rows.set(r.splitId, r);
    if (Array.isArray(p.removed))
      for (const r of p.removed) STATE.rows.delete(r.splitId);
    renderAll();
    return;
  }
  if (p.type === "classes") {
    STATE.classes = p.classes || [];
    if (typeof p.failover === "boolean") STATE.failover = p.failover;
    renderTopbar();
    return;
  }
  if (p.type === "failover") {
    STATE.failover = !!p.active;
    renderFailover();
    return;
  }
}

// ---- rendering ---------------------------------------------------------

function renderAll() {
  renderTopbar();
  renderFailover();
  renderEta();
  renderRows();
}

// Topbar ETA panel: shows EITHER the default ETA (when no measured
// average has kicked in yet) OR the measured average (which replaces the
// default once one or more legs have collected real samples). Both rows
// are never visible at the same time — the user only needs to see the
// value the countdown is actually anchored on.
function renderEta() {
  const def = STATE.defaultEtaS;
  const measured = measuredEtaAverage();

  const defRow = $("eta-default-row");
  const defEl = $("eta-default");
  const avgRow = $("eta-avg-row");
  const avgEl = $("eta-avg");

  if (measured != null) {
    defRow.hidden = true;
    avgRow.hidden = false;
    avgEl.textContent = formatMS(measured);
    return;
  }

  defRow.hidden = false;
  avgRow.hidden = true;
  avgEl.textContent = "--:--";
  defEl.textContent = def == null ? "--:--" : formatMS(def);
}

function measuredEtaAverage() {
  const def = STATE.defaultEtaS;
  if (def == null) return null;
  // Each row in a given raceClass shares the same etaSeconds value (see
  // _setEtaFromDurations on the server), so dedupe by class so a class
  // with many active runners doesn't dominate the average.
  const byClass = new Map();
  for (const r of STATE.rows.values()) {
    if (r.etaSeconds == null) continue;
    if (r.etaSeconds === def) continue;
    if (!byClass.has(r.raceClassId)) byClass.set(r.raceClassId, r.etaSeconds);
  }
  if (byClass.size === 0) return null;
  let sum = 0;
  for (const v of byClass.values()) sum += v;
  return Math.round(sum / byClass.size);
}

function formatMS(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function renderTopbar() {
  const list = $("class-list");
  list.innerHTML = "";
  for (const c of STATE.classes) {
    const li = document.createElement("li");
    li.textContent = c.name;
    li.setAttribute("role", "option");
    li.setAttribute("data-id", String(c.id));
    if (c.id === STATE.classId) li.setAttribute("aria-selected", "true");
    li.addEventListener("click", () => {
      closeClassPicker();
      const url = new URL(location.href);
      url.searchParams.set("class", c.name);
      history.replaceState(null, "", url.toString());
      selectClass(String(c.id));
    });
    list.appendChild(li);
  }
  $("class-name").textContent = STATE.className || "—";
  $("class-btn-label").textContent = STATE.className || "Välj klass";
}

function renderFailover() {
  $("failover-banner").hidden = !STATE.failover;
}

function renderRows() {
  const ol = $("rows");
  const empty = $("empty");
  const rows = [...STATE.rows.values()].sort((a, b) => a.prewarnAt - b.prewarnAt);

  if (rows.length === 0) {
    ol.innerHTML = "";
    renderEmpty(
      STATE.className
        ? `Väntar på första passering — ${STATE.className}`
        : "Väntar på data…",
    );
    return;
  }
  empty.hidden = true;

  // Reconcile DOM nodes with rows. Use splitId as the stable key.
  const present = new Set(rows.map((r) => String(r.splitId)));

  // Mark removals: nodes in DOM but not in `present`.
  for (const li of [...ol.children]) {
    const id = li.dataset.id;
    if (!present.has(id) && !li.classList.contains("removing")) {
      li.classList.add("removing");
      setTimeout(() => li.remove(), 700);
    }
  }

  // Add/update.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let li = ol.querySelector(`li[data-id="${cssEscape(row.splitId)}"]`);
    if (!li) {
      li = createRowEl(row);
      // insert at correct position
      const next = ol.children[i];
      if (next) ol.insertBefore(li, next);
      else ol.appendChild(li);
    } else {
      updateRowEl(li, row);
      // Re-order if needed.
      const at = [...ol.children].indexOf(li);
      if (at !== i && i < ol.children.length) {
        ol.insertBefore(li, ol.children[i]);
      }
    }
  }
}

function createRowEl(row) {
  const li = document.createElement("li");
  li.className = "row";
  li.dataset.id = String(row.splitId);
  li.innerHTML = `
    <div class="stripe ${row.stripe}"></div>
    <div class="bib">${escapeHtml(row.bib ?? "")}</div>
    <div class="team">${escapeHtml(row.teamName || "")}</div>
    <div class="finish">${finishLabel(row)}</div>
    <div class="leg">${legBadge(row.leg)}</div>
    <div class="countdown" data-cd>--:--</div>
  `;
  updateCountdown(li, row);
  return li;
}

function updateRowEl(li, row) {
  const stripe = li.querySelector(".stripe");
  stripe.className = `stripe ${row.stripe}`;
  li.querySelector(".bib").textContent = row.bib ?? "";
  li.querySelector(".team").textContent = row.teamName || "";
  li.querySelector(".finish").textContent = finishLabel(row);
  li.querySelector(".leg").textContent = legBadge(row.leg);
  updateCountdown(li, row);
  li.dataset.prewarnAt = String(row.prewarnAt);
  li.dataset.eta = String(row.etaSeconds || 180);
  li.dataset.finishAt = row.finishAt ? String(row.finishAt) : "";
}

// Status badge in the Finish column, just left of the leg badge:
//   "Finish" once the finish punch has landed (stripe red)
//   "Last"   when the runner has punched the last-checkpoint control AND
//            that anchor moment has been reached (server may park it in
//            the future during SimOLA fast-replay so the GREEN phase
//            renders first — gate on nowMs() to stay in sync with the
//            stripe).
//   empty    otherwise
function finishLabel(row) {
  if (row.stripe === "red") return "Finish";
  if (row.lastCheckpointAt != null && row.lastCheckpointAt <= nowMs()) {
    return "Last";
  }
  return "";
}

function legBadge(leg) {
  if (leg == null || leg === "") return "—";
  return `Str.${leg}`;
}

function renderEmpty(text) {
  const empty = $("empty");
  empty.hidden = false;
  $("empty-text").textContent = text;
  // Big clock in empty state — server-anchored so it matches the topbar.
  const now = new Date(nowMs());
  $("empty-clock").textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ---- countdown ticker --------------------------------------------------

setInterval(() => {
  const now = nowMs();
  for (const li of document.querySelectorAll(".row")) {
    const row = STATE.rows.get(numericKey(li.dataset.id));
    if (!row) continue;
    updateCountdown(li, row, now);
  }
  // also refresh empty-state clock if visible
  const empty = $("empty");
  if (!empty.hidden) {
    const d = new Date(nowMs());
    $("empty-clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}, 250);

function updateCountdown(li, row, now = nowMs()) {
  const cd = li.querySelector("[data-cd]");
  if (!cd) return;
  if (!row.prewarnAt) {
    cd.textContent = "--:--";
    cd.classList.remove("frozen");
    return;
  }
  // After finish has ACTUALLY arrived (finishAt <= now): count UP from
  // 0:00 into negative — 0:00 at the moment of finish, -0:01 a second
  // later, etc. The server removes the row once now - finishAt >
  // post_finish_remove_s, so the display caps near e.g. -0:30.
  //
  // finishAt MAY be parked in the future when prewarn + finish arrived
  // in the same poll (SimOLA fast-replay / restart-with-finished-data).
  // In that case the server keeps the stripe GREEN/YELLOW until the
  // dwell elapses, and we render the normal prewarn countdown — not the
  // post-finish display. Otherwise the user sees a red 0:00 next to a
  // green stripe.
  if (row.finishAt && row.finishAt <= now) {
    const elapsedMs = now - row.finishAt;
    const s = Math.floor(elapsedMs / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    cd.textContent = `${s > 0 ? "-" : ""}${mm}:${pad(ss)}`;
    cd.classList.add("post-finish");
    cd.classList.remove("frozen");
    return;
  }
  cd.classList.remove("post-finish");
  const target = row.prewarnAt + (row.etaSeconds || 180) * 1000;
  const remainMs = target - now;
  if (remainMs <= 0) {
    cd.textContent = "0:00";
    cd.classList.add("frozen");
    return;
  }
  const s = Math.ceil(remainMs / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  cd.textContent = `${mm}:${pad(ss)}`;
  cd.classList.remove("frozen");
}

// ---- top clock ---------------------------------------------------------

function startClock() {
  let blink = false;
  setInterval(() => {
    blink = !blink;
    const now = new Date(nowMs());
    $("clock-hh").textContent = pad(now.getHours());
    $("clock-mm").textContent = pad(now.getMinutes());
    $("clock-ss").textContent = pad(now.getSeconds());
    for (const sep of document.querySelectorAll(".clock-sep")) {
      sep.classList.toggle("off", blink);
    }
  }, 500);
}

// ---- class picker ------------------------------------------------------

function bindClassPicker() {
  $("class-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const list = $("class-list");
    if (list.hidden) openClassPicker();
    else closeClassPicker();
  });
  document.addEventListener("click", (e) => {
    if (!$("class-list").hidden && !e.target.closest(".class-picker")) {
      closeClassPicker();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeClassPicker();
  });
}

function openClassPicker() {
  $("class-list").hidden = false;
  $("class-btn").setAttribute("aria-expanded", "true");
}

function closeClassPicker() {
  $("class-list").hidden = true;
  $("class-btn").setAttribute("aria-expanded", "false");
}

// ---- helpers -----------------------------------------------------------

function showConn(disconnected) {
  $("connection").hidden = !disconnected;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cssEscape(v) {
  if (window.CSS && CSS.escape) return CSS.escape(String(v));
  return String(v).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function numericKey(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}
