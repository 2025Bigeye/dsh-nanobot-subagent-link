# dsh-tool-nanobot · NanoBot Subagent Bridge

> Run the local [nanobot](https://github.com/HKUDS/nanobot) AI agent as a **subagent** from DeepSeek Harness (DSH).

[![npm](https://img.shields.io/npm/v/dsh-tool-nanobot)](https://www.npmjs.com/package/dsh-tool-nanobot)
[![license](https://img.shields.io/npm/l/dsh-tool-nanobot)](./LICENSE)

Registers a **`nanobot_run`** tool: DSH hands one self-contained subtask to nanobot, which executes it with its own tools and context and returns **only its final answer**. The plugin also registers a `nanobot-run` runtime skill and a prompt section, so fresh conversations discover the capability.

## Install

```sh
dsh plugin --profile web add dsh-tool-nanobot
```

Restart `dsh web`, then use it. Requires `dsh web >= 0.1.0-rc.6` and a local `nanobot` CLI on `PATH`.

## Usage

DSH calls `nanobot_run` automatically. Two invocation modes:

- **`oneshot`** (default) — runs `nanobot agent -m <prompt>` as an independent process per task (stateless, safest for unrelated tasks).
- **`server`** — calls a persistent `nanobot serve` OpenAI-compatible endpoint (`/v1/chat/completions`); faster, and auto-started when not already running.

## Configuration (persisted in DSH Settings)

Namespace **`nanobot`** under Settings:

| Field | Default | Description |
|---|---|---|
| `mode` | `oneshot` | Default invocation mode: `oneshot` / `server` |
| `oneshotCommand` | `nanobot agent -m "{prompt}" --no-markdown` | oneshot command template; must contain exactly one `{prompt}` placeholder |
| `serverBaseUrl` | `http://localhost:8900` | server-mode address (loopback only) |
| `serverStartCommand` | `nanobot serve` | command used to start the server |
| `serverModel` | *(empty)* | model to send; empty omits it so the server uses its own configured model |

## Security

- The command template and base URL come **only from trusted user settings** — there is no model-controllable command/URL injection surface.
- server mode enforces a **loopback whitelist**; the API key is never sent off-host.
- Sandbox-aware execution with approval-gated escalation (`sandbox_permissions` + `justification`).
- Output is truncated, and a started server process is terminated when the plugin tears down.

## Requirements

- DeepSeek Harness `dsh web >= 0.1.0-rc.6`
- A local [`nanobot`](https://github.com/HKUDS/nanobot) CLI (e.g. `uv tool install nanobot-ai`)
- Windows: PowerShell, used by the shell service

## Development

```sh
git clone https://github.com/2025Bigeye/dsh-nanobot-subagent-link.git
cd dsh-nanobot-subagent-link
npm install
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
