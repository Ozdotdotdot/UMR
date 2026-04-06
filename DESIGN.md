# UMR Web UI Refresh — Design Document

## What this is

A design spec for refreshing the UMR web client (`cmd/remoted/web/`). The goal is a cleaner, more visually striking interface that matches the quality of the sonotui web client — same blurred-art background approach, same frosted-glass controls, same mobile-first philosophy. Drop Vibrant.js entirely.

The backend (Go daemon, WebSocket API) does not change. This is a pure frontend refresh.

---

## What changes and why

| Before | After |
|--------|-------|
| Card-based layout on dark static background | Album art blurred fullscreen as background |
| Vibrant.js extracts colors, repaints CSS variables | No color extraction — blur + overlay does the work |
| Token input + player dropdown always visible | Tucked into a Settings tab |
| Status bar pinned to bottom | Connection dot in the top-right corner of Now Playing |
| Text-based Prev/Next buttons | Icon buttons, same size as ±10s buttons |
| No tab navigation | Bottom tab bar: Now Playing / Settings |

---

## Visual direction

Same treatment as sonotui web client:

```css
.bg-art {
  position: fixed;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  filter: blur(60px) brightness(0.35) saturate(1.3);
  transform: scale(1.15);   /* hides blur edge artifacts */
  transition: background-image 0.8s ease;
}

.bg-art::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}
```

Set via JS when art changes:
```js
bgArt.style.backgroundImage = `url(${artSrc})`;
```

All controls sit at `z-index: 1`. Cards/panels use frosted glass:
```css
background: rgba(255, 255, 255, 0.08);
backdrop-filter: blur(12px);
-webkit-backdrop-filter: blur(12px);
border-radius: 16px;
```

White text, white icons, white range inputs. No theme switching, no accent colors, no Vibrant.js.

---

## Layout

Single page, `max-width: 480px`, centered. Works on mobile and desktop. Bottom tab bar with two tabs: **Now Playing** and **Settings**.

```
┌─────────────────────────┐
│  ● (connection dot) top-right │
│                         │
│   ┌─────────────────┐   │
│   │   album art     │   │
│   └─────────────────┘   │
│                         │
│   Song Title            │
│   Artist · App          │
│                         │
│   0:42 ━━━━━━──── 3:21  │
│                         │
│   ⏮  ↺10  ⏸  10↻  ⏭  │
│                         │
│   🔈 ──────●────── 🔊   │
│                         │
├─────────────────────────┤
│  🎵 Now Playing  ⚙ Settings │
└─────────────────────────┘
```

---

## Now Playing tab

**Art** — large centered square with `border-radius: 16px`, `box-shadow: 0 8px 40px rgba(0,0,0,0.5)`. Show a ♫ placeholder when no art is available. Hide the `<img>` tag when `src` is empty so the placeholder shows through.

**Meta** — title bold 20px, artist/app name 14px at 60% opacity. Single line each, `text-overflow: ellipsis`.

**Progress bar** — custom styled, same as sonotui:
- Thin track (4px), white fill, white thumb on the range input
- Times displayed above: elapsed left, total right
- Range input overlaid transparent on top of the visual track (same technique)
- Stays interactive — seek fires on `change` event

**Transport row** — five buttons in a row, centered:
```
⏮   ↺10   ⏸/▶   10↻   ⏭
```
- Play/pause button slightly larger (68px circle, frosted glass background)
- All others are ghost buttons (no background), same icon size (~28px)
- All SVG icons, no image files

**Volume row** — same as sonotui: small speaker icon, range slider, large speaker icon.

**Connection indicator** — small dot, top-right corner of the panel. Green when WS connected, grey when disconnected. Tap it to force reconnect (same behavior as the current connection icon, just repositioned and smaller).

---

## Settings tab

Clean, simple. Two sections:

**Connection**
- Token field (password input, `placeholder="Token (optional)"`)
- Save button — persists to `localStorage` (same key as today: `umr_token`)
- On save, reconnect WebSocket

**Player**
- Dropdown listing available players (populated from `/players`)
- Refresh button to re-fetch the player list
- Active player persisted to `localStorage` (same key: `umr_player`)

The settings tab is where the user goes once to set up, then never again during normal use. It should feel like a settings screen, not a control panel.

---

## JS architecture changes

### Remove
- Vibrant.js `<script>` tag from `index.html`
- `extractColorsFromImage()`, `applyTheme()`, `adjustColorForContrast()`, `getLuminance()`, `getContrastRatio()`, `darkenColor()`, `lightenColor()`, `detectFallbackTheme()`, `updateThemeFromArtwork()` — all the color system functions
- `fallbackThemes` object
- `currentTheme` variable
- The `artImg.onload` color extraction call in `setArtImage()`
- `setConnectionIcon()` — replace with a simple dot update function

### Add
- `updateBgArt(src)` — sets `bgArt.style.backgroundImage`
- `setConnectionDot(connected)` — toggles a small dot color
- Tab switching logic (same pattern as sonotui: toggle `.hidden` on panels, `.active` on tab buttons)

### Keep (unchanged)
- WebSocket connect/reconnect logic (`startWS`, `stopWS`, `wsReconnectTimer`)
- `currentPositionMillis()` + `tick()` rAF loop for smooth scrubber interpolation
- `applyLocalSeek()` for the ±10s buttons
- `loadPlayers()`, `loadNowPlaying()`, `syncVolume()`
- `foregroundRefresh()` on `visibilitychange`
- `haptic()` via the hidden checkbox trick
- `localStorage` prefs (`loadPrefs`, `savePrefs`)
- All the control button handlers (playpause, prev, next, ±10s, seek, volume)

### Simplify `setArtImage(src, info)`
```js
function setArtImage(src) {
  const next = src || fallbackArt;
  if (artImg.src === next) return;
  artImg.src = next;
  bgArt.style.backgroundImage = next !== fallbackArt
    ? `url(${next})`
    : '';
}
```
No color extraction. No `info` parameter needed anymore.

---

## CSS changes

### Remove
- All CSS variable transitions (`--color-transition`)
- All dynamic CSS variables (`--bg`, `--card`, `--accent`, `--primary`, `--button-bg`, `--button-hover-bg`, `--button-border-accent`)
- `.card` grid layout
- `.panel` card style
- `.top` section styles
- `.sticky` status bar styles
- `#status-line` styles
- `.connection-icon` styles

### New structure
```
body                     dark fallback background (#0a0a0a)
.bg-art                  fixed fullscreen blurred art layer
.app                     fixed inset, max-width 480px, flex column
.panel                   flex:1, overflow hidden, padding-bottom for tab bar
.panel.hidden            display:none
.tab-bar                 fixed bottom, frosted glass, two tabs
.tab-btn                 flex:1, icon + label, white when active
.np-scroll               scrollable inner content of Now Playing
.art-wrap                centered square
.meta                    title + sub
.progress-wrap           scrubber + times
.transport               five-button row
.volume-wrap             icon + slider + icon
.connection-dot          small circle, top-right absolute
.settings-section        padded card with label + inputs
```

---

## HTML structure

```html
<div class="bg-art" id="bg-art"></div>

<div class="app">
  <!-- Now Playing -->
  <div class="panel" id="panel-nowplaying">
    <div class="connection-dot" id="connection-dot"></div>
    <div class="np-scroll">
      <div class="art-wrap">
        <img id="art" src="" alt="Album art" />
        <div class="art-placeholder" id="art-placeholder">♫</div>
      </div>
      <div class="meta">
        <div class="track-title" id="title">—</div>
        <div class="track-sub" id="artist"></div>
      </div>
      <div class="progress-wrap">
        <div class="progress-times">
          <span id="current-time">0:00</span>
          <span id="total-time">0:00</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="progress-fill"></div>
          <input type="range" id="position" min="0" max="0" value="0" step="1000">
        </div>
      </div>
      <div class="transport">
        <button id="prev">   <!-- skip-prev SVG --> </button>
        <button id="replay10"> <!-- replay-10 SVG --> </button>
        <button id="playpause" class="play-btn">
          <svg class="icon-play">...</svg>
          <svg class="icon-pause hidden">...</svg>
        </button>
        <button id="forward10"> <!-- forward-10 SVG --> </button>
        <button id="next">  <!-- skip-next SVG --> </button>
      </div>
      <div class="volume-wrap">
        <svg class="vol-icon"><!-- quiet --></svg>
        <input type="range" id="volume" min="0" max="100" step="1">
        <svg class="vol-icon"><!-- loud --></svg>
      </div>
    </div>
  </div>

  <!-- Settings -->
  <div class="panel hidden" id="panel-settings">
    <div class="panel-header">Settings</div>
    <div class="settings-section">
      <label>Token</label>
      <input type="password" id="token" placeholder="Optional">
      <div class="settings-section">
        <label>Player</label>
        <select id="player"></select>
        <button id="refresh">Refresh</button>
      </div>
      <button id="connect">Save &amp; Connect</button>
    </div>
  </div>

  <!-- Tab bar -->
  <nav class="tab-bar">
    <button class="tab-btn active" data-tab="nowplaying">
      <!-- music note SVG -->
      <span>Now Playing</span>
    </button>
    <button class="tab-btn" data-tab="settings">
      <!-- gear SVG -->
      <span>Settings</span>
    </button>
  </nav>
</div>
```

---

## Files to change

| File | Change |
|------|--------|
| `index.html` | Remove Vibrant.js script tag. Restructure to new HTML layout above. |
| `style.css` | Full rewrite — remove color system, add bg-art + frosted glass + tab bar. |
| `app.js` | Remove color extraction system. Add `updateBgArt()`, tab switching, `setConnectionDot()`. Simplify `setArtImage()`. Move token/player UI interactions to settings tab handlers. |

---

## What to keep from the old app.js

The WebSocket logic, the `tick()` rAF loop, `applyLocalSeek()`, `foregroundRefresh()`, `haptic()`, and all the control button handlers are solid and don't need to change. The refresh is a visual layer on top of the existing working logic.
