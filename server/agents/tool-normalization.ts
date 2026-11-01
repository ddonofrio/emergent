import { randomUUID } from 'node:crypto';
import { assertObjectJsonSchema, isPlainJsonRecord, validateJsonSchemaValue } from '../../vendor/deepseek-harness/json-schema';
import type { CompletionResult } from './providers';
import { jsonTextDraft } from './response-repair';

type TextToolFormat='tool-parameters'|'tool-inline'|'named-tool'|'single-tool-arguments';
export interface ToolNormalization { source:'content';format:TextToolFormat; }

/** Decode one complete JSON response; never extract prose, repair JSON or infer missing arguments. */
export function normalizeTextToolCall(answer:CompletionResult,tools:unknown[]):CompletionResult {
  const draft=jsonTextDraft(answer);
  if(!draft)return answer;
  const candidates:{name:string;args:Record<string,unknown>;format:TextToolFormat}[]=[];
  for(const tool of tools){
    if(!isPlainJsonRecord(tool)||tool.type!=='function'||!isPlainJsonRecord(tool.function))continue;
    const {name,parameters}=tool.function;
    if(typeof name!=='string'||!/^[a-zA-Z0-9_-]+$/.test(name))continue;
    try{assertObjectJsonSchema(parameters);}catch{continue;}
    const accept=(args:unknown,format:TextToolFormat)=>{
      if(isPlainJsonRecord(args)&&!validateJsonSchemaValue(parameters,args).length)candidates.push({name,args,format});
    };
    if(draft.tool===name){
      if(Object.hasOwn(draft,'parameters')){
        if(Object.keys(draft).length===2)accept(draft.parameters,'tool-parameters');
      }else{
        const {tool:_,...args}=draft;
        accept(args,'tool-inline');
      }
    }
    if(Object.keys(draft).length===1&&Object.hasOwn(draft,name))accept(draft[name],'named-tool');
    // Unlabelled arguments are meaningful only when the request offers exactly one tool.
    if(tools.length===1)accept(draft,'single-tool-arguments');
  }
  if(candidates.length!==1)return answer;
  const {name,args,format}=candidates[0];
  return {...answer,calls:[{id:`text_${randomUUID()}`,type:'function',function:{name,arguments:JSON.stringify(args)}}],normalization:{source:'content',format}};
}
