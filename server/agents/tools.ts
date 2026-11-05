import type { Action, AgentIntent, Observation } from '../../src/core/types';
import type { ActionProgress, AgentPort, PerceivedEvent, ToolOutcome } from '../simulation/agent-port';
import { validateArguments, type ToolExecutor, type ToolSchema } from '../../vendor/littlewhale';

const number = { type: 'number' };
const text = { type: 'string', minLength: 1, maxLength: 500 };
const vector = { type: 'array', items: number, minItems: 3, maxItems: 3 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function localView(view: Observation) {
  return { tick: view.tick, position: view.self.position, facing: view.self.yaw, inventory: view.self.inventory,
    motion: view.self.motion, following: view.following, beingFollowed: view.beingFollowed,
    entities: view.entities, items: view.items.map(item => ({ id: item.id, kind: item.kind, position: item.position, contents: item.contents, water: item.water })),
    surfaces: view.surfaces, navigation: view.navigation, interactions: view.interactions,
    truncated: view.truncated };
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
    const data = event.data as { from?: string; speakerId?: string; word?: string; direction?: string; distance?: number };
    return { id: event.id, tick: event.tick, type: event.type,
      data: { from: data.from, speakerId: data.speakerId, word: data.word, direction: data.direction, distance: data.distance } };
  }
  return { id: event.id, tick: event.tick, type: event.type, message: event.message,
    ...(event.data === undefined ? {} : { data: event.data }) };
}

/** Durable receipts retain execution detail; the model receives each current fact once. */
export function toolOutcome(outcome: ToolOutcome) {
  const completed = new Map<string, ActionProgress>();
  for (const event of outcome.events) {
    const action = (event.data as { action?: ActionProgress } | undefined)?.action;
    if (action && terminal(action) && action.id !== outcome.action?.id) completed.set(action.id, action);
  }
  return { tick: outcome.tick, position: outcome.position, reason: outcome.reason,
    ...(outcome.motion ? { motion: outcome.motion } : {}),
    ...(outcome.following ? { following: outcome.following } : {}),
    ...(outcome.action ? { action: actionProgress(outcome.action) } : {}),
    ...(completed.size ? { completedActions: [...completed.values()].map(actionProgress) } : {}),
    actions: outcome.actions.filter(action => action.id !== outcome.action?.id).map(actionProgress),
    events: outcome.events.map(perceivedEvent) };
}

export function agentTools(port: AgentPort, memory: { notes: string[] }) {
  const schemas: ToolSchema[] = [];
  const executors: Record<string, ToolExecutor> = {};
  const tool = (name: string, description: string, parameters: Record<string, unknown>, execute: ToolExecutor) => {
    const schema = { name, description, parameters };
    schemas.push(schema);
    executors[name] = async (args, call, signal) => {
      validateArguments(schema, args);
      const result = await execute(args, call, signal);
      return result && typeof result === 'object' && 'reason' in result && 'actions' in result && 'events' in result
        ? toolOutcome(result as ToolOutcome) : result;
    };
  };
  tool('look', 'Observe your local field of view with normal range and occlusion. Optional relative angle changes the view without turning. No world time.',
    object({ angle: { ...number, minimum: -180, maximum: 180 } }), async args => localView(port.observe(args.angle as number | undefined)));
  tool('walk_to', 'Walk to horizontal x,z (at most 32m); terrain sets height. Returns at arrival, blockage or a perceived event. Events preserve movement; a new locomotion action replaces it.',
    object({ x: number, z: number }, ['x', 'z']), (args, call, signal) => port.submit(call.id, { action: 'walk', target: [args.x as number, port.observe().self.position[1], args.z as number] }, signal));
  for (const [name, description, maximum] of [
    ['walk', 'Walk a relative distance and optional angle. Events return progress while movement continues.', 32],
    ['run', 'Run a relative distance and optional angle, if body and inventory permit.', 24],
    ['reverse', 'Move backwards while keeping your forward orientation.', 4],
    ['jump', 'Jump a short distance and optional relative angle. Inspect unfamiliar landings first.', 2.5],
  ] as const) {
    tool(name, description, object({ distance: { ...number, exclusiveMinimum: 0, maximum }, ...(name === 'reverse' ? {} : { angle: { ...number, minimum: -180, maximum: 180 } }) }, ['distance']),
      (args, call, signal) => port.submit(call.id, { ...args, action: name } as Action, signal));
  }
  tool('inspect_jump', 'Check a local jump using normal perception, without moving or revealing unseen terrain.',
    object({ angle: { ...number, minimum: -90, maximum: 90 }, distance: { ...number, minimum: 1, maximum: 2.5 } }, ['angle', 'distance']),
    async args => port.inspectJump(args.angle as number, args.distance as number));
  tool('say', 'Speak one to three words in clear hearing range; three total per world second. Speaking and hearing preserve concurrent movement.',
    object({ word: { type: 'string', minLength: 1, maxLength: 100 } }, ['word']),
    (args, call, signal) => port.submit(call.id, { action: 'say', word: args.word as string }, signal));
  tool('wait_for_event', 'Wait for observable events, action completion or optional world-second timeout. actionId selects an existing action; omit it to listen. Other actions continue. Receives each queued event once.',
    object({ actionId: text, seconds: { ...number, exclusiveMinimum: 0, maximum: 3600 } }),
    (args, call, signal) => port.wait(call.id, args as { actionId?: string; seconds?: number }, signal));
  tool('cancel_action', 'Cancel your ongoing movement by action ID, preserving current position.',
    object({ actionId: text }, ['actionId']), (args, call, signal) => port.cancel(call.id, args.actionId as string, signal));
  tool('follow', 'Follow a visible creature within clear reach until blocked, cancelled or unavailable. Speech can run concurrently.',
    object({ entityId: text }, ['entityId']), (args, call, signal) => port.submit(call.id, { action: 'follow', entityId: args.entityId as string }, signal));
  tool('stop_follow', 'Stop following at the shared commit boundary.', object({}),
    (_args, call, signal) => port.submit(call.id, { action: 'stop_follow' }, signal));
  tool('turn', 'Turn your body by a relative angle while stationary.', object({ angle: { ...number, minimum: -360, maximum: 360 } }, ['angle']),
    (args, call, signal) => port.submit(call.id, { action: 'turn', angle: args.angle as number }, signal));
  for (const name of ['find_material', 'find_entity'] as const) {
    tool(name, 'Scan around for one world second with normal range and occlusion. Requires stationary body.', object({}),
      (_args, call, signal) => port.submit(call.id, { action: name }, signal));
  }
  tool('interact', 'Interact with inventory or nearby objects while stationary. Use IDs and coordinates observed via look. Reach, inventory and finite resources revalidate at commit. Discover outcomes experimentally.',
    object({ action: { type: 'string', enum: ['place', 'throw', 'pickup', 'hit', 'dig', 'strike_held', 'join', 'open', 'close', 'fill', 'empty', 'hold', 'store'] },
      target: vector, impact: { ...vector, description: 'Normalized impact coordinates within the held block [x,y,z], each 0..1.' },
      orientation: { type: 'string', enum: ['up', 'down'] }, itemId: text,
      force: { ...number, minimum: 0, maximum: 20 }, stack: { type: 'integer', minimum: 0 } }, ['action']),
    (args, call, signal) => port.submit(call.id, args as unknown as Action, signal));
  tool('set_intent', 'Write your identity, goal and observable success condition. Completion is your assessment, separate from physics. No world time.',
    object({ identity: text, goal: text, successCondition: text, assessment: text, status: { type: 'string', enum: ['active', 'completed', 'abandoned', 'blocked'] } }, ['goal', 'successCondition', 'status']),
    async args => { port.setIntent(args as unknown as AgentIntent); return { intent: args, assessmentBy: 'agent' }; });
  tool('remember', 'Replace your private notes (at most ten concise entries). Before adding to ten existing notes, merge those into nine or fewer. Preserve useful facts, hypotheses and commitments.',
    object({ notes: { type: 'array', items: text, maxItems: 10 } }, ['notes']),
    async args => { memory.notes = [...args.notes as string[]]; port.remember(memory.notes); return { notes: memory.notes }; });
  return { schemas, executors };
}
