// Runtime discovery and hook dispatch helpers.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

import type { HookEvent, RuntimeInfo } from './types';

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

export function resolveRuntime(pi: ExtensionAPI): RuntimeInfo {
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

export function isFlagDisabled(pi: ExtensionAPI): boolean {
  return pi.getFlag('peon-disabled') === true;
}

export function runtimeWarningText(runtime: RuntimeInfo): string {
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

export function fireHook(
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
