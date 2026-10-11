/** Map idioms the core, the adapters and the UI share. Dependency-free. */

/** The value stored under `key`, created with `create` and stored first when there is none. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = create()));
  return value;
}

/** Appends `value` to the list stored under `key` (a new list when there is none). */
export function groupInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  getOrCreate(map, key, () => []).push(value);
}
