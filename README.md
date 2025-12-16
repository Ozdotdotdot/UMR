# remoted

Go daemon + web UI for remote media control on Linux (MPRIS playback + PipeWire/PulseAudio volume). Includes a live now-playing page with artwork, transport controls, seek bar, and volume.

## Features
- Auto player selection with manual override; WebSocket push updates (no polling).
- Play/pause, next/prev, ±10s seek, arbitrary seek via scrubber, volume set/delta/mute.
- Artwork proxying for local `file://` art (under `/tmp`/`/var/tmp`).
- HTTP API + browser UI (`/ui`).

## Prereqs
- Linux desktop with MPRIS-capable players and DBus (standard on most distros).
- PipeWire (`wpctl`) or PulseAudio (`pactl`) for volume control.
- Go 1.21+ (only needed for `go install` or building yourself).

## Install (Go users)
```bash
go install github.com/myusername/UMR/cmd/remoted@latest
```
Notes:
- Binary name: `remoted`; ensure `$GOBIN` (or `$GOPATH/bin`) is on your `PATH`.
- `@latest` resolves to the latest git tag (e.g., `v0.1.0`). Tag and push releases so users get a stable version.

## Install (downloaded binary)
Release tarballs include ready-to-run binaries:
- `remoted-linux-amd64.tar.gz`
- `remoted-linux-arm64.tar.gz`

Download and unpack:
```bash
tar -xf remoted-linux-amd64.tar.gz
./remoted
```

## Configure / Run
You can configure with env vars or flags (flags override env defaults):
- `REMOTED_BIND` / `-bind` — listen address (default `127.0.0.1`)
- `REMOTED_PORT` / `-port` — listen port (default `8080`)
- `REMOTED_TOKEN` / `-token` — bearer token (required for everything except `/healthz` when set)
- `REMOTED_ART_CACHE` / `-art-cache` — art cache dir (default `~/.cache/umr/art` or `/tmp/umr/art`)
- `-version` (string) or `-v` (print version and exit)

Examples:
```bash
# local-only (env)
REMOTED_TOKEN="choose-a-secret" remoted

# LAN access (flag)
remoted -bind=0.0.0.0 -token=choose-a-secret
```

Visit the UI at `http://<host>:<port>/ui` (enter your token if set). WebSocket updates keep the page live; transport and volume controls call the API.

Health check:
```bash
curl http://127.0.0.1:8080/healthz
```

## API
See `docs/API.md` for endpoints, auth, and examples (players, nowplaying, playback controls, seek, volume, art proxy).
