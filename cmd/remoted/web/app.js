const el = (id) => document.getElementById(id);

const hostInput = el("host");
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
const playPauseBtn = el("playpause");
const prevBtn = el("prev");
const nextBtn = el("next");
const volDownBtn = el("vol-down");
const volUpBtn = el("vol-up");
const muteBtn = el("mute");
const volSlider = el("volume");

let ws;
let pollingTimer;
let playersTimer;
let wsReconnectTimer;
let lastPlayerPref = "";
let currentPlayer = "";

function loadPrefs() {
  const host = localStorage.getItem("umr_host") || "http://127.0.0.1:8080";
  const token = localStorage.getItem("umr_token") || "";
  lastPlayerPref = localStorage.getItem("umr_player") || "";
  currentPlayer = lastPlayerPref;
  hostInput.value = host;
  tokenInput.value = token;
}

function savePrefs() {
  localStorage.setItem("umr_host", hostInput.value.trim());
  localStorage.setItem("umr_token", tokenInput.value.trim());
  localStorage.setItem("umr_player", lastPlayerPref);
}

function setCurrentPlayer(val) {
  currentPlayer = val || "";
  lastPlayerPref = currentPlayer;
  savePrefs();
  if (playerSelect.value !== currentPlayer) {
    playerSelect.value = currentPlayer;
  }
}

function apiUrl(path, params = {}) {
  const base = hostInput.value.replace(/\/+$/, "");
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
  const art = info.art_url_proxy || info.art_url || "";
  artImg.src = art || "";
  statusLine.textContent = `Player: ${info.identity || info.bus_name || "auto"} | ${new Date().toLocaleTimeString()}`;
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

    const isPlaying = (p) => (p.playback_status || "").toLowerCase() === "playing";

    if (selected) {
      const exists = players.find((p) => p.bus_name === selected);
      if (!exists) {
        selected = "";
      }
    }

    if (!selected) {
      const playing = players.find(isPlaying);
      if (playing) {
        selected = playing.bus_name;
      } else {
        const active = players.find((p) => p.is_active);
        if (active) selected = active.bus_name;
      }
    }

    if (selected) {
      playerSelect.value = selected;
      setCurrentPlayer(selected);
    } else if (playerSelect.options.length > 0) {
      playerSelect.selectedIndex = 0; // Auto
      setCurrentPlayer("");
    }
  } catch (err) {
    statusLine.textContent = `Load players failed: ${err.message}`;
  }
}

async function refreshNowPlaying() {
  try {
    const params = {};
    if (currentPlayer) params.player = currentPlayer;
    const info = await fetchJSON("/nowplaying", params);
    updateUI(info);
  } catch (err) {
    statusLine.textContent = `Now playing failed: ${err.message}`;
  }
}

function startPolling() {
  clearInterval(pollingTimer);
  clearInterval(playersTimer);
  pollingTimer = setInterval(refreshNowPlaying, 3000);
  playersTimer = setInterval(loadPlayers, 5000);
}

function stopWS() {
  clearTimeout(wsReconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
}

function startWS() {
  stopWS();
  const params = new URLSearchParams();
  if (currentPlayer) params.set("player", currentPlayer);
  const token = tokenInput.value.trim();
  if (token) params.set("token", token);
  params.set("interval_ms", "2000");
  const wsUrl = apiUrl("/ws", Object.fromEntries(params));
  const wsUri = wsUrl.replace(/^http/, "ws");
  try {
    ws = new WebSocket(wsUri);
    ws.onmessage = (evt) => {
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
    ws.onopen = () => (statusLine.textContent = "Connected (WS)");
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

playerSelect.addEventListener("change", () => {
  setCurrentPlayer(playerSelect.value);
  startWS();
  refreshNowPlaying();
});

function playerParam() {
  return playerSelect.value ? { player: playerSelect.value } : {};
}

async function bindControls() {
  playPauseBtn.onclick = async () => {
    try {
      await postJSON("/player/playpause", {}, playerParam());
      await refreshNowPlaying();
    } catch (err) {
      statusLine.textContent = `Play/pause failed: ${err.message}`;
    }
  };
  prevBtn.onclick = async () => {
    try {
      await postJSON("/player/prev", {}, playerParam());
      await refreshNowPlaying();
    } catch (err) {
      statusLine.textContent = `Prev failed: ${err.message}`;
    }
  };
  nextBtn.onclick = async () => {
    try {
      await postJSON("/player/next", {}, playerParam());
      await refreshNowPlaying();
    } catch (err) {
      statusLine.textContent = `Next failed: ${err.message}`;
    }
  };
  volDownBtn.onclick = () => adjustVolume(-0.05);
  volUpBtn.onclick = () => adjustVolume(0.05);
  muteBtn.onclick = async () => {
    try {
      await postJSON("/volume", { mute: true });
      await refreshNowPlaying();
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
    stopWS();
    await loadPlayers();
    await refreshNowPlaying();
    startPolling();
    startWS();
  };
  refreshBtn.onclick = async () => {
    await loadPlayers();
    await refreshNowPlaying();
  };
  await loadPlayers();
  await refreshNowPlaying();
  startPolling();
  startWS();
}

init().catch((err) => (statusLine.textContent = err.message));
