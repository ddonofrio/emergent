# Decision contract smoke evaluation

Historical evaluation of the version-2 milestone contract. These results do not evaluate the current version-3 self-authored goals or establish diversity between fresh runs.

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
