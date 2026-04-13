// Core state machine for config/session toggles and hook forwarding.
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

import {
  getSettingsDisplayPath,
  getSettingsPath,
  readConfiguredEnabled,
  writeConfiguredEnabled,
} from './settings';
import {
  clearSessionEnabledOverride,
  readSessionEnabledOverride,
  setSessionEnabledOverride,
} from './session-state';
import {
  fireHook,
  isFlagDisabled,
  resolveRuntime,
  runtimeWarningText,
} from './runtime';
import type { ConfigScope } from './types';

export interface PeonController {
  syncState(ctx: ExtensionContext): void;
  setSessionEnabled(ctx: ExtensionContext, enabled: boolean): void;
  setDefaultEnabled(
    ctx: ExtensionContext,
    scope: ConfigScope,
    enabled: boolean,
  ): void;
  handleSessionStart(event: { reason: string }, ctx: ExtensionContext): void;
  handleInput(event: { source?: string }, ctx: ExtensionContext): void;
  handleToolResult(event: { isError: boolean }, ctx: ExtensionContext): void;
  handleAgentEnd(ctx: ExtensionContext): void;
  handleSessionBeforeCompact(ctx: ExtensionContext): void;
}

function sessionScopeNote(configEnabled: boolean, enabled: boolean): string {
  if (enabled && !configEnabled) return ' Settings still default to disabled.';
  if (!enabled && configEnabled) return ' Settings still default to enabled.';
  return '';
}

export function createPeonController(pi: ExtensionAPI): PeonController {
  let warnedMissingRuntime = false;
  let configEnabled = true;
  let sessionEnabledOverride: boolean | undefined;

  const sessionEnabled = () => sessionEnabledOverride ?? configEnabled;
  const hooksEnabled = () => !isFlagDisabled(pi) && sessionEnabled();

  const syncState = (ctx: ExtensionContext) => {
    configEnabled = readConfiguredEnabled(ctx.cwd);
    sessionEnabledOverride = readSessionEnabledOverride(ctx);
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
      ctx.ui.notify(
        `${prefix}${note} ${runtimeWarningText(runtime)}`,
        'warning',
      );
      return;
    }

    ctx.ui.notify(`${prefix}${note}`, 'info');
  };

  const setSessionEnabled = (ctx: ExtensionContext, enabled: boolean) => {
    const changed = sessionEnabled() !== enabled;
    if (changed) {
      sessionEnabledOverride = enabled;
      setSessionEnabledOverride(pi, enabled);
    }
    notifySessionState(ctx, enabled, changed);
  };

  const setDefaultEnabled = (
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

    sessionEnabledOverride = undefined;
    clearSessionEnabledOverride(pi);
    configEnabled = readConfiguredEnabled(ctx.cwd);

    if (!ctx.hasUI) return;

    const scopeText = scope === 'project' ? 'for this project' : 'globally';
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

  const handleSessionStart = (
    event: { reason: string },
    ctx: ExtensionContext,
  ) => {
    syncState(ctx);
    if (!hooksEnabled()) return;
    if (event.reason === 'reload') return;

    const runtime = resolveRuntime(pi);
    if (!runtime.adapterPath && ctx.hasUI && !warnedMissingRuntime) {
      warnedMissingRuntime = true;
      ctx.ui.notify(`pi-peon: ${runtimeWarningText(runtime)}`, 'warning');
      return;
    }

    fireHook(pi, ctx, 'SessionStart');
  };

  const handleInput = (event: { source?: string }, ctx: ExtensionContext) => {
    if (!hooksEnabled()) return;
    if (event.source === 'extension') return;
    fireHook(pi, ctx, 'UserPromptSubmit');
  };

  const handleToolResult = (
    event: { isError: boolean },
    ctx: ExtensionContext,
  ) => {
    if (!hooksEnabled()) return;
    if (event.isError) fireHook(pi, ctx, 'PostToolUseFailure');
  };

  const handleAgentEnd = (ctx: ExtensionContext) => {
    if (!hooksEnabled()) return;
    fireHook(pi, ctx, 'Stop');
  };

  const handleSessionBeforeCompact = (ctx: ExtensionContext) => {
    if (!hooksEnabled()) return;
    fireHook(pi, ctx, 'PreCompact');
  };

  return {
    syncState,
    setSessionEnabled,
    setDefaultEnabled,
    handleSessionStart,
    handleInput,
    handleToolResult,
    handleAgentEnd,
    handleSessionBeforeCompact,
  };
}
