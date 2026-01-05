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
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const state = {
  user: null,
  unsubDevices: null,
  unsubDevice: null,
  historyTimer: null,
  map: null,
  marker: null,
  polyline: null,
  lastDeviceId: null
};

const routes = [
  { pattern: /^\/home$/, handler: renderHome },
  { pattern: /^\/dog\/([^/]+)$/, handler: (_path, id) => renderDog(id) },
  { pattern: /^\/pet\/([^/]+)$/, handler: (_path, id) => renderPet(id) },
  { pattern: /^\/vehicles$/, handler: () => renderComingSoon("Vehicles") },
  { pattern: /^\/pets$/, handler: () => renderComingSoon("Pets") },
  { pattern: /^\/kids$/, handler: () => renderComingSoon("Kids") }
];

const view = document.getElementById("view");
const authForm = document.getElementById("auth-form");
const signInBtn = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const authStatus = document.getElementById("auth-status");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");

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
  authStatus.textContent = user ? `Signed in as ${user.email}` : "Not signed in";
  signInBtn.disabled = !!user;
  signOutBtn.disabled = !user;
  if (!user) {
    authForm.reset();
  }
  router();
});

window.addEventListener("hashchange", router);
router();

function router() {
  const path = (window.location.hash.replace(/^#/, "") || "/home").replace(/\/+$/, "") || "/home";

  if (!state.user) {
    renderAuthGate();
    return;
  }

  for (const r of routes) {
    const match = path.match(r.pattern);
    if (match) {
      r.handler(path, ...match.slice(1));
      return;
    }
  }

  renderNotFound();
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

function renderHome() {
  cleanupListeners();

  view.innerHTML = `
    <div class="section-header">
      <div>
        <h1>Devices</h1>
        <p class="muted">Live status from Firestore</p>
      </div>
      <button class="btn" type="button" id="add-device-btn">Add device (admin)</button>
    </div>
    <div id="device-grid" class="device-grid"></div>
  `;

  const grid = document.getElementById("device-grid");
  const q = query(collection(db, "devices"), orderBy("updatedAt", "desc"));

  state.unsubDevices = onSnapshot(
    q,
    (snap) => {
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
      grid.innerHTML = `<div class="placeholder"><p class="muted">Error loading devices: ${err.message}</p></div>`;
    }
  );
}

function buildDeviceCard(id, data) {
  const card = document.createElement("div");
  card.className = "card";

  const status = computeStatus(data);
  const lastDate = toDate(data?.last?.ts) || toDate(data?.updatedAt);
  const battery = data?.last?.battery ?? data?.battery;
  const typeLabel = data?.type ?? "unknown";

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
      <span>Battery: ${battery != null ? `${battery}%` : "—"}</span>
    </div>
    <p class="muted">Last update: ${lastDate ? formatDate(lastDate) : "—"}</p>
    <div class="actions">
      <div class="pill">ID: ${id}</div>
      ${renderTrackLink(id, typeLabel)}
    </div>
  `;

  return card;
}

function renderTrackLink(id, typeLabel) {
  const type = (typeLabel || "").toLowerCase();
  if (type === "dog") {
    return `<a class="btn" href="#/dog/${id}" aria-label="Track ${id}">Track dog →</a>`;
  }
  if (type === "pet") {
    return `<a class="btn" href="#/pet/${id}" aria-label="Track ${id}">Track pet →</a>`;
  }
  return `<span class="muted">No route</span>`;
}

function renderPet(deviceId) {
  renderDog(deviceId, "Pet");
}

function renderDog(deviceId, label = "Dog") {
  cleanupListeners();
  state.lastDeviceId = deviceId;

  view.innerHTML = `
    <div class="section-header">
      <div>
        <a class="back-link" href="#/home">← Back</a>
        <h2 id="dog-title">${label} tracker</h2>
        <p class="muted">Live location for <span id="dog-id">${deviceId}</span></p>
      </div>
      <span class="pill online" id="dog-status"><span class="dot"></span>Online</span>
    </div>

    <div id="map" class="map"></div>

    <div class="stats-grid">
      <div class="stat">
        <div class="label">Battery</div>
        <div class="value" id="stat-battery">—</div>
      </div>
      <div class="stat">
        <div class="label">Satellites</div>
        <div class="value" id="stat-sats">—</div>
      </div>
      <div class="stat">
        <div class="label">HDOP</div>
        <div class="value" id="stat-hdop">—</div>
      </div>
      <div class="stat">
        <div class="label">Last update</div>
        <div class="value" id="stat-updated">—</div>
      </div>
    </div>

    <div class="history-meta" id="history-meta">Loading history…</div>
  `;

  initMap();
  subscribeDevice(deviceId);
  loadHistory(deviceId);
  state.historyTimer = setInterval(() => loadHistory(deviceId), 30000);
}

function subscribeDevice(deviceId) {
  const ref = doc(db, "devices", deviceId);
  state.unsubDevice = onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        view.innerHTML = `<div class="placeholder"><h2>Device not found</h2><p class="muted">${deviceId}</p></div>`;
        return;
      }
      const data = snap.data();
      updateDogUI(deviceId, data);
    },
    (err) => {
      console.error("Device listener error", err);
      const meta = document.getElementById("history-meta");
      if (meta) meta.textContent = `Error: ${err.message}`;
    }
  );
}

async function loadHistory(deviceId) {
  const histMeta = document.getElementById("history-meta");
  if (!histMeta) return;
  histMeta.textContent = "Loading history…";
  try {
    const q = query(
      collection(db, "devices", deviceId, "points"),
      orderBy("ts", "desc"),
      limit(200)
    );
    const snap = await getDocs(q);
    const points = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (d.lat != null && d.lon != null) {
        points.push({
          lat: Number(d.lat),
          lon: Number(d.lon),
          ts: toDate(d.ts)
        });
      }
    });
    points.sort((a, b) => (a.ts?.getTime?.() ?? 0) - (b.ts?.getTime?.() ?? 0));
    drawHistory(points);
    histMeta.textContent = points.length
      ? `History points: ${points.length}`
      : "No history points yet.";
  } catch (err) {
    console.error("History load error", err);
    histMeta.textContent = `History error: ${err.message}`;
  }
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
    attribution: "© OpenStreetMap contributors"
  }).addTo(state.map);
}

function updateDogUI(deviceId, data) {
  const title = document.getElementById("dog-title");
  const idLabel = document.getElementById("dog-id");
  const statusEl = document.getElementById("dog-status");
  const batteryEl = document.getElementById("stat-battery");
  const satsEl = document.getElementById("stat-sats");
  const hdopEl = document.getElementById("stat-hdop");
  const updatedEl = document.getElementById("stat-updated");

  if (!title) return;

  title.textContent = data?.name || "Tracker";
  if (idLabel) idLabel.textContent = deviceId;

  const last = data?.last;
  const status = computeStatus(data);
  statusEl.className = `pill ${status}`;
  statusEl.innerHTML = `<span class="dot"></span>${status.toUpperCase()}`;

  batteryEl.textContent = last?.battery != null ? `${last.battery}%` : "—";
  satsEl.textContent = last?.sats != null ? last.sats : "—";
  hdopEl.textContent = last?.hdop != null ? last.hdop : "—";
  updatedEl.textContent = last?.ts ? formatDate(toDate(last.ts)) : "—";

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
  if (!date) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
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
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  state.marker = null;
  state.polyline = null;
}
