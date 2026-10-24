# Emergent

A local world observatory: continuous voxel physics, independent embodied agents, and durable replay. All code and product text are English.

## Run

Node 24+ is required. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm`.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. Without credentials the app runs a clearly labelled **scripted demo**, not an LLM experiment. Copy `.env.example` to `.env`, set `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL`, and restart for a Chat Completions tool-calling model. Keys remain server-side. Each agent has a configurable lifetime turn budget; failures use bounded backoff, requests time out after 45 seconds, and context retains complete tool/result groups plus twelve private notes.

`npm run build` builds production assets; `npm start` serves them. `npm test` checks the physical invariants, replay and an agent loop against a local mock provider.

## Shape

- `src/core`: authoritative 20 Hz simulation, sparse 16³ voxel chunks, local perception and validated physical actions.
- `src/modules`: `WorldModule` manifest, materials/items, entities, generator and world-specific rules. Register another module in `index.ts` and select it with `EMERGENT_MODULE`. Bump its version when generation or rules change.
- `server/agents`: independent per-entity decisions, bounded memory, tool contracts, model adapter, and an agent-scoped Harness plugin bridge.
- `server/store.ts`: SQLite WAL, compressed 10 Hz state deltas, 30-second checkpoints and append-only event identities. Seeking reads recordings; it never reruns a model.
- `src/view`: Three.js chunk instances, camera navigation and interpolation between recorded positions.

Records live in `data/`; restarting resumes the world. A world day is ten simulation minutes. Change `DATA_DIR` to start a fresh experiment. Export downloads the complete recording as NDJSON. The server must remain running for the world to advance; closing the observer does not stop it. Pending model requests are abandoned on shutdown and restarted from durable memory.

## MVP boundaries

Terrain is static until edited; thrown items use gravity, voxel collisions and buoyancy. Water is a level surface; a bucket carries water and pouring disperses it, without fluid simulation. Both Troglodytes start curious and easily bored; only the demo has scripted behavior. The observer preserves real model waiting time. Replay is sampled at 100 ms, with smooth visual interpolation, not an invented continuous action stream.

Headless schema validation and loop detection are extracted from the requested [DeepSeek Harness fork](https://github.com/ddonofrio/deepseek-harness), with the pinned revision and MIT license in `vendor/deepseek-harness`. The full Harness runtime and MCP loader are not bundled; the structural plugin bridge has not been integration-tested inside upstream Harness. No chat UI is imported.

The island is the verified scale. Sparse storage and chunk rendering are foundations for larger modules, not a claim that a 1,000 × 1,000 × 300 world has been benchmarked. Verification covers compilation, physical/runtime checks and local HTTP endpoints; visual browser QA and a real paid model run remain unverified in the initial environment.
