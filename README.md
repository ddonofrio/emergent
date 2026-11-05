# Emergent

A local observatory for independent universes, recorded worlds, and embodied agents. Node 24+ is required.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. The universe launcher and observers remain responsive while models think. Each universe starts stopped. Play resumes its active world; Stop cancels inference and freezes time. The application server is managed by the user.

No `.env` is required. Active worlds default to `data/`; an explicit `DATA_DIR` overrides it. Configure models in Settings or copy `.env.example`. Server-only `<DATA_DIR>/inference-config.json` uses `{ "version": 1, "providers": [...] }`. Models are tried in order. Each entry has one reasoning level, context capacity, output limit and optional credentials. Supported routes are OpenAI-compatible endpoints, OpenAI, OpenRouter, Vast gateways, and Amazon Bedrock. Model `auto` discovers an available model. Omitted credentials preserve that entry's saved credentials; explicit removal clears them. Keys and headers never enter browser configuration, world recordings or agent conversations.

## Execution contract

Settings includes `Parallel requests`. Enabled allows simultaneous model requests; disabled sends one at a time across all agents and universes. The choice is saved as `parallelRequests` in the inference configuration. Changing only this setting preserves conversations, prepared decisions and active requests. Simulation actions still execute concurrently once every agent is ready.

Each model-controlled entity owns one persistent conversation. It receives one initial local observation, then assistant tool calls and structured tool results. Events never start another conversation or rebuild its situation prompt. Agents author their own identity, goals, success conditions and at most ten private notes. Success remains an agent assessment, separate from physical validation.

`walk_to(x,z)` creates a persistent simulation action. Its tool waits until arrival, obstruction, collision or an observable event. A speech event returns position, movement progress, the action ID and what was heard; walking continues. The agent can `say`, then `wait_for_event({actionId})` for further events or completion. Speech runs alongside movement. Movement actions replace one another explicitly; scans and hand interactions require a stationary body. Body operations are mutually exclusive. `cancel_action` explicitly cancels movement, including collision rebound. Only local, range-checked and occlusion-checked events reach the agent. Queued events and completed actions survive tool returns, pauses and restart.

The world engine owns all time. A shared barrier freezes physics whenever any active agent is thinking, disconnected or retrying, including context compaction. Only committed actions or pending simulation-tool waits open it. The clock advances twenty physics ticks per world second, checking the barrier after every tick. Mid-second interruptions resume the remaining part of that second. Model latency never spends world time. Missing models and transport failures wait indefinitely until cancellation; no replacement action is invented.

## Boundaries and reuse

- `src/core` and `src/universes`: physics, perception, sparse terrain and universe rules; no model/session imports.
- `server/turn-clock.ts`: generic clock participant contract from `server/simulation/connection.ts`; runnable without agents.
- `server/simulation`: persistent action tasks, concurrency, per-entity capability ports and observable event queues.
- `server/agents`: one conversation per entity and simulation tool contracts; receives scoped ports instead of the engine.
- `vendor/littlewhale`: headless source adaptations of LittleWhale's session, execution loop, tool dispatch and basic compaction. The only context compactor preserves complete assistant/tool pairs and the original durable conversation. See its [source comparison and license notices](vendor/littlewhale/README.md).
- `server/inference`: LittleWhale's pinned pi-ai provider core, native replay, configuration and discovery; no chat UI or Cordis application stack.
- `server/store.ts`: SQLite WAL, authoritative events, world frames, conversation snapshots, action receipts and server-only inference audits. Replay reads recorded state without models or physics execution.

The former agent system, prompts, compaction modules, tests and snapshots of mixed files were moved to `.tmp/agent-system-before-persistent-tools/`. New code does not import that archive. The old paired planner/executor, movement interruption sessions, configuration and recording contracts are retired with no compatibility layer.

The old agent recording and configuration contracts are retired without migration or parallel storage. To reset an active recording explicitly while the server is stopped:

```powershell
.\scripts\worlds\reset.ps1 -UniverseId first-shore
```

Saved worlds under `data/worlds/` are never removed automatically. This refactor did not delete recordings or change the running server.

## Verification and measurement

```sh
npm run check
npm run check:startup
npm test
npm run build
npm run benchmark:agents
```

The benchmark compares the captured old implementation with the new loop on an eight-metre walk, with and without speech halfway. `tests/agent-refactor-results.json` records request counts, exact canonical payload bytes, clearly labelled token estimates, mock-provider latency and headless execution latency. Both include the first request after arrival. Provider usage, cache reads, calls, retries and latency are also recorded in live session metrics and server-only inference audits. Failed requests' billable token usage is unavailable.

| Scenario | Calls before / after | Estimated input tokens before / after |
| --- | --- | --- |
| Silent walk | 3 / 2 | 9,538 / 4,921 |
| Speech halfway | 4 / 4 | 9,851 / 10,653 |

The speech scenario now commits a reply at world second two while walking continues until second four; the former implementation waited until arrival. The richer conversation uses about eight percent more estimated input in this scenario. The JSON report includes synthetic latency measurements without claiming real-model speedups.

These are deterministic transport and simulation checks using a mock with a five-millisecond delay, not a live LLM experiment. Inference performance and actual token billing require a configured-model run. Context pressure uses a conservative estimate; uninterrupted long walks need no inference before their result, while persistent history and richer event handling can change total input size. UI build validation does not establish visual browser QA.
