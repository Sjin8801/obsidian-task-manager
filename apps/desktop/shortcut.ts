export const defaultShortcut = 'Control+Shift+Space';
const keys = new Set(['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)]);
export function validShortcut(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 60) return false;
  const parts = value.split('+'), key = parts.pop();
  return !!key && keys.has(key) && parts.some(p => p === 'Control' || p === 'Alt')
    && parts.join('+') === ['Control', 'Alt', 'Shift'].filter(p => parts.includes(p)).join('+');
}
export function shortcutLabel(value: string) { return value.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl').split('+').join(' + '); }
export function shortcutFromKey(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing' | 'getModifierState'>): string | null {
  if (event.isComposing || event.metaKey || event.getModifierState('AltGraph')) return null;
  const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(Key|Digit)/, '') : event.code.replace(/^Arrow/, '');
  const value = [...(event.ctrlKey ? ['Control'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key].join('+');
  return validShortcut(value) ? value : null;
}
