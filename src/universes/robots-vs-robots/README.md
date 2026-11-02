# Robots vs Robots

Robots vs Robots is an independent universe built on the Emergent engine. A universe defines simulation rules and can contain multiple saved worlds. A world is one stateful instance of a universe; the two terms are not interchangeable.

## Non-duplication rule

Do not duplicate any First Shore behavior that is, or could reasonably become, engine functionality. Use the shared engine implementation directly. If reusable behavior exists only inside First Shore, move it into the engine and refactor both universes to consume that shared implementation before adding it here.

Universe-specific rules, generation parameters, entities, and presentation choices belong in this directory. Simulation, world storage, agent runtime, rendering, controls, and reusable materials belong outside it.

## Initial increment

The world is an infinite, coordinate-generated voxel landscape. FastNoise Lite supplies deterministic 2D and 3D fields for hills, mountains, sandy dune regions, river channels, and clustered underground ores without materializing untouched chunks. A permanent bedrock floor lies at the minimum world height. Stone above it can contain common iron, copper, quartz, and coal deposits, with scarcer lithium and titanium deposits. Only explicit edits and removals are persisted; the observer renders nearby procedural surfaces in one color-instanced mesh.

New worlds contain no Pebble. Nine front-facing miners form three aligned rows with at least one metre of clear space between adjacent bodies. The front row contains the matte-iron MIN-01, polished-steel MIN-02, and slimmer polished-titanium MIN-03. Their BT variants form the second row with matching low-poly lithium battery packs, while their NR variants form the rear row with matching compact nuclear reactor modules. Every variant preserves its base robot's material, proportions, controls, and 2.86-metre height. None has a model connection. The observer uses a right-hand roster for selecting characters, choosing manual or deterministic automaton control, moving a manually controlled robot with the arrow keys, changing the camera view, playing or stopping the world, or restarting the active world from zero. Play resumes the current world without resetting its clock. In automaton mode, each miner repeatedly traces its own ten-metre square, detours around obstacles, performs a movement showcase, reverses briefly, returns to its starting point, and begins again facing forward.
