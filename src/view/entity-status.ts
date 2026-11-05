import type { TurnStatus } from '../core/time';
import type { Entity } from '../core/types';

interface DisplayStatus { text: string; thinking: boolean; title?: string; }

/** Live inference state is independent of an entity's frozen physical state. */
export function entityDisplayStatus(
  entity: Pick<Entity, 'id' | 'controller' | 'enabled' | 'status'>,
  runtime: Pick<TurnStatus, 'enabled' | 'agents'>,
  isLive: boolean,
): DisplayStatus {
  if (entity.enabled === false) return { text: 'disabled', thinking: false };
  if (!isLive || entity.controller !== 'agent') return { text: entity.status, thinking: false };
  if (!runtime.enabled) return { text: 'paused', thinking: false, title: 'World paused.' };

  const decision = runtime.agents[entity.id];
  if (decision?.state === 'thinking' || decision?.state === 'waiting') {
    return { text: decision.state, thinking: true, title: decision.message ??
      (decision.state === 'waiting' ? 'Waiting for the model to become available.' : 'Waiting for the model response.') };
  }
  if (decision?.state === 'disabled') return { text: 'disabled', thinking: false };
  if (decision?.state === 'ready' && entity.status === 'idle') {
    return { text: 'ready', thinking: false, title: 'Action ready; waiting for the shared commit.' };
  }
  return { text: entity.status, thinking: false };
}
