import {describe,it,expect,vi} from 'vitest';
import {normalizeUsage,aggregateUsage,estimateCost} from '../apps/server/usage.js';
import {AppCache} from '../apps/server/cache.js';
import {rankSearchResults} from '../apps/server/network.js';

describe('provider usage accounting',()=>{
  it('preserves absent fields while retaining genuinely reported zero',()=>{
    expect(normalizeUsage(undefined).output).toBeNull();
    expect(normalizeUsage({prompt_tokens:0,completion_tokens:0,total_tokens:0}).output).toBe(0);
    expect(normalizeUsage({prompt_tokens:0}).cacheRead).toBeNull();
  });
  it('maps cached input and keeps reasoning within output',()=>{
    const value=normalizeUsage({prompt_tokens:100,completion_tokens:30,prompt_tokens_details:{cached_tokens:40},completion_tokens_details:{reasoning_tokens:10},total_tokens:130});
    expect(value).toMatchObject({uncachedInput:60,cacheRead:40,cacheWrite:0,inputTotal:100,output:30,reasoning:10,total:130});
    expect(aggregateUsage([value,value]).total).toBe(260);
    expect(estimateCost(value,{inputPerMillion:2,outputPerMillion:10,cacheReadPerMillion:1,currency:'CNY'}).cost).toBeCloseTo(.00046);
    expect(estimateCost(value).cost).toBeNull();
  });
  it('maps anthropic and google usage without double counting cache or reasoning',()=>{
    expect(normalizeUsage({input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:7},'anthropic')).toMatchObject({inputTotal:35,total:42});
    expect(normalizeUsage({promptTokenCount:100,cachedContentTokenCount:40,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130},'google')).toMatchObject({uncachedInput:60,output:30,reasoning:10,total:130});
  });
});

describe('app cache',()=>{
  function fixture(){const values=new Map<string,string>();return {get:vi.fn(async(k:string)=>values.get(k)??null),set:vi.fn(async(k:string,v:string)=>{values.set(k,v);return 'OK';}),del:vi.fn(async(k:string)=>Number(values.delete(k))),quit:vi.fn(async()=> 'OK')};}
  it('isolates scopes and versions, expires and invalidates',async()=>{
    const client=fixture(),cache=new AppCache({client,prefix:'fixture'});
    const key={content:'private query',scope:'chat:a',model:'m',version:1};
    await cache.set('embedding',key,[1,2],1);
    expect(await cache.get('embedding',key)).toEqual([1,2]);
    expect(await cache.get('embedding',{...key,scope:'chat:b'})).toBeNull();
    expect(await cache.get('embedding',{...key,version:2})).toBeNull();
    await cache.invalidate('embedding',key);expect(await cache.get('embedding',key)).toBeNull();
    await cache.set('search',key,[],1);vi.spyOn(Date,'now').mockReturnValue(Date.now()+2000);
    try{expect(await cache.get('search',key)).toBeNull();expect(cache.stats().search.expired).toBe(1);}finally{vi.restoreAllMocks();}
    await cache.close();
  });
  it('degrades safely on cache failures',async()=>{
    const cache=new AppCache({client:{...fixture(),get:async()=>{throw new Error('offline');}}});
    expect(await cache.get('page',{content:'url',scope:'global'})).toBeNull();expect(cache.stats().page.errors).toBe(1);
  });
});

describe('search ranking',()=>{
  it('gates relevance, trusts configured domains and merges canonical duplicates',()=>{
    const hits=rankSearchResults('widget API latest',[
      {title:'Unrelated celebrity',url:'https://popular.example/a',content:'gossip',readCount:100000000},
      {title:'widget API',url:'https://docs.example/api?utm_source=x',content:'widget API reference',publishedDate:new Date().toISOString()},
      {title:'widget API duplicated',url:'https://docs.example/api',content:'widget API official reference'},
      {title:'widget API',url:'https://blog.example/a',content:'widget API',score:100000},
    ],{trustedDomains:['docs.example'],timeRange:'auto',maxResults:6,candidateLimit:30});
    expect(hits).toHaveLength(2);expect(hits[0].sourceType).toBe('official');expect(hits[0].url).toBe('https://docs.example/api');
    expect(hits[1].publishedAt).toBeNull();expect(hits[1].readCount).toBeNull();
  });
});
