// Session-scoped override persistence stored in session history.
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

import { SESSION_STATE_ENTRY } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readSessionEnabledOverride(
  ctx: ExtensionContext,
): boolean | undefined {
  let enabled: boolean | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom') continue;
    if (entry.customType !== SESSION_STATE_ENTRY) continue;
    if (!isRecord(entry.data)) continue;

    if (entry.data.inheritConfig === true) {
      enabled = undefined;
      continue;
    }

    if (typeof entry.data.enabled === 'boolean') enabled = entry.data.enabled;
  }

  return enabled;
}

export function setSessionEnabledOverride(
  pi: ExtensionAPI,
  enabled: boolean,
): void {
  pi.appendEntry(SESSION_STATE_ENTRY, { enabled });
}

export function clearSessionEnabledOverride(pi: ExtensionAPI): void {
  pi.appendEntry(SESSION_STATE_ENTRY, { inheritConfig: true });
}
