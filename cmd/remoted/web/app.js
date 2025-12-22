const el = (id) => document.getElementById(id);

const tokenInput = el("token");
const connectBtn = el("connect");
const refreshBtn = el("refresh");
const playerSelect = el("player");
const artImg = el("art");
const titleEl = el("title");
const artistEl = el("artist");
const albumEl = el("album");
const statusEl = el("status");
const statusLine = el("status-line");
const positionSlider = el("position");
const currentTimeEl = el("current-time");
const totalTimeEl = el("total-time");
const playPauseBtn = el("playpause");
const playPauseIcon = el("playpause-icon");
const replay10Btn = el("replay10");
const prevBtn = el("prev");
const nextBtn = el("next");
const forward10Btn = el("forward10");
const volDownBtn = el("vol-down");
const volUpBtn = el("vol-up");
const muteBtn = el("mute");
const muteIcon = el("mute-icon");
const volSlider = el("volume");

let ws;
let wsReconnectTimer;
let wsReady = false;
let lastPlayerPref = "";
let currentPlayer = ""; // empty string means Auto mode (server decides)
let isMuted = false;
let lastPositionMs = 0;
let durationMs = 0;
let lastUpdateTs = 0;
let isPlaying = false;
let userScrubbing = false;
let foregroundRefreshInFlight = false;

function currentPositionMillis() {
  if (!isPlaying || durationMs <= 0) {
    return lastPositionMs;
  }
  const elapsed = performance.now() - lastUpdateTs;
  return Math.min(durationMs, lastPositionMs + elapsed);
}

function loadPrefs() {
  const token = localStorage.getItem("umr_token") || "";
  lastPlayerPref = localStorage.getItem("umr_player") || "";
  currentPlayer = lastPlayerPref;
  tokenInput.value = token;
}

function savePrefs() {
  localStorage.setItem("umr_token", tokenInput.value.trim());
  localStorage.setItem("umr_player", lastPlayerPref);
}

function setCurrentPlayer(val) {
  currentPlayer = val || "";
  lastPlayerPref = currentPlayer;
  savePrefs();
  playerSelect.value = currentPlayer;
}

function apiUrl(path, params = {}) {
  const base = window.location.origin.replace(/\/+$/, "");
  const query = new URLSearchParams(params);
  const qs = query.toString() ? `?${query.toString()}` : "";
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
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function updateUI(info) {
  titleEl.textContent = info.title || "—";
  artistEl.textContent = info.artist || "";
  albumEl.textContent = info.album || "";
  statusEl.textContent = info.playback_status || "";
  setPlayPauseIcon(info.playback_status);
  updateScrubber(info);
  const art = pickArt(info);
  artImg.src = art || "";
  statusLine.textContent = `Player: ${info.identity || info.bus_name || "auto"} | ${new Date().toLocaleTimeString()}`;
}

function pickArt(info) {
  if (isNetflix(info)) return "/static/netflix_icon.svg";
  const thumb = youtubeThumbFromURL(info.url || "");
  if (thumb) return thumb;
  if (info.art_url_proxy) return info.art_url_proxy;
  if (info.art_url) return info.art_url;
  return "/static/noartworkfound.svg";
}

function isNetflix(info) {
  const t = (info.title || "").toLowerCase();
  const id = (info.identity || "").toLowerCase();
  return t === "netflix" || id === "netflix";
}

function youtubeThumbFromURL(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (!/^(www\.)?youtube\.com$/.test(u.hostname) && u.hostname !== "youtu.be") return "";
    let id = "";
    if (u.hostname === "youtu.be") {
      id = u.pathname.slice(1);
    } else {
      id = u.searchParams.get("v") || "";
    }
    if (!id) return "";
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  } catch (e) {
    return "";
  }
}

function setPlayPauseIcon(status) {
  const isPlaying = (status || "").toLowerCase() === "playing";
  playPauseIcon.classList.toggle("icon-play", !isPlaying);
  playPauseIcon.classList.toggle("icon-pause", isPlaying);
}

function setMuteIcon(stateMuted) {
  isMuted = !!stateMuted;
  muteIcon.src = isMuted
    ? "/static/volume_mute_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg"
    : "/static/volume_up_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg";
  muteIcon.alt = isMuted ? "Volume muted" : "Volume up";
  muteBtn.setAttribute("aria-pressed", isMuted ? "true" : "false");
}

function updateScrubber(info) {
  durationMs = info.length_millis || 0;
  lastPositionMs = info.position_millis || 0;
  lastUpdateTs = performance.now();
  isPlaying = (info.playback_status || "").toLowerCase() === "playing";
  positionSlider.max = durationMs;
  positionSlider.disabled = durationMs === 0;
  if (!userScrubbing) {
    positionSlider.value = lastPositionMs;
  }
  renderTime(lastPositionMs, durationMs);
}

function renderTime(posMs, durMs) {
  currentTimeEl.textContent = formatTime(posMs);
  totalTimeEl.textContent = durMs ? formatTime(durMs) : "0:00";
}

function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function tick() {
  if (!userScrubbing && isPlaying && durationMs > 0) {
    const elapsed = performance.now() - lastUpdateTs;
    const projected = Math.min(durationMs, lastPositionMs + elapsed);
    positionSlider.value = projected;
    renderTime(projected, durationMs);
  }
  requestAnimationFrame(tick);
}

function applyLocalSeek(deltaMs) {
  if (durationMs <= 0) {
    return;
  }
  lastPositionMs = Math.max(0, Math.min(durationMs, lastPositionMs + deltaMs));
  lastUpdateTs = performance.now();
  positionSlider.value = lastPositionMs;
  renderTime(lastPositionMs, durationMs);
}

async function syncVolume() {
  try {
    const res = await fetch(apiUrl("/volume"), { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setMuteIcon(data.muted);
    if (typeof data.volume === "number") {
      volSlider.value = Math.round(data.volume * 100);
    }
  } catch (err) {
    statusLine.textContent = `Volume fetch failed: ${err.message}`;
  }
}

async function loadPlayers() {
  try {
    const players = await fetchJSON("/players");
    let selected = currentPlayer || playerSelect.value || lastPlayerPref || "";
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

    if (selected) {
      const exists = players.find((p) => p.bus_name === selected);
      if (!exists) {
        selected = "";
      }
    }

    if (selected) {
      playerSelect.value = selected;
      setCurrentPlayer(selected);
    } else {
      playerSelect.selectedIndex = 0; // Auto
      setCurrentPlayer("");
    }
  } catch (err) {
    statusLine.textContent = `Load players failed: ${err.message}`;
  }
}

function stopWS() {
  clearTimeout(wsReconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
  wsReady = false;
}

function startWS() {
  stopWS();
  const params = new URLSearchParams();
  if (currentPlayer) params.set("player", currentPlayer);
  const token = tokenInput.value.trim();
  if (token) params.set("token", token);
  const wsUrl = apiUrl("/ws", Object.fromEntries(params));
  const wsUri = wsUrl.replace(/^http/, "ws");
  try {
    ws = new WebSocket(wsUri);
    ws.onmessage = (evt) => {
      if (!wsReady) return;
      try {
        const data = JSON.parse(evt.data);
        if (data.error) {
          statusLine.textContent = `WS error: ${data.error}`;
          return;
        }
        updateUI(data);
      } catch (e) {
        statusLine.textContent = `WS parse error: ${e.message}`;
      }
    };
    ws.onopen = () => {
      wsReady = true;
      statusLine.textContent = "Connected (WS)";
    };
    ws.onclose = () => {
      statusLine.textContent = "Disconnected";
      wsReconnectTimer = setTimeout(startWS, 1500);
    };
    ws.onerror = () => {
      statusLine.textContent = "WS error";
      wsReconnectTimer = setTimeout(startWS, 1500);
    };
  } catch (err) {
    statusLine.textContent = `WS failed: ${err.message}`;
  }
}

async function foregroundRefresh() {
  if (document.visibilityState !== "visible") return;
  if (foregroundRefreshInFlight) return;
  foregroundRefreshInFlight = true;
  try {
    stopWS();
    await loadPlayers();
    await syncVolume();
    startWS();
  } catch (err) {
    statusLine.textContent = `Refresh failed: ${err.message}`;
  } finally {
    foregroundRefreshInFlight = false;
  }
}

playerSelect.addEventListener("change", () => {
  setCurrentPlayer(playerSelect.value);
  startWS();
});

function playerParam() {
  return playerSelect.value ? { player: playerSelect.value } : {};
}

async function bindControls() {
  playPauseBtn.onclick = async () => {
    try {
      await postJSON("/player/playpause", {}, playerParam());
    } catch (err) {
      statusLine.textContent = `Play/pause failed: ${err.message}`;
    }
  };
  replay10Btn.onclick = async () => {
    try {
      await postJSON("/player/seek", { delta_ms: -10000 }, playerParam());
      applyLocalSeek(-10000);
    } catch (err) {
      statusLine.textContent = `Replay 10 failed: ${err.message}`;
    }
  };
  prevBtn.onclick = async () => {
    try {
      await postJSON("/player/prev", {}, playerParam());
    } catch (err) {
      statusLine.textContent = `Prev failed: ${err.message}`;
    }
  };
  nextBtn.onclick = async () => {
    try {
      await postJSON("/player/next", {}, playerParam());
    } catch (err) {
      statusLine.textContent = `Next failed: ${err.message}`;
    }
  };
  forward10Btn.onclick = async () => {
    try {
      await postJSON("/player/seek", { delta_ms: 10000 }, playerParam());
      applyLocalSeek(10000);
    } catch (err) {
      statusLine.textContent = `Forward 10 failed: ${err.message}`;
    }
  };
  positionSlider.addEventListener("input", (e) => {
    userScrubbing = true;
    const val = parseInt(e.target.value, 10) || 0;
    renderTime(val, durationMs);
  });
  positionSlider.addEventListener("change", async (e) => {
    const val = parseInt(e.target.value, 10) || 0;
    const currentPos = currentPositionMillis();
    const delta = val - currentPos;
    userScrubbing = false;
    if (durationMs === 0) return;
    try {
      await postJSON("/player/seek", { target_ms: val, delta_ms: Math.round(delta) }, playerParam());
      lastPositionMs = val;
      lastUpdateTs = performance.now();
    } catch (err) {
      statusLine.textContent = `Seek failed: ${err.message}`;
    }
  });
  volDownBtn.onclick = () => adjustVolume(-0.05);
  volUpBtn.onclick = () => adjustVolume(0.05);
  muteBtn.onclick = async () => {
    const nextMuted = !isMuted;
    try {
      await postJSON("/volume", { mute: nextMuted });
      setMuteIcon(nextMuted);
    } catch (err) {
      statusLine.textContent = `Mute failed: ${err.message}`;
    }
  };
  volSlider.oninput = async (e) => {
    const value = parseInt(e.target.value, 10) / 100;
    try {
      await postJSON("/volume", { absolute: value });
    } catch (err) {
      statusLine.textContent = `Volume set failed: ${err.message}`;
    }
  };
}

async function adjustVolume(delta) {
  try {
    await postJSON("/volume", { delta });
  } catch (err) {
    statusLine.textContent = `Volume adjust failed: ${err.message}`;
  }
}

async function init() {
  loadPrefs();
  await bindControls();
  connectBtn.onclick = async () => {
    savePrefs();
    await foregroundRefresh();
  };
  refreshBtn.onclick = async () => {
    await loadPlayers();
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

init().catch((err) => (statusLine.textContent = err.message));
