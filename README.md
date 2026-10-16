# pi-backend-start

A [Pi](https://pi.dev) extension that manages local LLM backends from inside Pi.
It lazily starts the backend behind the model you select, switches between
profiles, stops them, and paints a readiness light into the footer.

## What it does

- Registers `/backend [start|stop|restart|status|list] [alias]`.
- On `before_agent_start`, starts the backend for the currently selected model
  if it is not already ready (lazy start), then selects that model.
- Detects already-running Docker containers and reuses them instead of
  recreating a warm one.
- Polls each backend's `/v1/models` for readiness. Only a successful check turns
  the light green, so a loading container stays amber.
- Reports status through `ctx.ui.setStatus("backend", ...)` as
  `🟢 uptime: 2h` / `🟢 up:2h` / `🟢 2h` / `🟢` / `🟡` / `⚫`. The companion footer extension
  ([pi-colored-footer](https://github.com/zrlu/pi-colored-footer)) broadcasts the
  room each slot gets (`pi.footer.slotWidth` on `pi.events`); the backend light
  uses it to show the full `uptime:` label, fall back to `up:`, then `2h`, or the
  light alone as space allows. Without that footer the full form is shown.

## Configuration

Backends are declared in `backends.json` (not committed). Copy
`backends.example.json` and edit it:

```json
[
  {
    "key": "local-xpu/My-Model-int4",
    "alias": "my-model",
    "port": 18001,
    "served": "My-Model-int4",
    "cwd": "C:\\LocalLLM\\vllm-xpu",
    "script": "start-My-Model-int4.ps1",
    "start": [],
    "stop": ["-Model", "my-model"],
    "readySec": 1500,
    "manual": false,
    "containers": ["My-Model-int4"]
  }
]
```

| Field | Meaning |
|---|---|
| `key` | `provider/model-id`, matching the Pi model that uses this backend. |
| `alias` | Short name used by `/backend <alias>`. |
| `port` | Port the OpenAI-compatible server listens on. |
| `served` | Model id reported by `/v1/models`; readiness requires a match. |
| `cwd` | Working directory of the launcher script. |
| `script` | Launcher script file name (relative to `cwd`). |
| `start` / `stop` | Arguments appended for start and for stop. |
| `readySec` | Startup timeout in seconds. |
| `alwaysReady` | `true` for an always-on backend (no launcher). |
| `containers` | Docker container names for liveness detection (XPU profiles). |
| `lane` | Optional lock lane so two XPU profiles never start concurrently. |

`backends.json` is resolved in this order:

1. `$PI_BACKEND_CONFIG`
2. `<extension dir>/backends.json`
3. `~/.pi/agent/backends.json`

The first existing file wins; if none exists, `SPECS` is empty and the
extension stays inert.

## Install

```bash
pi install git:github.com/zrlu/pi-backend-start
```

Or copy this directory into `~/.pi/agent/extensions/pi-backend-start/`.

## Notes

This extension is Windows-oriented: it launches launcher scripts through `pwsh`
and inspects Docker through the `docker` CLI. Porting the launch/inspect paths
to another OS is straightforward.
