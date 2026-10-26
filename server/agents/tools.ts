import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { Engine } from '../../src/core/engine';
import type { Action } from '../../src/core/types';

export interface Memory { notes: string[]; }
export interface WorldTool {
  name: string; description: string; parameters: JsonSchemaNode;
  output: { schema: JsonSchemaNode; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec?: { signal?: AbortSignal }): Promise<unknown>;
  invoke(args: unknown, exec?: { signal?: AbortSignal }): unknown;
}
const vector: JsonSchemaNode = { type: 'array', items: { type: 'number' }, description: 'Exactly three numbers: [x,y,z].' };
export function worldTools(engine: Engine, id: string, memory: Memory): WorldTool[] {
  const tool = (name: string, description: string, parameters: JsonSchemaNode, run: (args: any) => unknown): WorldTool => {
    assertSupportedJsonSchema(parameters);
    return { name, description, parameters, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) { return this.invoke(args, exec); },
      invoke(args, exec) {
        exec?.signal?.throwIfAborted();
        const errors = validateJsonSchemaValue(parameters, args);
        if (errors.length) return { ok: false, message: errors.join('; ') };
        return run(args);
      } };
  };
  return [
    tool('observe', 'Look at your current field of view. navigation reports collision-checked clearance forward and 45 degrees to either side. Its turn values are relative and must be performed before moving along that path. Occluded or distant objects are unknown. A fresh observation is also supplied before every turn.', { type: 'object', properties: {}, additionalProperties: false }, () => engine.observe(id)),
    tool('act', 'Perform one embodied action. move: forward 0..8m; turn: relative degrees; remove/place/hit/fill/pour: integer target [x,y,z] within 3m. hit also needs impact in [0,1]^3. throw: force 1..12. pickup: itemId. say: one vocabulary word. Actions are checked against the current world. A rejected move returns local navigation alternatives; adapt instead of repeating it.', {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: { action: { type: 'string', enum: ['move','turn','wait','remove','place','throw','pickup','hit','fill','pour','say'] }, distance: { type: 'number' }, angle: { type: 'number' }, target: vector, impact: vector, force: { type: 'number' }, itemId: { type: 'string' }, word: { type: 'string', enum: engine.module.manifest.vocabulary } },
    }, (args: Action) => engine.act(id, args)),
    tool('remember', 'Keep one short observation or intention in private memory. The last 12 notes survive context compaction and server restarts.', { type: 'object', required: ['note'], additionalProperties: false, properties: { note: { type: 'string' } } }, ({ note }: { note: string }) => {
      if (!note.trim() || note.length > 300) return { ok: false, message: 'A memory note must contain 1..300 characters.' };
      memory.notes.push(note); memory.notes.splice(0, Math.max(0, memory.notes.length - 12));
      engine.event(id, 'memory', note); return { ok: true, message: 'Remembered.' };
    }),
  ];
}
