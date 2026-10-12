/**
 * The string form of a card in test specs: `'Island'` (one copy) or `'3 Island'`. Pure.
 */

/** The name and quantity of a card spec string (`'0 Island'` is quantity 0). */
export function parseCardSpecString(spec: string): { name: string; quantity: number } {
  const match = /^(\d+)\s+(.+)$/.exec(spec.trim());
  if (!match) return { name: spec.trim(), quantity: 1 };
  const [, quantity = '1', name = ''] = match;
  return { name, quantity: Number(quantity) };
}

/** The name of a card spec: the string without its quantity, or the object's `name`. */
export function cardSpecName(spec: string | { name: string }): string {
  return typeof spec === 'string' ? spec.replace(/^\d+\s+/, '') : spec.name;
}
