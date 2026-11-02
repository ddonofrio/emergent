import { island } from './island';
import type { WorldModule } from '../core/types';

export interface WorldCatalogEntry {
  id: string;
  name: string;
  available: boolean;
}

export const worldCatalog: readonly WorldCatalogEntry[] = [
  { id: island.manifest.id, name: island.manifest.name, available: true },
  { id: 'robots-vs-robots', name: 'Robots vs Robots', available: false },
];

export const modules: Record<string, WorldModule> = { [island.manifest.id]: island };
export function loadModule(id: string): WorldModule {
  const module = modules[id];
  if (!module) throw new Error(`Unknown world module: ${id}. Available: ${Object.keys(modules).join(', ')}`);
  return module;
}
