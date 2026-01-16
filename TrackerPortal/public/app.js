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
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  addDoc,
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
const DEFAULT_PROPANE_CAPACITY = 400;
const GEOFENCE_NAMES = ["nearby", "roaming"];

const state = {
  user: null,
  unsubDevices: null,
  unsubDevice: null,
  historyTimer: null,
  map: null,
  marker: null,
  polyline: null,
  geofencePolygons: {},
  drawingManager: null,
  selectedGeofence: "nearby",
  lastDeviceId: null,
  selectedDay: null,
  historyWindowMinutes: DEFAULT_WINDOW_MINUTES,
  historyPoints: [],
  currentConfig: null,
  lastSnapshot: null,
  thermostatUnsub: null,
  pendingNet: null,
  propaneUnsub: null,
  thermostatHistoryTimer: null,
  thermostatId: DEFAULT_THERMOSTAT_ID,
  thermostat: null,
  thermostatHistory: [],
  propaneReadings: [],
  propaneStats: null,
  outsideHistory: [],
  scheduleNames: [],
  scheduleZoom: 24,
  thermostatRange: "day",
  timelineStartMin: 0,
  timelineEndMin: 1440,
  timelineHoverTs: null,
  historyMarkers: [],
  hoverMarker: null,
  mapInfoWindow: null,
  timelineMouseUpHandler: null,
  debug: {
    deviceError: null,
    devicesError: null,
    historyError: null,
    lastDeviceId: null
  }
};

let googleMapsPromise = null;

async function loadGoogleMaps() {
  if (window.google?.maps) return window.google.maps;
  if (!googleMapsPromise) {
    const key = ingestConfig?.googleMapsApiKey || window.googleMapsApiKey || "";
    if (!key) {
      console.error("Google Maps API key missing. Set ingestConfig.googleMapsApiKey in public/firebase-config.js");
      googleMapsPromise = Promise.resolve(null);
    } else {
      googleMapsPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const libs = ingestConfig?.googleMapsLibraries || "drawing";
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=${encodeURIComponent(libs)}`;
        script.async = true;
        script.onload = () => resolve(window.google.maps);
        script.onerror = (err) => reject(err);
        document.head.appendChild(script);
      });
    }
  }
  try {
    return await googleMapsPromise;
  } catch (err) {
    console.error("Google Maps failed to load", err);
    return null;
  }
}

const routes = [
  { pattern: /^\/home$/, handler: renderHome },
  { pattern: /^\/pets$/, handler: renderPets },
  { pattern: /^\/dog\/([^/]+)$/, handler: (_path, id) => renderDog(id) },
  { pattern: /^\/pet\/([^/]+)$/, handler: (_path, id) => renderDog(id, "Pet") },
  { pattern: /^\/$/, handler: renderLanding },
  { pattern: /^\/doghouse$/, handler: renderDogHouse },
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
  petsLink.href = "#/pets";
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
  const raw = window.location.hash.replace(/^#/, "");
  const path = (raw || "/").replace(/\/+$/, "") || "/";

  if (!state.user && path !== "/") {
    window.location.hash = "#/";
    return;
  }
  if (state.user && (path === "/" || path === "")) {
    window.location.hash = "#/home";
    return;
  }

  setLandingMode(!state.user && path === "/");

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

function renderLanding() {
  cleanupListeners();
  view.innerHTML = `
    <section class="placeholder">
      <h2>Welcome to WurdemanIoT</h2>
      <p class="muted">Sign in above to access devices.</p>
    </section>
  `;
}

function renderPets() {
  cleanupListeners();
  const petId = ingestConfig?.deviceId || "Tyee";
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Pets</h2>
        <p class="muted">Choose a pet tracker.</p>
      </div>
    </div>
    <div class="card">
      <div class="actions">
        <span class="muted">Tyee tracker</span>
        <a class="btn" href="#/pet/${petId}">Open Tyee</a>
      </div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="actions">
        <span class="muted">Dog House</span>
        <a class="btn" href="#/doghouse">Open Dog House</a>
      </div>
    </div>
  `;
}

function renderDogHouse() {
  cleanupListeners();
  view.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Dog House</h2>
        <p class="muted">Door, climate, food/water control (scaffolding).</p>
      </div>
    </div>

    <div class="thermo-grid">
      <div class="card thermo-panel">
        <div class="section-header">
          <h3>Door &amp; Safety</h3>
        </div>
        <div class="thermo-metric">
          <div class="thermo-label">Door status</div>
          <div class="thermo-value" id="dog-door-status">--</div>
          <div class="thermo-sub">Last open: <span id="dog-door-open">--</span></div>
          <div class="thermo-sub">Last close: <span id="dog-door-close">--</span></div>
        </div>
        <div class="thermo-meta">Emergency open thresholds (editable soon)</div>
        <div class="thermo-sub">Actual > 200F → open</div>
        <div class="thermo-sub">Real feel > 100F → open</div>
      </div>

      <div class="card thermo-panel">
        <div class="section-header">
          <h3>Climate</h3>
        </div>
        <div class="thermo-metric">
          <div class="thermo-label">Inside</div>
          <div class="thermo-value" id="dog-temp">--</div>
          <div class="thermo-sub">Real feel: <span id="dog-feel">--</span></div>
          <div class="thermo-sub">Humidity: <span id="dog-hum">--</span></div>
        </div>
        <div class="thermo-sub">Fan on &gt; 80F feel | Heater on &lt; 50F feel</div>
        <div class="thermo-sub">Outside (WU): <span id="dog-outside">--</span></div>
      </div>
    </div>

    <div class="thermo-grid">
      <div class="card thermo-panel">
        <div class="section-header">
          <h3>Food &amp; Water</h3>
        </div>
        <div class="thermo-sub" id="dog-food-level">Food supply: --</div>
        <div class="thermo-sub" id="dog-water-level">Water status: --</div>
        <div class="thermo-sub" id="dog-feed-last">Last fed: --</div>
        <div class="thermo-sub" id="dog-water-last">Last watered: --</div>
        <div class="thermo-sub">Manual feed/water controls coming next.</div>
      </div>

      <div class="card thermo-panel">
        <div class="section-header">
          <h3>Camera</h3>
        </div>
        <div class="placeholder">
          <p class="muted">Wyze cam integration placeholder.</p>
        </div>
      </div>
    </div>

    <div class="card thermo-panel">
      <div class="section-header">
        <h3>History (indoor)</h3>
      </div>
      <canvas id="doghouse-chart" width="900" height="280"></canvas>
      <div class="thermo-history-legend">
        <span><span class="thermo-swatch" style="background:#30d158"></span>Temp</span>
        <span><span class="thermo-swatch" style="background:#ec4899"></span>Real feel</span>
        <span><span class="thermo-swatch" style="background:#22c55e"></span>Humidity</span>
      </div>
    </div>
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
          <div class="thermo-label">Real feel</div>
          <div class="thermo-value" id="thermo-feel">--</div>
          <div class="thermo-inline">
            <span class="thermo-inline-value" id="thermo-setpoint-live">--</span>
            <span class="thermo-inline-label">setpoint</span>
          </div>
          <div class="thermo-sub">Temperature: <span id="thermo-temp">--</span></div>
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

    <div class="thermo-grid">
      <div class="card thermo-panel">
        <div class="section-header">
          <h3>Outside (WU KNEBAYAR10)</h3>
        </div>
        <div class="thermo-metric outside-metric">
          <div class="thermo-label">Real feel</div>
          <div class="thermo-value" id="outside-feel">--</div>
          <div class="thermo-sub" id="outside-temp">Temperature: --</div>
          <div class="thermo-sub" id="outside-hum">Humidity: --</div>
          <div class="thermo-sub" id="outside-wind">Wind: --</div>
          <div class="thermo-sub" id="outside-precip">Precip: --</div>
        </div>
      </div>

      <div class="card thermo-panel propane-card">
        <div class="section-header">
          <h3>Propane</h3>
          <div class="thermo-schedule-actions">
            <button class="btn ghost" type="button" id="propane-refresh">Refresh</button>
          </div>
        </div>
        <div class="propane-oval-row">
          <div class="propane-oval">
            <div class="propane-lid"></div>
            <div class="propane-fill" id="propane-fill"></div>
          </div>
          <div class="thermo-value" id="propane-percent">--</div>
        </div>
        <div class="propane-meta">
          <div class="thermo-sub" id="propane-gallons">--</div>
          <div class="thermo-sub" id="propane-eta">--</div>
          <div class="thermo-sub" id="propane-cost">--</div>
        </div>
        <div class="propane-form-grid">
          <div class="propane-form">
            <label>Gallons</label>
            <input type="number" min="0" step="0.1" id="propane-gallons-input" placeholder="e.g. 362" />
          </div>
          <div class="propane-form">
            <label>Tank capacity (gal)</label>
            <input type="number" min="1" step="1" id="propane-capacity-input" value="400" />
          </div>
          <div class="propane-form">
            <label>Cost per gal ($)</label>
            <input type="number" min="0" step="0.01" id="propane-cost-input" value="1.80" />
          </div>
        </div>
        <div class="propane-actions">
          <button class="btn" type="button" id="propane-save">Log reading</button>
          <button class="btn ghost" type="button" id="propane-fill">Tank fill</button>
        </div>
        <div class="propane-stats" id="propane-stats">No readings yet.</div>
        <canvas id="propane-chart" width="900" height="180"></canvas>
      </div>
    </div>

    <div class="card thermo-panel">
      <div class="section-header">
        <h3>Schedule</h3>
        <div class="thermo-schedule-actions">
          <input class="schedule-input" type="text" id="schedule-name-input" placeholder="Block name" list="schedule-names" />
          <datalist id="schedule-names"></datalist>
          <input class="schedule-input" type="number" step="0.5" min="40" max="90" id="schedule-setpoint-input" placeholder="Setpoint (F)" />
          <button class="btn ghost" type="button" data-zoom="24">24h</button>
          <button class="btn ghost" type="button" data-zoom="12">12h</button>
          <button class="btn ghost" type="button" data-zoom="6">6h</button>
          <button class="btn ghost" type="button" id="thermo-schedule-refresh">Refresh</button>
          <button class="btn ghost" type="button" id="thermo-schedule-clear">Clear all</button>
        </div>
      </div>
      <div class="thermo-schedule-legend">Click and drag to set blocks. Hover to see time. Zoom for finer control.</div>
      <div id="thermo-schedule-grid"></div>
      <div class="muted">Blocks are inclusive of the end hour.</div>
    </div>

    <div class="card thermo-panel">
      <div class="section-header">
        <h3>Indoor history</h3>
        <div class="thermo-history-actions">
          <button class="btn ghost" type="button" data-range="day">Day</button>
          <button class="btn ghost" type="button" data-range="week">Week</button>
          <button class="btn ghost" type="button" data-range="month">Month</button>
          <button class="btn ghost" type="button" id="thermo-history-refresh">Refresh</button>
        </div>
      </div>
      <div class="chart-hover" id="thermo-hover-indoor">Hover to see values.</div>
      <canvas id="thermo-chart-indoor" width="900" height="320"></canvas>
      <div class="thermo-history-legend">
        <span><span class="thermo-swatch" style="background:#2f74ff"></span>Setpoint</span>
        <span><span class="thermo-swatch" style="background:#30d158"></span>Temperature</span>
        <span><span class="thermo-swatch" style="background:#f97316"></span>Runtime (min)</span>
        <span><span class="thermo-swatch" style="background:#38bdf8"></span>Propane %</span>
      </div>
    </div>

    <div class="card thermo-panel">
      <div class="section-header">
        <h3>Outside history</h3>
      </div>
      <div class="chart-hover" id="outside-hover-temp">Hover to see values.</div>
      <canvas id="outside-chart-temp" width="900" height="220"></canvas>
      <div class="thermo-history-legend">
        <span><span class="thermo-swatch" style="background:#a855f7"></span>Temp</span>
        <span><span class="thermo-swatch" style="background:#ec4899"></span>Feels</span>
      </div>
      <div class="chart-hover" id="outside-hover-precip">Hover to see values.</div>
      <canvas id="outside-chart-precip" width="900" height="180"></canvas>
      <div class="thermo-history-legend">
        <span><span class="thermo-swatch" style="background:#0ea5e9"></span>Precip (in/hr)</span>
      </div>
      <div class="chart-hover" id="outside-hover-wind">Hover to see values.</div>
      <canvas id="outside-chart-wind" width="900" height="200"></canvas>
      <div class="thermo-history-legend">
        <span><span class="thermo-swatch" style="background:#22c55e"></span>Wind</span>
        <span><span class="thermo-swatch" style="background:#f97316"></span>Gust</span>
      </div>
      <div class="chart-hover" id="outside-hover-pressure">Hover to see values.</div>
      <canvas id="outside-chart-pressure" width="900" height="180"></canvas>
      <div class="thermo-history-legend">
        <span><span class="thermo-swatch" style="background:#94a3b8"></span>Pressure (inHg)</span>
        <span><span class="thermo-swatch" style="background:#38bdf8"></span>Humidity</span>
      </div>
    </div>
  `;

  bindThermostatControls();
  subscribeThermostat();
  subscribePropane();
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
  const scheduleZoomBtns = document.querySelectorAll("[data-zoom]");
  const scheduleNameInput = document.getElementById("schedule-name-input");
  const scheduleSetpointInput = document.getElementById("schedule-setpoint-input");
  const scheduleNamesList = document.getElementById("schedule-names");
  const historyRefresh = document.getElementById("thermo-history-refresh");
  const historyButtons = document.querySelectorAll(".thermo-history-actions button[data-range]");
  const propaneSave = document.getElementById("propane-save");
  const propaneFill = document.getElementById("propane-fill");
  const propaneRefresh = document.getElementById("propane-refresh");

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
  if (scheduleNamesList) {
    scheduleNamesList.innerHTML = "";
    (state.scheduleNames || []).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      scheduleNamesList.appendChild(opt);
    });
  }
  scheduleZoomBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const zoom = Number(btn.getAttribute("data-zoom")) || 24;
      state.scheduleZoom = zoom;
      scheduleZoomBtns.forEach((b) => b.classList.toggle("active", b === btn));
      renderThermostatSchedule(state.thermostat?.config?.schedule);
    });
  });

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

  if (propaneSave) {
    propaneSave.onclick = () => savePropaneReading(false);
  }
  if (propaneFill) {
    propaneFill.onclick = () => savePropaneReading(true);
  }
  if (propaneRefresh) {
    propaneRefresh.onclick = () => loadPropaneReadings(true);
  }
}

function requireThermostatAuth(actionLabel) {
  if (state.user) return true;
  const note = document.getElementById("thermo-auth");
  if (note) note.textContent = `Sign in required to ${actionLabel}.`;
  return false;
}

async function updateThermostatConfig(partial) {
  if (!requireThermostatAuth("update thermostat config")) return;
  queueThermostatConfig(partial);
}

function adjustThermostatConfig(field, delta, min, max) {
  if (!requireThermostatAuth("update thermostat config")) return;
  const current = Number(
    state.thermostat?.config?.[field] ??
      state.thermostat?.status?.[field] ??
      0
  );
  const next = Math.min(Math.max(current + delta, min), max);
  updateThermostatConfig({ [field]: Number(next.toFixed(1)) });
}

let configDebounceTimer = null;
let pendingConfig = {};
const CONFIG_DEBOUNCE_MS = 2500;

function queueThermostatConfig(partial) {
  pendingConfig = { ...(pendingConfig || {}), ...partial };
  if (configDebounceTimer) {
    clearTimeout(configDebounceTimer);
  }
  configDebounceTimer = setTimeout(async () => {
    const ref = doc(db, "thermostats", state.thermostatId);
    const payload = pendingConfig;
    pendingConfig = {};
    configDebounceTimer = null;
    await setDoc(ref, { config: payload }, { merge: true });
  }, CONFIG_DEBOUNCE_MS);
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
  const setpointLiveEl = document.getElementById("thermo-setpoint-live");
  const diffEl = document.getElementById("thermo-diff");
  const fanStatus = document.getElementById("thermo-fan-status");
  const outsideTempEl = document.getElementById("outside-temp");
  const outsideFeelEl = document.getElementById("outside-feel");
  const outsideHumEl = document.getElementById("outside-hum");
  const outsideWindEl = document.getElementById("outside-wind");
  const outsidePrecipEl = document.getElementById("outside-precip");

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
    if (outsideTempEl) outsideTempEl.textContent = "Temp: --";
    if (outsideFeelEl) outsideFeelEl.textContent = "Feels: --";
    if (outsideHumEl) outsideHumEl.textContent = "Humidity: --";
    if (outsideWindEl) outsideWindEl.textContent = "Wind: --";
    if (outsidePrecipEl) outsidePrecipEl.textContent = "Precip: --";
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
  const spLive = status.setpointF ?? config.setpointF ?? null;
  if (feelEl) {
    feelEl.textContent = feel != null ? `${Number(feel).toFixed(1)} F` : "--";
    feelEl.className = "thermo-value";
    const hotter = spLive != null && feel != null && feel > spLive;
    const cooler = spLive != null && feel != null && feel < spLive;
    feelEl.style.color = hotter ? "#ef4444" : cooler ? "#38bdf8" : "";
  }
  if (tempEl) {
    tempEl.textContent = temp != null ? `${Number(temp).toFixed(1)} F` : "--";
    tempEl.style.color = "";
  }
  if (humEl) humEl.textContent = hum != null ? `${Number(hum).toFixed(0)} %` : "--";
  if (humEl) humEl.textContent = hum != null ? `${Number(hum).toFixed(0)} %` : "--";

  if (metaEl) {
    metaEl.textContent = updatedAt ? `Last update: ${formatDate(updatedAt)}` : "Last update: --";
  }

  const mode = (status.mode || config.mode || "--").toString();
  const lastRunStart = status.ts ? toDate(status.ts) : null;
  const durationMin = status.heatCycleSec ? Number(status.heatCycleSec) / 60 : null;
  if (modePill) {
    modePill.className = `pill ${status.heatOn || status.coolOn ? "online" : "offline"}`;
    const durLabel = durationMin != null ? ` | Duration: ${durationMin.toFixed(1)} min` : "";
    const startLabel = lastRunStart ? `Last run: ${formatTimeOfDay(lastRunStart)}` : "Last run: --";
    modePill.innerHTML = `<span class="dot"></span>${startLabel}${durLabel}`;
  }

  if (outputPill) {
    outputPill.className = "pill";
    outputPill.innerHTML = `<span class="dot"></span>Mode: ${mode}`;
  }

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
  if (setpointLiveEl) {
    const sp = status.setpointF ?? config.setpointF;
    setpointLiveEl.textContent = sp != null ? `${Number(sp).toFixed(1)} F` : "--";
    setpointLiveEl.style.color = "#ec4899";
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

  const outside = data.outside || {};
  if (outsideTempEl) {
    const t = outside.tempF;
    outsideTempEl.textContent = t != null ? `Temp: ${Number(t).toFixed(1)} F` : "Temp: --";
  }
  if (outsideFeelEl) {
    const f = outside.feelsF;
    outsideFeelEl.textContent = f != null ? `Feels: ${Number(f).toFixed(1)} F` : "Feels: --";
  }
  if (outsideHumEl) {
    const h = outside.humidity;
    outsideHumEl.textContent = h != null ? `Humidity: ${Number(h).toFixed(0)} %` : "Humidity: --";
  }
  if (outsideWindEl) {
    const w = outside.windMph;
    const g = outside.windGustMph;
    const parts = [];
    if (w != null) parts.push(`${Number(w).toFixed(1)} mph`);
    if (g != null) parts.push(`gust ${Number(g).toFixed(1)} mph`);
    outsideWindEl.textContent = `Wind: ${parts.length ? parts.join(" | ") : "--"}`;
  }
  if (outsidePrecipEl) {
    const p = outside.precipIn;
    outsidePrecipEl.textContent = p != null ? `Precip: ${Number(p).toFixed(2)} in/hr` : "Precip: --";
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
  let dragStart = null;

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
    row.innerHTML = `<div class="thermo-day-name">${dayNames[displayIdx]}</div><div class="thermo-day-bar" data-day="${dayIdx}"><div class="thermo-hover-line"></div><div class="thermo-ticks"></div></div>`;
    const bar = row.querySelector(".thermo-day-bar");
    const hoverLine = bar.querySelector(".thermo-hover-line");
    const ticks = bar.querySelector(".thermo-ticks");
    const zoom = state.scheduleZoom || 24;
    ticks.innerHTML = "";
    const tickEvery = zoom >= 24 ? 3 : zoom >= 12 ? 1 : 0.5;
    for (let hTick = 0; hTick <= 24; hTick += tickEvery) {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = `${(hTick / 24) * 100}%`;
      ticks.appendChild(tick);
    }

    function hourFromEvent(ev) {
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      return Math.round(pct * 23);
    }

    function updateHover(ev) {
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      hoverLine.style.left = `${pct * 100}%`;
      hoverLine.style.display = "block";
      hoverLine.textContent = `${Math.round(pct * 23)}:00`;
    }

    function clearHover() {
      hoverLine.style.display = "none";
    }

    function applyDrag(endHour) {
      if (!canEdit || dragStart == null) return;
      const startHour = Math.min(dragStart, endHour);
      const finalEnd = Math.max(dragStart, endHour);
      const defaultSp = Number(state.thermostat?.config?.setpointF ?? state.thermostat?.status?.setpointF ?? 70);
      let spInput = Number(scheduleSetpointInput?.value);
      if (!Number.isFinite(spInput)) spInput = defaultSp;
      const sp = spInput;
      if (!Number.isFinite(sp)) return;
      let name = (scheduleNameInput?.value || "").trim();
      const existingNames = state.scheduleNames || [];
      if (!name && existingNames.length) {
        name = existingNames[existingNames.length - 1];
      }
      if (name && !existingNames.includes(name)) {
        state.scheduleNames.push(name);
        if (scheduleNamesList) {
          const opt = document.createElement("option");
          opt.value = name;
          scheduleNamesList.appendChild(opt);
        }
      }
      applyScheduleBlock(dayIdx, startHour, finalEnd, sp);
      dragStart = null;
    }

    bar.addEventListener("pointerdown", (e) => {
      if (!canEdit) return;
      dragStart = hourFromEvent(e);
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener("pointermove", (e) => {
      updateHover(e);
    });
    bar.addEventListener("pointerup", (e) => {
      if (dragStart != null) {
        applyDrag(hourFromEvent(e));
      }
      bar.releasePointerCapture(e.pointerId);
      dragStart = null;
    });
    bar.addEventListener("pointerleave", () => {
      clearHover();
      dragStart = null;
    });

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
  const indoorCanvas = document.getElementById("thermo-chart-indoor");
  const outsideCanvas = document.getElementById("outside-chart-temp");
  if (!indoorCanvas && !outsideCanvas) return;
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
        setpointF: d.setpointF != null ? Number(d.setpointF) : null,
        heatCycleSec: d.heatCycleSec != null ? Number(d.heatCycleSec) : null,
        burnSec: d.burnSec != null ? Number(d.burnSec) : null
      });
    });
    state.thermostatHistory = points;
    const outsidePoints = await loadOutsideHistory(startDate, endDate);
    state.outsideHistory = outsidePoints;
    drawThermostatCharts(points, [], range);
    drawOutsideCharts(outsidePoints, range);
  } catch (err) {
    console.error("Thermostat history load error", err);
    drawThermostatCharts([], [], range);
    drawOutsideCharts([], range);
  }
}

async function loadOutsideHistory(startDate, endDate) {
  try {
    const q = query(
      collection(db, "thermostats", state.thermostatId, "outside"),
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
        feelsF: d.feelsF != null ? Number(d.feelsF) : null,
        humidity: d.humidity != null ? Number(d.humidity) : null,
        windMph: d.windMph != null ? Number(d.windMph) : null,
        windGustMph: d.windGustMph != null ? Number(d.windGustMph) : null,
        precipIn: d.precipIn != null ? Number(d.precipIn) : null,
        pressureIn: d.pressureIn != null ? Number(d.pressureIn) : null
      });
    });
    return points;
  } catch (err) {
    console.error("Outside history load error", err);
    return [];
  }
}

function drawOutsideCharts(outsidePoints, range) {
  const tempCanvas = document.getElementById("outside-chart-temp");
  const precipCanvas = document.getElementById("outside-chart-precip");
  const windCanvas = document.getElementById("outside-chart-wind");
  const pressureCanvas = document.getElementById("outside-chart-pressure");
  if (!tempCanvas && !precipCanvas && !windCanvas && !pressureCanvas) return;

  const tempSeries = [
    { label: "Temp", color: "#a855f7", points: outsidePoints.map((p) => ({ ts: p.ts.getTime(), value: p.tempF })) },
    { label: "Feels", color: "#ec4899", points: outsidePoints.map((p) => ({ ts: p.ts.getTime(), value: p.feelsF })) }
  ];
  const precipSeries = [
    { label: "Precip", color: "#0ea5e9", points: outsidePoints.map((p) => ({ ts: p.ts.getTime(), value: p.precipIn })) }
  ];
  const windSeries = [
    { label: "Wind", color: "#22c55e", points: outsidePoints.map((p) => ({ ts: p.ts.getTime(), value: p.windMph })) },
    { label: "Gust", color: "#f97316", points: outsidePoints.map((p) => ({ ts: p.ts.getTime(), value: p.windGustMph })) }
  ];
  const pressureSeries = [
    { label: "Pressure", color: "#94a3b8", points: outsidePoints.map((p) => ({ ts: p.ts.getTime(), value: p.pressureIn })) },
    { label: "Humidity", color: "#38bdf8", points: outsidePoints.map((p) => ({ ts: p.ts.getTime(), value: p.humidity })) }
  ];

  const charts = [];
  if (tempCanvas) charts.push(drawSyncChart(tempCanvas, tempSeries, range, document.getElementById("outside-hover-temp")));
  if (precipCanvas) charts.push(drawSyncChart(precipCanvas, precipSeries, range, document.getElementById("outside-hover-precip")));
  if (windCanvas) charts.push(drawSyncChart(windCanvas, windSeries, range, document.getElementById("outside-hover-wind")));
  if (pressureCanvas) charts.push(drawSyncChart(pressureCanvas, pressureSeries, range, document.getElementById("outside-hover-pressure")));

  function syncAt(time) {
    charts.forEach((c) => c && c.draw(time));
  }
  function clearSync() {
    charts.forEach((c) => c && c.draw(null));
  }

  // Attach listeners to each chart to drive sync
  charts.forEach((c) => {
    if (!c) return;
    c.canvas.onmousemove = (ev) => syncAt(c.timeFromEvent(ev));
    c.canvas.onmouseleave = () => clearSync();
    c.canvas.ontouchstart = (ev) => {
      ev.preventDefault();
      if (ev.touches?.[0]) syncAt(c.timeFromTouch(ev.touches[0]));
    };
    c.canvas.ontouchmove = (ev) => {
      ev.preventDefault();
      if (ev.touches?.[0]) syncAt(c.timeFromTouch(ev.touches[0]));
    };
    c.canvas.ontouchend = () => clearSync();
  });
}

function drawSyncChart(canvas, series, range, hoverEl) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cleaned = series
    .map((s) => ({ ...s, points: (s.points || []).filter((p) => p.value != null).sort((a, b) => a.ts - b.ts) }))
    .filter((s) => s.points.length);
  const allPoints = cleaned.flatMap((s) => s.points);
  if (!allPoints.length) {
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("No data yet.", 20, 30);
    if (hoverEl) hoverEl.textContent = "No data available.";
    return {
      canvas,
      draw: () => {},
      timeFromEvent: () => Date.now(),
      timeFromTouch: () => Date.now()
    };
  }
  const values = allPoints.map((p) => p.value);
  const times = allPoints.map((p) => p.ts);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const minTs = Math.min(...times);
  const maxTs = Math.max(...times);
  const pad = 30;
  const h = canvas.height - 2 * pad;
  const w = canvas.width - 2 * pad;
  const y = (v) => {
    if (maxVal === minVal) return canvas.height / 2;
    return pad + h - ((v - minVal) / (maxVal - minVal)) * h;
  };
  const x = (t) => {
    if (maxTs === minTs) return pad + w / 2;
    return pad + ((t - minTs) / (maxTs - minTs)) * w;
  };

  const baseImage = (() => {
    cleaned.forEach((seriesItem) => {
      ctx.beginPath();
      ctx.strokeStyle = seriesItem.color;
      ctx.lineWidth = 2;
      seriesItem.points.forEach((p, idx) => {
        const px = x(p.ts);
        const py = y(p.value);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    });
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
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  })();

  const findNearest = (pts, target) => {
    let best = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    pts.forEach((p) => {
      const diff = Math.abs(p.ts - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    });
    return best;
  };

  function draw(time) {
    ctx.putImageData(baseImage, 0, 0);
    if (time == null) {
      if (hoverEl) hoverEl.textContent = "Hover to see values.";
      return;
    }
    const px = x(time);
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, pad / 2);
    ctx.lineTo(px, canvas.height - pad / 2);
    ctx.stroke();

    if (hoverEl) {
      const timeLabel = range === "day"
        ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : new Date(time).toLocaleString();
      const parts = [];
      cleaned.forEach((s) => {
        const n = findNearest(s.points, time);
        if (!n) return;
        parts.push(`${s.label}: ${Number(n.value).toFixed(2)}`);
      });
      hoverEl.textContent = parts.length ? `${timeLabel} | ${parts.join("  ")}` : timeLabel;
    }
  }

  function timeFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    return minTs + pct * (maxTs - minTs);
  }
  function timeFromTouch(touch) {
    const rect = canvas.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    return minTs + pct * (maxTs - minTs);
  }

  draw(null);
  return { canvas, draw, timeFromEvent, timeFromTouch };
}
function drawThermostatCharts(points, _outsidePoints, range) {
  const propane = state.propaneReadings || [];
  const propanePercents = propane.map((r) => Math.min(100, Math.max(0, (r.level / (r.capacity || DEFAULT_PROPANE_CAPACITY)) * 100)));
  const propaneSeries = propane.map((r, idx) => ({ ts: r.ts.getTime(), value: propanePercents[idx] }));
  const indoorSeries = [
    { label: "Setpoint", color: "#2f74ff", points: points.map((p) => ({ ts: p.ts.getTime(), value: p.setpointF })) },
    { label: "Temperature", color: "#30d158", points: points.map((p) => ({ ts: p.ts.getTime(), value: p.tempF })) },
    { label: "Runtime (min)", color: "#f97316", points: points.map((p) => ({ ts: p.ts.getTime(), value: p.heatCycleSec != null ? Number(p.heatCycleSec) / 60 : null })) },
    { label: "Propane %", color: "#38bdf8", points: propaneSeries }
  ];
  drawLineChart("thermo-chart-indoor", indoorSeries, range, "thermo-hover-indoor");
}

function drawLineChart(canvasId, series, range, hoverId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const hoverEl = hoverId ? document.getElementById(hoverId) : null;

  const cleaned = series
    .map((s) => ({ ...s, points: (s.points || []).filter((p) => p.value != null).sort((a, b) => a.ts - b.ts) }))
    .filter((s) => s.points.length);

  const allPoints = cleaned.flatMap((s) => s.points);
  if (!allPoints.length) {
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("No data yet.", 20, 30);
    if (hoverEl) hoverEl.textContent = "No data available.";
    return;
  }

  const values = allPoints.map((p) => p.value);
  const times = allPoints.map((p) => p.ts);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const minTs = Math.min(...times);
  const maxTs = Math.max(...times);
  const pad = 30;
  const h = canvas.height - 2 * pad;
  const w = canvas.width - 2 * pad;

  const y = (v) => {
    if (maxVal === minVal) return canvas.height / 2;
    return pad + h - ((v - minVal) / (maxVal - minVal)) * h;
  };
  const x = (t) => {
    if (maxTs === minTs) return pad + w / 2;
    return pad + ((t - minTs) / (maxTs - minTs)) * w;
  };

  cleaned.forEach((seriesItem) => {
    ctx.beginPath();
    ctx.strokeStyle = seriesItem.color;
    ctx.lineWidth = 2;
    seriesItem.points.forEach((p, idx) => {
      const px = x(p.ts);
      const py = y(p.value);
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  });

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

  const resetHover = () => {
    if (hoverEl) hoverEl.textContent = "Hover to see values.";
  };
  resetHover();
  const findNearest = (pts, target) => {
    let best = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    pts.forEach((p) => {
      const diff = Math.abs(p.ts - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    });
    return best;
  };
  canvas.onmousemove = (ev) => {
    if (!hoverEl) return;
    const rect = canvas.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const targetTs = minTs + pct * (maxTs - minTs);
    const timeLabel = range === "day"
      ? new Date(targetTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(targetTs).toLocaleString();
    const parts = [];
    cleaned.forEach((s) => {
      const n = findNearest(s.points, targetTs);
      if (!n) return;
      const valueLabel = Number(n.value).toFixed(1);
      parts.push(`${s.label}: ${valueLabel}`);
    });
    hoverEl.textContent = parts.length ? `${timeLabel} | ${parts.join("  ")}` : timeLabel;
  };
  canvas.onmouseleave = resetHover;
}

function subscribePropane() {
  if (state.propaneUnsub) {
    state.propaneUnsub();
    state.propaneUnsub = null;
  }
  const ref = collection(db, "thermostats", state.thermostatId, "propane");
  const q = query(ref, orderBy("ts", "desc"), limit(100));
  state.propaneUnsub = onSnapshot(
    q,
    (snap) => {
      const readings = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        const ts = toDate(d.ts);
        if (!ts) return;
        readings.push({
          id: docSnap.id,
          ts,
          level: Number(d.levelGallons ?? d.level ?? d.gallons ?? 0),
          capacity: Number(d.capacityGallons ?? d.capacity ?? d.cap ?? 400)
        });
      });
      state.propaneReadings = readings;
      renderPropane(readings);
    },
    (err) => {
      console.error("Propane listener error", err);
    }
  );
}

async function loadPropaneReadings(force = false) {
  if (!force && state.propaneReadings.length) return;
  const ref = collection(db, "thermostats", state.thermostatId, "propane");
  const q = query(ref, orderBy("ts", "desc"), limit(100));
  const snap = await getDocs(q);
  const readings = [];
  snap.forEach((docSnap) => {
    const d = docSnap.data();
    const ts = toDate(d.ts);
    if (!ts) return;
    readings.push({
      id: docSnap.id,
      ts,
      level: Number(d.levelGallons ?? d.level ?? d.gallons ?? 0),
      capacity: Number(d.capacityGallons ?? d.capacity ?? d.cap ?? 400)
    });
  });
  state.propaneReadings = readings;
  renderPropane(readings);
}

async function savePropaneReading(isFill = false) {
  if (!requireThermostatAuth("log propane")) return;
  const levelInput = document.getElementById("propane-gallons-input");
  const capInput = document.getElementById("propane-capacity-input");
  const level = Number(levelInput?.value);
  const capacity = Number(capInput?.value) || 400;
  if (!Number.isFinite(level) || level <= 0) {
    alert("Enter a valid gallons value.");
    return;
  }
  if (!Number.isFinite(capacity) || capacity <= 0) {
    alert("Enter a valid capacity.");
    return;
  }
  const ref = collection(db, "thermostats", state.thermostatId, "propane");
  await addDoc(ref, {
    levelGallons: level,
    capacityGallons: capacity,
    filled: !!isFill,
    ts: Timestamp.now()
  });
  if (levelInput) levelInput.value = "";
}

function renderPropane(readings) {
  const pctEl = document.getElementById("propane-percent");
  const galEl = document.getElementById("propane-gallons");
  const etaEl = document.getElementById("propane-eta");
  const statsEl = document.getElementById("propane-stats");
  const fillEl = document.getElementById("propane-fill");
  const costEl = document.getElementById("propane-cost");
  const costInput = document.getElementById("propane-cost-input");
  const capInput = document.getElementById("propane-capacity-input");

  if (!readings.length) {
    if (pctEl) pctEl.textContent = "--";
    if (galEl) galEl.textContent = "--";
    if (etaEl) etaEl.textContent = "--";
    if (fillEl) fillEl.style.width = "0%";
    if (costEl) costEl.textContent = "--";
    if (statsEl) statsEl.textContent = "No readings yet.";
    drawPropaneChart([]);
    return;
  }

  const latest = readings[0];
  const level = Math.max(0, latest.level);
  const capacity = Math.max(1, latest.capacity || DEFAULT_PROPANE_CAPACITY);
  const percent = Math.min(100, Math.max(0, (level / capacity) * 100));
  if (pctEl) {
    pctEl.textContent = `${percent.toFixed(1)}%`;
    pctEl.style.color = propaneColor(percent);
  }
  if (galEl) galEl.textContent = `${level.toFixed(1)} gal / ${capacity} gal`;
  if (fillEl) {
    fillEl.style.height = `${percent}%`;
    fillEl.style.background = propaneColor(percent);
  }
  if (capInput && !capInput.value) capInput.value = String(capacity);

  const stats = computePropaneStats(readings);
  state.propaneStats = stats;
  const status = state.thermostat?.status || {};
  const cycleLabel = status.heatCycleSec
    ? `Last heat run: ${(Number(status.heatCycleSec) / 60).toFixed(1)} min`
    : "";
  const burnLabel = status.burnSec
    ? ` (~${(Number(status.burnSec) / 60).toFixed(1)} min burn)`
    : "";
  if (etaEl) {
    etaEl.textContent = stats.etaDays != null
      ? `Est. ${Math.max(0, stats.etaDays).toFixed(1)} days to 20%`
      : "Est. time to 20%: --";
    etaEl.style.color = propaneColor(percent);
  }
  const costPerGal = Number(costInput?.value) || 1.8;
  const costToFill = Math.max(0, capacity - level) * costPerGal;
  if (costEl) {
    costEl.textContent = `Est. fill cost: $${costToFill.toFixed(2)} @ $${costPerGal.toFixed(2)}/gal`;
  }
  if (statsEl) {
    statsEl.textContent = stats.usagePerDay != null
      ? `Usage since ${stats.baselineTs ? formatDate(stats.baselineTs) : "last fill"}: ${stats.usagePerDay.toFixed(2)} gal/day, ${stats.usagePerWeek.toFixed(1)} gal/wk, ${stats.usagePerMonth.toFixed(1)} gal/mo${cycleLabel ? " | " + cycleLabel + burnLabel : ""}`
      : `Need at least two readings to compute usage.${cycleLabel ? " " + cycleLabel + burnLabel : ""}`;
  }

  drawPropaneChart(readings);
}

function computePropaneStats(readings) {
  if (!readings?.length) return { usagePerDay: null, usagePerWeek: null, usagePerMonth: null, etaDays: null, baselineTs: null };
  const sorted = [...readings].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const baselineIdx = (() => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].filled) return i;
    }
    return 0;
  })();
  const start = sorted[baselineIdx];
  const last = sorted[sorted.length - 1];
  const days = Math.max((last.ts.getTime() - start.ts.getTime()) / (1000 * 60 * 60 * 24), 0.01);
  const used = Math.max(0, start.level - last.level);
  const usagePerDay = used > 0 ? used / days : 0;
  const usagePerWeek = usagePerDay * 7;
  const usagePerMonth = usagePerDay * 30;
  const capacity = last.capacity || DEFAULT_PROPANE_CAPACITY;
  const targetLevel = capacity * 0.2;
  const etaDays = usagePerDay > 0 ? (Math.max(0, last.level - targetLevel) / usagePerDay) : null;
  return { usagePerDay, usagePerWeek, usagePerMonth, etaDays, baselineTs: start.ts };
}

function propaneColor(percent) {
  if (percent >= 50) return "#30d158";
  if (percent >= 20) return "#fbbf24";
  if (percent >= 10) return "#f97316";
  return "#ef4444";
}

function drawPropaneChart(readings) {
  const canvas = document.getElementById("propane-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!readings.length) {
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("No propane readings yet.", 20, 30);
    return;
  }
  const sorted = [...readings].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const percents = sorted.map((r) => Math.min(100, Math.max(0, (r.level / (r.capacity || 400)) * 100)));
  const minP = Math.min(...percents);
  const maxP = Math.max(...percents);
  const minTs = sorted[0].ts.getTime();
  const maxTs = sorted[sorted.length - 1].ts.getTime();
  const pad = 30;
  const h = canvas.height - 2 * pad;
  const w = canvas.width - 2 * pad;
  const y = (v) => pad + h - ((v - minP) / Math.max(1, (maxP - minP))) * h;
  const x = (t) => pad + ((t - minTs) / Math.max(1, (maxTs - minTs))) * w;

  ctx.beginPath();
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2;
  sorted.forEach((r, idx) => {
    const px = x(r.ts.getTime());
    const py = y(percents[idx]);
    if (idx === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = "#94a3b8";
  ctx.textAlign = "left";
  ctx.fillText("Percent full over time", pad, 16);
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
  state.timelineStartMin = 0;
  state.timelineEndMin = 1440;
  state.timelineHoverTs = null;
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

    <div class="mode-row">
      <div class="pill" id="net-pill"><span class="dot"></span>Net: -</div>
      <div class="mode-actions">
        <button class="btn" type="button" id="net-wifi-btn">Use Wi‑Fi</button>
        <button class="btn ghost" type="button" id="net-cell-btn">Use Cellular</button>
        <span class="muted" id="net-meta"></span>
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

    <div class="card config-card">
      <div class="section-header">
        <h3>Geofence editor (polygon)</h3>
        <p class="muted">Select geofence, draw on map, save to Firestore. Defaults used if empty.</p>
      </div>
      <div class="config-grid">
        <label>Geofence
          <select id="geofence-select">
            ${GEOFENCE_NAMES.map((n) => `<option value="${n}">${n}</option>`).join("")}
          </select>
        </label>
        <div class="config-actions">
          <button class="btn ghost" type="button" id="geofence-draw-btn">Draw/Redraw</button>
          <button class="btn ghost" type="button" id="geofence-clear-btn">Clear</button>
          <button class="btn" type="button" id="geofence-save-btn">Save geofence</button>
        </div>
        <div class="muted" id="geofence-meta">No geofence loaded.</div>
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
      <div class="history-meta" id="history-meta">Loading history...</div>
    </div>

    <div class="card">
      <div class="section-header">
        <h3>Timeline (today)</h3>
        <div class="history-meta" id="timeline-label">00:00 - 23:59</div>
      </div>
      <div class="timeline-container">
        <canvas id="timeline-canvas" width="900" height="120"></canvas>
        <div class="history-meta" id="timeline-hover">Hover to see time.</div>
      </div>
    </div>

    <div class="card">
      <div class="section-header">
        <h3>Map</h3>
      </div>
      <div id="map" class="map"></div>
    </div>
    ${debugPanel}
  `;

  initMap();
  bindConfigHandlers(deviceId);
  setupGeofenceEditor(deviceId);
  setupTimelineCanvas(deviceId);
  subscribeDevice(deviceId);
  bindNetHandlers(deviceId);
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

async function setupGeofenceEditor(deviceId) {
  const select = document.getElementById("geofence-select");
  const drawBtn = document.getElementById("geofence-draw-btn");
  const clearBtn = document.getElementById("geofence-clear-btn");
  const saveBtn = document.getElementById("geofence-save-btn");
  const meta = document.getElementById("geofence-meta");
  const canEdit = !!state.user;
  if (select) select.value = state.selectedGeofence || "nearby";
  [drawBtn, clearBtn, saveBtn, select].forEach((el) => {
    if (!el) return;
    if (el.tagName === "BUTTON") el.disabled = !canEdit;
  });

  await loadGeofences(deviceId);

  if (select) {
    select.onchange = () => {
      state.selectedGeofence = select.value;
      renderGeofencePolygon(select.value);
    };
  }
  if (drawBtn) {
    drawBtn.onclick = () => {
      startDrawingGeofence();
      if (meta) meta.textContent = "Click on map to draw polygon. Double-click to finish.";
    };
  }
  if (clearBtn) {
    clearBtn.onclick = () => {
      clearGeofencePolygon(state.selectedGeofence);
      if (meta) meta.textContent = "Cleared.";
    };
  }
  if (saveBtn) {
    saveBtn.onclick = () => saveGeofence(deviceId);
  }
}

async function loadGeofences(deviceId) {
  try {
    const ref = doc(db, "devices", deviceId);
    const snap = await getDoc(ref);
    const data = snap.data();
    state.geofencePolygons = (data?.geofences as Record<string, { polygon?: Array<{ lat: number; lng: number }> }>) || {};
    renderGeofencePolygon(state.selectedGeofence || "nearby");
  } catch (err) {
    console.error("Failed to load geofences", err);
  }
}

function renderGeofencePolygon(name) {
  if (!state.map || !window.google?.maps) return;
  const maps = window.google.maps;
  // Clear existing
  if (state.geofencePolygons[name]?.overlay) {
    state.geofencePolygons[name].overlay.setMap(null);
    delete state.geofencePolygons[name].overlay;
  }
  const poly = state.geofencePolygons[name];
  if (!poly?.polygon || !poly.polygon.length) return;
  const path = poly.polygon.map((p) => ({ lat: p.lat, lng: p.lng }));
  const overlay = new maps.Polygon({
    paths: path,
    strokeColor: "#f59e0b",
    strokeOpacity: 0.9,
    strokeWeight: 2,
    fillColor: "#f59e0b",
    fillOpacity: 0.2
  });
  overlay.setMap(state.map);
  state.geofencePolygons[name].overlay = overlay;
}

function startDrawingGeofence() {
  if (!state.map || !window.google?.maps) return;
  const maps = window.google.maps;
  if (state.drawingManager) {
    state.drawingManager.setMap(null);
  }
  state.drawingManager = new maps.drawing.DrawingManager({
    drawingMode: maps.drawing.OverlayType.POLYGON,
    drawingControl: false,
    polygonOptions: {
      strokeColor: "#22c55e",
      strokeOpacity: 0.9,
      strokeWeight: 2,
      fillColor: "#22c55e",
      fillOpacity: 0.2
    }
  });
  state.drawingManager.setMap(state.map);
  maps.event.addListener(state.drawingManager, "overlaycomplete", (e) => {
    state.drawingManager?.setMap(null);
    state.drawingManager = null;
    const path = e.overlay.getPath().getArray().map((latlng) => ({ lat: latlng.lat(), lng: latlng.lng() }));
    clearGeofencePolygon(state.selectedGeofence);
    state.geofencePolygons[state.selectedGeofence] = { polygon: path, overlay: e.overlay };
  });
}

function clearGeofencePolygon(name) {
  const poly = state.geofencePolygons[name];
  if (poly?.overlay) {
    poly.overlay.setMap(null);
  }
  delete state.geofencePolygons[name];
}

async function saveGeofence(deviceId) {
  if (!requireAuth("save geofence")) return;
  const name = state.selectedGeofence || "nearby";
  const poly = state.geofencePolygons[name];
  const meta = document.getElementById("geofence-meta");
  if (!poly?.polygon?.length) {
    if (meta) meta.textContent = "Draw a polygon first.";
    return;
  }
  try {
    await setDoc(
      doc(db, "devices", deviceId),
      { geofences: { [name]: { polygon: poly.polygon, updatedAt: Timestamp.now() } } },
      { merge: true }
    );
    if (meta) meta.textContent = `Saved geofence "${name}".`;
  } catch (err) {
    console.error("Save geofence failed", err);
    if (meta) meta.textContent = "Error saving geofence.";
  }
}

function setupTimelineCanvas(deviceId) {
  const canvas = document.getElementById("timeline-canvas");
  const hoverEl = document.getElementById("timeline-hover");
  const labelEl = document.getElementById("timeline-label");
  const prevBtn = document.getElementById("day-prev-btn");
  const nextBtn = document.getElementById("day-next-btn");

  updateDayLabel();
  if (prevBtn) {
    prevBtn.onclick = () => {
      state.selectedDay = addDays(state.selectedDay, -1);
      state.timelineStartMin = 0;
      state.timelineEndMin = 1440;
      updateDayLabel();
      if (labelEl) labelEl.textContent = `${formatMinutes(0)} - ${formatMinutes(1440)}`;
      loadHistory(deviceId, state.selectedDay);
    };
  }
  if (nextBtn) {
    nextBtn.onclick = () => {
      const maybeNext = addDays(state.selectedDay, 1);
      if (maybeNext > startOfDay(new Date())) return;
      state.selectedDay = maybeNext;
      state.timelineStartMin = 0;
      state.timelineEndMin = 1440;
      updateDayLabel();
      if (labelEl) labelEl.textContent = `${formatMinutes(0)} - ${formatMinutes(1440)}`;
      loadHistory(deviceId, state.selectedDay);
    };
  }

  if (!canvas) return;
  let dragging = false;
  let dragStart = 0;

  const minuteFromEvent = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(evt.clientX - rect.left, 0), rect.width);
    return (x / rect.width) * 1440;
  };

  const updateHover = (minute) => {
    const dayStart = startOfDay(state.selectedDay || new Date()).getTime();
    const ts = new Date(dayStart + minute * 60000);
    if (hoverEl) hoverEl.textContent = `Hover: ${formatTimeOfDay(ts)}`;
    state.timelineHoverTs = ts.getTime();
    highlightNearestPoint(ts.getTime());
    drawTimeline(state.historyPoints);
  };

  canvas.onmousemove = (e) => {
    const minute = minuteFromEvent(e);
    if (!dragging) {
      updateHover(minute);
    } else {
      state.timelineStartMin = Math.max(0, Math.min(1440, Math.min(dragStart, minute)));
      state.timelineEndMin = Math.max(0, Math.min(1440, Math.max(dragStart, minute)));
      if (labelEl) {
        labelEl.textContent = `${formatMinutes(state.timelineStartMin)} - ${formatMinutes(state.timelineEndMin)}`;
      }
      drawTimeline(state.historyPoints);
    }
  };

  canvas.onmouseleave = () => {
    state.timelineHoverTs = null;
    if (hoverEl) hoverEl.textContent = "Hover to see time.";
    drawTimeline(state.historyPoints);
  };

  canvas.onmousedown = (e) => {
    dragging = true;
    dragStart = minuteFromEvent(e);
    state.timelineStartMin = dragStart;
    state.timelineEndMin = dragStart;
  };

  if (state.timelineMouseUpHandler) {
    window.removeEventListener("mouseup", state.timelineMouseUpHandler);
  }

  state.timelineMouseUpHandler = (e) => {
    if (!dragging) return;
    dragging = false;
    const minute = minuteFromEvent(e);
    state.timelineStartMin = Math.max(0, Math.min(1440, Math.min(dragStart, minute)));
    state.timelineEndMin = Math.max(0, Math.min(1440, Math.max(dragStart, minute)));
    if (labelEl) {
      labelEl.textContent = `${formatMinutes(state.timelineStartMin)} - ${formatMinutes(state.timelineEndMin)}`;
    }
    renderTimelineSlice();
    drawTimeline(state.historyPoints);
  };

  window.addEventListener("mouseup", state.timelineMouseUpHandler);
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
          ts: tsDate,
          speedMph: d.speedMph != null ? Number(d.speedMph) : undefined
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
  const startMin = Math.max(0, Math.min(1440, state.timelineStartMin ?? 0));
  const endMin = Math.max(startMin, Math.min(1440, state.timelineEndMin ?? 1440));

  const slice = filterPointsForRange(state.historyPoints, state.selectedDay, startMin, endMin);
  const reduced = downsamplePoints(slice, HISTORY_RENDER_LIMIT);
  drawHistory(reduced);

  if (labelEl) labelEl.textContent = `${formatMinutes(startMin)} - ${formatMinutes(endMin)}`;

  return slice;
}

function drawTimeline(points) {
  const canvas = document.getElementById("timeline-canvas");
  const hoverEl = document.getElementById("timeline-hover");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.height;
  if (canvas.width !== w) canvas.width = w;
  ctx.clearRect(0, 0, w, h);

  // background
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(0, 0, w, h);

  const startMin = Math.max(0, Math.min(1440, state.timelineStartMin ?? 0));
  const endMin = Math.max(startMin, Math.min(1440, state.timelineEndMin ?? 1440));

  // selection window
  ctx.fillStyle = "rgba(46, 204, 250, 0.12)";
  const selX1 = (startMin / 1440) * w;
  const selX2 = (endMin / 1440) * w;
  ctx.fillRect(selX1, 0, selX2 - selX1, h);

  // timeline baseline
  ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h - 20);
  ctx.lineTo(w, h - 20);
  ctx.stroke();

  if (points?.length) {
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2;
    points.forEach((p) => {
      const ts = p.ts?.getTime?.();
      if (!ts) return;
      const minutes = minutesSinceMidnight(p.ts);
      const x = (minutes / 1440) * w;
      ctx.beginPath();
      ctx.moveTo(x, h - 24);
      ctx.lineTo(x, h - 4);
      ctx.stroke();
    });
  }

  if (state.timelineHoverTs) {
    const minutes = minutesSinceMidnight(new Date(state.timelineHoverTs));
    const x = (minutes / 1440) * w;
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (hoverEl) hoverEl.textContent = `Hover: ${formatMinutes(minutes)}`;
  }
}

function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  if (state.marker?.setMap) state.marker.setMap(null);
  if (state.polyline?.setMap) state.polyline.setMap(null);
  state.marker = null;
  state.polyline = null;
  state.map = null;

  loadGoogleMaps().then((maps) => {
    if (!maps || !mapEl) {
      mapEl.innerHTML = `<div class="muted">Google Maps API key missing.</div>`;
      return;
    }
    state.map = new maps.Map(mapEl, {
      center: { lat: 0, lng: 0 },
      zoom: 2,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      zoomControl: true
    });
    if (state.lastDeviceId && state.lastSnapshot) {
      updateDogUI(state.lastDeviceId, state.lastSnapshot);
    }
  });
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
  const netPill = document.getElementById("net-pill");
  const netMeta = document.getElementById("net-meta");

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

  const desiredNet = (state.pendingNet?.target || config?.preferredNet || "auto").toLowerCase();
  const actualNet = (netKind || "").toLowerCase();
  const isSwitching = !!state.pendingNet && state.pendingNet.target === desiredNet && actualNet !== desiredNet;

  if (netPill) {
    const pillClass = isSwitching ? "pill stale" : actualNet ? "pill online" : "pill offline";
    netPill.className = pillClass;
    netPill.innerHTML = `<span class="dot"></span>Net: ${netKind || "-"}`;
  }
  if (netMeta) {
    if (isSwitching) {
      netMeta.textContent = `Switching to ${desiredNet}...`;
    } else {
      netMeta.textContent = `Preferred: ${desiredNet}`;
    }
  }
  if (state.pendingNet && actualNet === state.pendingNet.target) {
    state.pendingNet = null;
  }

  updateModeUI(deviceId, data, config);
  updateConfigUI(config, last);

  const lat = Number(last?.lat);
  const lon = Number(last?.lon);
  if (state.map && window.google?.maps && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    const pos = { lat, lng: lon };
    const maps = window.google.maps;
    if (!state.marker) {
      state.marker = new maps.Marker({ position: pos, map: state.map });
    } else {
      state.marker.setPosition(pos);
    }
    if (!state.polyline) {
      state.map.setCenter(pos);
      state.map.setZoom(15);
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

function bindNetHandlers(deviceId) {
  const wifiBtn = document.getElementById("net-wifi-btn");
  const cellBtn = document.getElementById("net-cell-btn");
  const meta = document.getElementById("net-meta");
  const canEdit = !!state.user;
  [wifiBtn, cellBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = !canEdit;
    btn.title = canEdit ? "" : "Sign in required.";
  });
  if (wifiBtn) wifiBtn.onclick = () => requestNetwork(deviceId, "wifi");
  if (cellBtn) cellBtn.onclick = () => requestNetwork(deviceId, "cell");
  if (!canEdit && meta) meta.textContent = "Sign in to change network.";
}

async function requestNetwork(deviceId, target) {
  if (!requireAuth("set network")) return;
  const meta = document.getElementById("net-meta");
  state.pendingNet = { target };
  if (meta) meta.textContent = `Requesting ${target}...`;
  try {
    await setDoc(
      doc(db, "devices", deviceId),
      { config: { preferredNet: target, requestedNetAt: Timestamp.now() } },
      { merge: true }
    );
    if (meta) meta.textContent = `Requested ${target}. Waiting for device...`;
  } catch (err) {
    console.error("Network request failed", err);
    if (meta) meta.textContent = `Network request error: ${err.message}`;
    state.pendingNet = null;
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
  if (!state.map || !window.google?.maps) return;
  if (state.polyline?.setMap) {
    state.polyline.setMap(null);
    state.polyline = null;
  }
  state.historyMarkers?.forEach((m) => m?.setMap && m.setMap(null));
  state.historyMarkers = [];
  if (!points.length) return;

  const path = points.map((p) => ({ lat: p.lat, lng: p.lon }));
  const maps = window.google.maps;
  state.polyline = new maps.Polyline({
    path,
    strokeColor: "#22d3ee",
    strokeOpacity: 0.8,
    strokeWeight: 4,
    map: state.map
  });
  const bounds = new maps.LatLngBounds();
  path.forEach((pt) => bounds.extend(pt));
  state.map.fitBounds(bounds, 30);

  if (!state.mapInfoWindow) state.mapInfoWindow = new maps.InfoWindow();

  points.forEach((p) => {
    const marker = new maps.Marker({
      position: { lat: p.lat, lng: p.lon },
      map: state.map,
      icon: {
        path: maps.SymbolPath.CIRCLE,
        scale: 4,
        fillColor: "#22d3ee",
        fillOpacity: 0.9,
        strokeColor: "#0ea5e9",
        strokeWeight: 1
      },
      title: `${formatTimeOfDay(p.ts)}`
    });
    marker.addListener("mouseover", () => {
      const speed = p.speedMph != null ? `${Number(p.speedMph).toFixed(1)} mph` : "-";
      state.mapInfoWindow.setContent(`${formatTimeOfDay(p.ts)}<br/>Speed: ${speed}`);
      state.mapInfoWindow.open({ map: state.map, anchor: marker });
    });
    state.historyMarkers.push(marker);
  });
}

function highlightNearestPoint(tsMs) {
  if (!state.map || !window.google?.maps || !state.historyPoints?.length || tsMs == null) return;
  let best = null;
  let bestDiff = Number.MAX_SAFE_INTEGER;
  state.historyPoints.forEach((p) => {
    const ts = p.ts?.getTime?.();
    if (ts == null) return;
    const diff = Math.abs(ts - tsMs);
    if (diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  });
  if (!best) return;

  const maps = window.google.maps;
  if (!state.hoverMarker) {
    state.hoverMarker = new maps.Marker({
      map: state.map,
      icon: {
        path: maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: "#f97316",
        fillOpacity: 0.9,
        strokeColor: "#fb923c",
        strokeWeight: 1.5
      }
    });
  }
  state.hoverMarker.setPosition({ lat: best.lat, lng: best.lon });
  const speed = best.speedMph != null ? `${Number(best.speedMph).toFixed(1)} mph` : "-";
  if (!state.mapInfoWindow) state.mapInfoWindow = new maps.InfoWindow();
  state.mapInfoWindow.setContent(`${formatTimeOfDay(best.ts)}<br/>Speed: ${speed}`);
  state.mapInfoWindow.open({ map: state.map, anchor: state.hoverMarker });
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

function filterPointsForRange(points, day, startMinutes, endMinutes) {
  if (!points?.length) return [];
  const dayStart = startOfDay(day || new Date()).getTime();
  const rangeStart = dayStart + startMinutes * 60000;
  const rangeEnd = dayStart + endMinutes * 60000;
  return points.filter((p) => {
    const ts = p.ts?.getTime?.();
    return ts != null && ts >= rangeStart && ts <= rangeEnd;
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

function formatMinutes(min) {
  const clamped = Math.max(0, Math.min(1439, Math.floor(min)));
  const hours = Math.floor(clamped / 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor(clamped % 60)
    .toString()
    .padStart(2, "0");
  return `${hours}:${minutes}`;
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

function setLandingMode(on) {
  const nav = document.querySelector(".nav-links");
  if (nav) nav.style.display = on ? "none" : "";
  document.body.classList.toggle("landing", !!on);
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
  if (state.propaneUnsub) {
    state.propaneUnsub();
    state.propaneUnsub = null;
  }
  if (state.timelineMouseUpHandler) {
    window.removeEventListener("mouseup", state.timelineMouseUpHandler);
    state.timelineMouseUpHandler = null;
  }
  if (state.marker?.setMap) state.marker.setMap(null);
  if (state.polyline?.setMap) state.polyline.setMap(null);
  if (state.hoverMarker?.setMap) state.hoverMarker.setMap(null);
  state.historyMarkers?.forEach((m) => m?.setMap && m.setMap(null));
  state.map = null;
  state.marker = null;
  state.polyline = null;
  state.hoverMarker = null;
  state.historyMarkers = [];
  state.mapInfoWindow = null;
  state.historyPoints = [];
  state.selectedDay = startOfDay(new Date());
  state.timelineStartMin = 0;
  state.timelineEndMin = 1440;
  state.timelineHoverTs = null;
  state.currentConfig = null;
  state.lastSnapshot = null;
  state.thermostat = null;
  state.thermostatHistory = [];
  state.propaneReadings = [];
  state.propaneStats = null;
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

