import type { Store } from '../store';
import type { CompletionRequest, CompletionResult } from './providers';

export const PROMPT_VERSION='projects-and-experience-v4';
export class InferenceAuditError extends Error {}

function persist<T>(write:()=>T):T {
  try{return write();}catch{throw new InferenceAuditError('Could not persist the inference audit.');}
}

export async function auditedCompletion(store:Store,tick:number,actor:string,phase:string,request:CompletionRequest,signal:AbortSignal,complete:()=>Promise<CompletionResult>) {
  signal.throwIfAborted();
  // The completion payload contains messages and schemas only, never credentials, headers or URLs.
  const audit=persist(()=>store.beginInference(tick,actor,phase,PROMPT_VERSION,request));
  let answer:CompletionResult;
  try{answer=await complete();}
  catch(error){
    persist(()=>store.finishInference(audit,{message:signal.aborted?'Request cancelled.':'Inference did not return a valid response.'},signal.aborted?'cancelled':'failed'));
    throw error;
  }
  persist(()=>store.finishInference(audit,answer,'completed'));
  return answer;
}
