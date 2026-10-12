/** Type guards for untrusted data (parsed JSON, `postMessage` payloads, stored columns). Dependency-free. */

/** A plain object: non-null, not an array. The check for a value that should be a JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
