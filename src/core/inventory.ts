import { clone, type Inventory, type Stack } from './types';

export const INVENTORY_STACKS = 10;
export const STACK_SIZE = 64;
export const INVENTORY_CAPACITY = INVENTORY_STACKS * STACK_SIZE;

const same = (a: Stack, b: Stack) => a.kind === b.kind && a.contents === b.contents;

export function normalizeInventory(value: unknown): Inventory | null {
  if (!value) return null;
  const source = value as Inventory & Stack;
  const original = Array.isArray(source.stacks) ? source.stacks : [source];
  const selected = Array.isArray(source.stacks) ? source.selected ?? null : 0;
  const stacks: Stack[] = [];
  let hand: number | null = null;
  for (const [index, old] of original.entries()) {
    const stack: Stack = { kind: old.kind, count: old.count, ...((old.contents || old.water) ? { contents: old.contents || 'water' } : {}) };
    let match = stacks.findIndex(item => same(item, stack));
    if (match < 0) { match = stacks.length; stacks.push(stack); }
    else stacks[match].count += stack.count;
    if (index === selected) hand = match;
  }
  return stacks.length ? { stacks, selected: hand, capacity: INVENTORY_CAPACITY } : null;
}

// Plan the entire exchange before mutating inventory or world resources.
export function exchangeInventory(value: Inventory | null, removals: { index: number; count: number }[], additions: Stack[], selectAdded = false): Inventory | undefined {
  const inventory = clone(value ?? { stacks: [], selected: null, capacity: INVENTORY_CAPACITY });
  const held = inventory.selected === null ? undefined : inventory.stacks[inventory.selected];
  for (const { index, count } of removals) {
    const stack = inventory.stacks[index];
    if (!stack || count < 1 || stack.count < count) return undefined;
    stack.count -= count;
  }
  inventory.stacks = inventory.stacks.filter(stack => stack.count > 0);
  inventory.selected = held && inventory.stacks.includes(held) ? inventory.stacks.indexOf(held) : null;
  for (const item of additions) {
    let index = inventory.stacks.findIndex(stack => same(stack, item));
    if (index < 0) {
      if (inventory.stacks.length >= INVENTORY_STACKS || item.count > STACK_SIZE) return undefined;
      index = inventory.stacks.length;
      inventory.stacks.push(clone(item));
    } else {
      if (inventory.stacks[index].count + item.count > STACK_SIZE) return undefined;
      inventory.stacks[index].count += item.count;
    }
    if (selectAdded || inventory.selected === null) inventory.selected = index;
  }
  inventory.capacity = INVENTORY_CAPACITY;
  return inventory;
}
