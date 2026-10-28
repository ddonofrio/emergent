# Emergent

A local world observatory: shared one-second turns, embodied agents, voxel physics and durable replay. All code and product text are English.

## Run

Node 24+ is required. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm`.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. Without a configured provider the app runs a clearly labelled **scripted demo**, not an LLM experiment. Copy `.env.example` to `.env` and configure OpenRouter and/or a local OpenAI-compatible server. Providers are attempted in declaration order; exhaustion pauses world time and retries indefinitely. Keys remain server-side. Agent decisions are unlimited unless an optional positive `AGENT_MAX_TURNS` is explicitly configured. Context keeps ten private notes, four recent actions, and a factual progress summary. Agents can select labeled, checked actions and inspect visible local geometry.

`npm run build` builds production assets; `npm start` serves them. `npm test` checks the physical invariants, replay and an agent loop against a local mock provider.

## Shape

- `src/core`: authoritative 20 Hz simulation, sparse 16³ voxel chunks, local perception and validated physical actions.
- `src/modules`: `WorldModule` manifest, materials/items, entities, generator and world-specific rules. Register another module in `index.ts` and select it with `EMERGENT_MODULE`. Bump its version when generation or rules change.
- `server/agents`: independent per-entity decisions, bounded memory, tool contracts, model adapter, and an agent-scoped Harness plugin bridge.
- `server/turn-clock.ts`: all decisions share one observation boundary; deterministic rotating priority commits them together, then twenty physics steps advance exactly one world second. NPCs, gravity, movement and speech use that same clock. Long movements continue into subsequent turns without another decision.
- `server/store.ts`: SQLite WAL, compressed 10 Hz state deltas, 30-second checkpoints and append-only event identities. Seeking reads recordings; it never reruns a model.
- `src/view`: Three.js chunk instances, camera navigation and interpolation between recorded positions.

Records live in `data/`; restarting resumes the world. A world day is ten simulation minutes. Change `DATA_DIR` to start a fresh experiment. Export downloads the complete recording as NDJSON. Ready decisions survive pause, provider outages and restart. Unfinished requests are reissued after restart; a partially committed turn finishes its remaining physics before asking again.

Inference has no deadline and consumes no world time. A missing response holds the shared turn indefinitely; connection failures retry with bounded backoff until availability returns. Live status uses a separate telemetry stream, so camera controls and history remain usable. At 1x, replay shows one world second per real second, omitting inference waits. Reaching the recording edge waits for new frames without accumulating time debt or switching to Live. Pause world cancels unfinished requests or finishes the current committed second. Set `WORLD_START_PAUSED=true` to start paused. Old wall-clock recordings require a fresh world; clock versions cannot be mixed.

Goals and their success conditions come from one selected milestone; the planner's motivation adds no extra tasks. Collection requires a recorded acquisition and a net inventory increase from the goal's baseline. Approaching a named creature requires a current local sighting within two metres. Reviews run every 30 decisions or after three identical two-action/result cycles; changing cracks and movement positions are not cycles. `finish_goal` closes a verified goal or abandons it before choosing another. Older plans are reviewed under the new contract before fresh execution; already prepared physical decisions remain intact.

Physical decisions may include one short `intention` for the next turn. It is a reminder, never an action queue, and expires when omitted or when the goal changes. Speech is acknowledged only at commit: new messages and historical memories are distinct, and historical speech carries no old navigation bearings. Action results describe execution separately from goal completion. Compressed, versioned requests and responses are stored in the server-only `inference_audit` table, including intermediate correction rounds; provider credentials and transport configuration are excluded. This table is not part of browser events or replay exports.

## MVP boundaries

Terrain is static until edited; thrown items use gravity, voxel collisions and buoyancy. Water is a level surface; a bucket carries water and pouring disperses it, without fluid simulation. Both Troglodytes start curious and easily bored; only the demo has scripted behavior. Real inference latency remains in decision metadata, not the world timeline. Replay is sampled at 100 ms with visual interpolation.

Headless schema validation and loop detection are extracted from the requested [DeepSeek Harness fork](https://github.com/ddonofrio/deepseek-harness), with the pinned revision and MIT license in `vendor/deepseek-harness`. The full Harness runtime and MCP loader are not bundled; the structural plugin bridge has not been integration-tested inside upstream Harness. No chat UI is imported.

The island is the verified scale. Sparse storage and chunk rendering are foundations for larger modules, not a claim that a 1,000 × 1,000 × 300 world has been benchmarked. Verification covers compilation, physical/runtime checks, local HTTP endpoints and a complete shared turn with the configured local model. Visual browser QA remains unavailable in this environment.
