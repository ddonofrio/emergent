import { island } from './island';
import type { WorldModule } from '../core/types';

export const modules: Record<string, WorldModule> = { [island.manifest.id]: island };
export function loadModule(id: string): WorldModule {
  const module = modules[id];
  if (!module) throw new Error(`Unknown world module: ${id}. Available: ${Object.keys(modules).join(', ')}`);
  return module;
}
