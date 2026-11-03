/** 公网搜索及正文读取，限制 URL、重定向和请求时限。搜索结果保留出处并视为不可信资料，联网失败不得阻断普通聊天。 */
import { BlockList,isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import type { NetworkSettings, SearchHit } from '../../packages/contracts.js';
import type {SecretStore} from './secrets.js';
import {DeepSeekClient,deepseekBaseUrl,deepseekSecretId,validateDeepSeekQuery,withNetworkDeadline,type ApiKeySource} from './deepseek.js';
import type {AppCache} from './cache.js';
import {defaultSearchSettings,validateSearchSettings,type SearchSettings} from './search-settings.js';

const blocked=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,prefix,'ipv4');
for(const [ip,prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]] as const)blocked.addSubnet(ip,prefix,'ipv6');
export function isPublicAddress(address:string):boolean {
  const value=address.replace(/^\[|\]$/g,'').toLowerCase();
  if(value.startsWith('::ffff:')){ const mapped=value.slice(7); if(isIP(mapped)===4)return isPublicAddress(mapped); return false; }
  const family=isIP(value); return Boolean(family)&&!blocked.check(value,family===4?'ipv4':'ipv6');
}
export async function validatePublicUrl(raw:string){
  const url=new URL(raw); const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||hostname==='localhost'||hostname.endsWith('.local')||hostname.endsWith('.localhost'))throw new Error('仅允许读取公网 HTTP/HTTPS 网页');
  const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true});
  if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new Error('不允许访问本机、内网或保留地址');
  return {url,address:addresses[0]};
}
async function requestPage(raw:string,depth=0,signal?:AbortSignal):Promise<{url:string;html:string}> {
  if(signal?.aborted)throw new Error('网页读取已停止');
  if(depth>4)throw new Error('网页重定向过多');
  const {url,address}=await validatePublicUrl(raw);
  if(signal?.aborted)throw new Error('网页读取已停止');
  return new Promise((resolve,reject)=>{
    const transport=url.protocol==='https:'?https:http;
    // Pin the validated DNS result to the connection, including every redirect.
    const req=transport.request(url,{method:'GET',headers:{'User-Agent':'LiinoWorkbench/0.1 (+local knowledge reader)','Accept':'text/html,text/plain'},lookup:((_hostname:any,options:any,callback:any)=>options?.all?callback(null,[address]):callback(null,address.address,address.family)) as any},res=>{
      if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();void requestPage(new URL(res.headers.location,url).href,depth+1,signal).then(resolve,reject);return;}
      if(!res.statusCode||res.statusCode>=400){res.resume();reject(new Error('网页返回 HTTP '+res.statusCode));return;}
      const chunks:Buffer[]=[];let bytes=0;
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2_000_000){req.destroy(new Error('网页超过2MB读取上限'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve({url:url.href,html:Buffer.concat(chunks).toString('utf8')}));res.on('error',reject);
    });const deadline=setTimeout(()=>req.destroy(new Error('网页读取超过10秒总时限')),10000),abort=()=>req.destroy(new Error('网页读取已停止'));
    signal?.addEventListener('abort',abort,{once:true});req.once('close',()=>{clearTimeout(deadline);signal?.removeEventListener('abort',abort);});req.setTimeout(10000,()=>req.destroy(new Error('网页读取超时')));req.on('error',reject);if(signal?.aborted)abort();else req.end();
  });
}
export async function fetchPage(url:string,signal?:AbortSignal,options:{cache?:AppCache;scope?:string}={}):Promise<SearchHit>{
  // Validate the URL shape even on hits. A stored public response cannot bypass scheme checks.
  const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('仅允许读取公网 HTTP/HTTPS 网页');
  const cacheKey={content:canonicalUrl(url)??url,scope:options.scope??'global',version:'page-v1'};
  if(signal?.aborted)throw new Error('网页读取已停止');
  const cached=await options.cache?.get<SearchHit>('page',cacheKey);if(cached)return cached;
  const deadline=new AbortController(),combined=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  const timer=setTimeout(()=>deadline.abort(new Error('网页读取超过10秒总时限')),10000);
  let abort:()=>void=()=>{};
  let result:{url:string;html:string};
  try{
    result=await new Promise((resolve,reject)=>{
      abort=()=>reject(deadline.signal.aborted?deadline.signal.reason:new Error('网页读取已停止'));
      combined.addEventListener('abort',abort,{once:true});
      if(combined.aborted){abort();return;}
      void requestPage(url,0,combined).then(resolve,reject);
    });
  }finally{clearTimeout(timer);combined.removeEventListener('abort',abort);}
  const {document}=parseHTML(result.html);const article=new Readability(document as unknown as Document).parse();
  const content=(article?.textContent??document.body?.textContent??'').replace(/\s+/g,' ').trim().slice(0,24000);
  if(!content)throw new Error('页面没有可提取的正文');
  const meta=(name:string)=>document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute('content');
  const hit:SearchHit={title:article?.title??document.title??url,url:result.url,content,fetchedAt:new Date().toISOString(),publishedAt:parseDate(meta('article:published_time')??meta('datePublished')),updatedAt:parseDate(meta('article:modified_time')??meta('dateModified')),readCount:null,sourceType:'unknown'};
  await options.cache?.set('page',cacheKey,hit);return hit;
}
export function canonicalUrl(raw:string):string|null{try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;url.hash='';url.hostname=url.hostname.toLowerCase();for(const key of [...url.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|ref$)/i.test(key))url.searchParams.delete(key);url.searchParams.sort();if(url.pathname.length>1)url.pathname=url.pathname.replace(/\/+$/,'');return url.href;}catch{return null;}}
function parseDate(raw:unknown):string|null{if(typeof raw!=='string'&&typeof raw!=='number')return null;const value=new Date(raw);return Number.isFinite(value.getTime())&&value.getTime()<=Date.now()+86400000?value.toISOString():null;}
export function freshQuery(query:string){return /最新|今天|今日|本周|本月|近期|现在|新闻|实时|current|latest|today|this week|news|20\d\d/i.test(query);}
function queryTerms(query:string){return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*|[\u3400-\u9fff]{2,}/g)?.flatMap(term=>/^[\u3400-\u9fff]+$/.test(term)?Array.from({length:term.length-1},(_,i)=>term.slice(i,i+2)):[term]).filter(term=>!['latest','today','current','news','最新','今天','今日','现在','新闻','近期','本周','本月'].includes(term))??[])];}
export function rankSearchResults(query:string,results:any[],settings:SearchSettings=defaultSearchSettings):SearchHit[]{
  const terms=queryTerms(query),fresh=freshQuery(query),dedup=new Map<string,{hit:SearchHit;relevance:number;authority:number;date:number|null}>();
  for(const result of results.slice(0,settings.candidateLimit)){
    const url=canonicalUrl(String(result.url??''));if(!url)continue;const title=String(result.title??'').slice(0,1000),content=String(result.content??'').slice(0,24000),text=(title+' '+content).toLowerCase();
    const matched=terms.filter(term=>text.includes(term)),relevance=terms.length?matched.length/terms.length:0;
    if(relevance<.3||!matched.length)continue;
    const hostname=new URL(url).hostname.replace(/^www\./,''),authority=settings.trustedDomains.some(domain=>hostname===domain||hostname.endsWith('.'+domain))?1:0;
    const publishedAt=parseDate(result.publishedAt??result.publishedDate??result.published_date),updatedAt=parseDate(result.updatedAt??result.updatedDate??result.updated_date),date=updatedAt??publishedAt;
    const readCount=typeof result.readCount==='number'&&Number.isFinite(result.readCount)&&result.readCount>=0?result.readCount:null;
    const hit:SearchHit={title,url,content,fetchedAt:new Date().toISOString(),publishedAt,updatedAt,sourceType:authority?'official':'unknown',readCount,...(typeof result.rerank_score==='number'&&Number.isFinite(result.rerank_score)?{score:result.rerank_score}:{}),rankReason:[`相关度 ${Math.round(relevance*100)}%`,authority?'配置的可信域名':'未验证来源',date?'来源提供时间':'发布日期未知',readCount!==null?'来源提供阅读量':'阅读量未知'].join('；')};
    const old=dedup.get(url);if(old){old.hit.publishedAt??=publishedAt;old.hit.updatedAt??=updatedAt;old.hit.readCount??=readCount;if(content.length>old.hit.content.length)old.hit.content=content;old.relevance=Math.max(old.relevance,relevance);old.date=old.hit.updatedAt||old.hit.publishedAt?Date.parse(old.hit.updatedAt??old.hit.publishedAt!):null;}else dedup.set(url,{hit,relevance,authority,date:date?Date.parse(date):null});
  }
  const rangeDays={day:1,week:7,month:31,year:366,all:Infinity,auto:fresh?31:Infinity}[settings.timeRange];
  const candidates=[...dedup.values()].filter(value=>rangeDays===Infinity||value.date===null||value.date>=Date.now()-rangeDays*86400000);
  candidates.sort((a,b)=>b.authority-a.authority||(fresh||settings.timeRange!=='all'&&settings.timeRange!=='auto'?(b.date??0)-(a.date??0):0)||b.relevance-a.relevance||(b.hit.readCount??-1)-(a.hit.readCount??-1)||a.hit.url.localeCompare(b.hit.url));
  return candidates.slice(0,settings.maxResults).map(value=>value.hit);
}
export interface WebResultContext {kind:'search'|'fetch';query?:string}
export interface SearchProviderOptions {settings?:SearchSettings|(()=>Promise<SearchSettings>);cache?:AppCache;scope?:string;provider?:'searxng'|'deepseek';deepseekBaseUrl?:string;apiKey?:ApiKeySource;onResults?:(hits:SearchHit[],context:WebResultContext)=>Promise<unknown>}
export function createNetworkProvider(network:NetworkSettings,secrets:Pick<SecretStore,'get'>,options:SearchProviderOptions={}){
  return new SearchProvider(network.searxngUrl,{...options,provider:network.provider??'searxng',deepseekBaseUrl:network.deepseekBaseUrl??deepseekBaseUrl,apiKey:()=>secrets.get(deepseekSecretId)});
}
export class SearchProvider {
  constructor(private baseUrl:string,private options:SearchProviderOptions={}){}
  private deepseek(){return new DeepSeekClient(this.options.deepseekBaseUrl??deepseekBaseUrl,this.options.apiKey);}
  async fetch(url:string,signal?:AbortSignal):Promise<SearchHit>{
    const hit=await this.fetchResult(url,signal);
    if(!signal?.aborted){try{await this.options.onResults?.([hit],{kind:'fetch'});}catch{/* Archival must not turn a successful fetch into a failure. */}}
    return hit;
  }
  private async fetchResult(url:string,signal?:AbortSignal):Promise<SearchHit>{
    if(this.options.provider!=='deepseek')return fetchPage(url,signal,this.options);
    if([...url].length>8192)throw new Error('网页地址不能超过 8192 个字符');
    return withNetworkDeadline(10000,signal,async combined=>{
      const {url:parsed}=await validatePublicUrl(url);combined.throwIfAborted();
      if(parsed.href.length>8192)throw new Error('编码后的网页地址不能超过 8192 个字符');
      const key={content:JSON.stringify({url:parsed.href,endpoint:this.options.deepseekBaseUrl??deepseekBaseUrl}),scope:this.options.scope??'global',version:'deepseek-page-v1'};
      const cached=await this.options.cache?.get<SearchHit>('page',key);combined.throwIfAborted();if(cached)return cached;
      const payload=await this.deepseek().post('fetch',{url:parsed.href},combined);
      if(!payload||typeof payload.title!=='string'||typeof payload.content!=='string')throw new Error('DeepSeek 网页返回格式无效');
      if(!payload.content.trim())throw new Error('页面没有可提取的正文');
      const hit:SearchHit={title:payload.title||parsed.href,url:parsed.href,content:payload.content.slice(0,24000),fetchedAt:new Date().toISOString(),publishedAt:null,updatedAt:null,readCount:null,sourceType:'unknown'};
      await this.options.cache?.set('page',key,hit);return hit;
    });
  }
  async search(query:string,signal?:AbortSignal):Promise<SearchHit[]>{
    const hits=await this.searchResults(query,signal);
    if(!signal?.aborted){try{await this.options.onResults?.(hits,{kind:'search',query});}catch{/* The knowledge service logs storage failures separately. */}}
    return hits;
  }
  private async searchResults(query:string,signal?:AbortSignal):Promise<SearchHit[]>{
    if(signal?.aborted)throw new Error('搜索已停止');
    if(this.options.provider==='deepseek')validateDeepSeekQuery(query);
    const settings=validateSearchSettings(typeof this.options.settings==='function'?await this.options.settings():this.options.settings??defaultSearchSettings);
    const key={content:JSON.stringify({query,settings,provider:this.options.provider??'searxng',endpoint:this.options.provider==='deepseek'?this.options.deepseekBaseUrl??deepseekBaseUrl:this.baseUrl}),scope:this.options.scope??'global',version:'search-v3'};
    const cached=await this.options.cache?.get<SearchHit[]>('search',key);if(cached)return cached;
    if(this.options.provider==='deepseek'){
      const days={day:1,week:7,month:31,year:366,all:Infinity,auto:freshQuery(query)?31:Infinity}[settings.timeRange];
      const after=days===Infinity?'':` after:${new Date(Date.now()-days*86400000).toISOString().slice(0,10)}`;
      const filteredQuery=[...query+after].length<=128&&!/\b(after|before):/i.test(query)?query+after:query;
      const payload=await withNetworkDeadline(12000,signal,combined=>this.deepseek().post('search',{query:filteredQuery,count:Math.min(50,settings.candidateLimit),need_content:false},combined));
      if(!payload||!Array.isArray(payload.results)||payload.results.some((r:any)=>!r||typeof r.title!=='string'||typeof r.url!=='string'||typeof r.summary!=='string'))throw new Error('DeepSeek 搜索返回格式无效');
      const relevanceQuery=query.replace(/(?:^|\s)(?:-?site:|lang:|after:|before:)\S+|(?:^|\s)-(?:"[^"]*"|\S+)|\bOR\b/g,' ').trim();
      const hits=rankSearchResults(relevanceQuery||query,payload.results.map((r:any)=>({...r,content:r.summary||r.snippet||r.content||'',publishedAt:r.date})),settings);
      await this.options.cache?.set('search',key,hits,freshQuery(query)?60:600);return hits;
    }
    const url=new URL('/search',this.baseUrl);url.searchParams.set('q',query);url.searchParams.set('format','json');url.searchParams.set('language','zh-CN');
    const range=settings.timeRange==='auto'?(freshQuery(query)?'month':null):settings.timeRange==='all'?null:settings.timeRange;
    // SearXNG supports day/month/year. A week request is narrowed locally after fetching a month.
    if(range)url.searchParams.set('time_range',range==='week'?'month':range);
    const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});if(!response.ok)throw new Error('搜索服务不可用（HTTP '+response.status+'），请确认启用了JSON输出');
    const payload=await response.json() as any;if(!Array.isArray(payload.results))throw new Error('搜索服务返回格式无效');const hits=rankSearchResults(query,payload.results,settings);
    await this.options.cache?.set('search',key,hits,freshQuery(query)?60:600);return hits;
  }
}
