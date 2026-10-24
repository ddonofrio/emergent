export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export function assertNever(value: never, message = 'Unexpected value'): never { throw new Error(message + ': ' + String(value)); }
export class HarnessError extends Error { constructor(message: string, readonly code: string) { super(message); } }
export function isJsonValue(value: unknown, seen = new Set<unknown>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Object.values(value).every(v => isJsonValue(v, seen));
  seen.delete(value);
  return valid;
}

