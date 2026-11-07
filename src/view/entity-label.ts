import type { Entity } from '../core/types';

export function entityLabelText(entity: Pick<Entity, 'name'>) {
  return entity.name;
}
