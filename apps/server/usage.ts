/** 记录厂商返回的 token 和费用，按模型用途统计。缺少单价或缓存用量时保留未知，避免将不完整估算显示为实际支出。 */
import {randomUUID} from 'node:crypto';
import type {Database} from './db.js';
import type {ModelConfig} from '../../packages/contracts.js';
import type {AppCache} from './cache.js';
export interface UsageContext {purpose:string;taskId?:string;chatId?:string;memberId?:string;attempt?:number}
export interface NormalizedUsage {uncachedInput:number|null;cacheRead:number|null;cacheWrite:number|null;inputTotal:number|null;output:number|null;reasoning:number|null;total:number|null}
const count=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const sum=(...values:(number|null)[])=>values.some(v=>v===null)?null:(values as number[]).reduce((a,b)=>a+b,0);
export function normalizeUsage(raw:any,protocol='openai-compatible'):NormalizedUsage{
  raw=raw??{};let uncachedInput:number|null=null,cacheRead:number|null=null,cacheWrite:number|null=null,inputTotal:number|null=null,output:number|null=null,reasoning:number|null=null,total:number|null=null;
  if(protocol==='anthropic'){
    uncachedInput=count(raw.input_tokens);cacheRead=count(raw.cache_read_input_tokens);cacheWrite=count(raw.cache_creation_input_tokens);output=count(raw.output_tokens);
    // Anthropic input_tokens excludes both cache classes. Absent cache reporting stays unknown.
    inputTotal=sum(uncachedInput,cacheRead,cacheWrite);total=sum(inputTotal,output);
  }else if(protocol==='google'){
    inputTotal=count(raw.promptTokenCount);cacheRead=count(raw.cachedContentTokenCount);cacheWrite=cacheRead!==null?0:null;uncachedInput=inputTotal===null||cacheRead===null?null:Math.max(0,inputTotal-cacheRead);
    reasoning=count(raw.thoughtsTokenCount);const candidates=count(raw.candidatesTokenCount);output=candidates===null?null:candidates+(reasoning??0);total=count(raw.totalTokenCount)??sum(inputTotal,output);
  }else{
    inputTotal=count(raw.prompt_tokens??raw.input_tokens);const details=raw.prompt_tokens_details??raw.input_tokens_details;
    cacheRead=count(details?.cached_tokens??raw.cache_read_input_tokens??raw.prompt_cache_hit_tokens);cacheWrite=count(details?.cache_write_tokens??raw.cache_creation_input_tokens)??(cacheRead!==null?0:null);
    uncachedInput=inputTotal===null||cacheRead===null||cacheWrite===null?null:Math.max(0,inputTotal-cacheRead-cacheWrite);
    output=count(raw.completion_tokens??raw.output_tokens);reasoning=count((raw.completion_tokens_details??raw.output_tokens_details)?.reasoning_tokens);total=count(raw.total_tokens)??sum(inputTotal,output);
  }
  return {uncachedInput,cacheRead,cacheWrite,inputTotal,output,reasoning,total};
}
export function aggregateUsage(items:NormalizedUsage[]):NormalizedUsage{const keys=['uncachedInput','cacheRead','cacheWrite','inputTotal','output','reasoning','total'] as const;return Object.fromEntries(keys.map(key=>[key,items.length?sum(...items.map(item=>item[key])):null])) as unknown as NormalizedUsage;}
export function estimateCost(usage:NormalizedUsage,pricing?:ModelConfig['pricing']){
  if(!pricing)return {cost:null,currency:null,pricing:null};
  const valid=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const parts:[[number|null,number|undefined],[number|null,number|undefined],[number|null,number|undefined],[number|null,number|undefined]]=[[usage.uncachedInput,pricing.inputPerMillion],[usage.cacheRead,pricing.cacheReadPerMillion],[usage.cacheWrite,pricing.cacheWritePerMillion],[usage.output,pricing.outputPerMillion]];
  return {cost:parts.some(([n,rate])=>n===null||(n>0&&!valid(rate)))?null:parts.reduce((total,[n,rate])=>total+(n??0)*(rate??0)/1e6,0),currency:pricing.currency,pricing:structuredClone(pricing)};
}
export interface UsageCall {id?:string;runId:string;modelId:string;modelName:string;protocol:string;purpose:string;taskId?:string;chatId?:string;memberId?:string;attempt:number;round:number;status:string;startedAt:string;finishedAt:string;usage:NormalizedUsage;cost:number|null;currency:string|null;pricing:ModelConfig['pricing']|null;httpStatus?:number}
export interface UsageFilters {from?:string;to?:string;modelId?:string;chatId?:string;purpose?:string;page?:number;pageSize?:number}
export class UsageStore {
  constructor(private db:Database,private cache?:AppCache){}
  async record(call:UsageCall){const id=call.id??randomUUID();await this.db.query('INSERT INTO model_calls(id,run_id,model_id,model_name,protocol,purpose,task_id,chat_id,member_id,attempt,round,status,started_at,finished_at,usage,cost,currency,pricing,http_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',[id,call.runId,call.modelId,call.modelName,call.protocol,call.purpose,call.taskId??null,call.chatId??null,call.memberId??null,call.attempt,call.round,call.status,call.startedAt,call.finishedAt,call.usage,call.cost,call.currency,call.pricing,call.httpStatus??null]);return id;}
  private where(filters:UsageFilters){const values:any[]=[],clauses:string[]=[];for(const [key,column,op] of [['from','started_at','>='],['to','started_at','<='],['modelId','model_id','='],['chatId','chat_id','='],['purpose','purpose','=']] as const){if(filters[key]){if((key==='from'||key==='to')&&!Number.isFinite(Date.parse(filters[key]!)))throw new Error('统计时间无效');values.push(filters[key]);clauses.push(`${column}${op}$${values.length}`);}}return {sql:clauses.length?' WHERE '+clauses.join(' AND '):'',values};}
  async calls(filters:UsageFilters={}){const {sql,values}=this.where(filters);const page=Math.max(1,Math.floor(Number(filters.page)||1)),pageSize=[20,50,100].includes(Number(filters.pageSize))?Number(filters.pageSize):20;const total=Number((await this.db.query('SELECT count(*) count FROM model_calls'+sql,values)).rows[0].count);const rows=(await this.db.query('SELECT * FROM model_calls'+sql+` ORDER BY started_at DESC,id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,pageSize,(page-1)*pageSize])).rows;return {items:rows.map(callRow),total,page,pageSize};}
  async getCall(id:string){
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))return null;const row=(await this.db.query('SELECT * FROM model_calls WHERE id=$1',[id])).rows[0];if(!row)return null;
    const rounds=(await this.db.query('SELECT * FROM model_calls WHERE run_id=$1 ORDER BY round,attempt,started_at,id',[row.run_id])).rows.map(callRow);
    const reported=rounds.filter(call=>call.status==='success'||Object.values(call.usage).some(value=>typeof value==='number'));
    const currencies=[...new Set(rounds.map(call=>call.currency).filter(Boolean))],runCurrency=currencies.length===1?currencies[0]:null;
    const runCost=runCurrency&&rounds.every(call=>call.cost!==null&&call.currency===runCurrency)?rounds.reduce((total,call)=>total+call.cost!,0):null;
    return {...callRow(row),rounds,runUsage:aggregateUsage(reported.map(call=>call.usage)),runCost,runCurrency};
  }
  async summary(filters:UsageFilters={}){
    const {sql,values}=this.where(filters),keys=['uncachedInput','cacheRead','cacheWrite','inputTotal','output','reasoning','total'];
    const columns=keys.map(key=>`sum((usage->>'${key}')::numeric) "${key}",count(usage->>'${key}') "${key}Known"`).join(',');
    const row=(await this.db.query(`SELECT count(*) calls,count(*) FILTER(WHERE status='error') errors,${columns},sum((usage->>'cacheRead')::numeric) FILTER(WHERE usage->>'cacheRead' IS NOT NULL AND usage->>'inputTotal' IS NOT NULL) cache_read,sum((usage->>'inputTotal')::numeric) FILTER(WHERE usage->>'cacheRead' IS NOT NULL AND usage->>'inputTotal' IS NOT NULL) cache_input,count(*) FILTER(WHERE usage->>'cacheRead' IS NOT NULL) cache_known,count(*) FILTER(WHERE (usage->>'cacheRead')::numeric>0) cache_hits FROM model_calls${sql}`,values)).rows[0];
    const costs=(await this.db.query(`SELECT currency,sum(cost) cost,count(cost) "knownCalls" FROM model_calls${sql} GROUP BY currency`,values)).rows;
    return {calls:Number(row.calls),errors:Number(row.errors),usage:Object.fromEntries(keys.map(k=>[k,row[k]===null?null:Number(row[k])])),knownCounts:Object.fromEntries(keys.map(k=>[k,Number(row[k+'Known'])])),cacheReadTokenRate:Number(row.cache_input)>0?Number(row.cache_read)/Number(row.cache_input):null,cacheHitRequestRate:Number(row.cache_known)>0?Number(row.cache_hits)/Number(row.cache_known):null,cacheReportingCalls:Number(row.cache_known),costs:costs.map(r=>({currency:r.currency,cost:r.cost===null?null:Number(r.cost),knownCalls:Number(r.knownCalls)}))};
  }
  cacheStats(){return this.cache?.stats()??{search:{hits:0,misses:0,expired:0,errors:0},page:{hits:0,misses:0,expired:0,errors:0},embedding:{hits:0,misses:0,expired:0,errors:0}};}
}
function callRow(r:any){return {id:r.id,runId:r.run_id,modelId:r.model_id,modelName:r.model_name,protocol:r.protocol,purpose:r.purpose,taskId:r.task_id,chatId:r.chat_id,memberId:r.member_id,attempt:r.attempt,round:r.round,status:r.status,startedAt:r.started_at,finishedAt:r.finished_at,usage:r.usage,cost:r.cost===null?null:Number(r.cost),currency:r.currency,pricing:r.pricing,httpStatus:r.http_status};}
