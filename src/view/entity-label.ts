import type { Entity } from '../core/types';

export function entityLabelText(entity: Pick<Entity, 'name' | 'speech'>) {
  return entity.speech ? `${entity.name} · ${entity.speech.word}` : entity.name;
}
