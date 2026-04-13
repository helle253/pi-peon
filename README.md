# pi-peon

Thin [pi](https://pi.dev) extension that forwards pi lifecycle events to the existing [`peon-ping`](https://github.com/PeonPing/peon-ping) runtime so pi can use your OpenPeon sounds.

## Scope

This package only:

- forwards pi lifecycle events to `peon-ping`
- adds `/peon-enable` and `/peon-disable` for session or persistent toggling
- supports `--peon-disabled` and `--peon-script`

Everything else should be done with the regular `peon` CLI.

## Event mapping

| pi event                          | peon-ping hook       | CESP category                    |
| --------------------------------- | -------------------- | -------------------------------- |
| `session_start`                   | `SessionStart`       | `session.start`                  |
| `input`                           | `UserPromptSubmit`   | `task.acknowledge` / `user.spam` |
| `tool_result` with `isError=true` | `PostToolUseFailure` | `task.error`                     |
| `agent_end`                       | `Stop`               | `task.complete`                  |
| `session_before_compact`          | `PreCompact`         | `resource.limit`                 |

Not auto-mapped right now:

- `input.required`
- `task.progress`
- `session.end`

## Install

### 1) Install peon-ping

Install and set up [`peon-ping`](https://github.com/PeonPing/peon-ping) first.

### 2) Install this package

From npm:

```bash
pi install npm:@helle253/pi-peon
```

From this repo:

```bash
pi install /absolute/path/to/pi-peon
```

For a one-off test:

```bash
pi -e /absolute/path/to/pi-peon/extensions/pi-peon.ts
```

## Usage

Enabled by default.

Disable hooks for one run:

```bash
pi --peon-disabled
```

Toggle hooks only for the current session:

```text
/peon-disable
/peon-enable
```

Write a persistent project or global default:

```text
/peon-disable --project
/peon-enable --project
/peon-disable --global
/peon-enable --global
```

The commands write to:

- `.pi/settings.json` for `--project`
- `~/.pi/agent/settings.json` for `--global`

Equivalent manual config:

```json
{
  "piPeon": {
    "enabled": false
  }
}
```

Use a custom hook script:

```bash
pi --peon-script /absolute/path/to/peon.sh
```

Precedence is:

1. `--peon-disabled` for the current run
2. `/peon-enable` or `/peon-disable` for the current session
3. `piPeon.enabled` in settings

The extension looks for the standard `peon-ping` hook script automatically.

## Use the peon CLI for everything else

```bash
peon status
peon preview task.complete
peon packs list --registry
peon packs install glados
```
