import type { CompletionResult } from './providers';

export function completionAttempt(answer:CompletionResult) {
  return {content:answer.content,calls:answer.calls};
}

// A complete object may be normalized against the current tool schema, or retained for format repair.
export function jsonTextDraft(answer:CompletionResult):Record<string,unknown>|undefined {
  if(answer.calls.length||!answer.content)return undefined;
  try{
    const value=JSON.parse(answer.content);
    if(value&&typeof value==='object'&&!Array.isArray(value))return value;
  }catch{/* Unstructured prose cannot identify a tool or its arguments. */}
}

export const FORMAT_REPAIR='No tool call was received. Use an actual available tool call with JSON arguments. Repair the response format only: preserve the previous draft and decision; do not choose a new task or method. Return no extra prose.';
