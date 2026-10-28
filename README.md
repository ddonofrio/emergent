# Emergent

A local world observatory: shared one-second turns, embodied agents, voxel physics and durable replay. All code and product text are English.

## Run

Node 24+ is required. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm`.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. Without a configured provider the app runs a clearly labelled **scripted demo**, not an LLM experiment. Copy `.env.example` to `.env` and configure OpenRouter and/or a local OpenAI-compatible server. Providers are attempted in declaration order; exhaustion pauses world time and retries indefinitely. Keys remain server-side. Agent decisions are unlimited unless an optional positive `AGENT_MAX_TURNS` is explicitly configured. Context keeps ten private notes, four recent actions, and a factual progress summary. Agents can select labeled, checked actions and inspect visible local geometry.

## Inference settings

The Settings screen stores ordered provider/model entries and the selection strategy in the server-only `data/llm-config.json`. Supported adapters are OpenAI-compatible, OpenAI, OpenRouter and Amazon Bedrock. API keys are never returned by the configuration endpoint; leaving a saved key blank preserves it. `First model only` disables the remaining entries, `Round robin` rotates the starting provider for each inference request and falls through on failure, `Fallback` sticks to the last successful provider, and `Master / slaves` starts with the first entry each time. Bedrock uses an API key and region; the European Claude Sonnet 4.6 and Haiku 4.5 model IDs are mapped to their EU inference profiles automatically.

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

The model writes its own goal, success condition and motivation as free text; there is no goal catalog or programmed activity sequence. Reviews run every 30 decisions or after three identical two-action/result cycles. The model can continue, complete or abandon its goal. `finish_goal` and reviews require references to recorded outcomes for completion; references are validated, but whether they satisfy a free-text goal is explicitly an agent assessment, not an engine-verified fact. Existing version-2 plans retain their recorded criteria until closed; every newly authored plan uses the free-text contract. Already prepared decisions remain intact across restart. Initial terrain and spawn positions are fixed, so fresh runs can still produce similar model choices.

Physical decisions may include one short `intention` for the next turn. It is a reminder, never an action queue, and expires when omitted or when the goal changes. Speech is acknowledged only at commit: new messages and historical memories are distinct, and historical speech carries no old navigation bearings. Action results describe execution separately from goal completion. Compressed, versioned requests and responses are stored in the server-only `inference_audit` table, including intermediate correction rounds; provider credentials and transport configuration are excluded. This table is not part of browser events or replay exports.

## MVP boundaries

Terrain is static until edited; thrown items use gravity, voxel collisions and buoyancy. Water is a level surface; a bucket carries water and pouring disperses it, without fluid simulation. Both Troglodytes start curious and easily bored; only the demo has scripted behavior. Real inference latency remains in decision metadata, not the world timeline. Replay is sampled at 100 ms with visual interpolation.

Headless schema validation and loop detection are extracted from the requested [DeepSeek Harness fork](https://github.com/ddonofrio/deepseek-harness), with the pinned revision and MIT license in `vendor/deepseek-harness`. The full Harness runtime and MCP loader are not bundled; the structural plugin bridge has not been integration-tested inside upstream Harness. No chat UI is imported.

The island is the verified scale. Sparse storage and chunk rendering are foundations for larger modules, not a claim that a 1,000 × 1,000 × 300 world has been benchmarked. Verification covers compilation, physical/runtime checks, local HTTP endpoints and a complete shared turn with the configured local model. Visual browser QA remains unavailable in this environment.
