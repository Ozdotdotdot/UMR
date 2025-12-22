const TOKEN = "TEST"; // set your token (or "" if none)
const BASE = "http://127.0.0.1:8080";

async function currentChromiumBus() {
  const res = await fetch(`${BASE}/players`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
  });
  if (!res.ok) throw new Error(`players HTTP ${res.status}`);
  const players = await res.json();
  // prefer playing Chromium, else any Chromium
  const playing = players.find(p => (p.identity || "").toLowerCase() === "chromium" &&
    (p.playback_status || "").toLowerCase() === "playing");
  if (playing) return playing.bus_name;
  const any = players.find(p => (p.identity || "").toLowerCase() === "chromium");
  return any ? any.bus_name : "";
}

async function postURL(busName, url) {
  if (!busName || !url) return;
  await fetch(`${BASE}/player/url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
    },
    body: JSON.stringify({ bus_name: busName, url })
  });
}

async function handleTab(tab) {
  if (!tab || !tab.url) return;
  try {
    const bus = await currentChromiumBus();
    if (!bus) return;
    await postURL(bus, tab.url);
  } catch (e) {
    // ignore errors; this is best-effort
  }
}

// Trigger on audible media tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.audible === true) handleTab(tab);
});

// Also when switching tabs (in case media keeps playing)
chrome.tabs.onActivated.addListener(async (info) => {
  const tab = await chrome.tabs.get(info.tabId);
  handleTab(tab);
});
