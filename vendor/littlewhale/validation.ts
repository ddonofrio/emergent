import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import { isJsonValue } from './json';
import type { ToolSchema } from './types';

/** Validate without coercion before an action crosses the world capability boundary. */
export function validateArguments(schema: ToolSchema, args: unknown): void {
  if (!isJsonValue(args)) throw new Error('Tool arguments must contain only finite, lossless JSON values.');
  // pi-ai uses this mature validator underneath validateToolArguments. Its
  // convenience wrapper coerces values, so use the same engine directly to
  // preserve exact model arguments and enforce standard schema bounds.
  const violations = [...Value.Errors(schema.parameters as TSchema, args)];
  if (violations.length) throw new Error(violations.map(error => `arguments${error.instancePath} ${error.message}`).join('; '));
}
