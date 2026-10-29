# Emergent

A local world observatory: shared one-second turns, embodied agents, voxel physics and durable replay. All code and product text are English.

## Run

Node 24+ is required. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm`.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. Without a configured provider the app runs a clearly labelled **scripted demo**, not an LLM experiment. Copy `.env.example` to `.env` and configure OpenRouter and/or a local OpenAI-compatible server. Providers are attempted in declaration order; exhaustion pauses world time and retries indefinitely. Keys remain server-side. Agent decisions are unlimited unless an optional positive `AGENT_MAX_TURNS` is explicitly configured. Context keeps ten private notes, four recent actions, and a factual progress summary. Direct interaction tools identify their current local targets while the agent chooses its own movement and actions.

## Inference settings

The Settings screen stores ordered provider/model entries, their active state and the selection strategy in the server-only `data/llm-config.json`. New entries are active by default; inactive entries remain editable but are excluded from inference. Model choices are detected from the provider when Settings opens and can be refreshed without exposing the provider key; an empty model field selects the first returned model. Supported adapters are OpenAI-compatible, OpenAI, OpenRouter and Amazon Bedrock. OpenAI-compatible entries can enable `Tokenless server` to omit the Authorization header from discovery and inference requests. API keys are never returned by the configuration endpoint; leaving a saved key blank preserves it, while the model-specific removal button deletes only that entry's key on save and prevents that entry from inheriting another saved key. Other models of the same provider keep their credentials. A new model defaults to the first saved key for its provider. Blank key fields are omitted from browser requests. Entering a key overrides the saved default. `Single model` uses the first active entry, `Round robin` rotates the starting provider for each inference request and falls through on failure, `Fallback` sticks to the last successful provider, and `Master / slaves` starts with the first active entry each time. Bedrock uses an API key and region; the European Claude Sonnet 4.6 and Haiku 4.5 model IDs are mapped to their EU inference profiles automatically.

`npm run build` builds production assets; `npm start` serves them. `npm test` checks the physical invariants, replay and an agent loop against a local mock provider.

OpenAI-compatible entries in the server-only configuration can set `maxOutputTokens` (32..32768) to override a phase's visible-output budget. Reasoning-enabled requests reserve a separate 10,000-token reasoning budget; planning keeps its 2,200-token output budget, while movement, action and journal requests retain their own smaller output limits. The transport sends the combined hard ceiling through both `max_completion_tokens` and the legacy `max_tokens`, so planning generation is stopped at 12,200 total tokens without increasing the ceiling on retries. A legacy `enableThinking: false` value is never sent; `enableThinking: true` remains available for servers that require an explicit opt-in. When a model exhausts the combined budget, the response is discarded and retried with one additional cumulative prompt line instructing it to remain within both budgets and return the required tool call. Configuration-file edits take effect after a server restart.

Token-limit responses and tool calls with malformed JSON arguments are discarded before entering conversation history, then retried through the correction protocol. This prevents llama-server from rejecting every subsequent request with `Failed to parse tool call arguments as JSON`. HTTP failures expose a bounded, credential-redacted provider message. Restarting an already stalled session reconstructs its pending request from the saved world without replaying malformed in-flight history.

## Shape

- `src/core`: authoritative 20 Hz simulation, sparse 16³ voxel chunks, local perception and validated physical actions.
- `src/modules`: `WorldModule` manifest, materials/items, entities, generator and world-specific rules. Register another module in `index.ts` and select it with `EMERGENT_MODULE`. Bump its version when generation or rules change.
- `server/agents`: independent per-entity decisions, bounded memory, tool contracts, model adapter, and an agent-scoped Harness plugin bridge.
- `server/turn-clock.ts`: all decisions share one observation boundary; deterministic rotating priority commits them together, then twenty physics steps advance exactly one world second. NPCs, gravity, movement and speech use that same clock. Long movements continue into subsequent turns without another decision.
- `server/store.ts`: SQLite WAL, compressed 10 Hz state deltas, 30-second checkpoints and append-only event identities. Seeking reads recordings; it never reruns a model.
- `src/view`: Three.js chunk instances, camera navigation and interpolation between recorded positions.

Records live in `data/`; restarting resumes the world. A world day is ten simulation minutes. Change `DATA_DIR` to start a fresh experiment. Export downloads the complete recording as NDJSON. Ready decisions survive pause, provider outages and restart. Unfinished requests are reissued after restart; a partially committed turn finishes its remaining physics before asking again.

Inference has no deadline and consumes no world time. A missing response holds the shared turn indefinitely; connection failures retry with bounded backoff until availability returns. Live status uses a separate telemetry stream, so camera controls and history remain usable. At 1x, replay shows one world second per real second, omitting inference waits. Reaching the recording edge waits for new frames without accumulating time debt or switching to Live. Pause world cancels unfinished requests or finishes the current committed second. Set `WORLD_START_PAUSED=true` to start paused. Old wall-clock recordings require a fresh world; clock versions cannot be mixed.

The planner writes its own longer-term direction, sustained project and immediate task, with observable success conditions and one to three conditional suggestions for the executor. There is no goal catalog or programmed activity sequence. Reviews run after 30 decisions, repeated cycles, new discoveries, repeated blocked attempts or unproductive searches. The executor can return a blocked task without claiming success or erasing its parent project. Completion references recorded outcomes, but whether they satisfy a free-text condition remains an agent assessment, not an engine-verified fact. Version-3 plans are reframed at the next uncached decision; version-2 plans retain their recorded criteria until closed. Already prepared decisions remain intact across restart. Initial terrain and spawn positions are fixed, so fresh runs can still produce similar model choices.

Planning includes current inventory, applicable and conditional tool contracts, all personally learned recipes, twenty recent actions, and bounded accumulated experience rebuilt from the agent's own recorded events. The experience index retains up to 256 distinct experiments with exact inputs and results, showing up to 48 selected by project relevance and recency, plus materials, last sightings, search regions and task history. It never reads unseen world state. Recipes remain available when another item is held. Private notes preserve the agent's interpretations, hypotheses and commitments; automatic action records do not replace this role. At ten notes, compaction must merge them into nine or fewer before appending; invalid compaction retains the originals. Known Bedrock Claude 4.5/4.6 models receive a separate thinking budget for independent planner and compaction requests.

Physical decisions may include one short `intention` for the next turn. It is a reminder, never an action queue, and expires when omitted or when the goal changes. Speech is acknowledged only at commit: new messages and historical memories are distinct, and historical speech carries no old navigation bearings. Action results describe execution separately from goal completion. Compressed, versioned requests and responses are stored in the server-only `inference_audit` table, including intermediate correction rounds; provider credentials and transport configuration are excluded. This table is not part of browser events or replay exports.

Agent coordinates consistently use `[x,y,z]`, with `y` as height; walking toward an absolute target follows terrain at its `x,z` position. Consecutive scans from the same pose with identical results report that nothing changed, while recordings retain the full evidence. Notes have stable IDs for replacing specific outdated claims, and short planning fields and notes are limited to one sentence of 500 characters.

Speech is always offered as an action, including while following: up to three freely chosen words per turn, heard within 18 metres on the island when the line of sight is clear. Results identify listeners or explicitly report that nobody heard. The duck stops and faces the speaker before replying. Generic interaction tools remain visible without nearby targets; descriptions only name currently visible targets and held items.

## MVP boundaries

Terrain is static until edited; thrown items use gravity, voxel collisions and buoyancy. Raw blocks can extend supported terrain; shaped planks remain loose objects and do not provide walkable structural support. Water is a level surface; a bucket carries water and pouring disperses it, without fluid simulation. Both Troglodytes start curious and easily bored; only the demo has scripted behavior. Real inference latency remains in decision metadata, not the world timeline. Replay is sampled at 100 ms with visual interpolation.

Headless schema validation and loop detection are extracted from the requested [DeepSeek Harness fork](https://github.com/ddonofrio/deepseek-harness), with the pinned revision and MIT license in `vendor/deepseek-harness`. The full Harness runtime and MCP loader are not bundled; the structural plugin bridge has not been integration-tested inside upstream Harness. No chat UI is imported.

The island is the verified scale. Sparse storage and chunk rendering are foundations for larger modules, not a claim that a 1,000 × 1,000 × 300 world has been benchmarked. Verification covers compilation, physical/runtime checks, local HTTP endpoints and a complete shared turn with the configured local model. Visual browser QA remains unavailable in this environment.
