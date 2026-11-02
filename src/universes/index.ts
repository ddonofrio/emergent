import type { UniverseModule } from '../core/types';
import { island as firstShore } from './first-shore';
import { robotsVsRobots } from './robots-vs-robots';

export interface UniverseCatalogEntry {
  id: string;
  name: string;
  available: boolean;
  observerLayout: 'full' | 'world-only';
}

export const universeCatalog: readonly UniverseCatalogEntry[] = [
  { id: firstShore.manifest.id, name: firstShore.manifest.name, available: true, observerLayout: 'full' },
  { id: robotsVsRobots.manifest.id, name: robotsVsRobots.manifest.name, available: true, observerLayout: 'world-only' },
];

export const universes: Readonly<Record<string, UniverseModule>> = {
  [firstShore.manifest.id]: firstShore,
  [robotsVsRobots.manifest.id]: robotsVsRobots,
};

export function loadUniverse(id: string): UniverseModule {
  const universe = universes[id];
  if (!universe) throw new Error(`Unknown universe: ${id}. Available: ${Object.keys(universes).join(', ')}`);
  return universe;
}
