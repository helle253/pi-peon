import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StringEnum } from '@mariozechner/pi-ai';
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

const ALL_CATEGORIES = [
  'session.start',
  'task.acknowledge',
  'task.complete',
  'task.error',
  'input.required',
  'resource.limit',
  'user.spam',
  'session.end',
  'task.progress',
] as const;

const CLI_PREVIEW_CATEGORIES = [
  'session.start',
  'task.acknowledge',
  'task.complete',
  'task.error',
  'input.required',
  'resource.limit',
  'user.spam',
] as const;

type Category = (typeof ALL_CATEGORIES)[number];
type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PreCompact'
  | 'SessionEnd';

const CATEGORY_TO_HOOK: Partial<Record<Category, HookEvent>> = {
  'session.start': 'SessionStart',
  'task.acknowledge': 'UserPromptSubmit',
  'task.complete': 'Stop',
  'task.error': 'PostToolUseFailure',
  'input.required': 'PermissionRequest',
  'resource.limit': 'PreCompact',
  'user.spam': 'UserPromptSubmit',
  'session.end': 'SessionEnd',
};

interface RuntimeInfo {
  adapterPath?: string;
  adapterKind?: 'bash' | 'powershell';
  cliAvailable: boolean;
}

interface PreviewResult {
  ok: boolean;
  text: string;
  details: {
    category: Category;
    mode: 'cli-preview' | 'hook' | 'unavailable';
    hookEvent?: HookEvent;
    adapterPath?: string;
    cliAvailable: boolean;
  };
}

function fileExists(filePath: string | undefined): filePath is string {
  return !!filePath && fs.existsSync(filePath);
}

function isCategory(value: string): value is Category {
  return (ALL_CATEGORIES as readonly string[]).includes(value);
}

function isCliPreviewCategory(
  value: Category,
): value is (typeof CLI_PREVIEW_CATEGORIES)[number] {
  return (CLI_PREVIEW_CATEGORIES as readonly string[]).includes(value);
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

function isDisabled(pi: ExtensionAPI): boolean {
  return pi.getFlag('peon-disabled') === true;
}

function buildSessionId(ctx: ExtensionContext): string {
  return `pi-${ctx.sessionManager.getSessionId()}`;
}

function buildStatusReport(
  pi: ExtensionAPI,
  runtime: RuntimeInfo,
  ctx: ExtensionContext,
): string {
  const lines = [
    'pi-peon integration',
    '',
    `disabled: ${isDisabled(pi) ? 'yes' : 'no'}`,
    `adapter: ${runtime.adapterPath ?? 'not found'}`,
    `adapter kind: ${runtime.adapterKind ?? 'n/a'}`,
    `peon CLI: ${runtime.cliAvailable ? 'available' : 'not found'}`,
    `cwd: ${ctx.cwd}`,
    `session id: ${buildSessionId(ctx)}`,
    '',
  ];

  if (!runtime.adapterPath && !runtime.cliAvailable) {
    lines.push('Install peon-ping first:');
    lines.push(
      'curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash',
    );
  }

  lines.push('');
  lines.push('Automatic mappings enabled:');
  lines.push('- session_start -> session.start');
  lines.push('- input -> task.acknowledge / user.spam (via peon-ping)');
  lines.push('- tool_result(isError) -> task.error');
  lines.push('- agent_end -> task.complete');
  lines.push('- session_before_compact -> resource.limit');
  lines.push('');
  lines.push('Not auto-mapped today:');
  lines.push(
    '- input.required (pi has no global permission/input-required event)',
  );
  lines.push('- task.progress (no stable peon-ping hook event today)');
  lines.push(
    '- session.end (session_shutdown also fires during reload/switch/fork)',
  );

  return lines.join('\n');
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
  if (isDisabled(pi)) return false;

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

async function runPeon(pi: ExtensionAPI, args: string[], signal?: AbortSignal) {
  try {
    return await pi.exec('peon', args, { signal });
  } catch (error) {
    return {
      code: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      killed: false,
    };
  }
}

function formatCommandResult(
  command: string,
  result: { code: number; stdout?: string; stderr?: string },
): string {
  const parts = [`$ ${command}`];
  if (result.stdout?.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr?.trim()) parts.push(result.stderr.trimEnd());
  parts.push(`(exit ${result.code})`);
  return parts.join('\n\n');
}

async function showReport(
  ctx: ExtensionCommandContext,
  title: string,
  body: string,
): Promise<void> {
  if (!ctx.hasUI) return;
  await ctx.ui.editor(title, body);
}

async function previewCategory(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  category: Category,
  signal?: AbortSignal,
): Promise<PreviewResult> {
  if (isDisabled(pi)) {
    return {
      ok: false,
      text: 'pi-peon is disabled via --peon-disabled.',
      details: { category, mode: 'unavailable', cliAvailable: false },
    };
  }

  const runtime = resolveRuntime(pi);
  if (isCliPreviewCategory(category) && runtime.cliAvailable) {
    const result = await runPeon(pi, ['preview', category], signal);
    if (result.code === 0) {
      return {
        ok: true,
        text: `Previewed ${category} via \`peon preview\`.`,
        details: {
          category,
          mode: 'cli-preview',
          adapterPath: runtime.adapterPath,
          cliAvailable: runtime.cliAvailable,
        },
      };
    }
  }

  const hookEvent = CATEGORY_TO_HOOK[category];
  if (hookEvent && fireHook(pi, ctx, hookEvent)) {
    return {
      ok: true,
      text: `Emitted ${category} via hook event ${hookEvent}.`,
      details: {
        category,
        mode: 'hook',
        hookEvent,
        adapterPath: runtime.adapterPath,
        cliAvailable: runtime.cliAvailable,
      },
    };
  }

  const extra =
    category === 'task.progress'
      ? 'peon-ping does not expose a stable hook/preview path for task.progress yet.'
      : 'Install peon-ping or configure --peon-script to enable previews.';

  return {
    ok: false,
    text: `Could not preview ${category}. ${extra}`,
    details: {
      category,
      mode: 'unavailable',
      hookEvent,
      adapterPath: runtime.adapterPath,
      cliAvailable: runtime.cliAvailable,
    },
  };
}

export default function piPeonExtension(pi: ExtensionAPI) {
  const peonPreviewTool = defineTool({
    name: 'peon_preview',
    label: 'Peon Preview',
    description:
      'Preview a peon-ping / OpenPeon sound category. Use only when the user explicitly asks to test or preview sounds.',
    promptSnippet:
      'Preview a peon-ping sound category when the user explicitly asks to test notification sounds',
    promptGuidelines: [
      'Do not use this tool automatically during normal coding.',
      'Use it only when the user explicitly asks to preview or test peon-ping / OpenPeon sounds.',
    ],
    parameters: Type.Object({
      category: StringEnum(ALL_CATEGORIES, {
        description: 'CESP category to preview or emit.',
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await previewCategory(pi, ctx, params.category, signal);
      return {
        content: [{ type: 'text', text: result.text }],
        details: result.details,
      };
    },
  });

  pi.registerFlag('peon-disabled', {
    description: 'Disable pi-peon for this pi run',
    type: 'boolean',
    default: false,
  });

  pi.registerFlag('peon-script', {
    description: 'Absolute path to peon.sh or peon.ps1',
    type: 'string',
  });

  pi.registerTool(peonPreviewTool);

  let warnedMissingRuntime = false;
  let suppressNextComplete = false;

  pi.on('session_start', async (event, ctx) => {
    if (isDisabled(pi)) return;
    if (event.reason === 'reload') return;

    const runtime = resolveRuntime(pi);
    if (!runtime.adapterPath && ctx.hasUI && !warnedMissingRuntime) {
      warnedMissingRuntime = true;
      ctx.ui.notify(
        runtime.cliAvailable
          ? 'pi-peon: peon-ping CLI was found, but the runtime hook script was not. Run /peon-status for setup details.'
          : 'pi-peon: peon-ping runtime not found. Run /peon-status for install instructions.',
        'warning',
      );
      return;
    }

    fireHook(pi, ctx, 'SessionStart');
  });

  pi.on('input', async (event, ctx) => {
    if (isDisabled(pi)) return;
    if (event.source === 'extension') return;
    fireHook(pi, ctx, 'UserPromptSubmit');
  });

  pi.on('tool_result', async (event, ctx) => {
    if (isDisabled(pi)) return;
    if (event.toolName === 'peon_preview') {
      suppressNextComplete = true;
      return;
    }
    if (event.isError) fireHook(pi, ctx, 'PostToolUseFailure');
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (isDisabled(pi)) return;
    if (suppressNextComplete) {
      suppressNextComplete = false;
      return;
    }
    fireHook(pi, ctx, 'Stop');
  });

  pi.on('session_before_compact', async (_event, ctx) => {
    if (isDisabled(pi)) return;
    fireHook(pi, ctx, 'PreCompact');
  });

  pi.registerCommand('peon-status', {
    description: 'Show pi-peon / peon-ping integration status',
    handler: async (args, ctx) => {
      const runtime = resolveRuntime(pi);
      const verbose = args.trim() === '--verbose';

      if (runtime.cliAvailable) {
        const commandArgs = ['status', ...(verbose ? ['--verbose'] : [])];
        const result = await runPeon(pi, commandArgs, ctx.signal);
        const report =
          result.code === 0
            ? formatCommandResult(`peon ${commandArgs.join(' ')}`, result)
            : `${buildStatusReport(pi, runtime, ctx)}\n\n${formatCommandResult(`peon ${commandArgs.join(' ')}`, result)}`;
        await showReport(ctx, 'pi-peon Status', report);
        return;
      }

      await showReport(
        ctx,
        'pi-peon Status',
        buildStatusReport(pi, runtime, ctx),
      );
    },
  });

  pi.registerCommand('peon-preview', {
    description:
      'Preview a peon-ping category (usage: /peon-preview <category>)',
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        const runtime = resolveRuntime(pi);
        if (!runtime.cliAvailable) {
          ctx.ui.notify('Usage: /peon-preview <category>', 'warning');
          return;
        }

        const result = await runPeon(pi, ['preview'], ctx.signal);
        await showReport(
          ctx,
          'pi-peon Preview',
          formatCommandResult('peon preview', result),
        );
        return;
      }

      if (!isCategory(raw)) {
        ctx.ui.notify(
          `Unknown category. Valid values: ${ALL_CATEGORIES.join(', ')}`,
          'warning',
        );
        return;
      }

      const result = await previewCategory(pi, ctx, raw, ctx.signal);
      if (result.ok) {
        ctx.ui.notify(result.text, 'info');
      } else {
        ctx.ui.notify(result.text, 'warning');
      }
    },
  });

  pi.registerCommand('peon-packs', {
    description:
      'List or search packs (usage: /peon-packs [--registry|query])',
    handler: async (args, ctx) => {
      const runtime = resolveRuntime(pi);
      if (!runtime.cliAvailable) {
        await showReport(
          ctx,
          'pi-peon Packs',
          buildStatusReport(pi, runtime, ctx),
        );
        return;
      }

      const trimmed = args.trim();
      const commandArgs =
        trimmed.length === 0
          ? ['packs', 'list']
          : trimmed === '--registry'
            ? ['packs', 'list', '--registry']
            : ['packs', 'search', trimmed];

      const result = await runPeon(pi, commandArgs, ctx.signal);
      await showReport(
        ctx,
        'pi-peon Packs',
        formatCommandResult(`peon ${commandArgs.join(' ')}`, result),
      );
    },
  });

  pi.registerCommand('peon-install', {
    description:
      'Install one or more packs (usage: /peon-install <pack[,pack2]>)',
    handler: async (args, ctx) => {
      const packs = args.trim();
      if (!packs) {
        ctx.ui.notify('Usage: /peon-install <pack[,pack2]>', 'warning');
        return;
      }

      const runtime = resolveRuntime(pi);
      if (!runtime.cliAvailable) {
        await showReport(
          ctx,
          'pi-peon Install',
          buildStatusReport(pi, runtime, ctx),
        );
        return;
      }

      const commandArgs = ['packs', 'install', packs];
      const result = await runPeon(pi, commandArgs, ctx.signal);
      await showReport(
        ctx,
        'pi-peon Install',
        formatCommandResult(`peon ${commandArgs.join(' ')}`, result),
      );
    },
  });
}
