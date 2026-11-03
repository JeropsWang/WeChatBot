/** 生成稳定的提示词缓存标识，固定指令与动态资料分离。键不含明文聊天内容，供应商是否命中以实际返回统计为准。 */
import type {RunInput} from './models.js';
import type {ModelConfig} from '../../packages/contracts.js';
import {createHash} from 'node:crypto';

export function promptCacheSessionId(input:RunInput):string{
  // Stable across requests and tool rounds; never put a task UUID or personal data in the key.
  return createHash('sha256').update(JSON.stringify(['prompt-v1',input.model.id,input.model.model,input.context?.purpose??'chat',input.context?.chatId??'global',input.systemPrompt])).digest('hex');
}
export function applyPromptCachePolicy(payload:any,model:ModelConfig):any{
  // Third-party "OpenAI compatible" servers may reject these newer fields.
  const version=/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model.model);
  if(model.protocol!=='openai'||!version||!(Number(version[1])>=6||Number(version[1])===5&&Number(version[2])>=6))return payload;
  try{const url=new URL(model.baseUrl);if(url.protocol!=='https:'||url.hostname!=='api.openai.com')return payload;}catch{return payload;}
  const instruction=payload.input?.[0];
  if(!instruction||!['system','developer'].includes(instruction.role))return payload;
  const content=typeof instruction.content==='string'?[{type:'input_text',text:instruction.content}]:instruction.content;
  if(!Array.isArray(content)||!content.length||content.at(-1)?.type!=='input_text')return payload;
  instruction.content=content.map((part:any,index:number)=>index===content.length-1?{...part,prompt_cache_breakpoint:{mode:'explicit'}}:part);
  payload.prompt_cache_options={mode:'implicit',ttl:'30m'};
  return payload;
}
