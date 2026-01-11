import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  endAt,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  startAt,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ingestConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const DEFAULT_CONFIG = {
  home: null,
  geofence: { innerFt: 250, outerFt: 750 },
  forceRoamUntil: null,
  wifiRssiMin: -72,
  ping: { homeSec: 900, nearbySec: 120, roamingSec: 15 },
  batteryUploadThreshold: 25
};

const HISTORY_LIMIT = 2000;
const HISTORY_RENDER_LIMIT = 200;
const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_THERMOSTAT_ID = ingestConfig?.thermostatId || "home";
const THERMOSTAT_HISTORY_LIMIT = 2000;
const THERMOSTAT_HISTORY_RENDER_LIMIT = 400;

const state = {
  user: null,
  unsubDevices: null,
  unsubDevice: null,
  historyTimer: null,
  map: null,
  marker: null,
  polyline: null,
  lastDeviceId: null,
  selectedDay: null,
  timelineCursorMin: 0,
  historyWindowMinutes: DEFAULT_WINDOW_MINUTES,
  historyPoints: [],
  currentConfig: null,
  lastSnapshot: null,
  thermostatUnsub: null,
  thermostatHistoryTimer: null,
  thermostatId: DEFAULT_THERMOSTAT_ID,
  thermostat: null,
  thermostatHistory: [],
  thermostatRange: "day",
  debug: {
    deviceError: null,
    devicesError: null,
    historyError: null,
    lastDeviceId: null
  }
};

const routes = [
  { pattern: /^\/home$/, handler: renderHome },
  { pattern: /^\/dog\/([^/]+)$/, handler: (_path, id) => renderDog(id) },
  { pattern: /^\/pet\/([^/]+)$/, handler: (_path, id) => renderDog(id, "Pet") },
  { pattern: /^\/thermostat$/, handler: renderThermostat }
];

const view = document.getElementById("view");
const authForm = document.getElementById("auth-form");
const signInBtn = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const authStatus = document.getElementById("auth-status");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const petsLink = document.getElementById("pets-link");

const defaultDeviceId = ingestConfig?.deviceId || "Tyee";
if (petsLink) {
  petsLink.href = `#/pet/${defaultDeviceId}`;
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) return;
  toggleAuthButtons(true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    authStatus.textContent = "";
  } catch (err) {
    console.error("Sign-in failed", err);
    authStatus.textContent = err.message ?? "Sign-in failed";
  } finally {
    toggleAuthButtons(false);
  }
});

signOutBtn.addEventListener("click", async () => {
  toggleAuthButtons(true);
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Sign-out failed", err);
    authStatus.textContent = err.message ?? "Sign-out failed";
  } finally {
    toggleAuthButtons(false);
  }
});

onAuthStateChanged(auth, (user) => {
  state.user = user;
  updateAuthUI();
  router();
});

window.addEventListener("hashchange", router);
router();

function updateAuthUI() {
  const user = state.user;
  authStatus.textContent = user ? `Signed in as ${user.email}` : "";
  authEmail.style.display = user ? "none" : "";
  authPassword.style.display = user ? "none" : "";
  signInBtn.style.display = user ? "none" : "";
  signOutBtn.style.display = user ? "" : "none";
  if (!user) {
    authForm.reset();
  }
}

function router() {
  const path = (window.location.hash.replace(/^#/, "") || "/home").replace(/\/+$/, "") || "/home";

  for (const r of routes) {
    const match = path.match(r.pattern);
    if (match) {
      r.handler(path, ...match.slice(1));
      return;
    }
  }

  renderNotFound();
}

function requireAuth(actionLabel) {
  if (state.user) return true;
  const meta = document.getElementById("history-meta");
  if (meta) meta.textContent = `Sign in required to ${actionLabel}.`;
  return false;
}

function renderAuthGate() {
  cleanupListeners();
  view.innerHTML = `
    <section class="placeholder">
      <h2>Sign in required</h2>
      <p class="muted">Use email/password to load devices.</p>
    </section>
  `;
}

function renderNotFound() {
  cleanupListeners();
  view.innerHTML = `
    <section class="placeholder">
      <h2>Page not found</h2>
      <p class="muted">Try #/home or #/dog/&lt;deviceId&gt;.</p>
    </section>
  `;
}

function renderComingSoon(label) {
  cleanupListeners();
  view.innerHTML = `
    <section class="placeholder">
      <h2>${label}</h2>
      <p class="muted">Coming soon.</p>
    </section>
  `;
}

function renderThermostat() {
  cleanupListeners();
  const canEdit = !!state.user;
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Thermostat</h2>
        <p class="muted">Live status and controls synced with Firebase.</p>
        <div class="muted" id="thermo-auth">${canEdit ? "" : "Sign in to change settings."}</div>
      </div>
      <span class="pill offline" id="thermo-status-pill"><span class="dot"></span>Offline</span>
    </div>

    <div class="thermo-grid">
      <div class="card thermo-panel">
        <div class="thermo-metric">
          <div class="thermo-label">Temperature</div>
          <div class="thermo-value" id="thermo-temp">--</div>
          <div class="thermo-sub">Real feel: <span id="thermo-feel">--</span></div>
          <div class="thermo-sub">Humidity: <span id="thermo-hum">--</span></div>
        </div>
        <div class="thermo-meta" id="thermo-meta">Last update: --</div>
        <div class="thermo-chip-row">
          <span class="pill" id="thermo-mode-pill"><span class="dot"></span>Mode: --</span>
          <span class="pill" id="thermo-output-pill"><span class="dot"></span>Outputs: --</span>
        </div>
        <div class="thermo-sub" id="thermo-schedule-status">Schedule: --</div>
        <div class="thermo-sub" id="thermo-wifi">WiFi: --</div>
        <div class="thermo-sub" id="thermo-sd">SD: --</div>
      </div>

      <div class="card thermo-panel">
        <div class="thermo-control-row">
          <div class="thermo-label">Setpoint (&deg;F)</div>
          <div class="thermo-control-group">
            <button class="btn ghost" type="button" id="thermo-set-down">-</button>
            <div class="thermo-control-value" id="thermo-setpoint">--</div>
            <button class="btn" type="button" id="thermo-set-up">+</button>
          </div>
        </div>
        <div class="thermo-control-row">
          <div class="thermo-label">Diff (&deg;F)</div>
          <div class="thermo-control-group">
            <button class="btn ghost" type="button" id="thermo-diff-down">-</button>
            <div class="thermo-control-value" id="thermo-diff">--</div>
            <button class="btn" type="button" id="thermo-diff-up">+</button>
          </div>
        </div>
        <div class="thermo-control-row">
          <div class="thermo-label">Mode</div>
          <div class="thermo-mode-buttons" id="thermo-mode-buttons">
            <button class="btn ghost" type="button" data-mode="heat">Heat</button>
            <button class="btn ghost" type="button" data-mode="cool">Cool</button>
            <button class="btn ghost" type="button" data-mode="fan">Fan</button>
            <button class="btn ghost" type="button" data-mode="off">Off</button>
          </div>
        </div>
        <div class="thermo-control-row">
          <div class="thermo-label">Fan timer</div>
          <div class="thermo-control-group">
            <button class="btn ghost" type="button" id="thermo-fan-start">Start</button>
            <button class="btn ghost" type="button" id="thermo-fan-clear">Clear</button>
          </div>
          <div class="thermo-sub" id="thermo-fan-status">--</div>
        </div>
      </div>
    </div>

    <div class="card thermo-panel">
      <div class="section-header">
        <h3>Schedule</h3>
        <div class="thermo-schedule-actions">
          <button class="btn ghost" type="button" id="thermo-schedule-refresh">Refresh</button>
          <button class="btn ghost" type="button" id="thermo-schedule-clear">Clear all</button>
        </div>
      </div>
      <div class="thermo-schedule-legend">Long-press a day bar to add a setpoint block.</div>
      <div id="thermo-schedule-grid"></div>
      <div class="muted">Blocks are inclusive of the end hour.</div>
    </div>

    <div class="card thermo-panel">
      <div class="section-header">
        <h3>History</h3>
        <div class="thermo-history-actions">
          <button class="btn ghost" type="button" data-range="day">Day</button>
          <button class="btn ghost" type="button" data-range="week">Week</button>
          <button class="btn ghost" type="button" data-range="month">Month</button>
          <button class="btn ghost" type="button" id="thermo-history-refresh">Refresh</button>
        </div>
      </div>
      <canvas id="thermo-chart" width="900" height="360"></canvas>
      <div class="thermo-history-legend">
        <span><span class="thermo-swatch" style="background:#2f74ff"></span>Setpoint</span>
        <span><span class="thermo-swatch" style="background:#30d158"></span>Temperature</span>
      </div>
    </div>
  `;

  bindThermostatControls();
  subscribeThermostat();
  loadThermostatHistory(state.thermostatRange);
  state.thermostatHistoryTimer = setInterval(() => {
    loadThermostatHistory(state.thermostatRange);
  }, 60000);
}

function bindThermostatControls() {
  const setDown = document.getElementById("thermo-set-down");
  const setUp = document.getElementById("thermo-set-up");
  const diffDown = document.getElementById("thermo-diff-down");
  const diffUp = document.getElementById("thermo-diff-up");
  const modeButtons = document.getElementById("thermo-mode-buttons");
  const fanStart = document.getElementById("thermo-fan-start");
  const fanClear = document.getElementById("thermo-fan-clear");
  const scheduleRefresh = document.getElementById("thermo-schedule-refresh");
  const scheduleClear = document.getElementById("thermo-schedule-clear");
  const historyRefresh = document.getElementById("thermo-history-refresh");
  const historyButtons = document.querySelectorAll(".thermo-history-actions button[data-range]");

  const canEdit = !!state.user;
  const disableEls = [
    setDown,
    setUp,
    diffDown,
    diffUp,
    modeButtons,
    fanStart,
    fanClear,
    scheduleClear
  ];
  disableEls.forEach((el) => {
    if (!el) return;
    if (el.tagName === "BUTTON") {
      el.disabled = !canEdit;
    } else {
      el.querySelectorAll("button").forEach((btn) => {
        btn.disabled = !canEdit;
      });
    }
  });

  if (setDown) setDown.onclick = () => adjustThermostatConfig("setpointF", -0.5, 40, 90);
  if (setUp) setUp.onclick = () => adjustThermostatConfig("setpointF", 0.5, 40, 90);
  if (diffDown) diffDown.onclick = () => adjustThermostatConfig("diffF", -0.5, 0.1, 10);
  if (diffUp) diffUp.onclick = () => adjustThermostatConfig("diffF", 0.5, 0.1, 10);

  if (modeButtons) {
    modeButtons.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode");
        if (!mode) return;
        updateThermostatConfig({ mode });
      });
    });
  }

  if (fanStart) {
    fanStart.onclick = () => {
      if (!requireThermostatAuth("start fan timer")) return;
      const value = prompt("Fan runtime minutes (0-60)", "10");
      if (value == null) return;
      const minutes = Math.max(0, Math.min(60, Number(value) || 0));
      const now = Date.now();
      const fanUntil = minutes ? Math.floor((now + minutes * 60000) / 1000) : 0;
      updateThermostatConfig({ fanUntil });
    };
  }
  if (fanClear) {
    fanClear.onclick = () => updateThermostatConfig({ fanUntil: 0 });
  }

  if (scheduleRefresh) {
    scheduleRefresh.onclick = () => renderThermostatSchedule(state.thermostat?.config?.schedule);
  }
  if (scheduleClear) {
    scheduleClear.onclick = () => clearThermostatSchedule();
  }

  if (historyRefresh) {
    historyRefresh.onclick = () => loadThermostatHistory(state.thermostatRange);
  }
  historyButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const range = btn.getAttribute("data-range") || "day";
      state.thermostatRange = range;
      loadThermostatHistory(range);
    });
  });
}

function requireThermostatAuth(actionLabel) {
  if (state.user) return true;
  const note = document.getElementById("thermo-auth");
  if (note) note.textContent = `Sign in required to ${actionLabel}.`;
  return false;
}

async function updateThermostatConfig(partial) {
  if (!requireThermostatAuth("update thermostat config")) return;
  const ref = doc(db, "thermostats", state.thermostatId);
  await setDoc(ref, { config: partial }, { merge: true });
}

function adjustThermostatConfig(field, delta, min, max) {
  if (!requireThermostatAuth("update thermostat config")) return;
  const current = Number(state.thermostat?.config?.[field] ?? 0);
  const next = Math.min(Math.max(current + delta, min), max);
  updateThermostatConfig({ [field]: Number(next.toFixed(1)) });
}

function subscribeThermostat() {
  const ref = doc(db, "thermostats", state.thermostatId);
  state.thermostatUnsub = onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        state.thermostat = null;
        updateThermostatUI(null);
        return;
      }
      state.thermostat = snap.data();
      updateThermostatUI(state.thermostat);
    },
    (err) => {
      console.error("Thermostat listener error", err);
      updateThermostatUI(null);
    }
  );
}

function updateThermostatUI(data) {
  const pill = document.getElementById("thermo-status-pill");
  const tempEl = document.getElementById("thermo-temp");
  const feelEl = document.getElementById("thermo-feel");
  const humEl = document.getElementById("thermo-hum");
  const metaEl = document.getElementById("thermo-meta");
  const modePill = document.getElementById("thermo-mode-pill");
  const outputPill = document.getElementById("thermo-output-pill");
  const scheduleEl = document.getElementById("thermo-schedule-status");
  const wifiEl = document.getElementById("thermo-wifi");
  const sdEl = document.getElementById("thermo-sd");
  const setpointEl = document.getElementById("thermo-setpoint");
  const diffEl = document.getElementById("thermo-diff");
  const fanStatus = document.getElementById("thermo-fan-status");

  if (!data) {
    if (pill) {
      pill.className = "pill offline";
      pill.innerHTML = `<span class="dot"></span>Offline`;
    }
    if (tempEl) tempEl.textContent = "--";
    if (feelEl) feelEl.textContent = "--";
    if (humEl) humEl.textContent = "--";
    if (metaEl) metaEl.textContent = "Last update: --";
    if (modePill) modePill.innerHTML = `<span class="dot"></span>Mode: --`;
    if (outputPill) outputPill.innerHTML = `<span class="dot"></span>Outputs: --`;
    if (scheduleEl) scheduleEl.textContent = "Schedule: --";
    if (wifiEl) wifiEl.textContent = "WiFi: --";
    if (sdEl) sdEl.textContent = "SD: --";
    if (setpointEl) setpointEl.textContent = "--";
    if (diffEl) diffEl.textContent = "--";
    if (fanStatus) fanStatus.textContent = "--";
    renderThermostatSchedule([]);
    return;
  }

  const status = data.status || {};
  const config = data.config || {};
  const updatedAt = toDate(status.ts) || toDate(data.updatedAt);
  const ageMs = updatedAt ? Date.now() - updatedAt.getTime() : null;
  const online = ageMs != null && ageMs < 2 * 60 * 1000;
  const stale = ageMs != null && ageMs < 10 * 60 * 1000;

  if (pill) {
    pill.className = `pill ${online ? "online" : stale ? "stale" : "offline"}`;
    pill.innerHTML = `<span class="dot"></span>${online ? "Online" : stale ? "Stale" : "Offline"}`;
  }

  const temp = status.tempF ?? null;
  const feel = status.heatIndexF ?? null;
  const hum = status.humidity ?? null;
  if (tempEl) tempEl.textContent = temp != null ? `${Number(temp).toFixed(1)} F` : "--";
  if (feelEl) feelEl.textContent = feel != null ? `${Number(feel).toFixed(1)} F` : "--";
  if (humEl) humEl.textContent = hum != null ? `${Number(hum).toFixed(0)} %` : "--";

  if (metaEl) {
    metaEl.textContent = updatedAt ? `Last update: ${formatDate(updatedAt)}` : "Last update: --";
  }

  const mode = (status.mode || config.mode || "--").toString();
  if (modePill) {
    modePill.className = `pill ${thermostatModeClass(mode)}`;
    modePill.innerHTML = `<span class="dot"></span>Mode: ${mode}`;
  }

  const outputs = `Heat ${status.heatOn ? "ON" : "OFF"} | Cool ${status.coolOn ? "ON" : "OFF"} | Fan ${status.fanOn ? "ON" : "OFF"}`;
  if (outputPill) outputPill.innerHTML = `<span class="dot"></span>${outputs}`;

  if (scheduleEl) {
    const schedLabel = status.scheduleActive ? "Scheduled" : "Manual";
    const schedValue = status.scheduleSetpoint != null ? `${Number(status.scheduleSetpoint).toFixed(1)} F` : "";
    scheduleEl.textContent = `Schedule: ${schedLabel}${schedValue ? ` (${schedValue})` : ""}`;
  }

  const wifi = status.wifi || {};
  const wifiParts = [];
  if (wifi.ssid) wifiParts.push(wifi.ssid);
  if (wifi.ip) wifiParts.push(wifi.ip);
  if (wifi.rssi != null) wifiParts.push(`${wifi.rssi} dBm`);
  if (wifiEl) wifiEl.textContent = wifiParts.length ? `WiFi: ${wifiParts.join(" | ")}` : "WiFi: --";

  if (sdEl) {
    const sdOk = status.sdOk ? "OK" : "NO";
    const sdErr = status.sdError ? ` (${status.sdError})` : "";
    sdEl.textContent = `SD: ${sdOk}${sdErr}`;
  }

  if (setpointEl) {
    const sp = config.setpointF ?? status.setpointF;
    setpointEl.textContent = sp != null ? Number(sp).toFixed(1) : "--";
  }
  if (diffEl) {
    const diff = config.diffF ?? status.diffF;
    diffEl.textContent = diff != null ? Number(diff).toFixed(1) : "--";
  }

  if (fanStatus) {
    const fanUntil = config.fanUntil ?? status.fanUntil ?? 0;
    if (fanUntil && Number(fanUntil) > 0) {
      const untilDate = new Date(Number(fanUntil) * 1000);
      fanStatus.textContent = `Running until ${formatTimeOfDay(untilDate)}`;
    } else {
      fanStatus.textContent = "Not running";
    }
  }

  const modeButtons = document.querySelectorAll("#thermo-mode-buttons button");
  modeButtons.forEach((btn) => {
    const btnMode = btn.getAttribute("data-mode");
    btn.classList.toggle("active", btnMode === mode);
  });

  renderThermostatSchedule(config.schedule);
}

function renderThermostatSchedule(rawSchedule) {
  const schedule = normalizeThermostatSchedule(rawSchedule);
  const canEdit = !!state.user;
  const wrap = document.getElementById("thermo-schedule-grid");
  if (!wrap) return;

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];

  wrap.innerHTML = "";
  let pressTimer = null;

  function cancelPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function startPress(ev, dayIdx, bar) {
    if (!canEdit) return;
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      createBlock(ev, dayIdx, bar);
    }, 500);
  }

  function createBlock(ev, dayIdx, bar) {
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const start = Math.floor(pct * 24);
    const duration = parseInt(prompt(`Duration hours (1-24) starting at ${start}:00`, "2") || "0", 10);
    if (!duration || duration < 1 || duration > 24) return;
    const end = (start + duration - 1) % 24;
    const sp = parseFloat(prompt("Setpoint (F)", "70") || "70");
    applyScheduleBlock(dayIdx, start, end, sp);
  }

  function addSeg(bar, start, end, sp) {
    if (start < 0 || end < start) return;
    const seg = document.createElement("div");
    const left = (start / 24) * 100;
    const width = ((end - start + 1) / 24) * 100;
    seg.className = "thermo-seg";
    seg.style.left = `${left}%`;
    seg.style.width = `${width}%`;
    seg.style.background = "#2f74ff";
    seg.innerHTML = `<span>${sp.toFixed(0)} F</span>`;
    bar.appendChild(seg);
  }

  dayOrder.forEach((dayIdx, displayIdx) => {
    const hours = schedule[dayIdx];
    const row = document.createElement("div");
    row.className = "thermo-day-row";
    row.innerHTML = `<div class="thermo-day-name">${dayNames[displayIdx]}</div><div class="thermo-day-bar" data-day="${dayIdx}"></div>`;
    const bar = row.querySelector(".thermo-day-bar");
    bar.addEventListener("pointerdown", (e) => startPress(e, dayIdx, bar));
    bar.addEventListener("pointerup", cancelPress);
    bar.addEventListener("pointerleave", cancelPress);

    let start = -1;
    let lastSp = null;
    for (let h = 0; h < 25; h++) {
      const sp = h < 24 ? hours[h] : null;
      if (sp != null && lastSp == null) {
        start = h;
        lastSp = sp;
      } else if ((sp == null && lastSp != null) || (sp != null && lastSp != null && Math.abs(sp - lastSp) > 0.01)) {
        addSeg(bar, start, h - 1, lastSp);
        start = sp == null ? -1 : h;
        lastSp = sp;
      } else if (h === 24 && lastSp != null) {
        addSeg(bar, start, 23, lastSp);
      }
    }

    wrap.appendChild(row);
  });
}

function normalizeThermostatSchedule(rawSchedule) {
  const schedule = Array.isArray(rawSchedule) ? rawSchedule : [];
  const filled = [];
  for (let d = 0; d < 7; d++) {
    const day = Array.isArray(schedule[d]) ? schedule[d] : [];
    const row = [];
    for (let h = 0; h < 24; h++) {
      const value = Number(day[h]);
      row.push(Number.isFinite(value) ? value : null);
    }
    filled.push(row);
  }
  return filled;
}

async function applyScheduleBlock(dayIdx, start, end, setpoint) {
  if (!requireThermostatAuth("update schedule")) return;
  const schedule = normalizeThermostatSchedule(state.thermostat?.config?.schedule);
  let h = start;
  while (true) {
    schedule[dayIdx][h] = Number(setpoint.toFixed(1));
    if (h === end) break;
    h = (h + 1) % 24;
    if (h === start) break;
  }
  await updateThermostatConfig({ schedule });
  renderThermostatSchedule(schedule);
}

async function clearThermostatSchedule() {
  if (!requireThermostatAuth("clear schedule")) return;
  const schedule = normalizeThermostatSchedule([]);
  await updateThermostatConfig({ schedule });
  renderThermostatSchedule(schedule);
}

async function loadThermostatHistory(range) {
  const canvas = document.getElementById("thermo-chart");
  if (!canvas) return;
  const now = Date.now();
  let cutoff = 0;
  if (range === "day") cutoff = now - 24 * 60 * 60 * 1000;
  if (range === "week") cutoff = now - 7 * 24 * 60 * 60 * 1000;
  if (range === "month") cutoff = now - 30 * 24 * 60 * 60 * 1000;

  const startDate = cutoff ? new Date(cutoff) : new Date(0);
  const endDate = new Date();

  try {
    const q = query(
      collection(db, "thermostats", state.thermostatId, "history"),
      orderBy("ts"),
      startAt(startDate),
      endAt(endDate),
      limit(THERMOSTAT_HISTORY_LIMIT)
    );
    const snap = await getDocs(q);
    const points = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const ts = toDate(d.ts);
      if (!ts) return;
      points.push({
        ts,
        tempF: d.tempF != null ? Number(d.tempF) : null,
        setpointF: d.setpointF != null ? Number(d.setpointF) : null
      });
    });
    state.thermostatHistory = points;
    drawThermostatHistory(points, range);
  } catch (err) {
    console.error("Thermostat history load error", err);
    drawThermostatHistory([], range);
  }
}

function drawThermostatHistory(points, range) {
  const canvas = document.getElementById("thermo-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!points.length) {
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("No history yet.", 20, 30);
    return;
  }

  const temps = points.map((p) => p.tempF).filter((v) => v != null);
  const sets = points.map((p) => p.setpointF).filter((v) => v != null);
  const minVal = Math.min(...temps, ...sets);
  const maxVal = Math.max(...temps, ...sets);
  const minTs = points[0].ts.getTime();
  const maxTs = points[points.length - 1].ts.getTime();
  const pad = 30;
  const h = canvas.height - 2 * pad;
  const w = canvas.width - 2 * pad;

  function y(v) {
    if (maxVal === minVal) return canvas.height / 2;
    return pad + h - ((v - minVal) / (maxVal - minVal)) * h;
  }
  function x(t) {
    if (maxTs === minTs) return pad + w / 2;
    return pad + ((t - minTs) / (maxTs - minTs)) * w;
  }
  function line(color, key) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    let first = true;
    points.forEach((p) => {
      const v = p[key];
      if (v == null) return;
      const px = x(p.ts.getTime());
      const py = y(v);
      if (first) {
        ctx.moveTo(px, py);
        first = false;
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();
  }

  line("#2f74ff", "setpointF");
  line("#30d158", "tempF");

  ctx.strokeStyle = "#222a35";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, canvas.height - pad);
  ctx.lineTo(canvas.width - pad, canvas.height - pad);
  ctx.stroke();

  ctx.fillStyle = "#94a3b8";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const t = minTs + (i / (ticks - 1)) * (maxTs - minTs);
    const px = x(t);
    const label = range === "day"
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString();
    ctx.fillText(label, px, canvas.height - pad + 4);
    ctx.beginPath();
    ctx.moveTo(px, canvas.height - pad);
    ctx.lineTo(px, canvas.height - pad - 4);
    ctx.strokeStyle = "#444d5e";
    ctx.stroke();
  }
}

function renderHome() {
  cleanupListeners();
  const authNote = state.user ? "" : `<p class="muted">Viewing public data. Sign in to edit devices.</p>`;
  const debugPanel = buildDebugPanel();

  view.innerHTML = `
    <div class="section-header">
      <div>
        <h1>Devices</h1>
        <p class="muted">Live status from Firestore</p>
        ${authNote}
      </div>
      <button class="btn" type="button" id="add-device-btn">Add device (admin)</button>
    </div>
    <div id="device-grid" class="device-grid"></div>
    ${debugPanel}
  `;

  const grid = document.getElementById("device-grid");
  const addBtn = document.getElementById("add-device-btn");
  if (addBtn && !state.user) {
    addBtn.disabled = true;
    addBtn.title = "Sign in required.";
  }
  const q = query(collection(db, "devices"), orderBy("updatedAt", "desc"));

  state.unsubDevices = onSnapshot(
    q,
    (snap) => {
      state.debug.devicesError = null;
      updateDebugPanel();
      grid.innerHTML = "";
      if (snap.empty) {
        grid.innerHTML = `<div class="placeholder"><p class="muted">No devices yet.</p></div>`;
        return;
      }
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        const card = buildDeviceCard(docSnap.id, data);
        grid.appendChild(card);
      });
    },
    (err) => {
      console.error("Device load error", err);
      state.debug.devicesError = err?.message || String(err);
      updateDebugPanel();
      grid.innerHTML = `<div class="placeholder"><p class="muted">Error loading devices: ${err.message}</p></div>`;
    }
  );

  updateDebugPanel();
}

function buildDeviceCard(id, data) {
  const card = document.createElement("div");
  card.className = "card";

  const status = computeStatus(data);
  const lastDate = toDate(data?.last?.ts) || toDate(data?.updatedAt);
  const battery = data?.last?.battery ?? data?.battery;
  const typeLabel = data?.type ?? "unknown";
  const config = withConfigDefaults(data?.config, data?.last);
  const forceActive = isForceActive(config.forceRoamUntil);
  const modeLabel = forceActive ? "force" : normalizeMode(data?.mode || data?.last?.mode) || "unknown";

  card.innerHTML = `
    <div class="actions">
      <h3>${data?.name || id}</h3>
      <span class="pill ${status}">
        <span class="dot"></span>
        ${status.toUpperCase()}
      </span>
    </div>
    <div class="meta">
      <span>Type: ${typeLabel}</span>
      <span>Battery: ${battery != null ? `${battery}%` : "n/a"}</span>
      <span>Mode: ${modeLabel}</span>
    </div>
    <p class="muted">Last update: ${lastDate ? formatDate(lastDate) : "n/a"}</p>
    <div class="actions">
      <div class="pill">ID: ${id}</div>
      ${renderTrackLink(id, typeLabel)}
    </div>
  `;

  return card;
}

function renderTrackLink(id, typeLabel) {
  const type = (typeLabel || "").toLowerCase();
  if (type === "dog" || type === "pet") {
    return `<a class="btn" href="#/dog/${id}" aria-label="Track ${id}">Track ${type} &rarr;</a>`;
  }
  return `<span class="muted">No route</span>`;
}

function renderDog(deviceId, label = "Dog") {
  cleanupListeners();
  state.lastDeviceId = deviceId;
  state.selectedDay = startOfDay(new Date());
  state.timelineCursorMin = minutesSinceMidnight(new Date());
  state.historyWindowMinutes = DEFAULT_WINDOW_MINUTES;
  state.historyPoints = [];
  state.debug.deviceError = null;
  state.debug.historyError = null;
  state.debug.lastDeviceId = deviceId;
  const authNote = state.user ? "" : `<p class="muted">Viewing public data. Sign in to edit settings.</p>`;
  const debugPanel = buildDebugPanel();

  view.innerHTML = `
    <div class="section-header">
      <div>
        <a class="back-link" href="#/home">&larr; Back</a>
        <h2 id="dog-title">${label} tracker</h2>
        <p class="muted">Live location for <span id="dog-id">${deviceId}</span></p>
        ${authNote}
      </div>
      <span class="pill online" id="dog-status"><span class="dot"></span>Online</span>
    </div>

    <div id="map" class="map"></div>

    <div class="stats-grid">
      <div class="stat">
        <div class="label">Battery</div>
        <div class="value" id="stat-battery">-</div>
      </div>
      <div class="stat">
        <div class="label">Satellites</div>
        <div class="value" id="stat-sats">-</div>
      </div>
      <div class="stat">
        <div class="label">HDOP</div>
        <div class="value" id="stat-hdop">-</div>
      </div>
      <div class="stat">
        <div class="label">Speed</div>
        <div class="value" id="stat-speed">-</div>
      </div>
      <div class="stat">
        <div class="label">Mode</div>
        <div class="value" id="stat-mode">-</div>
      </div>
      <div class="stat">
        <div class="label">Last ping</div>
        <div class="value" id="stat-ping">-</div>
      </div>
      <div class="stat">
        <div class="label">Network</div>
        <div class="value" id="stat-net">-</div>
      </div>
      <div class="stat">
        <div class="label">Data usage</div>
        <div class="value" id="stat-usage">-</div>
      </div>
      <div class="stat">
        <div class="label">Last update</div>
        <div class="value" id="stat-updated">-</div>
      </div>
    </div>

    <div class="mode-row">
      <div class="pill" id="mode-pill"><span class="dot"></span>Mode: -</div>
      <div class="pill" id="force-pill">Force roaming: off</div>
      <div class="mode-actions">
        <button class="btn" type="button" id="force-roam-btn">Force roaming</button>
        <button class="btn ghost" type="button" id="clear-force-btn">Clear override</button>
      </div>
    </div>

    <div class="card config-card">
      <div class="section-header">
        <h3>Geofence config</h3>
        <p class="muted" id="home-label">Home: not set</p>
      </div>
      <div class="config-grid">
        <label>Inner radius (ft)<input type="number" id="config-inner-ft" min="0" step="1"></label>
        <label>Outer radius (ft)<input type="number" id="config-outer-ft" min="0" step="1"></label>
        <label>Wi-Fi min RSSI (dBm)<input type="number" id="config-rssi" step="1"></label>
        <label>Ping: Home (sec)<input type="number" id="config-ping-home" min="0" step="1"></label>
        <label>Ping: Nearby (sec)<input type="number" id="config-ping-nearby" min="0" step="1"></label>
        <label>Ping: Roaming (sec)<input type="number" id="config-ping-roaming" min="0" step="1"></label>
        <label>Battery upload threshold (%)<input type="number" id="config-battery" min="0" max="100" step="1"></label>
      </div>
      <div class="config-actions">
        <button class="btn" type="button" id="save-config-btn">Save config</button>
        <button class="btn ghost" type="button" id="set-home-btn">Set home = current</button>
      </div>
    </div>

    <div class="card">
      <div class="section-header">
        <h3>History</h3>
        <div class="day-nav">
          <button class="btn ghost" type="button" id="day-prev-btn">&larr;</button>
          <span id="day-label" class="muted"></span>
          <button class="btn ghost" type="button" id="day-next-btn">&rarr;</button>
        </div>
      </div>
      <div class="timeline-row">
        <label class="label">Timeline scrubber (minutes)
          <input type="range" id="timeline-range" min="0" max="1440" step="1">
        </label>
        <div class="history-meta" id="timeline-label">Adjust scrubber to view track.</div>
      </div>
      <div class="history-meta" id="history-meta">Loading history...</div>
    </div>
    ${debugPanel}
  `;

  initMap();
  bindConfigHandlers(deviceId);
  setupTimelineControls(deviceId);
  subscribeDevice(deviceId);
  loadHistory(deviceId, state.selectedDay);
  state.historyTimer = setInterval(() => loadHistory(deviceId, state.selectedDay), 30000);

  updateDebugPanel();
}

function bindConfigHandlers(deviceId) {
  const saveBtn = document.getElementById("save-config-btn");
  if (saveBtn) {
    saveBtn.disabled = !state.user;
    saveBtn.title = state.user ? "" : "Sign in required.";
    saveBtn.onclick = () => saveConfig(deviceId);
  }
  const setHomeBtn = document.getElementById("set-home-btn");
  if (setHomeBtn) {
    setHomeBtn.disabled = !state.user;
    setHomeBtn.title = state.user ? "" : "Sign in required.";
    setHomeBtn.onclick = () => setHomeToCurrent(deviceId);
  }
}

function setupTimelineControls(deviceId) {
  const range = document.getElementById("timeline-range");
  const prevBtn = document.getElementById("day-prev-btn");
  const nextBtn = document.getElementById("day-next-btn");

  updateDayLabel();

  if (range) {
    range.value = state.timelineCursorMin;
    range.oninput = (e) => {
      state.timelineCursorMin = Number(e.target.value) || 0;
      renderTimelineSlice();
    };
  }

  if (prevBtn) {
    prevBtn.onclick = () => {
      state.selectedDay = addDays(state.selectedDay, -1);
      updateDayLabel();
      loadHistory(deviceId, state.selectedDay);
    };
  }

  if (nextBtn) {
    nextBtn.onclick = () => {
      const maybeNext = addDays(state.selectedDay, 1);
      if (maybeNext > startOfDay(new Date())) return;
      state.selectedDay = maybeNext;
      updateDayLabel();
      loadHistory(deviceId, state.selectedDay);
    };
  }
}

function subscribeDevice(deviceId) {
  const ref = doc(db, "devices", deviceId);
  state.unsubDevice = onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        state.debug.deviceError = "Device doc not found";
        updateDebugPanel();
        view.innerHTML = `<div class="placeholder"><h2>Device not found</h2><p class="muted">${deviceId}</p></div>`;
        return;
      }
      state.debug.deviceError = null;
      updateDebugPanel();
      const data = snap.data();
      updateDogUI(deviceId, data);
    },
    (err) => {
      console.error("Device listener error", err);
      state.debug.deviceError = err?.message || String(err);
      updateDebugPanel();
      const meta = document.getElementById("history-meta");
      if (meta) meta.textContent = `Error: ${err.message}`;
    }
  );
}

async function loadHistory(deviceId, day = state.selectedDay || startOfDay(new Date())) {
  const histMeta = document.getElementById("history-meta");
  if (!histMeta) return;
  histMeta.textContent = "Loading history...";

  const dayStart = startOfDay(day);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  try {
    const q = query(
      collection(db, "devices", deviceId, "points"),
      orderBy("ts"),
      startAt(dayStart),
      endAt(dayEnd),
      limit(HISTORY_LIMIT)
    );
    const snap = await getDocs(q);
    state.debug.historyError = null;
    updateDebugPanel();
    const points = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const tsDate = toDate(d.ts);
      if (d.lat != null && d.lon != null && tsDate) {
        points.push({
          lat: Number(d.lat),
          lon: Number(d.lon),
          ts: tsDate
        });
      }
    });
    state.historyPoints = points;
    const slice = renderTimelineSlice();
    histMeta.textContent = points.length
      ? `History points: ${points.length} (showing ${slice.length})`
      : "No history points for this day.";
  } catch (err) {
    console.error("History load error", err);
    state.debug.historyError = err?.message || String(err);
    updateDebugPanel();
    histMeta.textContent = `History error: ${err.message}`;
  }
}

function renderTimelineSlice() {
  const labelEl = document.getElementById("timeline-label");
  const range = document.getElementById("timeline-range");
  if (range && range.value !== String(state.timelineCursorMin)) {
    range.value = state.timelineCursorMin;
  }

  const slice = filterPointsForWindow(
    state.historyPoints,
    state.selectedDay,
    state.timelineCursorMin,
    state.historyWindowMinutes
  );
  const reduced = downsamplePoints(slice, HISTORY_RENDER_LIMIT);
  drawHistory(reduced);

  const dayStart = startOfDay(state.selectedDay || new Date());
  const cursorDate = new Date(dayStart.getTime() + state.timelineCursorMin * 60000);

  if (labelEl) {
    labelEl.textContent = slice.length
      ? `Showing ${state.historyWindowMinutes} min ending ${formatTimeOfDay(cursorDate)} (${slice.length} / ${state.historyPoints.length})`
      : `No points in last ${state.historyWindowMinutes} min before ${formatTimeOfDay(cursorDate)}`;
  }

  const histMeta = document.getElementById("history-meta");
  if (histMeta && state.historyPoints.length && slice.length === 0) {
    const dayLabel = formatDayLabel(state.selectedDay);
    histMeta.textContent = `No points in selected window on ${dayLabel}.`;
  }

  return slice;
}

function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  if (state.map) {
    state.map.remove();
    state.map = null;
  }

  state.map = L.map(mapEl).setView([0, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "OpenStreetMap contributors"
  }).addTo(state.map);
}

function updateDogUI(deviceId, data) {
  const title = document.getElementById("dog-title");
  const idLabel = document.getElementById("dog-id");
  const statusEl = document.getElementById("dog-status");
  const batteryEl = document.getElementById("stat-battery");
  const satsEl = document.getElementById("stat-sats");
  const hdopEl = document.getElementById("stat-hdop");
  const speedEl = document.getElementById("stat-speed");
  const updatedEl = document.getElementById("stat-updated");
  const modeEl = document.getElementById("stat-mode");
  const pingEl = document.getElementById("stat-ping");
  const netEl = document.getElementById("stat-net");
  const usageEl = document.getElementById("stat-usage");

  if (!title) return;

  state.lastSnapshot = data;
  const last = data?.last || {};
  const config = withConfigDefaults(data?.config, last);
  state.currentConfig = config;

  title.textContent = data?.name || "Tracker";
  if (idLabel) idLabel.textContent = deviceId;

  const status = computeStatus(data);
  const lastDate = toDate(last?.ts) || toDate(data?.updatedAt);
  const mode = deriveMode(data, config);
  const netKind = last?.netKind || last?.net?.kind || last?.network || "-";

  if (statusEl) {
    statusEl.className = `pill ${status}`;
    statusEl.innerHTML = `<span class="dot"></span>${status.toUpperCase()}`;
  }

  if (batteryEl) batteryEl.textContent = last?.battery != null ? `${last.battery}%` : "-";
  if (satsEl) satsEl.textContent = last?.sats != null ? last.sats : "-";
  if (hdopEl) hdopEl.textContent = last?.hdop != null ? last.hdop : "-";
  if (speedEl)
    speedEl.textContent = last?.speedMph != null ? `${Number(last.speedMph).toFixed(1)} mph` : "-";
  if (updatedEl) updatedEl.textContent = lastDate ? formatDate(lastDate) : "-";
  if (modeEl) modeEl.textContent = mode;
  if (pingEl) pingEl.textContent = formatAge(lastDate);
  if (netEl) netEl.textContent = netKind;
  if (usageEl) usageEl.textContent = formatDataUsage(data?.counters?.monthBytes);

  updateModeUI(deviceId, data, config);
  updateConfigUI(config, last);

  const lat = Number(last?.lat);
  const lon = Number(last?.lon);
  if (state.map && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    const pos = [lat, lon];
    if (!state.marker) {
      state.marker = L.marker(pos).addTo(state.map);
    } else {
      state.marker.setLatLng(pos);
    }
    if (!state.polyline) {
      state.map.setView(pos, 15);
    }
  }

  updateDebugPanel();
}

function updateModeUI(deviceId, data, config) {
  const modePill = document.getElementById("mode-pill");
  const forcePill = document.getElementById("force-pill");
  const forceBtn = document.getElementById("force-roam-btn");
  const clearBtn = document.getElementById("clear-force-btn");
  const canEdit = !!state.user;

  const forceUntil = toDate(config?.forceRoamUntil);
  const forceActive = isForceActive(config?.forceRoamUntil);
  const mode = deriveMode(data, config);

  if (modePill) {
    modePill.className = `pill ${modeClass(mode)}`;
    modePill.innerHTML = `<span class="dot"></span>Mode: ${mode}`;
  }

  if (forcePill) {
    const label = forceActive && forceUntil
      ? `Force roaming until ${formatTimeOfDay(forceUntil)}`
      : "Force roaming: off";
    forcePill.className = `pill ${forceActive ? "online" : "stale"}`;
    forcePill.textContent = label;
  }

  if (forceBtn) {
    forceBtn.disabled = !canEdit || forceActive;
    forceBtn.title = canEdit ? "" : "Sign in required.";
    forceBtn.onclick = () => setForceRoaming(deviceId, 20);
  }
  if (clearBtn) {
    clearBtn.disabled = !canEdit || (!forceActive && !config?.forceRoamUntil);
    clearBtn.title = canEdit ? "" : "Sign in required.";
    clearBtn.onclick = () => clearForceRoaming(deviceId);
  }
}

async function setForceRoaming(deviceId, minutes) {
  if (!requireAuth("force roaming")) return;
  const meta = document.getElementById("history-meta");
  if (meta) meta.textContent = "Enabling force roaming...";
  try {
    const expiresAt = Timestamp.fromMillis(Date.now() + minutes * 60 * 1000);
    await setDoc(
      doc(db, "devices", deviceId),
      { config: { forceRoamUntil: expiresAt } },
      { merge: true }
    );
    if (meta) meta.textContent = `Force roaming set for ${minutes} minutes.`;
  } catch (err) {
    console.error("Force roaming update failed", err);
    if (meta) meta.textContent = `Force roaming error: ${err.message}`;
  }
}

async function clearForceRoaming(deviceId) {
  if (!requireAuth("clear overrides")) return;
  const meta = document.getElementById("history-meta");
  if (meta) meta.textContent = "Clearing override...";
  try {
    await setDoc(
      doc(db, "devices", deviceId),
      { config: { forceRoamUntil: null } },
      { merge: true }
    );
    if (meta) meta.textContent = "Override cleared.";
  } catch (err) {
    console.error("Clear force roaming failed", err);
    if (meta) meta.textContent = `Force roaming error: ${err.message}`;
  }
}

async function saveConfig(deviceId) {
  if (!requireAuth("save config")) return;
  const meta = document.getElementById("history-meta");
  if (meta) meta.textContent = "Saving config...";
  try {
    const config = readConfigInputs();
    await setDoc(doc(db, "devices", deviceId), { config }, { merge: true });
    if (meta) meta.textContent = "Config saved.";
  } catch (err) {
    console.error("Config save failed", err);
    if (meta) meta.textContent = `Config error: ${err.message}`;
  }
}

async function setHomeToCurrent(deviceId) {
  if (!requireAuth("set home")) return;
  const meta = document.getElementById("history-meta");
  const last = state.lastSnapshot?.last;
  const lat = toNumber(last?.lat);
  const lon = toNumber(last?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    if (meta) meta.textContent = "No last location to set home.";
    return;
  }
  if (meta) meta.textContent = "Updating home location...";
  const newHome = { lat, lon };
  try {
    await setDoc(
      doc(db, "devices", deviceId),
      { config: { home: newHome } },
      { merge: true }
    );
    state.currentConfig = { ...(state.currentConfig || DEFAULT_CONFIG), home: newHome };
    updateConfigUI(state.currentConfig, last);
    if (meta) meta.textContent = "Home location set to last point.";
  } catch (err) {
    console.error("Set home failed", err);
    if (meta) meta.textContent = `Home update error: ${err.message}`;
  }
}

function readConfigInputs() {
  const innerFt = toNumber(document.getElementById("config-inner-ft")?.value, DEFAULT_CONFIG.geofence.innerFt);
  const outerFt = toNumber(document.getElementById("config-outer-ft")?.value, DEFAULT_CONFIG.geofence.outerFt);
  const wifiRssiMin = toNumber(document.getElementById("config-rssi")?.value, DEFAULT_CONFIG.wifiRssiMin);
  const pingHome = toNumber(document.getElementById("config-ping-home")?.value, DEFAULT_CONFIG.ping.homeSec);
  const pingNearby = toNumber(document.getElementById("config-ping-nearby")?.value, DEFAULT_CONFIG.ping.nearbySec);
  const pingRoaming = toNumber(document.getElementById("config-ping-roaming")?.value, DEFAULT_CONFIG.ping.roamingSec);
  const batteryUploadThreshold = toNumber(
    document.getElementById("config-battery")?.value,
    DEFAULT_CONFIG.batteryUploadThreshold
  );

  return {
    home: state.currentConfig?.home ?? null,
    geofence: { innerFt, outerFt },
    forceRoamUntil: state.currentConfig?.forceRoamUntil ?? null,
    wifiRssiMin,
    ping: {
      homeSec: pingHome,
      nearbySec: pingNearby,
      roamingSec: pingRoaming
    },
    batteryUploadThreshold
  };
}

function updateConfigUI(config, last) {
  const homeLabel = document.getElementById("home-label");
  if (homeLabel) {
    const home = config?.home;
    homeLabel.textContent = home && Number.isFinite(home.lat) && Number.isFinite(home.lon)
      ? `Home: ${Number(home.lat).toFixed(5)}, ${Number(home.lon).toFixed(5)}`
      : "Home: not set";
  }

  const setHomeBtn = document.getElementById("set-home-btn");
  if (setHomeBtn) {
    const hasLast = Number.isFinite(toNumber(last?.lat)) && Number.isFinite(toNumber(last?.lon));
    setHomeBtn.disabled = !state.user || !hasLast;
    setHomeBtn.title = state.user ? "" : "Sign in required.";
  }

  const entries = [
    { id: "config-inner-ft", value: config?.geofence?.innerFt ?? DEFAULT_CONFIG.geofence.innerFt },
    { id: "config-outer-ft", value: config?.geofence?.outerFt ?? DEFAULT_CONFIG.geofence.outerFt },
    { id: "config-rssi", value: config?.wifiRssiMin ?? DEFAULT_CONFIG.wifiRssiMin },
    { id: "config-ping-home", value: config?.ping?.homeSec ?? DEFAULT_CONFIG.ping.homeSec },
    { id: "config-ping-nearby", value: config?.ping?.nearbySec ?? DEFAULT_CONFIG.ping.nearbySec },
    { id: "config-ping-roaming", value: config?.ping?.roamingSec ?? DEFAULT_CONFIG.ping.roamingSec },
    { id: "config-battery", value: config?.batteryUploadThreshold ?? DEFAULT_CONFIG.batteryUploadThreshold }
  ];

  entries.forEach(({ id, value }) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) {
      el.value = value ?? "";
    }
  });
}

function drawHistory(points) {
  if (!state.map) return;
  if (state.polyline) {
    state.polyline.remove();
    state.polyline = null;
  }
  if (!points.length) return;

  const latlngs = points.map((p) => [p.lat, p.lon]);
  state.polyline = L.polyline(latlngs, {
    color: "#22d3ee",
    weight: 4,
    opacity: 0.8
  }).addTo(state.map);

  state.map.fitBounds(state.polyline.getBounds(), { padding: [30, 30] });
}

function computeStatus(data) {
  const lastDate = toDate(data?.last?.ts) || toDate(data?.updatedAt);
  if (!lastDate) return "offline";
  const diff = Date.now() - lastDate.getTime();
  return diff <= 10 * 60 * 1000 ? "online" : "stale";
}

function deriveMode(data, config) {
  if (isForceActive(config?.forceRoamUntil)) return "force";
  return normalizeMode(data?.mode || data?.last?.mode || "unknown");
}

function normalizeMode(mode) {
  if (!mode) return "unknown";
  const m = String(mode).toLowerCase();
  if (m.includes("force")) return "force";
  if (m.includes("home")) return "home";
  if (m.includes("near")) return "nearby";
  if (m.includes("roam")) return "roaming";
  return mode;
}

function modeClass(mode) {
  switch (mode) {
    case "home":
      return "online";
    case "nearby":
      return "stale";
    case "roaming":
    case "force":
      return "online";
    default:
      return "offline";
  }
}

function thermostatModeClass(mode) {
  const value = String(mode || "").toLowerCase();
  if (value === "heat" || value === "cool" || value === "fan") return "online";
  if (value === "off") return "stale";
  return "offline";
}

function withConfigDefaults(config, last) {
  const home = config?.home ?? (last?.lat != null && last?.lon != null
    ? { lat: Number(last.lat), lon: Number(last.lon) }
    : null);

  return {
    home,
    geofence: {
      innerFt: toNumber(config?.geofence?.innerFt, DEFAULT_CONFIG.geofence.innerFt),
      outerFt: toNumber(config?.geofence?.outerFt, DEFAULT_CONFIG.geofence.outerFt)
    },
    forceRoamUntil: config?.forceRoamUntil ?? null,
    wifiRssiMin: toNumber(config?.wifiRssiMin, DEFAULT_CONFIG.wifiRssiMin),
    ping: {
      homeSec: toNumber(config?.ping?.homeSec, DEFAULT_CONFIG.ping.homeSec),
      nearbySec: toNumber(config?.ping?.nearbySec, DEFAULT_CONFIG.ping.nearbySec),
      roamingSec: toNumber(config?.ping?.roamingSec, DEFAULT_CONFIG.ping.roamingSec)
    },
    batteryUploadThreshold: toNumber(
      config?.batteryUploadThreshold,
      DEFAULT_CONFIG.batteryUploadThreshold
    )
  };
}

function filterPointsForWindow(points, day, cursorMinutes, windowMinutes) {
  if (!points?.length) return [];
  const dayStart = startOfDay(day || new Date()).getTime();
  const cursor = dayStart + cursorMinutes * 60000;
  const windowStart = cursor - windowMinutes * 60000;
  return points.filter((p) => {
    const ts = p.ts?.getTime?.();
    return ts != null && ts >= windowStart && ts <= cursor;
  });
}

function downsamplePoints(points, maxPoints) {
  if (!points || points.length <= maxPoints) return points || [];
  const step = Math.ceil(points.length / maxPoints);
  const sampled = [];
  for (let i = 0; i < points.length; i += step) {
    sampled.push(points[i]);
  }
  if (sampled[sampled.length - 1] !== points[points.length - 1]) {
    sampled.push(points[points.length - 1]);
  }
  return sampled;
}

function updateDayLabel() {
  const label = document.getElementById("day-label");
  const nextBtn = document.getElementById("day-next-btn");
  if (label) label.textContent = formatDayLabel(state.selectedDay);
  if (nextBtn) nextBtn.disabled = startOfDay(state.selectedDay) >= startOfDay(new Date());
}

function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts === "number") return new Date(ts);
  if (typeof ts === "string") return new Date(ts);
  if (ts.toDate) return ts.toDate();
  if (ts.seconds != null) return new Date(ts.seconds * 1000);
  return null;
}

function formatDate(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatTimeOfDay(date) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatAge(date) {
  if (!date) return "-";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "0s";
  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  if (minutes <= 0) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ${seconds}s ago`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m ago`;
}

function formatDataUsage(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "-";
  const mb = Number(bytes) / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function toNumber(value, fallback = undefined) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return fallback;
}

function isForceActive(forceUntil) {
  const d = toDate(forceUntil);
  if (!d) return false;
  return d.getTime() > Date.now();
}

function startOfDay(date) {
  const d = new Date(date || new Date());
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, delta) {
  const d = new Date(date || new Date());
  d.setDate(d.getDate() + delta);
  return startOfDay(d);
}

function minutesSinceMidnight(date) {
  const d = new Date(date || new Date());
  return d.getHours() * 60 + d.getMinutes();
}

function formatDayLabel(date) {
  const target = startOfDay(date || new Date());
  const today = startOfDay(new Date());
  if (target.getTime() === today.getTime()) return "Today";
  const yesterday = addDays(today, -1);
  if (target.getTime() === yesterday.getTime()) return "Yesterday";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(target);
}

function toggleAuthButtons(disabled) {
  signInBtn.disabled = disabled || !!state.user;
  signOutBtn.disabled = disabled || !state.user;
}

function cleanupListeners() {
  if (state.unsubDevices) {
    state.unsubDevices();
    state.unsubDevices = null;
  }
  if (state.unsubDevice) {
    state.unsubDevice();
    state.unsubDevice = null;
  }
  if (state.historyTimer) {
    clearInterval(state.historyTimer);
    state.historyTimer = null;
  }
  if (state.thermostatHistoryTimer) {
    clearInterval(state.thermostatHistoryTimer);
    state.thermostatHistoryTimer = null;
  }
  if (state.thermostatUnsub) {
    state.thermostatUnsub();
    state.thermostatUnsub = null;
  }
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  state.marker = null;
  state.polyline = null;
  state.historyPoints = [];
  state.selectedDay = startOfDay(new Date());
  state.timelineCursorMin = minutesSinceMidnight(new Date());
  state.currentConfig = null;
  state.lastSnapshot = null;
  state.thermostat = null;
  state.thermostatHistory = [];
  state.debug.deviceError = null;
  state.debug.devicesError = null;
  state.debug.historyError = null;
  state.debug.lastDeviceId = null;
}

function buildDebugPanel() {
  return `
    <div class="card" id="debug-panel">
      <div class="section-header">
        <h3>Debug</h3>
        <span class="pill" id="debug-auth-pill"><span class="dot"></span>Auth: -</span>
      </div>
      <div class="meta">
        <span>Project: ${firebaseConfig?.projectId || "-"}</span>
        <span>Device ID: ${state.debug.lastDeviceId || defaultDeviceId || "-"}</span>
        <span>Devices error: <span id="debug-devices-error">-</span></span>
        <span>Device error: <span id="debug-device-error">-</span></span>
        <span>History error: <span id="debug-history-error">-</span></span>
      </div>
      <div class="meta">
        <span>Last update: <span id="debug-last-update">-</span></span>
        <span>Last lat/lon: <span id="debug-last-coords">-</span></span>
        <span>Points today: <span id="debug-history-count">-</span></span>
      </div>
    </div>
  `;
}

function updateDebugPanel() {
  const panel = document.getElementById("debug-panel");
  if (!panel) return;

  const authPill = document.getElementById("debug-auth-pill");
  if (authPill) {
    const authed = !!state.user;
    authPill.className = `pill ${authed ? "online" : "stale"}`;
    authPill.innerHTML = `<span class="dot"></span>Auth: ${authed ? "signed-in" : "public"}`;
  }

  const devicesErr = document.getElementById("debug-devices-error");
  if (devicesErr) devicesErr.textContent = state.debug.devicesError || "-";
  const deviceErr = document.getElementById("debug-device-error");
  if (deviceErr) deviceErr.textContent = state.debug.deviceError || "-";
  const historyErr = document.getElementById("debug-history-error");
  if (historyErr) historyErr.textContent = state.debug.historyError || "-";

  const last = state.lastSnapshot?.last;
  const lastUpdate = toDate(last?.ts) || toDate(state.lastSnapshot?.updatedAt);
  const lastUpdateEl = document.getElementById("debug-last-update");
  if (lastUpdateEl) lastUpdateEl.textContent = lastUpdate ? formatDate(lastUpdate) : "-";

  const coordsEl = document.getElementById("debug-last-coords");
  if (coordsEl && last?.lat != null && last?.lon != null) {
    coordsEl.textContent = `${Number(last.lat).toFixed(5)}, ${Number(last.lon).toFixed(5)}`;
  } else if (coordsEl) {
    coordsEl.textContent = "-";
  }

  const historyCountEl = document.getElementById("debug-history-count");
  if (historyCountEl) historyCountEl.textContent = String(state.historyPoints?.length || 0);
}

