import { validateArguments, type ToolExecutor, type ToolSchema } from '../../vendor/littlewhale';
import { wakeEventTypes, type AgentPort, type WaitOptions } from '../simulation/agent-port';

export const MAX_SEQUENCE_STEPS = 8;
export const MAX_SAVED_SEQUENCES = 8;
const MAX_SEQUENCE_BYTES = 8192;
export const sequenceActions = new Set(['look', 'walk_to', 'walk', 'run', 'reverse', 'jump', 'say', 'turn',
  'find_material', 'find_entity', 'hit', 'pickup', 'place', 'throw', 'store', 'strike_held', 'dig', 'fill', 'empty', 'hold', 'join', 'open', 'close']);
// Advertise event names once, on wait_for_event, instead of in every action schema.
export const eventTypesSchema = { type: 'array', items: { type: 'string' }, maxItems: wakeEventTypes.length };
export const namedEventTypesSchema = { ...eventTypesSchema, items: { type: 'string', enum: [...wakeEventTypes] } };
export function validateEventTypes(eventTypes: unknown) {
  if (eventTypes !== undefined) validateArguments({ name: 'eventTypes', description: '', parameters: namedEventTypesSchema }, eventTypes);
}
type EventTypes = NonNullable<WaitOptions['eventTypes']>;
export interface SequenceStep { tool: string; args: Record<string, unknown>; }
export interface SavedSequence { name: string; description: string; parameters: string[]; steps: SequenceStep[]; }
export interface SequenceRun {
  id: string;
  invocationId: string;
  name?: string;
  steps: SequenceStep[];
  eventTypes: EventTypes;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  index: number;
  actionId?: string;
  waitSerial: number;
  outcomes: { step: number; tool: string; result: Record<string, unknown> }[];
  error?: string;
}
export interface SequenceMemory {
  sequence?: SequenceRun;
  routines?: SavedSequence[];
  saveTools?: () => void;
  /** Dispatch locks are transient; durable progress is in sequence. */
  physicalCalls?: Set<string>;
  executingSequence?: boolean;
}
type Toolkit = { schemas: ToolSchema[]; executors: Record<string, ToolExecutor> };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const name = { type: 'string', minLength: 1, maxLength: 48, pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' };
const stepsSchema = { type: 'array', minItems: 1, maxItems: MAX_SEQUENCE_STEPS,
  items: object({ tool: { type: 'string', minLength: 1, maxLength: 64 }, args: { type: 'object', maxProperties: 16 } }, ['tool', 'args']) };
const defaultEvents: EventTypes = ['speech', 'encounter', 'discovery', 'collision'];
const pending = (run: SequenceRun) => run.status === 'running' || run.status === 'interrupted';
const stepCallId = (run: SequenceRun) => `${run.id}:step:${run.index}`;
const waitCallId = (run: SequenceRun) => `${stepCallId(run)}:wait:${run.waitSerial}`;

export function sequenceRetainedCalls(memory: SequenceMemory): string[] {
  const run = memory.sequence;
  return run && pending(run) ? [stepCallId(run), ...(run.actionId ? [waitCallId(run)] : [])] : [];
}

export function sequenceContext(memory: SequenceMemory) {
  const run = memory.sequence;
  return {
    ...(memory.routines?.length ? { routines: memory.routines.map(({ name, description, parameters, steps }) => ({ name, description, parameters, steps: steps.length })) } : {}),
    ...(run && pending(run) ? { sequence: { id: run.id, status: run.status, completedSteps: run.index,
      totalSteps: run.steps.length, nextStep: run.steps[run.index], ...(run.actionId ? { actionId: run.actionId } : {}) } } : {}),
  };
}

function checkSteps(steps: SequenceStep[]) {
  if (Buffer.byteLength(JSON.stringify(steps), 'utf8') > MAX_SEQUENCE_BYTES) throw new Error('Sequence exceeds 8192 bytes.');
  for (const step of steps) {
    if (!sequenceActions.has(step.tool)) throw new Error(`${step.tool} is not a finite physical sequence action.`);
    if ('eventTypes' in step.args) throw new Error('Choose eventTypes once for the whole sequence.');
  }
}

/** Exact JSON references only: no evaluation, interpolation, filesystem or global state. */
function bind(value: unknown, parameters: string[], bindings?: Record<string, unknown>, depth = 0): unknown {
  if (depth > 8) throw new Error('Sequence arguments are nested too deeply.');
  if (Array.isArray(value)) return value.map(item => bind(item, parameters, bindings, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (Object.hasOwn(value, '$param')) {
      const parameter = (value as { $param: unknown }).$param;
      if (entries.length !== 1 || typeof parameter !== 'string' || !parameters.includes(parameter)) throw new Error('Unknown or malformed parameter reference.');
      if (bindings && !Object.hasOwn(bindings, parameter)) throw new Error(`Missing parameter ${parameter}.`);
      return bindings ? structuredClone(bindings[parameter]) : value;
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, bind(item, parameters, bindings, depth + 1)]));
  }
  return value;
}

export function sequenceTools(port: AgentPort, memory: SequenceMemory, prepare: () => Toolkit,
  resume: (callId: string, signal: AbortSignal) => Promise<unknown> | undefined,
  present: (outcome: Awaited<ReturnType<AgentPort['wait']>>) => Record<string, unknown>): Toolkit {
  const schemas: ToolSchema[] = [], executors: Record<string, ToolExecutor> = {};
  const add = (name: string, description: string, parameters: Record<string, unknown>, execute: ToolExecutor, advertise = true) => {
    const schema = { name, description, parameters };
    if (advertise) schemas.push(schema);
    executors[name] = async (args, call, signal) => {
      signal.throwIfAborted();
      try { validateArguments(schema, args); validateEventTypes(args.eventTypes); return await execute(args, call, signal); }
      catch (error) { signal.throwIfAborted(); return { error: error instanceof Error ? error.message : 'Sequence failed.' }; }
    };
  };
  const save = () => memory.saveTools?.();
  const result = (run: SequenceRun) => ({ sequenceId: run.id, status: run.status, completedSteps: run.index,
    totalSteps: run.steps.length, ...(pending(run) ? { nextStep: run.steps[run.index], actionId: run.actionId } : {}),
    outcomes: structuredClone(run.outcomes), ...(run.error ? { error: run.error } : {}) });

  add('run_sequence', 'Execute up to eight finite physical tool steps in order, checking current availability before each. Supply steps, a saved name with bindings, or sequenceId to resume. Stops on failure or selected events; default interruptions are speech, encounter, discovery and collision. Use as the only physical call in a response.',
    { ...object({ steps: stepsSchema, name, bindings: { type: 'object', maxProperties: 8 }, sequenceId: { type: 'string', minLength: 1, maxLength: 100 }, eventTypes: eventTypesSchema }),
      oneOf: [{ required: ['steps'] }, { required: ['name'] }, { required: ['sequenceId'] }] }, async (args, call, signal) => {
      if (memory.executingSequence || memory.physicalCalls?.size) throw new Error('A sequence must be the only physical call in its response.');
      let run = memory.sequence;
      if (run?.invocationId !== call.id) {
        if (args.sequenceId) {
          if (!run || run.id !== args.sequenceId || run.status !== 'interrupted') throw new Error('No matching interrupted sequence.');
          if (args.bindings) throw new Error('Cannot change parameters while resuming.');
          run.invocationId = call.id; run.status = 'running'; run.outcomes = [];
          if (args.eventTypes !== undefined) run.eventTypes = [...args.eventTypes as EventTypes];
        } else {
          if (run && pending(run)) throw new Error('Resume or cancel the existing sequence first.');
          if (port.bodyActivity() || port.observe().self.motion || port.observe().self.following) throw new Error('Start a new sequence with a free stationary body.');
          let steps: SequenceStep[];
          if (args.name) {
            const routine = memory.routines?.find(routine => routine.name === args.name);
            if (!routine) throw new Error('Unknown saved sequence.');
            const bindings = (args.bindings ?? {}) as Record<string, unknown>;
            if (Object.keys(bindings).some(key => !routine.parameters.includes(key)) || routine.parameters.some(key => !Object.hasOwn(bindings, key))) throw new Error('Bindings must match the saved parameters exactly.');
            steps = bind(routine.steps, routine.parameters, bindings) as SequenceStep[];
          } else {
            if (args.bindings) throw new Error('Bindings require a saved sequence name.');
            steps = bind(args.steps, []) as SequenceStep[];
          }
          validateArguments({ name: 'steps', description: '', parameters: object({ steps: stepsSchema }, ['steps']) }, { steps });
          checkSteps(steps);
          run = { id: call.id, invocationId: call.id, ...(args.name ? { name: args.name as string } : {}), steps: structuredClone(steps),
            eventTypes: [...(args.eventTypes as EventTypes | undefined ?? defaultEvents)], status: 'running', index: 0, waitSerial: 0, outcomes: [] };
          memory.sequence = run;
        }
        save();
      }
      if (!run) throw new Error('Missing sequence state.');
      if (run.status !== 'running') return result(run);
      memory.executingSequence = true;
      try {
        while (run.index < run.steps.length) {
          signal.throwIfAborted();
          const step = run.steps[run.index];
          let outcome: Record<string, unknown>;
          if (run.actionId) {
            const callId = waitCallId(run);
            const resumed = port.resume(callId, signal);
            outcome = present(await (resumed ?? port.wait(callId, { actionId: run.actionId, eventTypes: run.eventTypes }, signal, true)));
          } else {
            const callId = stepCallId(run);
            const resumed = resume(callId, signal);
            if (resumed) outcome = await resumed as Record<string, unknown>;
            else {
              const toolkit = prepare(), schema = toolkit.schemas.find(schema => schema.name === step.tool);
              if (!schema) { run.status = 'failed'; run.error = `Step ${run.index + 1}: ${step.tool} is not currently available.`; save(); break; }
              const stepArgs = { ...step.args, eventTypes: run.eventTypes };
              try { validateArguments(schema, stepArgs); }
              catch (error) { run.status = 'failed'; run.error = `Step ${run.index + 1}: ${error instanceof Error ? error.message : 'Invalid arguments.'}`; save(); break; }
              outcome = await toolkit.executors[step.tool](stepArgs, { id: callId, name: step.tool, arguments: stepArgs }, signal) as Record<string, unknown>;
            }
          }
          signal.throwIfAborted();
          run.outcomes.push({ step: run.index + 1, tool: step.tool, result: outcome });
          const action = outcome.action as { id: string; status: string; result?: { ok: boolean; message: string } } | undefined;
          const events = (outcome.events ?? []) as { type: string }[];
          if (outcome.error || outcome.reason === 'rejected' || action?.result?.ok === false || action && ['blocked', 'cancelled', 'rejected'].includes(action.status)) {
            run.status = 'failed'; run.error = String(outcome.error ?? action?.result?.message ?? 'Physical step failed.');
          } else if (action?.status === 'completed') {
            run.index++; delete run.actionId; run.waitSerial = 0;
            if (run.index === run.steps.length) run.status = 'completed';
            else if (events.some(event => run!.eventTypes.includes(event.type as EventTypes[number]))) run.status = 'interrupted';
          } else if (action) {
            run.actionId = action.id; run.waitSerial++; run.status = 'interrupted';
          } else {
            run.status = 'failed'; run.error = 'Step returned no physical action receipt.';
          }
          save();
          if (run.status !== 'running') break;
        }
        return result(run);
      } catch (error) {
        signal.throwIfAborted();
        run.status = 'failed'; run.error = error instanceof Error ? error.message : 'Sequence execution failed.'; save();
        return result(run);
      } finally { memory.executingSequence = false; }
    });

  add('save_sequence', 'Save or replace your own procedure (at most eight). Steps use existing physical tool names. Parameter values use exact JSON references {"$param":"name"}. Describe when it is useful; saving does not establish that it works.',
    object({ name, description: { type: 'string', minLength: 1, maxLength: 240 }, parameters: { type: 'array', items: name, maxItems: 8 }, steps: stepsSchema }, ['name', 'description', 'steps']), async args => {
      const routine: SavedSequence = { name: args.name as string, description: args.description as string,
        parameters: [...args.parameters as string[] | undefined ?? []], steps: structuredClone(args.steps as SequenceStep[]) };
      checkSteps(routine.steps); bind(routine.steps, routine.parameters);
      const routines = memory.routines ?? [];
      if (!routines.some(item => item.name === routine.name) && routines.length >= MAX_SAVED_SEQUENCES) throw new Error('Eight procedures are already saved. Replace or forget one first.');
      memory.routines = [...routines.filter(item => item.name !== routine.name), routine]; save();
      return { saved: routine.name, parameters: routine.parameters, steps: routine.steps.length };
    });
  const names = memory.routines?.map(routine => routine.name) ?? [];
  add('read_sequence', 'Read one of your saved procedures before reusing or editing it.', object({ name: { ...name, enum: names } }, ['name']),
    async args => structuredClone(memory.routines!.find(routine => routine.name === args.name)), names.length > 0);
  add('forget_sequence', 'Delete one of your saved procedures. A running copy is unaffected.', object({ name: { ...name, enum: names } }, ['name']), async args => {
    memory.routines = memory.routines!.filter(routine => routine.name !== args.name); save(); return { forgotten: args.name };
  }, names.length > 0);
  add('cancel_sequence', 'Discard remaining sequence steps. An already started physical action continues; use cancel_action to stop movement.',
    object({ sequenceId: { type: 'string', minLength: 1 } }, ['sequenceId']), async args => {
      const run = memory.sequence;
      if (memory.executingSequence || !run || run.id !== args.sequenceId || run.status !== 'interrupted') throw new Error('No matching interrupted sequence.');
      run.status = 'cancelled'; save(); return { sequenceId: run.id, status: run.status, actionId: run.actionId };
    }, memory.sequence?.status === 'interrupted');
  return { schemas, executors };
}
