// Shared types and constants for the pi-peon extension.
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'PostToolUseFailure'
  | 'PreCompact';

export type ConfigScope = 'global' | 'project';

export interface RuntimeInfo {
  adapterPath?: string;
  adapterKind?: 'bash' | 'powershell';
  cliAvailable: boolean;
}

export const SESSION_STATE_ENTRY = 'pi-peon-state';
export const SETTINGS_SECTION = 'piPeon';
