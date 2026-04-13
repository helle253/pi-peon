import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'PostToolUseFailure'
  | 'PreCompact';

type ConfigScope = 'global' | 'project';

interface RuntimeInfo {
  adapterPath?: string;
  adapterKind?: 'bash' | 'powershell';
  cliAvailable: boolean;
}

const SESSION_STATE_ENTRY = 'pi-peon-state';
const SETTINGS_SECTION = 'piPeon';

function fileExists(filePath: string | undefined): filePath is string {
  return !!filePath && fs.existsSync(filePath);
}

function commandExists(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(checker, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function normalizeFlagString(
  value: boolean | string | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getCandidateAdapterPaths(customPath?: string): string[] {
  const home = os.homedir();
  const claudeBase =
    process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const openclawBase = path.join(home, '.openclaw');

  if (process.platform === 'win32') {
    return [
      customPath,
      path.join(claudeBase, 'hooks', 'peon-ping', 'peon.ps1'),
    ].filter((value): value is string => !!value);
  }

  return [
    customPath,
    path.join(claudeBase, 'hooks', 'peon-ping', 'peon.sh'),
    path.join(openclawBase, 'hooks', 'peon-ping', 'peon.sh'),
  ].filter((value): value is string => !!value);
}

function resolveRuntime(pi: ExtensionAPI): RuntimeInfo {
  const customPath =
    normalizeFlagString(pi.getFlag('peon-script')) ||
    process.env.PI_PEON_SCRIPT ||
    process.env.PI_OPENPEON_SCRIPT ||
    process.env.PEON_SH_PATH;
  const adapterPath = getCandidateAdapterPaths(customPath).find((candidate) =>
    fileExists(candidate),
  );

  return {
    adapterPath,
    adapterKind: adapterPath?.toLowerCase().endsWith('.ps1')
      ? 'powershell'
      : adapterPath
        ? 'bash'
        : undefined,
    cliAvailable: commandExists('peon'),
  };
}

function isFlagDisabled(pi: ExtensionAPI): boolean {
  return pi.getFlag('peon-disabled') === true;
}

function getGlobalSettingsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'settings.json');
}

function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, '.pi', 'settings.json');
}

function getSettingsPath(scope: ConfigScope, cwd: string): string {
  return scope === 'global' ? getGlobalSettingsPath() : getProjectSettingsPath(cwd);
}

function getSettingsDisplayPath(scope: ConfigScope): string {
  return scope === 'global' ? '~/.pi/agent/settings.json' : '.pi/settings.json';
}

function readSessionEnabledOverride(
  ctx: ExtensionContext,
): boolean | undefined {
  let enabled: boolean | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom') continue;
    if (entry.customType !== SESSION_STATE_ENTRY) continue;

    const data = entry.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

    if ((data as { inheritConfig?: unknown }).inheritConfig === true) {
      enabled = undefined;
      continue;
    }

    const value = (data as { enabled?: unknown }).enabled;
    if (typeof value === 'boolean') enabled = value;
  }

  return enabled;
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!fileExists(filePath)) return undefined;

  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readConfiguredEnabledSetting(filePath: string): boolean | undefined {
  const settings = readJsonObject(filePath);
  const section = settings?.[SETTINGS_SECTION];
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return undefined;
  }

  const enabled = (section as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function readConfiguredEnabled(cwd: string): boolean {
  return (
    readConfiguredEnabledSetting(getProjectSettingsPath(cwd)) ??
    readConfiguredEnabledSetting(getGlobalSettingsPath()) ??
    true
  );
}

function loadSettingsForWrite(filePath: string): Record<string, unknown> {
  if (!fileExists(filePath)) return {};

  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a top-level JSON object.`);
  }

  return value as Record<string, unknown>;
}

function writeConfiguredEnabled(filePath: string, enabled: boolean): void {
  const settings = loadSettingsForWrite(filePath);
  const currentSection = settings[SETTINGS_SECTION];
  const nextSection =
    currentSection &&
    typeof currentSection === 'object' &&
    !Array.isArray(currentSection)
      ? { ...(currentSection as Record<string, unknown>), enabled }
      : { enabled };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ ...settings, [SETTINGS_SECTION]: nextSection }, null, 2)}\n`,
    'utf8',
  );
}

function parseCommandScope(
  commandName: 'peon-enable' | 'peon-disable',
  args: string,
): { scope?: ConfigScope; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  if (tokens.length !== 1) {
    return {
      error: `Usage: /${commandName} [--project|--global]`,
    };
  }

  if (tokens[0] === '--project') return { scope: 'project' };
  if (tokens[0] === '--global') return { scope: 'global' };

  return {
    error: `Usage: /${commandName} [--project|--global]`,
  };
}

function sessionScopeNote(configEnabled: boolean, enabled: boolean): string {
  if (enabled && !configEnabled) return ' Settings still default to disabled.';
  if (!enabled && configEnabled) return ' Settings still default to enabled.';
  return '';
}

function runtimeWarningText(runtime: RuntimeInfo): string {
  return runtime.cliAvailable
    ? 'peon-ping CLI was found, but the runtime hook script was not. Configure --peon-script to point at peon.sh or peon.ps1.'
    : 'peon-ping runtime not found. Install peon-ping or configure --peon-script to point at peon.sh or peon.ps1.';
}

function buildSessionId(ctx: ExtensionContext): string {
  return `pi-${ctx.sessionManager.getSessionId()}`;
}

function spawnDetached(
  command: string,
  args: string[],
  stdinText?: string,
): boolean {
  try {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true,
    });

    child.on('error', () => {});
    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function fireHook(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  hookEvent: HookEvent,
): boolean {
  if (isFlagDisabled(pi)) return false;

  const runtime = resolveRuntime(pi);
  if (!runtime.adapterPath) return false;

  const payload = JSON.stringify({
    hook_event_name: hookEvent,
    notification_type: '',
    cwd: ctx.cwd,
    session_id: buildSessionId(ctx),
    permission_mode: '',
    source: 'pi',
  });

  if (runtime.adapterKind === 'powershell') {
    return spawnDetached(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        runtime.adapterPath,
      ],
      payload,
    );
  }

  return spawnDetached('bash', [runtime.adapterPath], payload);
}

export default function piPeonExtension(pi: ExtensionAPI) {
  pi.registerFlag('peon-disabled', {
    description: 'Disable pi-peon for this pi run',
    type: 'boolean',
    default: false,
  });

  pi.registerFlag('peon-script', {
    description: 'Absolute path to peon.sh or peon.ps1',
    type: 'string',
  });

  let warnedMissingRuntime = false;
  let configEnabled = true;
  let sessionEnabledOverride: boolean | undefined;

  const sessionEnabled = () => sessionEnabledOverride ?? configEnabled;
  const hooksEnabled = () => !isFlagDisabled(pi) && sessionEnabled();

  const syncEnabledState = (ctx: ExtensionContext) => {
    configEnabled = readConfiguredEnabled(ctx.cwd);
    sessionEnabledOverride = readSessionEnabledOverride(ctx);
  };

  const setSessionEnabledOverride = (enabled: boolean) => {
    sessionEnabledOverride = enabled;
    pi.appendEntry(SESSION_STATE_ENTRY, { enabled });
  };

  const clearSessionEnabledOverride = () => {
    sessionEnabledOverride = undefined;
    pi.appendEntry(SESSION_STATE_ENTRY, { inheritConfig: true });
  };

  const notifySessionState = (
    ctx: ExtensionContext,
    enabled: boolean,
    changed: boolean,
  ) => {
    if (!ctx.hasUI) return;

    const prefix = enabled
      ? changed
        ? 'pi-peon enabled for this session.'
        : 'pi-peon is already enabled for this session.'
      : changed
        ? 'pi-peon disabled for this session.'
        : 'pi-peon is already disabled for this session.';
    const note = sessionScopeNote(configEnabled, enabled);

    if (isFlagDisabled(pi)) {
      ctx.ui.notify(
        `${prefix}${note} Hooks are still disabled for this run via --peon-disabled.`,
        'warning',
      );
      return;
    }

    if (!enabled) {
      ctx.ui.notify(`${prefix}${note}`, 'info');
      return;
    }

    const runtime = resolveRuntime(pi);
    if (!runtime.adapterPath) {
      ctx.ui.notify(`${prefix}${note} ${runtimeWarningText(runtime)}`, 'warning');
      return;
    }

    ctx.ui.notify(`${prefix}${note}`, 'info');
  };

  const setConfiguredEnabled = (
    ctx: ExtensionContext,
    scope: ConfigScope,
    enabled: boolean,
  ) => {
    const settingsPath = getSettingsPath(scope, ctx.cwd);

    try {
      writeConfiguredEnabled(settingsPath, enabled);
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Could not update ${getSettingsDisplayPath(scope)}: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
      return;
    }

    clearSessionEnabledOverride();
    configEnabled = readConfiguredEnabled(ctx.cwd);

    if (!ctx.hasUI) return;

    const scopeText =
      scope === 'project' ? 'for this project' : 'globally';
    let message = enabled
      ? `pi-peon enabled by default ${scopeText}. Updated ${getSettingsDisplayPath(scope)}.`
      : `pi-peon disabled by default ${scopeText}. Updated ${getSettingsDisplayPath(scope)}.`;

    const effectiveEnabled = sessionEnabled();
    if (scope === 'global' && effectiveEnabled !== enabled) {
      message += ` Current project settings still keep pi-peon ${effectiveEnabled ? 'enabled' : 'disabled'} here.`;
    }

    if (isFlagDisabled(pi)) {
      ctx.ui.notify(
        `${message} Hooks are still disabled for this run via --peon-disabled.`,
        'warning',
      );
      return;
    }

    if (enabled) {
      const runtime = resolveRuntime(pi);
      if (!runtime.adapterPath) {
        ctx.ui.notify(`${message} ${runtimeWarningText(runtime)}`, 'warning');
        return;
      }
    }

    ctx.ui.notify(message, 'info');
  };

  pi.registerCommand('peon-enable', {
    description:
      'Enable pi-peon hooks for this session, or persist with --project/--global',
    handler: async (args, ctx) => {
      syncEnabledState(ctx);
      const parsed = parseCommandScope('peon-enable', args);
      if (parsed.error) {
        if (ctx.hasUI) ctx.ui.notify(parsed.error, 'warning');
        return;
      }

      if (parsed.scope) {
        setConfiguredEnabled(ctx, parsed.scope, true);
        return;
      }

      const changed = !sessionEnabled();
      if (changed) setSessionEnabledOverride(true);
      notifySessionState(ctx, true, changed);
    },
  });

  pi.registerCommand('peon-disable', {
    description:
      'Disable pi-peon hooks for this session, or persist with --project/--global',
    handler: async (args, ctx) => {
      syncEnabledState(ctx);
      const parsed = parseCommandScope('peon-disable', args);
      if (parsed.error) {
        if (ctx.hasUI) ctx.ui.notify(parsed.error, 'warning');
        return;
      }

      if (parsed.scope) {
        setConfiguredEnabled(ctx, parsed.scope, false);
        return;
      }

      const changed = sessionEnabled();
      if (changed) setSessionEnabledOverride(false);
      notifySessionState(ctx, false, changed);
    },
  });

  pi.on('session_start', async (event, ctx) => {
    syncEnabledState(ctx);
    if (!hooksEnabled()) return;
    if (event.reason === 'reload') return;

    const runtime = resolveRuntime(pi);
    if (!runtime.adapterPath && ctx.hasUI && !warnedMissingRuntime) {
      warnedMissingRuntime = true;
      ctx.ui.notify(`pi-peon: ${runtimeWarningText(runtime)}`, 'warning');
      return;
    }

    fireHook(pi, ctx, 'SessionStart');
  });

  pi.on('session_tree', async (_event, ctx) => {
    syncEnabledState(ctx);
  });

  pi.on('session_compact', async (_event, ctx) => {
    syncEnabledState(ctx);
  });

  pi.on('input', async (event, ctx) => {
    if (!hooksEnabled()) return;
    if (event.source === 'extension') return;
    fireHook(pi, ctx, 'UserPromptSubmit');
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!hooksEnabled()) return;
    if (event.isError) fireHook(pi, ctx, 'PostToolUseFailure');
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (!hooksEnabled()) return;
    fireHook(pi, ctx, 'Stop');
  });

  pi.on('session_before_compact', async (_event, ctx) => {
    if (!hooksEnabled()) return;
    fireHook(pi, ctx, 'PreCompact');
  });
}
