import { z } from 'zod';

export const hostShortcutIds = ['OPEN_CONTROL_CENTER', 'TOGGLE_PET_VISIBILITY', 'RESCUE_INTERACTION'] as const;
export type HostShortcutId = typeof hostShortcutIds[number];

export const defaultHostShortcutBindings = Object.freeze({
  OPEN_CONTROL_CENTER: 'CommandOrControl+Shift+P',
  TOGGLE_PET_VISIBILITY: 'CommandOrControl+Shift+H',
  RESCUE_INTERACTION: 'CommandOrControl+Shift+I',
});

/** Always at least two modifiers. Excludes canonical OS commands such as
 * Ctrl+C and Alt+F4, aliases, arbitrary keys, and unbounded input. */
export const hostShortcutAcceleratorSchema = z.string().max(42)
  .regex(/^CommandOrControl\+(?:Shift|Alt(?:\+Shift)?)\+(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/u);

export const hostShortcutBindingsSchema = z.strictObject({
  OPEN_CONTROL_CENTER: hostShortcutAcceleratorSchema,
  TOGGLE_PET_VISIBILITY: hostShortcutAcceleratorSchema,
  RESCUE_INTERACTION: hostShortcutAcceleratorSchema,
}).refine(value => new Set(Object.values(value)).size === hostShortcutIds.length, 'Global shortcut combinations must be distinct');

export type HostShortcutBindings = z.infer<typeof hostShortcutBindingsSchema>;
