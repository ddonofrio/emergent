import { resolve } from 'node:path';
export const DEFAULT_DATA_DIRECTORY = 'data';

export function resolveDataDirectory(value?: string, cwd = process.cwd()) {
  return resolve(cwd, value?.trim() || DEFAULT_DATA_DIRECTORY);
}
