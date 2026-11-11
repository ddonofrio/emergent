# Emergent

A local observatory for independent universes, recorded worlds, and embodied agents. Node 24+ is required.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000/emergent/. This public observer is read-only: it can navigate worlds, inspect characters, read world chat, use the timeline and camera, and open debug information without changing simulation state. The administrator interface is at http://127.0.0.1:3000/emergent/admin/ and requests its hardcoded access key before exposing world controls, observer speech, manual robot control, or model settings. Administrator sessions expire after twelve hours or when the application process restarts. The application server is managed by the user.

Both interfaces intentionally omit the character enabled/disabled checkboxes. Entity enablement remains part of the engine and API with its existing enabled values so the control can be placed elsewhere later.

No `.env` is required. Persistent data defaults to `data/`; an explicit `DATA_DIR` overrides it. Each world is self-contained under `<DATA_DIR>/worlds/<uuid>/`, with metadata in `world.json` and its SQLite recording beside it. `<DATA_DIR>/worlds/active.json` only identifies the current world for each universe. Existing flat recordings and legacy named world directories are moved into this layout on the next server startup without deleting their recordings.

The administrator Settings screen contains Agent and World Manager sections. World Manager creates named worlds with a fixed seed, renames them, shows their seed and recording duration, loads a saved world as the current world, and deletes non-current worlds after confirmation. The public observer remains read-only and can select and replay any recorded world beside the day selector. Loading a recording made with the retired `lockstep-v1` contract upgrades its storage metadata and runtime tables while preserving its recorded state and history.

Configure models in Agent settings or copy `.env.example`. Server-only `<DATA_DIR>/inference-config.json` uses `{ "version": 1, "providers": [...] }`. Models are tried in order. Each entry has one reasoning level, context capacity and optional credentials. Output uses the remaining context, estimated by pi-ai with its 4096-token safety reserve and any known native model output limit; there is no fixed application output cap. Supported routes are OpenAI-compatible endpoints, OpenAI, OpenRouter, Vast gateways, and Amazon Bedrock. Model `auto` discovers an available model. Omitted credentials preserve that entry's saved credentials; explicit removal clears them. Keys and headers never enter browser configuration, world recordings or agent conversations.

## Deployment

The `Deploy` GitHub Actions workflow verifies every push to `main`, builds both interfaces under `/emergent/`, and atomically deploys the application to the production server. The observer remains at `/emergent/` and the administrator interface is routed under `/emergent/admin/`. The system service keeps persistent world data outside versioned releases, and Nginx proxies the public subpath to the loopback-only Node server. See [Production deployment](deploy/README.md) for the security boundary, required secrets, server layout, deployment lifecycle, rollback, and operating commands.

## Execution contract

Settings includes `Parallel requests`. Enabled allows simultaneous model requests; disabled sends one at a time across all agents and universes. The choice is saved as `parallelRequests` in the inference configuration. Changing only this setting preserves conversations, prepared decisions and active requests. Simulation actions still execute concurrently once every agent is ready.

Each model-controlled entity owns one persistent conversation. It receives one initial local observation, then assistant tool calls and structured tool results. Events never start another conversation or rebuild its situation prompt. Agents author their own goals, success conditions and at most ten private notes. Success remains an agent assessment, separate from physical validation.

Agents can record their own next step, expected observation and reconsideration condition. First holding an item durably records its uses and experiment inputs; successful experiments add their recipes separately. Conditional capabilities remain visible for owned objects without advertising invalid targets. See [First Shore crafting](src/universes/first-shore/README.md).

Physical action tools and `wait_for_event` accept optional `eventTypes` for agent-selected early interruptions. Omitted filters preserve the normal behavior; `[]` waits for completion. Deferred events remain queued and are delivered on the next return, including when the selected action ends or a timeout expires. Every `wait_for_event` call returns within five world seconds; omitted timeouts default to five, the runtime caps any unvalidated or persisted later deadline, and three consecutive timeouts disable that tool until the agent uses another tool. Following also ends automatically after five world seconds. For `wait_for_event`, `eventTypes: []` requires an action ID or timeout. Body occupancy is reported separately from movement, and unavailable body tools reappear when the current action finishes.

`run_sequence` executes an agent-authored list of at most eight finite physical tool steps, rebuilding and validating available tools before each step. It waits for each action to complete, preserves normal world time and stops on physical failure or selected events (speech, encounter, discovery and collision by default). An interruption returns a `sequenceId`; use `run_sequence({sequenceId})` to continue or `cancel_sequence` to discard the remaining steps. Cancellation of a sequence does not cancel already started movement. Use a sequence as the only physical call in a response. Its progress and pending receipts survive pauses and restart without replaying completed steps. There are no loops, nested sequences or automatic selection of new targets.

Each agent can keep eight private procedures with `save_sequence`, inspect them with `read_sequence` and remove them with `forget_sequence`. A procedure contains a name, a short usage description, up to eight parameter names and steps shaped as `{tool, args}` (at most 8 KiB per procedure's steps). An exact value such as `{"$param":"destination"}` binds a declared parameter; `run_sequence({name, bindings})` executes a resolved copy. Saved procedures do not assign goals or certify success. Only their compact index enters ordinary context. Memory appears once in the current record, sensory state once in the latest observation, and tool receipts retain action outcomes and events without copying the current memory or capability lists.

`walk_to(x,z)` creates a persistent simulation action. Its tool waits until arrival, obstruction, collision or an observable event. A speech event returns position, movement progress, the action ID and what was heard; walking continues. The agent can `say`, then `wait_for_event({actionId})` for further events or completion. Speech runs alongside movement. Movement actions replace one another explicitly; scans and hand interactions require a stationary body. Body operations are mutually exclusive. `cancel_action` explicitly cancels movement, including collision rebound. Only local, range-checked and occlusion-checked events reach the agent. Queued events and completed actions survive tool returns, pauses and restart.

The world engine owns all time. A shared barrier freezes physics whenever any active agent is thinking, disconnected or retrying, including context compaction. Only committed actions or pending simulation-tool waits open it. The clock advances twenty physics ticks per world second, checking the barrier after every tick. Mid-second interruptions resume the remaining part of that second. Model latency never spends world time. Missing models and transport failures wait indefinitely until cancellation; no replacement action is invented.

## Boundaries and reuse

- `src/core` and `src/universes`: physics, perception, sparse terrain and universe rules; no model/session imports.
- `server/turn-clock.ts`: generic clock participant contract from `server/simulation/connection.ts`; runnable without agents.
- `server/simulation`: persistent action tasks, concurrency, per-entity capability ports and observable event queues.
- `server/agents`: one conversation per entity and simulation tool contracts; receives scoped ports instead of the engine.
- `vendor/littlewhale`: headless source adaptations of LittleWhale's session, execution loop, tool dispatch and basic compaction. Conversation history grows to 90% of the configured context window before the compactor preserves a bounded tail of complete assistant/tool pairs. An independent JSON size guard bounds underreported context. Discarded conversation history is not retained in a duplicate log. See its [source comparison and license notices](vendor/littlewhale/README.md).
- `server/inference`: LittleWhale's pinned pi-ai provider core, native replay, configuration and discovery; no chat UI or Cordis application stack.
- `server/store.ts`: SQLite WAL, authoritative events, world frames, separate conversation snapshots and pending action receipts. Physics saves never rewrite unchanged conversations. Server-only diagnostics keep the latest 256 finished inferences with timing, usage and errors, not full prompts. Replay reads recorded state without models or physics execution.

Existing persistent-tool recordings migrate on the next server startup: redundant session logs and old diagnostic payloads are removed, pending actions and world history are preserved, and freed disk pages are reclaimed once. A read-only serialization benchmark for a recording is available with `node --import tsx scripts/benchmark-persistence.ts <DATA_DIR>/worlds/<uuid>/<universe-id>.sqlite`.

The former agent system, prompts, compaction modules, tests and snapshots of mixed files were moved to `.tmp/agent-system-before-persistent-tools/`. New code does not import that archive. The old paired planner/executor, movement interruption sessions, configuration and recording contracts are retired with no compatibility layer.

The old agent recording and configuration contracts are retired without migration or parallel storage. To reset an active recording explicitly while the server is stopped:

```powershell
.\scripts\worlds\reset.ps1 -UniverseId first-shore
```

World directories under `<DATA_DIR>/worlds/` are never removed automatically. A non-current world is removed only through the explicit, confirmed Delete action. Resetting affects only the current world's SQLite recording and preserves its metadata and every other world.

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
