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
const statusText = el("status-text");
const connectionIcon = el("connection-icon");
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
const fallbackArt = "/static/noartworkfound.svg";

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

// Color theming system
let currentTheme = null;

// Predefined themes for fallback images
const fallbackThemes = {
  netflix: {
    name: "Netflix",
    primary: [229, 9, 20],      // Netflix red
    secondary: [0, 0, 0],        // Black
    accent: [229, 9, 20],
    background: [20, 20, 20],
    backgroundDark: [0, 0, 0]
  },
  crunchyroll: {
    name: "Crunchyroll",
    primary: [244, 123, 35],     // Crunchyroll orange
    secondary: [35, 35, 35],
    accent: [244, 123, 35],
    background: [23, 23, 23],
    backgroundDark: [15, 15, 15]
  },
  default: {
    name: "Default",
    primary: [97, 218, 251],     // Original accent color
    secondary: [23, 27, 34],
    accent: [97, 218, 251],
    background: [15, 17, 21],
    backgroundDark: [10, 12, 15]
  }
};

// Utility: Convert RGB array to hex string
function rgbToHex(rgb) {
  return '#' + rgb.map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

// Utility: Calculate relative luminance for WCAG contrast
function getLuminance(rgb) {
  const [r, g, b] = rgb.map(val => {
    const normalized = val / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Utility: Calculate contrast ratio between two colors
function getContrastRatio(rgb1, rgb2) {
  const lum1 = getLuminance(rgb1);
  const lum2 = getLuminance(rgb2);
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Utility: Lighten or darken a color to meet contrast requirements
function adjustColorForContrast(foreground, background, targetRatio = 4.5) {
  let adjusted = [...foreground];
  let ratio = getContrastRatio(adjusted, background);

  if (ratio >= targetRatio) return adjusted;

  // Determine if we need to lighten or darken
  const shouldLighten = getLuminance(foreground) < getLuminance(background);

  // Binary search for the right adjustment
  let step = shouldLighten ? 10 : -10;
  let iterations = 0;
  const maxIterations = 50;

  while (ratio < targetRatio && iterations < maxIterations) {
    adjusted = adjusted.map(val => {
      const newVal = val + step;
      return Math.max(0, Math.min(255, newVal));
    });
    ratio = getContrastRatio(adjusted, background);
    iterations++;

    // If we've hit the bounds, we're done
    if (adjusted.every(v => v === 0 || v === 255)) break;
  }

  return adjusted;
}

// Utility: Create a darker version of a color
function darkenColor(rgb, factor = 0.3) {
  return rgb.map(val => Math.round(val * factor));
}

// Utility: Create a lighter version of a color
function lightenColor(rgb, factor = 1.5) {
  return rgb.map(val => Math.min(255, Math.round(val * factor)));
}

// Extract colors from an image using Vibrant.js
async function extractColorsFromImage(imgElement) {
  try {
    const vibrant = new Vibrant(imgElement);
    const palette = await vibrant.getPalette();

    // Vibrant.js provides these swatches: Vibrant, Muted, DarkVibrant, DarkMuted, LightVibrant, LightMuted
    const swatches = {
      vibrant: palette.Vibrant,
      muted: palette.Muted,
      darkVibrant: palette.DarkVibrant,
      darkMuted: palette.DarkMuted,
      lightVibrant: palette.LightVibrant,
      lightMuted: palette.LightMuted
    };

    // Use DarkMuted for background - this is what Vibrant.js is designed for!
    // It's a desaturated, dark version of the dominant color - perfect for backgrounds
    const backgroundSwatch = swatches.darkMuted || swatches.muted || swatches.darkVibrant;
    if (!backgroundSwatch) {
      throw new Error("No suitable background color found");
    }

    // Use Vibrant or LightVibrant for accent - these are the most saturated, eye-catching colors
    const accentSwatch = swatches.vibrant || swatches.lightVibrant || swatches.darkVibrant;
    if (!accentSwatch) {
      throw new Error("No vibrant accent color found");
    }

    // Extract RGB values
    const backgroundRgb = backgroundSwatch.rgb.map(Math.round);
    const accentRgb = accentSwatch.rgb.map(Math.round);

    // For the "primary" color (used for certain UI elements), use the Vibrant swatch
    // or fallback to DarkVibrant
    const primarySwatch = swatches.vibrant || swatches.darkVibrant || accentSwatch;
    const primaryRgb = primarySwatch.rgb.map(Math.round);

    // Create a slightly lighter version of background for cards
    const cardBg = lightenColor(backgroundRgb, 1.15);

    // Create an even darker version for the page background
    const pageBg = darkenColor(backgroundRgb, 0.85);

    // Create theme using Vibrant.js's purpose-built swatches
    const theme = {
      name: "Extracted",
      primary: primaryRgb,
      accent: accentRgb,
      secondary: (swatches.muted || swatches.lightMuted)?.rgb.map(Math.round) || backgroundRgb,
      // Use the natural background colors from Vibrant.js
      background: cardBg,              // Slightly lighter for cards
      backgroundDark: pageBg           // DarkMuted darkened for page background
    };

    // Debug log with all swatches
    console.log('🎨 Vibrant.js extracted swatches:', {
      darkMuted: swatches.darkMuted ? rgbToHex(swatches.darkMuted.rgb) : 'null',
      vibrant: swatches.vibrant ? rgbToHex(swatches.vibrant.rgb) : 'null',
      lightVibrant: swatches.lightVibrant ? rgbToHex(swatches.lightVibrant.rgb) : 'null',
      muted: swatches.muted ? rgbToHex(swatches.muted.rgb) : 'null'
    });

    console.log('🎨 Theme colors:', {
      background: rgbToHex(backgroundRgb),
      accent: rgbToHex(accentRgb),
      primary: rgbToHex(primaryRgb)
    });

    return theme;
  } catch (err) {
    throw new Error(`Vibrant.js extraction failed: ${err.message}`);
  }
}

// Apply theme colors to CSS variables
function applyTheme(theme) {
  if (!theme) return;

  currentTheme = theme;
  const root = document.documentElement;

  // Adjust colors for accessibility
  const textColor = [233, 237, 245]; // Original --text color
  const adjustedPrimary = adjustColorForContrast(theme.primary, theme.background, 4.5);
  const adjustedAccent = adjustColorForContrast(theme.accent, theme.background, 4.5);

  // Apply theme to CSS variables
  root.style.setProperty('--bg', rgbToHex(theme.backgroundDark));
  root.style.setProperty('--card', rgbToHex(theme.background));
  root.style.setProperty('--accent', rgbToHex(adjustedAccent));
  root.style.setProperty('--primary', rgbToHex(adjustedPrimary));

  // Keep text colors readable
  const adjustedText = adjustColorForContrast(textColor, theme.background, 7);
  root.style.setProperty('--text', rgbToHex(adjustedText));

  // Muted text should have lower contrast
  const mutedColor = theme.primary.map((val, idx) =>
    Math.round((val + textColor[idx]) / 2)
  );
  root.style.setProperty('--muted', rgbToHex(mutedColor));

  // Button colors - use accent color for prominent interactive elements
  // Background: darker version of accent for good contrast
  const buttonBg = darkenColor(theme.accent, 0.5);
  // Hover: even darker or use primary color for variation
  const buttonHoverBg = darkenColor(theme.accent, 0.6);
  root.style.setProperty('--button-bg', rgbToHex(buttonBg));
  root.style.setProperty('--button-hover-bg', rgbToHex(buttonHoverBg));

  // Button border/outline accent - use the full brightness accent
  const buttonBorderAccent = adjustColorForContrast(theme.accent, buttonBg, 3);
  root.style.setProperty('--button-border-accent', rgbToHex(buttonBorderAccent));

  // Status bar background with transparency
  const statusBarBg = [...theme.backgroundDark];
  root.style.setProperty('--status-bar-bg', `rgba(${statusBarBg[0]}, ${statusBarBg[1]}, ${statusBarBg[2]}, 0.95)`);

  // Border color for status bar
  const borderColor = lightenColor(theme.backgroundDark, 1.3);
  root.style.setProperty('--status-border', rgbToHex(borderColor));

  // Debug logging
  console.log('🎨 Theme applied:', {
    name: theme.name,
    bg: rgbToHex(theme.backgroundDark),
    card: rgbToHex(theme.background),
    accent: rgbToHex(adjustedAccent),
    primary: rgbToHex(adjustedPrimary),
    buttonBg: rgbToHex(buttonBg),
    buttonBorderAccent: rgbToHex(buttonBorderAccent)
  });
}

// Detect which fallback theme to use based on current media
function detectFallbackTheme(artSrc, info) {
  if (!artSrc || artSrc === fallbackArt) {
    return fallbackThemes.default;
  }

  if (artSrc.includes('netflix_icon.svg') || (info && isNetflix(info))) {
    return fallbackThemes.netflix;
  }

  if (artSrc.includes('crunchyroll_icon.svg') || (info && isCrunchyroll(info))) {
    return fallbackThemes.crunchyroll;
  }

  return null; // Will extract from actual artwork
}

// Main function to update theme based on artwork
async function updateThemeFromArtwork(imgElement, artSrc, info) {
  try {
    // Check if we should use a predefined fallback theme
    const fallbackTheme = detectFallbackTheme(artSrc, info);

    if (fallbackTheme) {
      applyTheme(fallbackTheme);
      return;
    }

    // For SVG fallback or images that can't be analyzed, use default
    if (artSrc.endsWith('.svg')) {
      applyTheme(fallbackThemes.default);
      return;
    }

    // Extract colors from the actual artwork
    const theme = await extractColorsFromImage(imgElement);
    applyTheme(theme);

  } catch (err) {
    console.warn("Failed to extract theme colors:", err);
    // Fallback to default theme on error
    applyTheme(fallbackThemes.default);
  }
}

artImg.dataset.fallback = "true";
artImg.onerror = () => {
  if (artImg.dataset.fallback === "true") return;
  artImg.dataset.fallback = "true";
  artImg.src = fallbackArt;
  // Apply default theme when artwork fails to load
  applyTheme(fallbackThemes.default);
};

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
  setArtImage(art, info);
  statusText.textContent = `Player: ${info.identity || info.bus_name || "auto"} | ${new Date().toLocaleTimeString()}`;
}

function pickArt(info) {
  if (isNetflix(info)) return "/static/netflix_icon.svg";
  if (isCrunchyroll(info)) {
    // If backend found TMDb artwork, use it; otherwise fallback to Crunchyroll icon
    if (info.art_url_proxy) return info.art_url_proxy;
    if (info.art_url) return info.art_url;
    return "/static/crunchyroll_icon.svg";
  }
  const thumb = youtubeThumbFromURL(info.url || "");
  if (thumb) return thumb;
  if (info.art_url_proxy) return info.art_url_proxy;
  if (info.art_url) return info.art_url;
  return fallbackArt;
}

function isNetflix(info) {
  const t = (info.title || "").toLowerCase();
  const id = (info.identity || "").toLowerCase();
  return t === "netflix" || id === "netflix";
}

function isCrunchyroll(info) {
  const t = (info.title || "").toLowerCase();
  return t.endsWith(" - watch on crunchyroll");
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

function setConnectionIcon(connected) {
  if (connected) {
    connectionIcon.src = "/static/connected.svg";
    connectionIcon.alt = "Connected";
    connectionIcon.classList.remove("clickable");
    connectionIcon.style.cursor = "default";
    connectionIcon.onclick = null;
  } else {
    connectionIcon.src = "/static/disconnected.svg";
    connectionIcon.alt = "Disconnected (click to reconnect)";
    connectionIcon.classList.add("clickable");
    connectionIcon.style.cursor = "pointer";
    connectionIcon.onclick = () => {
      statusText.textContent = "Reconnecting...";
      startWS();
    };
  }
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
    statusText.textContent = `Volume fetch failed: ${err.message}`;
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
    statusText.textContent = `Load players failed: ${err.message}`;
  }
}

function setArtImage(src, info) {
  const next = src || fallbackArt;
  artImg.dataset.fallback = next === fallbackArt ? "true" : "false";

  // Only update if the source has changed
  if (artImg.src !== next) {
    artImg.src = next;

    // Wait for image to load before extracting colors
    if (artImg.complete) {
      updateThemeFromArtwork(artImg, next, info);
    } else {
      artImg.onload = () => {
        updateThemeFromArtwork(artImg, next, info);
      };
    }
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
          statusText.textContent = `WS error: ${data.error}`;
          return;
        }
        updateUI(data);
      } catch (e) {
        statusText.textContent = `WS parse error: ${e.message}`;
      }
    };
    ws.onopen = () => {
      wsReady = true;
      statusText.textContent = "Connected (WS)";
      setConnectionIcon(true);
    };
    ws.onclose = () => {
      statusText.textContent = "Disconnected";
      setConnectionIcon(false);
      wsReconnectTimer = setTimeout(startWS, 1500);
    };
    ws.onerror = () => {
      statusText.textContent = "WS error";
      setConnectionIcon(false);
      wsReconnectTimer = setTimeout(startWS, 1500);
    };
  } catch (err) {
    statusText.textContent = `WS failed: ${err.message}`;
    setConnectionIcon(false);
  }
}

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
    statusText.textContent = `Refresh failed: ${err.message}`;
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
      statusText.textContent = `Play/pause failed: ${err.message}`;
    }
  };
  replay10Btn.onclick = async () => {
    try {
      await postJSON("/player/seek", { delta_ms: -10000 }, playerParam());
      applyLocalSeek(-10000);
    } catch (err) {
      statusText.textContent = `Replay 10 failed: ${err.message}`;
    }
  };
  prevBtn.onclick = async () => {
    try {
      await postJSON("/player/prev", {}, playerParam());
    } catch (err) {
      statusText.textContent = `Prev failed: ${err.message}`;
    }
  };
  nextBtn.onclick = async () => {
    try {
      await postJSON("/player/next", {}, playerParam());
    } catch (err) {
      statusText.textContent = `Next failed: ${err.message}`;
    }
  };
  forward10Btn.onclick = async () => {
    try {
      await postJSON("/player/seek", { delta_ms: 10000 }, playerParam());
      applyLocalSeek(10000);
    } catch (err) {
      statusText.textContent = `Forward 10 failed: ${err.message}`;
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
      statusText.textContent = `Seek failed: ${err.message}`;
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
      statusText.textContent = `Mute failed: ${err.message}`;
    }
  };
  volSlider.oninput = async (e) => {
    const value = parseInt(e.target.value, 10) / 100;
    try {
      await postJSON("/volume", { absolute: value });
    } catch (err) {
      statusText.textContent = `Volume set failed: ${err.message}`;
    }
  };
}

async function adjustVolume(delta) {
  try {
    await postJSON("/volume", { delta });
  } catch (err) {
    statusText.textContent = `Volume adjust failed: ${err.message}`;
  }
}

async function loadNowPlaying() {
  try {
    const info = await fetchJSON("/nowplaying", playerParam());
    updateUI(info);
  } catch (err) {
    statusText.textContent = `Now playing fetch failed: ${err.message}`;
  }
}

async function init() {
  loadPrefs();
  setConnectionIcon(false); // Start with disconnected state
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

init().catch((err) => (statusText.textContent = err.message));
