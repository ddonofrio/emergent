# Robots vs Robots

Robots vs Robots is an independent universe built on the Emergent engine. A universe defines simulation rules and can contain multiple saved worlds. A world is one stateful instance of a universe; the two terms are not interchangeable.

## Non-duplication rule

Do not duplicate any First Shore behavior that is, or could reasonably become, engine functionality. Use the shared engine implementation directly. If reusable behavior exists only inside First Shore, move it into the engine and refactor both universes to consume that shared implementation before adding it here.

Universe-specific rules, generation parameters, entities, and presentation choices belong in this directory. Simulation, world storage, agent runtime, rendering, controls, and reusable materials belong outside it.

## Initial increment

The initial world is an infinite horizontal procedural surface using the shared voxel materials. Pebble, the duck, starts alone at the origin. Its observer uses the shared world renderer in a world-only layout with no side panels.
