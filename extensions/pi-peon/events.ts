// Event wiring that delegates lifecycle handling to the controller.
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import type { PeonController } from './controller';

export function registerPeonEvents(
  pi: ExtensionAPI,
  controller: PeonController,
): void {
  pi.on('session_start', async (event, ctx) => {
    controller.handleSessionStart(event, ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    controller.syncState(ctx);
  });

  pi.on('session_compact', async (_event, ctx) => {
    controller.syncState(ctx);
  });

  pi.on('input', async (event, ctx) => {
    controller.handleInput(event, ctx);
  });

  pi.on('tool_result', async (event, ctx) => {
    controller.handleToolResult(event, ctx);
  });

  pi.on('agent_end', async (_event, ctx) => {
    controller.handleAgentEnd(ctx);
  });

  pi.on('session_before_compact', async (_event, ctx) => {
    controller.handleSessionBeforeCompact(ctx);
  });
}
