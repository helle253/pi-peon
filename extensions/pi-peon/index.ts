// Extension bootstrap: register flags, commands, and lifecycle handlers.
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { registerPeonCommands } from './commands';
import { createPeonController } from './controller';
import { registerPeonEvents } from './events';

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

  const controller = createPeonController(pi);
  registerPeonCommands(pi, controller);
  registerPeonEvents(pi, controller);
}
