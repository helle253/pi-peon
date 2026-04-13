# pi-peon

A small [pi](https://pi.dev) package that hooks pi into the [OpenPeon](https://openpeon.com/) ecosystem through the existing [`peon-ping`](https://github.com/PeonPing/peon-ping) runtime.

## What this package does

This package takes the practical route:

- it **does not** reimplement the full CESP player in TypeScript
- it **does** forward pi lifecycle events to `peon-ping`
- it also adds a few pi slash commands for pack management and sound preview

That gives you OpenPeon sounds in pi quickly, while reusing the reference player that already handles:

- sound pack loading
- random/no-repeat playback
- volume/mute config
- desktop notifications
- pack installation and registry browsing

## Why this approach

After reviewing `openpeon.com`, the split is roughly:

- **OpenPeon / CESP** = the open spec + registry + pack format
- **peon-ping** = the working player/runtime that most tools integrate with today

So for pi, the lowest-friction integration is a **thin adapter extension**, similar to the OpenCode adapter in `peon-ping`.

## Automatic event mapping

This extension maps pi events like this:

| pi event | peon-ping hook | CESP category |
|---|---|---|
| `session_start` | `SessionStart` | `session.start` |
| `input` | `UserPromptSubmit` | `task.acknowledge` / `user.spam` |
| `tool_result` with `isError=true` | `PostToolUseFailure` | `task.error` |
| `agent_end` | `Stop` | `task.complete` |
| `session_before_compact` | `PreCompact` | `resource.limit` |

## Not auto-mapped yet

These are intentionally left as manual / best-effort for now:

- `input.required` — pi does not expose one global “needs approval / waiting for input” lifecycle event
- `task.progress` — `peon-ping` does not expose a stable hook event for it yet
- `session.end` — `session_shutdown` in pi also fires during reload/switch/fork, so auto-firing it would be noisy

## Included slash commands

- `/peon-status`
- `/peon-status --verbose`
- `/peon-preview <category>`
- `/peon-packs`
- `/peon-packs --registry`
- `/peon-packs <query>`
- `/peon-install <pack[,pack2]>`

## Included tool

- `peon_preview`

The LLM tool is intentionally narrow: it should only be used when the user explicitly asks to preview/test sounds.

## Install

### 1) Install peon-ping

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash
```

or via Homebrew:

```bash
brew install PeonPing/tap/peon-ping
peon-ping-setup
```

### 2) Install this pi package

From this repo:

```bash
pi install /absolute/path/to/pi-peon
```

Or for a one-off test:

```bash
pi -e /absolute/path/to/pi-peon/extensions/pi-peon.ts
```

## Optional flags

- `--peon-disabled` — disable integration for one run
- `--peon-script /path/to/peon.sh` — point pi at a custom `peon.sh` or `peon.ps1`

## Usage tips

Test the integration quickly:

```text
/peon-status
/peon-preview task.complete
/peon-packs --registry
/peon-install glados
```

## Future improvements

If you want to go beyond the thin adapter, the next step would be a **native CESP player for pi** that:

- reads `~/.openpeon/packs/*/openpeon.json`
- installs packs directly from the OpenPeon registry
- plays audio without depending on `peon-ping`

This package deliberately starts smaller and more reliable.
