# remoted

Prototype Go daemon for remote media control on Linux. Early stage: only a health endpoint is wired up while we build out media and volume controls.

## Prereqs

- Go 1.21+ (`go` and `gofmt` need to be installed on your system)

## Run (dev)

```bash
# from repo root
export REMOTED_TOKEN="choose-a-secret"   # optional; required for future control endpoints
export REMOTED_BIND="127.0.0.1"          # default
export REMOTED_PORT="8080"               # default

go run ./cmd/remoted
```

Health check:

```bash
curl http://127.0.0.1:8080/healthz
```

Response example:

```json
{
  "status": "ok",
  "version": "0.0.1",
  "host": "my-host",
  "uptime": "123ms",
  "started": "2023-12-13T03:34:00Z",
  "now": "2023-12-13T03:35:00Z",
  "requires_token": false
}
```

## Next steps (planned)

- Token-authenticated control endpoints (MPRIS playback, PulseAudio/PipeWire volume)
- Simple web harness for cURL/JS testing
- TUI client using Bubble Tea
