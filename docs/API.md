# UMR remoted API

All endpoints are HTTP+JSON unless noted. Defaults bind to `127.0.0.1:8080`; set envs to change:
- `REMOTED_BIND` (default `127.0.0.1`)
- `REMOTED_PORT` (default `8080`)
- `REMOTED_TOKEN` (optional; when set, all routes except `/healthz` require it)
- `REMOTED_ART_CACHE` (optional art cache dir; default `~/.cache/umr/art` or `/tmp/umr/art`)

Quick start (server):
```bash
REMOTED_TOKEN="choose-a-secret" remoted
# or: go run ./cmd/remoted
```
UI: `http://<host>:<port>/ui` (enter token if set). API: `http://<host>:<port>/...`

## Auth
When `REMOTED_TOKEN` is set, include it on every request (except `/healthz`):
- `Authorization: Bearer <token>` (preferred), or
- `X-Remote-Token: <token>`

## Player selection
If you don’t pass `?player=…`, the daemon picks a player in this order:
1) last player you successfully controlled
2) any player with `PlaybackStatus == Playing`
3) any player with `PlaybackStatus == Paused`
4) the first available player
You can pin a player by bus name or identity via `?player=org.mpris.MediaPlayer2.spotify` (or `?player=Spotify`, etc.).

## Endpoints

### Health
- `GET /healthz` — open; returns status/version/uptime.

### Players + metadata
- `GET /players` — lists MPRIS players with identity, playback status, metadata (title, artist, album, length, position), and artwork URLs (`art_url`, `art_url_proxy`).
- `GET /player/status` — returns a single player (auto-selected unless `?player=` provided).
- `GET /nowplaying` — alias of `/player/status` (same selection rules).

### Playback controls
- `POST /player/playpause` — toggles play/pause (uses Play/Pause explicitly, fallback to PlayPause).
- `POST /player/next` — next track.
- `POST /player/prev` — previous track.
- `POST /player/seek` — JSON body `{"delta_ms":10000}` moves playback forward/back by delta (ms) using MPRIS Seek; negative to rewind.
Optional: `?player=...` to target a specific player.

### System volume (PipeWire/PulseAudio)
- `GET /volume` — returns `{backend:"wpctl"|"pactl", volume:<0.0–1.5>, muted:<bool>}`.
- `POST /volume` — JSON body:
  - `{"absolute":0.5}` set to 50%
  - `{"delta":0.05}` add +5% (negative to decrease)
  - `{"mute":true}` mute/unmute
Supports combinations (e.g., set volume and mute in one call). Uses `wpctl` first, falls back to `pactl`.

### Artwork proxy
- `GET /art/{id}` — serves cached artwork (token-protected). Responses are `image/*`.
  - `art_url_proxy` fields from player/status endpoints point here.
  - Only `file://` artwork under `/tmp` or `/var/tmp` is proxied; remote HTTP art is left untouched.

## Examples

Health:
```bash
curl http://127.0.0.1:8080/healthz
```

List players:
```bash
curl -H "Authorization: Bearer $REMOTED_TOKEN" http://127.0.0.1:8080/players
```

Now playing:
```bash
curl -H "Authorization: Bearer $REMOTED_TOKEN" http://127.0.0.1:8080/nowplaying
```

Play/pause Spotify explicitly:
```bash
curl -X POST -H "Authorization: Bearer $REMOTED_TOKEN" \
  'http://127.0.0.1:8080/player/playpause?player=org.mpris.MediaPlayer2.spotify'
```

Volume +5%:
```bash
curl -X POST -H "Authorization: Bearer $REMOTED_TOKEN" \
  -d '{"delta":0.05}' http://127.0.0.1:8080/volume
```

Use artwork proxy in a web UI:
```html
<img src="http://127.0.0.1:8080/art/abc123.jpg" />
```
(`abc123.jpg` comes from the `art_url_proxy` in `/nowplaying` or `/players`.)
