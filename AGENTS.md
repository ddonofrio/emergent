# Emergent

- Write all source, comments, UI text, documentation, and agent instructions in English. Do not use emojis.
- The user manages the application server. Do not start, stop, restart, or change the running server's state unless the user explicitly requests that operation. Make code and configuration changes, run offline checks, and tell the user when a restart is needed.
- Saved worlds live in `data/worlds/`. Never delete a saved world unless the user explicitly names it for deletion. When the user asks to delete or reset the active world, delete or reset it directly; do not create a precautionary backup, archive, or copy unless the user explicitly requests one.
- Build the smallest useful, runnable increment. Prefer established libraries and patterns over new frameworks.
- Keep documentation minimal and close to the code. Tests are construction tools: add focused checks for difficult invariants, not coverage for its own sake.
- Keep the simulation engine, world modules, agent runtime, and observer UI independent. World-specific rules belong in modules.
- The server owns world state. A shared turn collects all decisions, then advances exactly one world second. Model latency never consumes world time; the renderer and history remain responsive while waiting. Validate actions at the shared commit boundary.
- Model unavailability is an indefinite, cancellable wait. Retain ready decisions, retry transport failures, and never replace an unavailable agent's decision with an invented action.
- Record authoritative events and state changes durably. Replay must use recorded history, never call a model or rerun decisions.
- Agents receive local, occlusion-aware observations, bounded memory, and explicit action results. Never give them observer privileges.
- Agents author their own goals and success conditions. Do not replace them with a fixed goal catalog, scripted activity sequence, or server-selected objective. Keep physical action validation separate from the agent's assessment of goal completion.
- Keep each inference request focused on the current situation: short instructions, applicable tools, relevant learned facts, and at most 10 private notes (compact the existing ten into nine or fewer before appending a new note). Do not reveal undiscovered outcomes in tool descriptions.
- Reuse the headless DeepSeek Harness core where practical; preserve upstream licenses and provenance. Do not import its chat UI.
- Keep provider credentials on the server and out of source control, browser responses, and world recordings.
- Use sparse world storage and chunked rendering. The island is the first module, not a hard-coded engine assumption.
- Preserve finite resources, inventory limits, action reach, water boundaries, and short-range communication.
- Report working behavior and remaining limitations honestly. A scripted demo is not an LLM experiment.
