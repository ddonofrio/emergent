import { impactPoints } from '../../src/core/impact-points';
import { isRawBlock } from '../../src/core/materials';
import type { Action, AgentIntent, Observation, Vec3 } from '../../src/core/types';
import type { ActionProgress, AgentPort, PerceivedEvent, ToolOutcome } from '../simulation/agent-port';
import { validateArguments, type ToolExecutor, type ToolSchema } from '../../vendor/littlewhale';

const number = { type: 'number' };
const integer = { type: 'integer' };
const text = { type: 'string', minLength: 1, maxLength: 500 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const coordinates = ([x, y, z]: Vec3) => ({ x, yHeight: y, z });

function selfView(view: Observation) {
  return { position: coordinates(view.self.position), facingDegrees: view.self.yaw, inventory: view.self.inventory,
    intent: view.self.intent, motion: view.self.motion, following: view.following };
}

const visibleEntities = (view: Observation) => view.entities.map(entity => ({ ...entity, position: coordinates(entity.position) }));

export function localView(view: Observation & { viewAngle?: number }, learned: string[] = [], notes: string[] = []) {
  return { tick: view.tick, viewAngle: view.viewAngle ?? 0, self: selfView(view), learned, notes,
    beingFollowed: view.beingFollowed, entities: visibleEntities(view),
    items: view.items.map(item => ({ id: item.id, kind: item.kind, position: coordinates(item.position), contents: item.contents, water: item.water })),
    surfaces: view.surfaces.map(surface => ({ ...surface, nearest: coordinates(surface.nearest) })),
    navigation: view.navigation, interactions: view.interactions, truncated: view.truncated };
}

function currentContext(port: AgentPort, notes: string[]) {
  const view = port.observe();
  return { self: selfView(view), learned: port.knowledge(), notes, visibleEntities: visibleEntities(view) };
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

/** Durable receipts retain execution detail; current context contains only local, occlusion-checked state. */
export function toolOutcome(outcome: ToolOutcome, current?: ReturnType<typeof currentContext>) {
  const completed = new Map<string, ActionProgress>();
  for (const event of outcome.events) {
    const action = (event.data as { action?: ActionProgress } | undefined)?.action;
    if (action && terminal(action) && action.id !== outcome.action?.id) completed.set(action.id, action);
  }
  return { tick: outcome.tick, reason: outcome.reason,
    ...(current ? { current } : { position: outcome.position }),
    ...(outcome.motion ? { motion: outcome.motion } : {}),
    ...(outcome.following ? { following: outcome.following } : {}),
    ...(outcome.action ? { action: actionProgress(outcome.action) } : {}),
    ...(completed.size ? { completedActions: [...completed.values()].map(actionProgress) } : {}),
    actions: outcome.actions.filter(action => action.id !== outcome.action?.id).map(actionProgress),
    events: outcome.events.map(perceivedEvent) };
}

export function agentTools(port: AgentPort, memory: { notes: string[]; viewAngle?: number }) {
  const schemas: ToolSchema[] = [];
  const executors: Record<string, ToolExecutor> = {};
  const viewAngle = memory.viewAngle ?? 0;
  const view = port.observe(viewAngle);
  const inventory = view.self.inventory;
  const held = inventory?.selected === null || !inventory ? undefined : inventory.stacks[inventory.selected];
  const stationary = !view.self.motion && !view.self.following;
  const limited = <T>(values: T[]) => values.slice(0, 24);
  const target = (values: Vec3[], description: string) => ({ type: 'array', items: integer, minItems: 3, maxItems: 3,
    enum: limited(values), description: `${description} Coordinates are [x,y,z], with y as height.` });
  const tool = (name: string, description: string, parameters: Record<string, unknown>, execute: ToolExecutor) => {
    const schema = { name, description, parameters };
    schemas.push(schema);
    executors[name] = async (args, call, signal) => {
      validateArguments(schema, args);
      const result = await execute(args, call, signal);
      return result && typeof result === 'object' && 'reason' in result && 'actions' in result && 'events' in result
        ? toolOutcome(result as ToolOutcome, currentContext(port, memory.notes)) : result;
    };
  };
  const submit = (name: Action['action'], description: string, parameters: Record<string, unknown>, prepare: (args: Record<string, unknown>) => Action = args => ({ ...args, action: name } as Action)) =>
    tool(name, description, parameters, (args, call, signal) => {
      const action = prepare(args); memory.viewAngle = 0;
      return port.submit(call.id, action, signal);
    });

  tool('look', 'Refresh your local field of view with normal range and occlusion. Optional relative angle changes the view without turning. No world time.',
    object({ angle: { ...number, minimum: -180, maximum: 180 } }), async args => {
      const angle = args.angle as number | undefined; memory.viewAngle = angle ?? 0;
      return localView(port.observe(angle), port.knowledge(angle), memory.notes);
    });
  if (!view.self.following) {
    tool('walk_to', 'Walk to horizontal x,z (at most 32m); terrain sets y height. Returns at arrival, blockage or a perceived event. Events preserve movement; a new locomotion action replaces it.',
      object({ x: number, z: number }, ['x', 'z']), (args, call, signal) => {
        memory.viewAngle = 0;
        return port.submit(call.id, { action: 'walk', target: [args.x as number, port.observe().self.position[1], args.z as number] }, signal);
      });
    for (const [name, description, maximum] of [
      ['walk', 'Walk a relative distance and optional body-relative angle. Events return progress while movement continues.', 32],
      ...(!held || !isRawBlock(held.kind) ? [['run', 'Run a relative distance and optional body-relative angle.', 24] as const] : []),
      ['reverse', 'Move backwards while keeping your forward orientation.', 4],
      ['jump', 'Jump a short distance and optional body-relative angle. Inspect unfamiliar landings first.', 2.5],
    ] as const) {
      submit(name, description, object({ distance: { ...number, exclusiveMinimum: 0, maximum }, ...(name === 'reverse' ? {} : { angle: { ...number, minimum: name === 'jump' ? -90 : -180, maximum: name === 'jump' ? 90 : 180 } }) }, ['distance']));
    }
  }
  tool('inspect_jump', 'Check a local jump using normal perception, without moving or revealing unseen terrain.',
    object({ angle: { ...number, minimum: -90, maximum: 90 }, distance: { ...number, minimum: .75, maximum: 2.5 } }, ['angle', 'distance']),
    async args => port.inspectJump(args.angle as number, args.distance as number));
  submit('say', 'Speak one to three words in clear hearing range; three total per world second. Speaking and hearing preserve concurrent movement.',
    object({ word: { type: 'string', minLength: 1, maxLength: 100 } }, ['word']));
  tool('wait_for_event', 'Wait for observable events, action completion or optional world-second timeout. actionId selects an existing action; omit it to listen. Other actions continue. Receives each queued event once.',
    object({ actionId: text, seconds: { ...number, exclusiveMinimum: 0, maximum: 3600 } }),
    (args, call, signal) => port.wait(call.id, args as { actionId?: string; seconds?: number }, signal));
  if (view.self.motion) tool('cancel_action', 'Cancel your ongoing movement by action ID, preserving current position.',
    object({ actionId: text }, ['actionId']), (args, call, signal) => { memory.viewAngle = 0; return port.cancel(call.id, args.actionId as string, signal); });

  if (view.interactions.follow.length) {
    const choices = view.interactions.follow.map(entity => entity.id);
    submit('follow', `Follow one currently visible creature until blocked, cancelled or unavailable. Current choices: ${view.interactions.follow.map(entity => `${entity.id} (${entity.name}, ${entity.metres}m)`).join(', ')}.`,
      object({ entityId: { ...text, enum: choices } }, ['entityId']), args => ({ action: 'follow', entityId: args.entityId as string, ...(viewAngle ? { angle: viewAngle } : {}) }));
  }
  if (view.self.following) submit('stop_follow', 'Stop following at the shared commit boundary.', object({}));
  if (stationary) {
    submit('turn', 'Turn your body by a relative angle.', object({ angle: { ...number, minimum: -360, maximum: 360 } }, ['angle']));
    for (const name of ['find_material', 'find_entity'] as const) submit(name, 'Scan around for one world second with normal range and occlusion.', object({}));

    if (!held && view.interactions.hit.length) {
      const choices = limited(view.interactions.hit);
      submit('hit', `Strike one currently reachable block with empty hands. Targets: ${choices.map(item => `${item.kind} [${item.target.join(',')}]${item.cracks ? `, cracks ${item.cracks}/3` : ''}`).join('; ')}.`,
        object({ target: target(choices.map(item => item.target), 'Choose one current reachable block target.') }, ['target']));
    }
    if (!held && view.interactions.pickup.length) {
      const choices = limited(view.interactions.pickup);
      submit('pickup', `Pick up one currently reachable loose item. Choices: ${choices.map(item => `${item.itemId} (${item.kind}, ${item.metres}m)`).join(', ')}.`,
        object({ itemId: { ...text, enum: choices.map(item => item.itemId) } }, ['itemId']));
    }
    if (held) {
      if (view.interactions.place.length) submit('place', `Place one held ${held.kind} at a currently reachable supported target.`,
        object({ target: target(view.interactions.place, 'Choose one current placement target.') }, ['target']));
      submit('throw', `Throw one held ${held.kind} forward.`, object({ force: { ...number, minimum: 1, maximum: 12 } }));
      submit('store', 'Free your hands without changing inventory quantities.', object({}));
      if (held.kind === 'wood') {
        tool('strike_held', 'Experiment on the raw wood in your hands by striking one named surface region. The point names identify distinct regions, not undiscovered outcomes.',
          object({ point: { type: 'string', enum: Object.keys(impactPoints) }, orientation: { type: 'string', enum: ['up', 'down'], description: 'Required only for front_edge.' } }, ['point']),
          (args, call, signal) => {
            if (args.point === 'front_edge' && !args.orientation) throw new Error('front_edge requires orientation up or down.');
            return port.submit(call.id, { action: 'strike_held', impact: impactPoints[args.point as string], ...(args.orientation ? { orientation: args.orientation as 'up' | 'down' } : {}) }, signal);
          });
      }
      if (held.kind === 'shovel' && view.interactions.hit.length) {
        const choices = limited(view.interactions.hit);
        submit('dig', `Dig one reachable sand, dirt or grass block with the held shovel. Targets: ${choices.map(item => `${item.kind} [${item.target.join(',')}]`).join('; ')}.`,
          object({ target: target(choices.map(item => item.target), 'Choose one current dig target.') }, ['target']));
      }
      if (held.kind === 'bucket' && !held.contents && view.interactions.fill.length) submit('fill', 'Fill one held empty bucket from a current compatible source.',
        object({ target: target(view.interactions.fill, 'Choose one current fill source.') }, ['target']));
      if (held.kind === 'bucket' && held.contents && view.interactions.empty.length) submit('empty', `Empty one held bucket containing ${held.contents} at a current valid destination.`,
        object({ target: target(view.interactions.empty, 'Choose one current emptying destination.') }, ['target']));
    }

    const otherStacks = inventory?.stacks.flatMap((_stack, index) => index === inventory.selected ? [] : [index]) ?? [];
    if (otherStacks.length) submit('hold', `Take one owned stack into your hands. Choices: ${otherStacks.map(index => `${index} (${inventory!.stacks[index].count} x ${inventory!.stacks[index].kind})`).join(', ')}.`,
      object({ stack: { type: 'integer', enum: otherStacks } }, ['stack']));
    if (inventory?.stacks.some(stack => stack.kind === 'door_half_up') && inventory.stacks.some(stack => stack.kind === 'door_half_down'))
      submit('join', 'Join one owned upper and lower wooden door half.', object({}));
    for (const name of ['open', 'close'] as const) {
      const choices = view.interactions[name];
      if (choices.length) submit(name, `${name === 'open' ? 'Open' : 'Close'} one currently reachable installed door.`,
        object({ itemId: { ...text, enum: choices.map(door => door.itemId) } }, ['itemId']));
    }
  }

  tool('set_intent', 'Create or update your identity, goal and observable success condition. Reassess it from current outcomes and set completed promptly when every condition is satisfied. No world time.',
    object({ identity: text, goal: text, successCondition: text, assessment: text, status: { type: 'string', enum: ['active', 'completed', 'abandoned', 'blocked'] } }, ['goal', 'successCondition', 'status']),
    async args => { port.setIntent(args as unknown as AgentIntent); return { intent: args, assessmentBy: 'agent' }; });
  tool('remember', 'Replace your private notes (at most ten concise entries). Before adding to ten existing notes, merge those into nine or fewer. Preserve useful facts, hypotheses and commitments.',
    object({ notes: { type: 'array', items: text, maxItems: 10 } }, ['notes']),
    async args => { memory.notes = [...args.notes as string[]]; port.remember(memory.notes); return { notes: memory.notes }; });
  return { schemas, executors };
}
