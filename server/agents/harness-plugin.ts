import { worldTools, type Memory, type WorldTool } from './tools';
import type { Engine } from '../../src/core/engine';

// Structural boundary for the pinned fork's agent-scoped tools.register API.
// Mount once per embodied agent scope. Never accept a model-supplied entity ID.
export const name = 'emergent-world';
export const inject = ['tools'];
export function apply(ctx: { tools: { register(tool: WorldTool): () => void } }, config: { engine: Engine; entityId: string; memory: Memory }) {
  for (const tool of worldTools(config.engine, config.entityId, config.memory)) ctx.tools.register(tool);
}
