/** 缓存是可丢失的加速层，不能作为发送或身份确认依据。键按用途和作用域隔离，Redis 不可用时由调用方处理降级。 */
import {createHash} from 'node:crypto';
import {Redis} from 'ioredis';

export type CacheKind='search'|'page'|'embedding';
export interface CacheKey {content:string;scope:string;model?:string;version?:string|number}
interface CacheClient {get(key:string):Promise<string|null>;set(key:string,value:string,...args:any[]):Promise<unknown>;del(key:string):Promise<unknown>;quit?():Promise<unknown>}
export interface CacheOptions {redisUrl?:string;prefix?:string;client?:CacheClient}
export const cacheTTL={search:600,page:3600,embedding:30*86400} as const;
export class AppCache {
  private client?:CacheClient;private owned=false;
  private metrics=Object.fromEntries((['search','page','embedding'] as const).map(k=>[k,{hits:0,misses:0,expired:0,errors:0}])) as Record<CacheKind,{hits:number;misses:number;expired:number;errors:number}>;
  constructor(private options:CacheOptions={}){this.client=options.client;}
  private connection(){
    if(!this.client&&this.options.redisUrl){const client=new Redis(this.options.redisUrl,{lazyConnect:true,connectTimeout:500,maxRetriesPerRequest:0,enableOfflineQueue:false,retryStrategy:()=>null});client.on('error',()=>{});void client.connect().catch(()=>{});this.client=client;this.owned=true;}
    return this.client;
  }
  key(kind:CacheKind,key:CacheKey){if(!key.scope)throw new Error('缓存必须指定作用域');return (this.options.prefix??'liino')+':cache:'+kind+':'+createHash('sha256').update(JSON.stringify([key.scope,key.model??'',key.version??'',key.content])).digest('hex');}
  async get<T>(kind:CacheKind,key:CacheKey):Promise<T|null>{
    const stats=this.metrics[kind];try{const client=this.connection();if(!client){stats.misses++;return null;}const value=await client.get(this.key(kind,key));if(!value){stats.misses++;return null;}
      const item=JSON.parse(value);if(!Number.isFinite(item.expiresAt)||item.expiresAt<=Date.now()){stats.expired++;stats.misses++;await client.del(this.key(kind,key));return null;}stats.hits++;return item.value as T;
    }catch{stats.errors++;stats.misses++;return null;}
  }
  async set<T>(kind:CacheKind,key:CacheKey,value:T,ttl:number=cacheTTL[kind]){try{const seconds=Number.isFinite(ttl)?Math.max(1,Math.min(cacheTTL[kind],Math.floor(ttl))):cacheTTL[kind];
    // A bounded stale retention window lets us count observed expirations. get() always enforces
    // the exact logical TTL, and Redis removes an unobserved stale entry after at most one hour.
    await this.connection()?.set(this.key(kind,key),JSON.stringify({expiresAt:Date.now()+seconds*1000,value}),'EX',seconds+Math.min(seconds,3600));}catch{this.metrics[kind].errors++;}}
  async invalidate(kind:CacheKind,key:CacheKey){try{await this.connection()?.del(this.key(kind,key));}catch{this.metrics[kind].errors++;}}
  stats(){return structuredClone(this.metrics);}
  async close(){if(this.owned&&this.client){try{await this.client.quit?.();}catch{}this.client=undefined;}}
}
