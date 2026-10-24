# Emergent

- Write all source, comments, UI text, documentation, and agent instructions in English. Do not use emojis.
- The user manages the application server. Do not start, stop, restart, or change the running server's state unless the user explicitly requests that operation. Make code and configuration changes, run offline checks, and tell the user when a restart is needed.
- Build the smallest useful, runnable increment. Prefer established libraries and patterns over new frameworks.
- Keep documentation minimal and close to the code. Tests are construction tools: add focused checks for difficult invariants, not coverage for its own sake.
- Keep the simulation engine, world modules, agent runtime, and observer UI independent. World-specific rules belong in modules.
- The server owns world state. A shared turn collects all decisions, then advances exactly one world second. Model latency never consumes world time; the renderer and history remain responsive while waiting. Validate actions at the shared commit boundary.
- Model unavailability is an indefinite, cancellable wait. Retain ready decisions, retry transport failures, and never replace an unavailable agent's decision with an invented action.
- Record authoritative events and state changes durably. Replay must use recorded history, never call a model or rerun decisions.
- Agents receive local, occlusion-aware observations, bounded memory, and explicit action results. Never give them observer privileges.
- Reuse the headless DeepSeek Harness core where practical; preserve upstream licenses and provenance. Do not import its chat UI.
- Keep provider credentials on the server and out of source control, browser responses, and world recordings.
- Use sparse world storage and chunked rendering. The island is the first module, not a hard-coded engine assumption.
- Preserve finite resources, inventory limits, action reach, water boundaries, and short-range communication.
- Report working behavior and remaining limitations honestly. A scripted demo is not an LLM experiment.
