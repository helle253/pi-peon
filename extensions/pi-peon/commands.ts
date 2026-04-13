// Slash command registration for session and persistent toggles.
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import type { PeonController } from './controller';
import { parseCommandScope } from './settings';

type ToggleCommandName = 'peon-enable' | 'peon-disable';

function registerToggleCommand(
  pi: ExtensionAPI,
  controller: PeonController,
  name: ToggleCommandName,
  enabled: boolean,
): void {
  const action = enabled ? 'Enable' : 'Disable';

  pi.registerCommand(name, {
    description: `${action} pi-peon hooks for this session, or persist with --project/--global`,
    handler: async (args, ctx) => {
      controller.syncState(ctx);
      const parsed = parseCommandScope(name, args);
      if (parsed.error) {
        if (ctx.hasUI) ctx.ui.notify(parsed.error, 'warning');
        return;
      }

      if (parsed.scope) {
        controller.setDefaultEnabled(ctx, parsed.scope, enabled);
        return;
      }

      controller.setSessionEnabled(ctx, enabled);
    },
  });
}

export function registerPeonCommands(
  pi: ExtensionAPI,
  controller: PeonController,
): void {
  registerToggleCommand(pi, controller, 'peon-enable', true);
  registerToggleCommand(pi, controller, 'peon-disable', false);
}
