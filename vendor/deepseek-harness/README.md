# Headless Harness extraction

Source: https://github.com/ddonofrio/deepseek-harness
Revision: `29672527891b62245a73a4e2745d6274325100bf`.

- `json-schema.ts`: complete enforced schema validator from `packages/core/tools/src/json-schema.ts`; only imports changed to local compatibility primitives.
- `loop-detector.ts`: pure detection/tokenization functions from `packages/core/agent-loop/src/loop-detector.ts`; stream adapters and their type-only imports omitted.
- `compat.ts`: Emergent-owned replacements for the validator's three small external primitives.

MIT license retained. Emergent uses these at runtime. The world tools also expose the pinned Harness ToolDefinition shape through `server/agents/harness-plugin.ts`. Full Harness lifecycle, MCP loading, and its frontend are not bundled.

