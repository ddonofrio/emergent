export const SAMPLING_TEMPLATES={
  'signal-3.8':{
    label:'Signal-3.8',
    parameters:{temperature:0.6,top_p:0.95,top_k:20,min_p:0.05,presence_penalty:1.0},
  },
} as const;

export type SamplingTemplateId=keyof typeof SAMPLING_TEMPLATES;

export function isSamplingTemplateId(value:unknown):value is SamplingTemplateId {
  return typeof value==='string'&&Object.hasOwn(SAMPLING_TEMPLATES,value);
}
