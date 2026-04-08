const el = (id) => document.getElementById(id);

const tokenInput    = el("token");
const connectBtn    = el("connect");
const refreshBtn    = el("refresh");
const playerSelect  = el("player");
const artImg        = el("art");
const bgArt         = el("bg-art");
const titleEl       = el("title");
const artistEl      = el("artist");
const connectionDot = el("connection-dot");
const positionSlider = el("position");
const progressFill  = el("progress-fill");
const currentTimeEl = el("current-time");
const totalTimeEl   = el("total-time");
const playPauseBtn  = el("playpause");
const replay10Btn   = el("replay10");
const prevBtn       = el("prev");
const nextBtn       = el("next");
const forward10Btn  = el("forward10");
const volSlider     = el("volume");
const hapticLabel   = el("haptic-label");
const fallbackArt   = "/static/noartworkfound.svg";

function haptic() {
  if (hapticLabel) hapticLabel.click();
}

let ws;
let wsReconnectTimer;
let wsReady          = false;
let lastPlayerPref   = "";
let currentPlayer    = "";
let lastPositionMs   = 0;
let durationMs       = 0;
let lastUpdateTs     = 0;
let isPlaying        = false;
let userScrubbing    = false;
let foregroundRefreshInFlight = false;

// ── Tab switching ──────────────────────────────────────────
const panels = {
  nowplaying: el("panel-nowplaying"),
  settings:   el("panel-settings"),
};

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    Object.values(panels).forEach((p) => p.classList.add("hidden"));
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    panels[tab].classList.remove("hidden");
    btn.classList.add("active");
  });
});

// ── Art & background ───────────────────────────────────────
function setArtImage(src) {
  const next = src || fallbackArt;
  if (artImg.dataset.current === next) return;
  artImg.dataset.current = next;
  artImg.src = next;
  bgArt.style.backgroundImage = next !== fallbackArt ? `url(${next})` : "";
}

artImg.onerror = () => {
  artImg.src = fallbackArt;
  bgArt.style.backgroundImage = "";
  artImg.dataset.current = fallbackArt;
};

// ── Connection dot ─────────────────────────────────────────
function setConnectionDot(connected) {
  connectionDot.classList.toggle("connected", connected);
  if (connected) {
    connectionDot.onclick = null;
  } else {
    connectionDot.onclick = () => startWS();
  }
}

// ── Play/pause icon ────────────────────────────────────────
function setPlayPauseIcon(status) {
  const playing = (status || "").toLowerCase() === "playing";
  playPauseBtn.querySelector(".icon-play").classList.toggle("hidden", playing);
  playPauseBtn.querySelector(".icon-pause").classList.toggle("hidden", !playing);
}

// ── Time & scrubber ────────────────────────────────────────
function currentPositionMillis() {
  if (!isPlaying || durationMs <= 0) return lastPositionMs;
  const elapsed = performance.now() - lastUpdateTs;
  return Math.min(durationMs, lastPositionMs + elapsed);
}

function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderTime(posMs, durMs) {
  currentTimeEl.textContent = formatTime(posMs);
  totalTimeEl.textContent = durMs ? formatTime(durMs) : "0:00";
  const pct = durMs > 0 ? Math.min(100, (posMs / durMs) * 100) : 0;
  progressFill.style.width = pct + "%";
}

function updateScrubber(info) {
  durationMs    = info.length_millis || 0;
  lastPositionMs = info.position_millis || 0;
  lastUpdateTs  = performance.now();
  isPlaying     = (info.playback_status || "").toLowerCase() === "playing";
  positionSlider.max = durationMs;
  positionSlider.disabled = durationMs === 0;
  if (!userScrubbing) positionSlider.value = lastPositionMs;
  renderTime(lastPositionMs, durationMs);
}

function tick() {
  if (!userScrubbing && isPlaying && durationMs > 0) {
    const elapsed  = performance.now() - lastUpdateTs;
    const projected = Math.min(durationMs, lastPositionMs + elapsed);
    positionSlider.value = projected;
    renderTime(projected, durationMs);
  }
  requestAnimationFrame(tick);
}

function applyLocalSeek(deltaMs) {
  if (durationMs <= 0) return;
  lastPositionMs = Math.max(0, Math.min(durationMs, lastPositionMs + deltaMs));
  lastUpdateTs = performance.now();
  positionSlider.value = lastPositionMs;
  renderTime(lastPositionMs, durationMs);
}

// ── UI update ──────────────────────────────────────────────
function pickArt(info) {
  if (isNetflix(info))     return "/static/netflix_icon.svg";
  if (isCrunchyroll(info)) {
    if (info.art_url_proxy) return info.art_url_proxy;
    if (info.art_url)       return info.art_url;
    return "/static/crunchyroll_icon.svg";
  }
  const thumb = youtubeThumbFromURL(info.url || "");
  if (thumb)               return thumb;
  if (info.art_url_proxy)  return info.art_url_proxy;
  if (info.art_url)        return info.art_url;
  return fallbackArt;
}

function isNetflix(info) {
  const t  = (info.title    || "").toLowerCase();
  const id = (info.identity || "").toLowerCase();
  return t === "netflix" || id === "netflix";
}

function isCrunchyroll(info) {
  return (info.title || "").toLowerCase().endsWith(" - watch on crunchyroll");
}

function youtubeThumbFromURL(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (!/^(www\.)?youtube\.com$/.test(u.hostname) && u.hostname !== "youtu.be") return "";
    let id = u.hostname === "youtu.be"
      ? u.pathname.slice(1)
      : (u.searchParams.get("v") || "");
    if (!id) return "";
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  } catch (e) {
    return "";
  }
}

function updateUI(info) {
  titleEl.textContent = info.title || "—";
  const sub = [info.artist, info.identity].filter(Boolean).join(" · ");
  artistEl.textContent = sub;
  setPlayPauseIcon(info.playback_status);
  updateScrubber(info);
  setArtImage(pickArt(info));
}

// ── Prefs ──────────────────────────────────────────────────
function loadPrefs() {
  const token = localStorage.getItem("umr_token") || "";
  lastPlayerPref = localStorage.getItem("umr_player") || "";
  currentPlayer  = lastPlayerPref;
  tokenInput.value = token;
}

function savePrefs() {
  localStorage.setItem("umr_token",  tokenInput.value.trim());
  localStorage.setItem("umr_player", lastPlayerPref);
}

function setCurrentPlayer(val) {
  currentPlayer  = val || "";
  lastPlayerPref = currentPlayer;
  savePrefs();
  playerSelect.value = currentPlayer;
}

// ── HTTP helpers ───────────────────────────────────────────
function apiUrl(path, params = {}) {
  const base  = window.location.origin.replace(/\/+$/, "");
  const query = new URLSearchParams(params);
  const qs    = query.toString() ? `?${query.toString()}` : "";
  return `${base}${path}${qs}`;
}

function authHeaders() {
  const token = tokenInput.value.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJSON(path, params) {
  const res = await fetch(apiUrl(path, params), { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJSON(path, body, params) {
  const res = await fetch(apiUrl(path, params), {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body:    JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function playerParam() {
  return playerSelect.value ? { player: playerSelect.value } : {};
}

// ── Volume ────────────────────────────────────────────────
async function syncVolume() {
  try {
    const res = await fetch(apiUrl("/volume"), { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (typeof data.volume === "number") {
      volSlider.value = Math.round(data.volume * 100);
    }
  } catch (err) {
    console.error("Volume fetch failed:", err);
  }
}

// ── Players ───────────────────────────────────────────────
async function loadPlayers() {
  try {
    const players = await fetchJSON("/players");
    let selected  = currentPlayer || playerSelect.value || lastPlayerPref || "";
    playerSelect.innerHTML = "";
    const autoOpt = document.createElement("option");
    autoOpt.value = "";
    autoOpt.textContent = "Auto";
    playerSelect.appendChild(autoOpt);
    for (const p of players) {
      const opt = document.createElement("option");
      opt.value = p.bus_name;
      opt.textContent = `${p.identity || p.bus_name} (${p.playback_status})`;
      playerSelect.appendChild(opt);
    }
    if (selected && !players.find((p) => p.bus_name === selected)) selected = "";
    if (selected) {
      playerSelect.value = selected;
      setCurrentPlayer(selected);
    } else {
      playerSelect.selectedIndex = 0;
      setCurrentPlayer("");
    }
  } catch (err) {
    console.error("Load players failed:", err);
  }
}

async function loadNowPlaying() {
  try {
    const info = await fetchJSON("/nowplaying", playerParam());
    updateUI(info);
  } catch (err) {
    console.error("Now playing fetch failed:", err);
  }
}

// ── WebSocket ─────────────────────────────────────────────
function stopWS() {
  clearTimeout(wsReconnectTimer);
  if (ws) { ws.close(); ws = null; }
  wsReady = false;
}

function startWS() {
  stopWS();
  const params = new URLSearchParams();
  if (currentPlayer) params.set("player", currentPlayer);
  const token = tokenInput.value.trim();
  if (token) params.set("token", token);
  const wsUri = apiUrl("/ws", Object.fromEntries(params)).replace(/^http/, "ws");
  try {
    ws = new WebSocket(wsUri);
    ws.onmessage = (evt) => {
      if (!wsReady) return;
      try {
        const data = JSON.parse(evt.data);
        if (!data.error) updateUI(data);
      } catch (e) {
        console.error("WS parse error:", e);
      }
    };
    ws.onopen = () => {
      wsReady = true;
      setConnectionDot(true);
    };
    ws.onclose = () => {
      setConnectionDot(false);
      wsReconnectTimer = setTimeout(startWS, 1500);
    };
    ws.onerror = () => {
      setConnectionDot(false);
      wsReconnectTimer = setTimeout(startWS, 1500);
    };
  } catch (err) {
    console.error("WS failed:", err);
    setConnectionDot(false);
  }
}

// ── foreground refresh ─────────────────────────────────────
async function foregroundRefresh() {
  if (document.visibilityState !== "visible") return;
  if (foregroundRefreshInFlight) return;
  foregroundRefreshInFlight = true;
  try {
    stopWS();
    await loadPlayers();
    await loadNowPlaying();
    await syncVolume();
    startWS();
  } catch (err) {
    console.error("Refresh failed:", err);
  } finally {
    foregroundRefreshInFlight = false;
  }
}

// ── Controls ──────────────────────────────────────────────
async function bindControls() {
  playPauseBtn.onclick = async () => {
    haptic();
    try { await postJSON("/player/playpause", {}, playerParam()); }
    catch (err) { console.error("Play/pause failed:", err); }
  };
  replay10Btn.onclick = async () => {
    haptic();
    try {
      await postJSON("/player/seek", { delta_ms: -10000 }, playerParam());
      applyLocalSeek(-10000);
    } catch (err) { console.error("Replay 10 failed:", err); }
  };
  prevBtn.onclick = async () => {
    haptic();
    try { await postJSON("/player/prev", {}, playerParam()); }
    catch (err) { console.error("Prev failed:", err); }
  };
  nextBtn.onclick = async () => {
    haptic();
    try { await postJSON("/player/next", {}, playerParam()); }
    catch (err) { console.error("Next failed:", err); }
  };
  forward10Btn.onclick = async () => {
    haptic();
    try {
      await postJSON("/player/seek", { delta_ms: 10000 }, playerParam());
      applyLocalSeek(10000);
    } catch (err) { console.error("Forward 10 failed:", err); }
  };
  positionSlider.addEventListener("input", (e) => {
    userScrubbing = true;
    renderTime(parseInt(e.target.value, 10) || 0, durationMs);
  });
  positionSlider.addEventListener("change", async (e) => {
    haptic();
    const val   = parseInt(e.target.value, 10) || 0;
    const delta = val - currentPositionMillis();
    userScrubbing = false;
    if (durationMs === 0) return;
    try {
      await postJSON("/player/seek", { target_ms: val, delta_ms: Math.round(delta) }, playerParam());
      lastPositionMs = val;
      lastUpdateTs   = performance.now();
    } catch (err) { console.error("Seek failed:", err); }
  });
  volSlider.oninput = async (e) => {
    haptic();
    const value = parseInt(e.target.value, 10) / 100;
    try { await postJSON("/volume", { absolute: value }); }
    catch (err) { console.error("Volume set failed:", err); }
  };
}

playerSelect.addEventListener("change", () => {
  setCurrentPlayer(playerSelect.value);
  startWS();
});

// ── Init ──────────────────────────────────────────────────
async function init() {
  loadPrefs();
  setConnectionDot(false);
  await bindControls();
  connectBtn.onclick = async () => {
    savePrefs();
    await foregroundRefresh();
  };
  refreshBtn.onclick = async () => {
    await loadPlayers();
    await loadNowPlaying();
    await syncVolume();
  };
  await foregroundRefresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      foregroundRefresh();
    } else {
      stopWS();
    }
  });
  requestAnimationFrame(tick);
}

init().catch(console.error);
