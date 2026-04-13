// Persistent config helpers for piPeon.enabled in settings.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConfigScope } from './types';
import { SETTINGS_SECTION } from './types';

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function getGlobalSettingsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'settings.json');
}

export function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, '.pi', 'settings.json');
}

export function getSettingsPath(scope: ConfigScope, cwd: string): string {
  return scope === 'global'
    ? getGlobalSettingsPath()
    : getProjectSettingsPath(cwd);
}

export function getSettingsDisplayPath(scope: ConfigScope): string {
  return scope === 'global' ? '~/.pi/agent/settings.json' : '.pi/settings.json';
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

export function readConfiguredEnabled(cwd: string): boolean {
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

export function writeConfiguredEnabled(
  filePath: string,
  enabled: boolean,
): void {
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

export function parseCommandScope(
  commandName: 'peon-enable' | 'peon-disable',
  args: string,
): { scope?: ConfigScope; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  if (tokens.length !== 1) {
    return { error: `Usage: /${commandName} [--project|--global]` };
  }

  if (tokens[0] === '--project') return { scope: 'project' };
  if (tokens[0] === '--global') return { scope: 'global' };

  return { error: `Usage: /${commandName} [--project|--global]` };
}
