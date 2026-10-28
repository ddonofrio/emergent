# Decision contract smoke evaluation

## Version 4: projects and accumulated experience

On 2026-10-28, offline validation passed 149 tests and the production build. Focused regressions cover actor-local historical evidence, exact strike conditions, recipe availability with another held item, conditional capabilities without world mutation, blocked-task replanning, restart of staged decisions, bounded compaction without silent note loss, visible loose items, and distinct body/view directions.

Real-model checks reconstructed Flint at recorded second 79 using a read-only source database and an in-memory simulation. Only Flint made model decisions; the other agent remained stationary. Two twelve-second trials with `eu.anthropic.claude-sonnet-4-6` recovered from the unsupported crafting-table assumption, tested `bottom_center`, produced five planks, and retained the recipe-mapping project across tasks. These trials exposed stale journal content and orientation confusion; the final changes expose the journal contract to the planner, suggest corrections to contradicted notes, and explain the body/view coordinate frame.

The final six-second trial made 12 Sonnet calls, including two successfully corrected overlong suggestions. Flint produced five planks, reviewed the result immediately, replaced the incorrect journal note with the observed top/front/bottom strike outcomes, and began travelling to obtain more wood for the same project. The planner saw the plank recipe in `learned` on the next review. All evaluated actions and goals were model-authored; no strike point or outcome was assigned by the fixture. The source world, application server and provider configuration were unchanged. Local requests, responses and decisions are in `.tmp/v4-sonnet-play-journal-*` (untracked).

The currently configured `zai.glm-4.7-flash` repeatedly returned malformed nested objects/lists or overlong fields. One planning trial reached a valid contract after six attempts; another did not within eight. This adapter/model combination is not validated for reliable operation with this contract. The Sonnet checks are short smoke tests, not proof of reliable navigation, long-term autonomy, building behavior or improvement across independent fresh runs. They do not establish a causal comparison between models or prompt revisions. Shaped planks still do not provide walkable terrain support.

## Historical version-2 milestone evaluation

These earlier results do not evaluate the current project contract or establish diversity between fresh runs.

On 2026-10-28, the configured local `omnicoder-9b` ran two repetitions of four isolated scenarios against baseline commit `92c87d1` and the revised decision contract. Each trial used a fresh in-memory world and at most six shared world seconds. No application server or saved world was changed. The model chose all evaluated actions; fixture setup and success checks were deterministic.

| Scenario and externally checked outcome | Baseline | Revised |
| --- | --- | --- |
| Cracked grass and one already owned grass: increase grass inventory | 0/2 | 2/2 |
| Unknown plant interaction: acquire its actual product | 2/2 | 2/2 |
| Approach Moss: see the named creature within two metres | 1/2 | 2/2 |
| Inspect surroundings: complete a scan | 2/2 | 2/2 |

The revised collector used two further hits in both trials, the plant interaction used three hits, and the social scenario used two follow decisions. Exploration used one scan. The baseline social goal used its previous free-text intent and generic movement milestone; the revised goal used the entity-specific criterion. Evaluation checked actual proximity in both versions, not either model's completion claim.

The revised exploration prompt used 2,284 input tokens versus 2,374 in the baseline. This is a context-size spot check, not a general token reduction claim. Full local trial requests, responses and summaries are in `.tmp/agent-evaluation-final/` (untracked).

Eight trials per version are a smoke check, not evidence of reliable long-running behavior or a statistically established improvement. Repeated model runs can differ. Offline regression tests separately cover completion evidence, cancellation, shared commits, restart, bounded intentions, historical speech and audit persistence failures.
