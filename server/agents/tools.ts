import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ItemCapability } from '../../src/core/crafting';
import { isRawBlock } from '../../src/core/materials';
import { TURN_TICKS } from '../../src/core/time';
import { sanitizeAgentIntent, type Action, type AgentIntent, type Observation, type Vec3 } from '../../src/core/types';
import { MAX_WAIT_SECONDS, type ActionProgress, type AgentPort, type BodyActivity, type PerceivedEvent, type ToolOutcome, type WaitOptions } from '../simulation/agent-port';
import { validateArguments, type ToolExecutor, type ToolSchema } from '../../vendor/littlewhale';
import { eventTypesSchema, namedEventTypesSchema, sequenceActions, sequenceTools, validateEventTypes, type SequenceMemory } from './sequences';

const number = { type: 'number' };
const integer = { type: 'integer' };
const text = { type: 'string', minLength: 1, maxLength: 500 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const coordinates = ([x, y, z]: Vec3) => ({ x, yHeight: y, z });

export interface LookState { signature?: string; }
export interface RepeatedToolFailure { signature: string; count: number; unavailable?: boolean; reason?: string; }
export type RepeatedToolFailures = Record<string, RepeatedToolFailure>;
export interface FailedCallCounter { turn: number; count: number; }
type RepeatedToolName = 'hit' | 'walk';
export interface AgentToolMemory extends SequenceMemory {
  notes: string[]; viewAngle?: number; look?: LookState;
  toolFailures?: RepeatedToolFailures;
  failedCalls?: FailedCallCounter;
  writeMemory?: (update: { notes?: string[]; intent?: AgentIntent }) => void;
}

function clearToolFailure(memory: AgentToolMemory, name: string) {
  if (!memory.toolFailures?.[name]) return;
  delete memory.toolFailures[name];
  if (!Object.keys(memory.toolFailures).length) delete memory.toolFailures;
}

function unlockWithOtherTool(memory: AgentToolMemory, name: string) {
  for (const [failedName, failure] of Object.entries(memory.toolFailures ?? {})) {
    if (failedName !== name && failure.unavailable) clearToolFailure(memory, failedName);
  }
}

function repeatedToolControl(name: string, count: number, failedCalls: number, passTurn: boolean, reason: string) {
  return {
    tool: name, failed: true, failures: count, failedCallsThisTurn: failedCalls,
    ...(count >= 2 ? { repeatedFailure: true } : {}),
    ...(count >= 3 ? { unavailable: true } : {}),
    ...(passTurn ? { passTurn: true } : {}),
    message: count >= 3
      ? `${name} has failed three times and is unavailable until you use another tool. ${reason}`
      : passTurn
        ? `Three tool calls have failed this turn. Passing the turn. ${reason}`
        : count === 2 ? `The same ${name} call has failed twice. ${reason}` : reason,
  };
}

const lookSignature = (value: Record<string, unknown>) => {
  const { tick: _tick, ...stable } = value;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
};

function selfView(view: Observation) {
  const inventory = view.self.inventory, holding = inventory?.selected == null ? undefined : inventory.stacks[inventory.selected];
  return { position: coordinates(view.self.position), facingDegrees: view.self.yaw, inventory: view.self.inventory,
    holding: holding ?? null, ...(holding ? { handConstraint: 'World-block hit and pickup require empty hands. Use store to free them without losing inventory; moving closer does not free your hands.' } : {}),
    intent: sanitizeAgentIntent(view.self.intent), motion: view.self.motion ? { kind: view.self.motion.kind, destination: view.self.motion.destination, scanType: view.self.motion.scanType } : undefined, following: view.following };
}

const visibleEntities = (view: Observation) => view.entities.map(entity => ({ ...entity, position: coordinates(entity.position) }));

function capabilityView(capabilities: ItemCapability[], view: Observation, bodyActivity?: BodyActivity) {
  return capabilities.map(({ experiments, ...capability }) => ({ ...capability,
    available: capability.available && !bodyActivity && !view.self.motion && !view.self.following,
    ...(experiments ? { experiments: experiments.map(({ point, orientations }) => ({ point, ...(orientations ? { orientations } : {}) })) } : {}) }));
}

export function localView(view: Observation & { viewAngle?: number }, learned: string[] = [], notes: string[] = [], capabilities: ItemCapability[] = [], bodyActivity?: BodyActivity) {
  return { tick: view.tick, viewAngle: view.viewAngle ?? 0, self: selfView(view), bodyActivity, learned, notes,
    capabilities: capabilityView(capabilities, view, bodyActivity),
    beingFollowed: view.beingFollowed, entities: visibleEntities(view),
    items: view.items.map(item => ({ id: item.id, kind: item.kind, position: coordinates(item.position), contents: item.contents, water: item.water })),
    surfaces: view.surfaces.map(surface => ({ kind: surface.kind, visibleBlockCount: surface.count, nearest: coordinates(surface.nearest) })),
    navigation: view.navigation, interactions: view.interactions, truncated: view.truncated };
}

export function observeAgent(port: AgentPort, notes: string[], angle = 0) {
  const view = port.observe(angle);
  return { ...localView(view, port.knowledge(angle), notes, port.capabilities(view), port.bodyActivity()),
    speech: { wordsRemainingThisTurn: port.remainingSpeechWords() } };
}

/** Memory is supplied once in the current record, outside the sensory observation. */
export function currentObservation(port: AgentPort, angle = 0) {
  const { learned: _learned, notes: _notes, self: { intent: _intent, ...self }, ...observation } = observeAgent(port, [], angle);
  return { ...observation, self };
}

const metres = (value: number) => Math.round(value * 1000) / 1000;
const terminal = (action: ActionProgress) => !['queued', 'running'].includes(action.status);
function actionResult(action: ActionProgress) {
  const result = action.result!;
  const redundant = ['scanSignature', 'scanPosition', ...(action.channel === 'movement'
    ? ['from', 'to', 'destination', 'requestedTarget', 'requestedDistance', 'distanceTravelled'] : [])];
  const feedback = Object.fromEntries(Object.entries(result.feedback ?? {}).filter(([key]) => !redundant.includes(key)));
  return { ok: result.ok, message: result.message,
    ...(result.navigation ? { navigation: result.navigation } : {}),
    ...(Object.keys(feedback).length ? { feedback } : {}) };
}
function actionProgress(action: ActionProgress) {
  return { id: action.id, kind: action.kind, status: action.status,
    ...(action.target ? { target: action.target } : {}),
    ...(action.channel === 'movement' ? { distanceTravelled: metres(action.distanceTravelled), remainingDistance: metres(action.remainingDistance) } : {}),
    ...(terminal(action) && action.result ? { result: actionResult(action) } : {}) };
}
function perceivedEvent(event: PerceivedEvent) {
  if (event.type.startsWith('action-')) {
    const data = event.data as { actionId?: string; action?: ActionProgress; status?: string } | undefined;
    return { id: event.id, tick: event.tick, type: event.type,
      data: { actionId: data?.actionId ?? data?.action?.id, status: data?.status ?? data?.action?.status ?? event.type.slice('action-'.length) } };
  }
  if (event.type === 'speech') {
    const data = event.data as { from?: string; speakerId?: string; word?: string; direction?: string; distance?: number; description?: string };
    return { id: event.id, tick: event.tick, type: event.type,
      data: { from: data.from, speakerId: data.speakerId, word: data.word, direction: data.direction, distance: data.distance,
        ...(data.description ? { description: data.description } : {}) } };
  }
  return { id: event.id, tick: event.tick, type: event.type, message: event.message,
    ...(event.data === undefined ? {} : { data: event.data }) };
}

function completedLook(port: AgentPort, memory: AgentToolMemory, angle: number, turn: number, outcome: ToolOutcome, startTick?: number) {
  const result = observeAgent(port, memory.notes, angle), signature = lookSignature(result);
  const unchanged = memory.look?.signature === signature, count = port.lookCount(turn);
  memory.look = { signature };
  return { tick: outcome.tick, reason: outcome.reason, viewAngle: angle,
    ...(startTick === undefined ? {} : { timeAdvancedTicks: outcome.tick - startTick }),
    looksUsedThisTurn: count, looksRemainingThisTurn: Math.max(0, 3 - count),
    ...(outcome.action ? { action: actionProgress(outcome.action) } : {}),
    ...(outcome.events.length ? { events: outcome.events.map(perceivedEvent) } : {}),
    ...(unchanged ? { unchanged: true, message: 'Nothing has changed since the previous look; this result contains no new information.' } : {}),
    ...(count >= 3 ? { lookUnavailable: true, instruction: 'Look is unavailable until the next world turn.' } : {}),
  };
}

export function resumeAgentTool(port: AgentPort, memory: AgentToolMemory, callId: string, signal: AbortSignal) {
  const turn = Math.floor(port.tick / TURN_TICKS), angle = memory.viewAngle ?? 0;
  return port.resume(callId, signal)?.then(outcome => outcome.action?.kind === 'look' && outcome.reason !== 'rejected'
    ? completedLook(port, memory, angle, turn, outcome) : toolOutcome(outcome));
}

/** Durable receipts retain execution detail; current context contains only local, occlusion-checked state. */
export function toolOutcome(outcome: ToolOutcome) {
  const completed = new Map<string, ActionProgress>();
  for (const event of outcome.events) {
    const action = (event.data as { action?: ActionProgress } | undefined)?.action;
    if (action && terminal(action) && action.id !== outcome.action?.id) completed.set(action.id, action);
  }
  return { tick: outcome.tick, reason: outcome.reason,
    position: outcome.position,
    ...(outcome.motion ? { motion: outcome.motion } : {}),
    ...(outcome.following ? { following: outcome.following } : {}),
    ...(outcome.action ? { action: actionProgress(outcome.action) } : {}),
    ...(completed.size ? { completedActions: [...completed.values()].map(actionProgress) } : {}),
    actions: outcome.actions.filter(action => action.id !== outcome.action?.id).map(actionProgress),
    events: outcome.events.map(perceivedEvent) };
}

export function agentTools(port: AgentPort, memory: AgentToolMemory) {
  const schemas: ToolSchema[] = [];
  const executors: Record<string, ToolExecutor> = {};
  const viewAngle = memory.viewAngle ?? 0;
  const looksThisTurn = port.lookCount();
  const view = port.observe(viewAngle);
  const inventory = view.self.inventory;
  const held = inventory?.selected === null || !inventory ? undefined : inventory.stacks[inventory.selected];
  const bodyActivity = port.bodyActivity(), capabilities = port.capabilities(view);
  const stationary = !view.self.motion && !view.self.following && !bodyActivity;
  const limited = <T>(values: T[]) => values.slice(0, 24);
  const repeatedParameters: Record<RepeatedToolName, Record<string, unknown>> = {
    walk: object({ distance: { ...number, exclusiveMinimum: 0, maximum: 32 }, angle: { ...number, minimum: -180, maximum: 180 }, eventTypes: eventTypesSchema }, ['distance']),
    hit: object({ target: { type: 'array', items: integer, minItems: 3, maxItems: 3 }, eventTypes: eventTypesSchema }, ['target']),
  };
  const repeatedSignature = (name: RepeatedToolName, args: Record<string, unknown>) => {
    try { validateArguments({ name, description: '', parameters: repeatedParameters[name] }, args); }
    catch { return undefined; }
    return name === 'hit'
      ? JSON.stringify({ target: args.target })
      : JSON.stringify({ distance: args.distance, angle: args.angle ?? 0 });
  };
  const target = (values: Vec3[], description: string) => ({ type: 'array', items: integer, minItems: 3, maxItems: 3,
    enum: limited(values), description: `${description} Coordinates are [x,y,z], with y as height.` });
  const present = (result: unknown) => result && typeof result === 'object' && 'reason' in result && 'actions' in result && 'events' in result
    ? toolOutcome(result as ToolOutcome) : result;
  const failureReason = (result: unknown) => {
    if (!result || typeof result !== 'object') return undefined;
    const value = result as { error?: unknown; reason?: unknown; action?: { result?: { ok?: unknown; message?: unknown } }; events?: { message?: unknown }[] };
    if (typeof value.error === 'string') return value.error;
    if (value.action?.result?.ok === false) return typeof value.action.result.message === 'string' ? value.action.result.message : 'The tool call failed.';
    if (value.reason === 'rejected') {
      const message = value.events?.find(event => typeof event.message === 'string')?.message;
      return typeof message === 'string' ? message : 'The tool call was rejected.';
    }
    return undefined;
  };
  const fail = async (name: string, args: Record<string, unknown>, call: Parameters<ToolExecutor>[1], signal: AbortSignal,
    startTurn: number, result: unknown, reason: string, incrementTool = true) => {
    const signature = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const previous = memory.toolFailures?.[name];
    const count = incrementTool ? (previous?.count ?? 0) + 1 : previous?.count ?? 1;
    memory.toolFailures ??= {};
    const newlyUnavailable = incrementTool && count >= 3 && !previous?.unavailable;
    memory.toolFailures[name] = {
      signature, count, reason,
      ...((previous?.unavailable || count >= 3) ? { unavailable: true } : {}),
    };
    if (memory.failedCalls?.turn !== startTurn) memory.failedCalls = { turn: startTurn, count: 0 };
    memory.failedCalls.count++;
    const passTurn = newlyUnavailable || memory.failedCalls.count >= 3;
    const control = repeatedToolControl(name, count, memory.failedCalls.count, passTurn, reason);
    let forcedTurn: ReturnType<typeof toolOutcome> | undefined;
    if (passTurn && Math.floor(port.tick / TURN_TICKS) === startTurn) {
      forcedTurn = toolOutcome(await port.yieldTurn(call.id, signal));
    }
    const displayed = present(result);
    return {
      ...(displayed && typeof displayed === 'object' ? displayed : { error: reason }),
      toolControl: control,
      ...(passTurn ? { forcedTurn: forcedTurn ?? { tick: port.tick, reason: 'The world already advanced to the next turn.' } } : {}),
    };
  };
  const tool = (name: string, description: string, parameters: Record<string, unknown>, execute: ToolExecutor, advertise = true) => {
    const physical = sequenceActions.has(name) || ['follow', 'stop_follow', 'cancel_action', 'wait_for_event'].includes(name);
    const filtered = sequenceActions.has(name) || name === 'follow' || name === 'stop_follow';
    const schema = { name, description, parameters: filtered
      ? { ...parameters, properties: { ...parameters.properties as Record<string, unknown>, eventTypes: eventTypesSchema } } : parameters };
    if (advertise && !memory.toolFailures?.[name]?.unavailable) schemas.push(schema);
    executors[name] = async (args, call, signal) => {
      const internalStep = memory.executingSequence && call.id === `${memory.sequence?.id}:step:${memory.sequence?.index}`;
      if (physical && memory.executingSequence && !internalStep) return { error: 'A sequence must be the only physical call in its response.' };
      if (physical) { memory.physicalCalls ??= new Set(); memory.physicalCalls.add(call.id); }
      try {
        unlockWithOtherTool(memory, name);
        const startTurn = Math.floor(port.tick / TURN_TICKS);
        const locked = memory.toolFailures?.[name];
        if (locked?.unavailable) return fail(name, args, call, signal, startTurn,
          { error: locked.reason ?? `${name} is unavailable until you use another tool.` },
          locked.reason ?? `${name} is unavailable until you use another tool.`, false);
        try { validateEventTypes(args.eventTypes); }
        catch (error) {
          const reason = error instanceof Error ? error.message : 'Invalid event filter.';
          return fail(name, args, call, signal, startTurn, { error: reason }, reason);
        }
        const repeated = name === 'hit' || name === 'walk', signature = repeated ? repeatedSignature(name, args) : undefined;
        let attemptOnly = false;
        try { validateArguments(schema, args); }
        catch (error) {
          // A structurally valid hit may name a stale or empty target. Let the
          // simulation execute the physical attempt instead of rejecting its enum.
          if (name === 'hit' && signature) attemptOnly = true;
          else {
            signal.throwIfAborted();
            const reason = error instanceof Error ? error.message : 'Tool arguments are invalid.';
            return fail(name, args, call, signal, startTurn, { error: reason }, reason);
          }
        }
        let result: unknown;
        try { result = await execute(attemptOnly ? { ...args, attemptOnly: true } : args, call, signal); }
        catch (error) {
          signal.throwIfAborted();
          const reason = error instanceof Error ? error.message : 'Tool execution failed.';
          return fail(name, args, call, signal, startTurn, { error: reason }, reason);
        }
        const reason = failureReason(result) ?? (name === 'wait_for_event' && result && typeof result === 'object'
          && (result as { reason?: unknown }).reason === 'timeout'
          ? 'No selected event or action completion occurred before the five-second timeout.' : undefined);
        if (reason) return fail(name, args, call, signal, startTurn, result, reason);
        clearToolFailure(memory, name);
        return present(result);
      } finally { if (physical) memory.physicalCalls?.delete(call.id); }
    };
  };
  const submit = (name: Action['action'], description: string, parameters: Record<string, unknown>, prepare: (args: Record<string, unknown>) => Action = args => ({ ...args, action: name } as Action), advertise = true) =>
    tool(name, description, parameters, (args, call, signal) => {
      const { eventTypes, ...physicalArgs } = args;
      const action = prepare(physicalArgs); memory.viewAngle = 0;
      return port.submit(call.id, action, signal, { eventTypes: eventTypes as WaitOptions['eventTypes'] });
    }, advertise);

  if (looksThisTurn < 3) {
    tool('look', 'Refresh your local view without turning. At most three looks per world turn. The next current observation contains the view.',
      object({ angle: { ...number, minimum: -180, maximum: 180 } }), async (args, call, signal) => {
        const angle = args.angle as number | undefined, startTick = port.tick, turn = Math.floor(startTick / TURN_TICKS);
        memory.viewAngle = angle ?? 0;
        const outcome = await port.submit(call.id, { action: 'look', ...(angle === undefined ? {} : { angle }) }, signal, { eventTypes: args.eventTypes as WaitOptions['eventTypes'] });
        if (outcome.reason === 'rejected') return outcome;
        return completedLook(port, memory, angle ?? 0, turn, outcome, startTick);
      });
  } else {
    tool('look', 'Refresh one local view without turning your body.',
      object({ angle: { ...number, minimum: -180, maximum: 180 } }),
      async () => ({ error: 'look is unavailable until the next world turn. Use wait_for_event to advance time.' }), false);
  }
  if (!view.self.following && !bodyActivity) {
    tool('walk_to', 'Walk in a straight line to horizontal x,z (at most 32m); terrain sets y height. This does not route around obstacles. Returns at arrival, blockage or a perceived event. Events preserve movement; a new locomotion action replaces it.',
      object({ x: number, z: number }, ['x', 'z']), (args, call, signal) => {
        memory.viewAngle = 0;
        return port.submit(call.id, { action: 'walk', target: [args.x as number, port.observe().self.position[1], args.z as number] }, signal, { eventTypes: args.eventTypes as WaitOptions['eventTypes'] });
      });
    for (const [name, description, maximum] of [
      ['walk', 'Walk a relative distance and optional body-relative angle. Events return progress while movement continues.', 32],
      ...(!held || !isRawBlock(held.kind) ? [['run', 'Run a relative distance and optional body-relative angle.', 24] as const] : []),
      ['reverse', 'Move backwards while keeping your forward orientation.', 4],
      ['jump', 'Jump a short distance and optional body-relative angle. Inspect unfamiliar landings first.', 2.5],
    ] as const) {
      if (name === 'walk' && memory.toolFailures?.walk?.unavailable) continue;
      submit(name, description, object({ distance: { ...number, exclusiveMinimum: 0, maximum }, ...(name === 'reverse' ? {} : { angle: { ...number, minimum: name === 'jump' ? -90 : -180, maximum: name === 'jump' ? 90 : 180 } }) }, ['distance']));
    }
  }
  tool('inspect_jump', 'Check a local jump using normal perception, without moving or revealing unseen terrain.',
    object({ angle: { ...number, minimum: -90, maximum: 90 }, distance: { ...number, minimum: .75, maximum: 2.5 } }, ['angle', 'distance']),
    async args => port.inspectJump(args.angle as number, args.distance as number));
  const remainingSpeechWords = port.remainingSpeechWords();
  if (remainingSpeechWords > 0) submit('say', `Speak at most ${remainingSpeechWords} ${remainingSpeechWords === 1 ? 'word' : 'words'} in clear hearing range; three total per world turn. The tool is unavailable after the budget is spent until world time enters the next turn. Speaking and hearing preserve concurrent movement.`,
    object({ word: { type: 'string', minLength: 1, maxLength: 100 } }, ['word']));
  else tool('say', 'Speak in clear hearing range.',
    object({ word: { type: 'string', minLength: 1, maxLength: 100 } }, ['word']),
    async () => ({ error: 'say is unavailable because the speech budget is exhausted until the next world turn. Use wait_for_event to advance time.' }), false);
  tool('wait_for_event', 'Wait for an ongoing actionId, selected event or timeout, for at most five world seconds. Omitted seconds defaults to five. Three consecutive timeouts make this tool unavailable until you use another tool. After an action ends, omit actionId to wait again. An empty eventTypes needs actionId or seconds.',
    object({ actionId: text, seconds: { ...number, exclusiveMinimum: 0, maximum: MAX_WAIT_SECONDS }, eventTypes: namedEventTypesSchema }),
    (args, call, signal) => {
      if (Array.isArray(args.eventTypes) && !args.eventTypes.length && !args.actionId && args.seconds === undefined) throw new Error('An empty eventTypes list requires actionId or seconds.');
      return port.wait(call.id, args as WaitOptions, signal);
    });
  if (view.self.motion) tool('cancel_action', 'Cancel your ongoing movement by action ID, preserving current position.',
    object({ actionId: text }, ['actionId']), (args, call, signal) => { memory.viewAngle = 0; return port.cancel(call.id, args.actionId as string, signal); });

  if (!bodyActivity && view.interactions.follow.length) {
    const choices = view.interactions.follow.map(entity => entity.id);
    submit('follow', 'Follow a visible creature for at most five world seconds, until blocked, cancelled or unavailable.',
      object({ entityId: { ...text, enum: choices } }, ['entityId']), args => ({ action: 'follow', entityId: args.entityId as string, ...(viewAngle ? { angle: viewAngle } : {}) }));
  }
  if (view.self.following) submit('stop_follow', 'Stop following at the shared commit boundary.', object({}));
  if (stationary) {
    submit('turn', 'Turn your body by a relative angle.', object({ angle: { ...number, minimum: -360, maximum: 360 } }, ['angle']));
    for (const [name, description] of [
      ['find_material', 'Scan 360 degrees for visible materials over one world second. On completion, returns the nearest visible source of each material and records each observed material once in durable Learned Knowledge. An identical repeated scan says that nothing changed.'],
      ['find_entity', 'Scan 360 degrees for visible living beings over one world second. On completion, returns every visible being within normal range and occlusion. An identical repeated scan says that nothing changed.'],
    ] as const) submit(name, description, object({}));

    if (!held && view.interactions.hit.length && !memory.toolFailures?.hit?.unavailable) {
      const choices = limited(view.interactions.hit);
      submit('hit', 'Strike a reachable block with empty hands. Current cracks and materials are in observation.interactions.hit.',
        object({ target: target(choices.map(item => item.target), 'Choose one current reachable block target.') }, ['target']));
    }
    if (!held && view.interactions.pickup.length) {
      const choices = limited(view.interactions.pickup);
      submit('pickup', 'Pick up a reachable loose item with empty hands.',
        object({ itemId: { ...text, enum: choices.map(item => item.itemId) } }, ['itemId']));
    }
    if (held) {
      if (view.interactions.place.length) submit('place', `Place one held ${held.kind} at a currently reachable supported target.`,
        object({ target: target(view.interactions.place, 'Choose one current placement target.') }, ['target']));
      submit('throw', `Throw one held ${held.kind} forward.`, object({ force: { ...number, minimum: 1, maximum: 12 } }));
      submit('store', 'Free your hands without changing inventory quantities.', object({}));
      const shaping = capabilities.find(capability => capability.action === 'strike_held' && capability.available);
      if (shaping?.experiments) {
        const experiments = shaping.experiments;
        tool('strike_held', shaping.description + ' Point names identify distinct regions; results must be discovered separately. To hit a world block, store this item first.',
          object({ point: { type: 'string', enum: experiments.map(experiment => experiment.point) }, orientation: { type: 'string', enum: ['up', 'down'], description: `Required for: ${experiments.filter(experiment => experiment.orientations).map(experiment => experiment.point).join(', ') || 'none'}.` } }, ['point']),
          (args, call, signal) => {
            const experiment = experiments.find(experiment => experiment.point === args.point)!;
            if (experiment.orientations && !experiment.orientations.includes(args.orientation as 'up' | 'down')) throw new Error(`${experiment.point} requires orientation ${experiment.orientations.join(' or ')}.`);
            memory.viewAngle = 0;
            return port.submit(call.id, { action: 'strike_held', impact: experiment.impact, ...(args.orientation ? { orientation: args.orientation as 'up' | 'down' } : {}) }, signal, { eventTypes: args.eventTypes as WaitOptions['eventTypes'] });
          });
      }
      const digging = capabilities.find(capability => capability.action === 'dig' && capability.available);
      if (digging) {
        const choices = limited(view.interactions.hit);
        submit('dig', digging.description,
          object({ target: target(choices.map(item => item.target), 'Choose one current dig target.') }, ['target']));
      }
      if (capabilities.some(capability => capability.action === 'fill' && capability.available)) submit('fill', 'Fill one held empty container from a current compatible source.',
        object({ target: target(view.interactions.fill, 'Choose one current fill source.') }, ['target']));
      if (capabilities.some(capability => capability.action === 'empty' && capability.available)) submit('empty', `Empty one held container containing ${held.contents} at a current valid destination.`,
        object({ target: target(view.interactions.empty, 'Choose one current emptying destination.') }, ['target']));
    }

    const otherStacks = inventory?.stacks.flatMap((_stack, index) => index === inventory.selected ? [] : [index]) ?? [];
    if (otherStacks.length) submit('hold', 'Take an owned stack into your hands; stack indices refer to your current inventory.',
      object({ stack: { type: 'integer', enum: otherStacks } }, ['stack']));
    const combinations = capabilities.filter(capability => capability.action === 'join' && capability.available);
    if (combinations.length) submit('join', combinations.map(capability => `${capability.recipeId}: ${capability.description}`).join(' '),
      object({ recipeId: { type: 'string', enum: combinations.map(capability => capability.recipeId) } }, combinations.length > 1 ? ['recipeId'] : []));
    for (const name of ['open', 'close'] as const) {
      const choices = view.interactions[name];
      if (choices.length) submit(name, `${name === 'open' ? 'Open' : 'Close'} one currently reachable installed door.`,
        object({ itemId: { ...text, enum: choices.map(door => door.itemId) } }, ['itemId']));
    }
  }

  tool('set_intent', 'Replace your goal, success condition and assessment, optionally recording your next step and when to reconsider. Preserve fields you still need. No world time.',
    object({ goal: text, successCondition: text, assessment: text, nextStep: text, expectedObservation: text, reconsiderWhen: text, status: { type: 'string', enum: ['active', 'completed', 'abandoned', 'blocked'] } }, ['goal', 'successCondition', 'status']),
    async args => {
      const intent = args as unknown as AgentIntent;
      if (isDeepStrictEqual(sanitizeAgentIntent(port.observe().self.intent), intent)) {
        return { error: 'Intent is unchanged. Choose another listed tool or wait for an event.' };
      }
      if (memory.writeMemory) memory.writeMemory({ intent });
      else port.setIntent(intent);
      return { updated: 'intent', assessmentBy: 'agent' };
    });
  tool('recall', 'Search your permanent Learned Knowledge by item or topic, including objects you no longer own. Returns up to twenty matching facts you have already discovered; refine the query if total is larger. No world time.',
    object({ query: text }, ['query']), async args => port.recall(args.query as string));
  tool('remember', 'Replace your private notes (at most ten concise entries); merge ten into nine or fewer before adding. Preserve reproducible findings with exact inputs, labelled hypotheses and commitments. Correct disproven claims. Avoid current inventory, tool lists and bearings; timestamp useful last sightings. Learned knowledge is already durable.',
    object({ notes: { type: 'array', items: text, maxItems: 10 } }, ['notes']),
    async args => {
      const notes = [...args.notes as string[]];
      if (memory.writeMemory) memory.writeMemory({ notes });
      else { memory.notes = notes; port.remember(notes); }
      return { updated: 'notes', count: notes.length };
    });
  // Keep non-advertised dispatchers for stale or hallucinated calls so their
  // failures enter the same counters instead of starting simulation work.
  if (!executors.walk) tool('walk', 'Walk a relative distance and optional body-relative angle.', repeatedParameters.walk,
    async () => ({ error: 'walk is not currently available. Use a listed tool or wait for the current action.' }), false);
  if (!executors.hit) {
    const reason = view.following
      ? `hit is unavailable while following ${view.following.name}. Use stop_follow first.`
      : held ? 'hit requires empty hands. Use store first.'
        : bodyActivity ? `hit is unavailable while your body is busy with ${bodyActivity.id}. Wait for that action to finish.`
          : view.self.motion ? 'hit is unavailable while moving. Wait for movement to finish or cancel it.'
            : 'hit is not currently available because no reachable block target is listed. Use another listed tool.';
    tool('hit', 'Strike a block with empty hands.', repeatedParameters.hit, async () => ({ error: reason }), false);
  }
  const sequences = sequenceTools(port, memory, () => agentTools(port, memory),
    (callId, signal) => resumeAgentTool(port, memory, callId, signal), toolOutcome);
  return { schemas: [...schemas, ...sequences.schemas], executors: { ...executors, ...sequences.executors } };
}
