import type { Store } from '../store';
import type { CompletionRequest, CompletionResult } from './providers';
import { InvalidCompletionError, ProviderUnavailableError } from './providers';
import { normalizeTextToolCall } from './tool-normalization';

export const PROMPT_VERSION='focused-context-v13';
export class InferenceAuditError extends Error {}

function persist<T>(write:()=>T):T {
  try{return write();}catch{throw new InferenceAuditError('Could not persist the inference audit.');}
}

export async function auditedCompletion(store:Store,tick:number,actor:string,phase:string,request:CompletionRequest,signal:AbortSignal,complete:()=>Promise<CompletionResult>) {
  signal.throwIfAborted();
  const startedAt=new Date().toISOString(),started=performance.now();
  const timing=()=>({startedAt,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started)});
  // The completion payload contains messages and schemas only, never credentials, headers or URLs.
  const audit=persist(()=>store.beginInference(tick,actor,phase,PROMPT_VERSION,request));
  let answer:CompletionResult;
  try{answer=normalizeTextToolCall(await complete(),request.tools);}
  catch(error){
    persist(()=>store.finishInference(audit,{message:signal.aborted?'Request cancelled.':error instanceof InvalidCompletionError||error instanceof ProviderUnavailableError?error.message:'Inference did not return a valid response.',timing:timing()},signal.aborted?'cancelled':'failed'));
    throw error;
  }
  persist(()=>store.finishInference(audit,{...answer,timing:timing()},'completed'));
  return answer;
}
