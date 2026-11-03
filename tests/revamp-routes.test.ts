import Fastify,{type FastifyInstance,type HTTPMethods} from 'fastify';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {z} from 'zod';
import {Database} from '../apps/server/db.js';
import {MemoryManager} from '../apps/server/memory-management.js';
import {MembersService} from '../apps/server/members.js';
import {CommunityService} from '../apps/server/community.js';
import {MediaService} from '../apps/server/media.js';
import {UsageStore,normalizeUsage} from '../apps/server/usage.js';
import {AppCache} from '../apps/server/cache.js';
import type {ModelGateway,RunInput} from '../apps/server/models.js';
import type {SecretStore} from '../apps/server/secrets.js';
import {registerRevampRoutes,type RevampRouteServices} from '../apps/server/revamp-routes.js';

const headers={'x-test-session':'isolated-fixture-session'};
const png='iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP0LNvCAAZMEIqBgQEAGecBd35E2xsAAAAASUVORK5CYII=';
function testApp(services:RevampRouteServices){
  const app=Fastify({logger:false,bodyLimit:8_000_000});
  // The production parent supplies authentication; this fixture verifies that registration inherits its scope.
  app.addHook('onRequest',async(request,reply)=>{if(request.headers['x-test-session']!==headers['x-test-session'])return reply.code(401).send({message:'fixture authentication required'});});
  app.setErrorHandler((error:any,_request,reply)=>reply.code(error instanceof z.ZodError?400:error.statusCode??500).send({message:error instanceof z.ZodError?error.issues.map((issue:any)=>issue.message).join('；'):error.message}));
  registerRevampRoutes(app,services);return app;
}

describe('revamp route boundary validation',()=>{
  let app:FastifyInstance;
  beforeAll(()=>{app=testApp({db:{},memory:{},members:{},community:{},media:{},usage:{},cache:{stats:()=>({search:{hits:0,misses:0,expired:0,errors:0}})},changed:vi.fn()} as unknown as RevampRouteServices);});
  afterAll(async()=>{await app.close();});
  it('inherits authentication for reads, uploads and deletion',async()=>{
    for(const [method,url,payload] of [['GET','/api/cache/stats',undefined],['POST','/api/media-assets',{name:'fixture',kind:'image'}],['POST','/api/memories/bulk-delete',{token:'a'.repeat(64),includePinned:true}]] as const){
      const response=await app.inject({method,url,payload});expect(response.statusCode).toBe(401);
    }
    expect((await app.inject({method:'GET',url:'/api/cache/stats',headers})).json().search.hits).toBe(0);
  });
  it('rejects malformed IDs, unbounded pages, invalid dates and unknown body fields before services',async()=>{
    const id=randomUUID();
    const cases:{method:HTTPMethods;url:string;payload?:unknown}[]=[
      {method:'GET',url:'/api/memories/not-a-uuid'},
      {method:'GET',url:'/api/media-assets?pageSize=500'},
      {method:'GET',url:'/api/usage/calls?page=0'},
      {method:'GET',url:'/api/usage/summary?from=invalid'},
      {method:'GET',url:'/api/usage/summary?from=2026-10-28&to=2026-10-27'},
      {method:'POST',url:'/api/memories/selection',payload:{ids:[id],filters:{}}},
      {method:'POST',url:'/api/memories/selection',payload:{filters:{visibility:''}}},
      {method:'PATCH',url:`/api/chats/${id}/members/${id}`,payload:{identityStatus:'verified'}},
      {method:'POST',url:'/api/media-assets',payload:{name:'path',kind:'image',filePath:'C:/private/secret.png'}},
      {method:'POST',url:'/api/media-assets',payload:{name:'position',kind:'native-sticker',nativeRef:{index:2}}},
      {method:'POST',url:'/api/memories/bulk-delete',payload:{token:'a'.repeat(64)}},
      {method:'PUT',url:'/api/mode-settings',payload:{jeropsPrompt:null,planPrompt:null}},
      {method:'POST',url:`/api/media-assets/${id}/tag`,payload:{prompt:'ignore source'}},
    ];
    for(const test of cases){const response=await app.inject({...test,payload:test.payload as any,headers});expect(response.statusCode,`${test.method} ${test.url}: ${response.body}`).toBe(400);expect(response.body).not.toContain('C:/private/secret.png');}
  });
  it('exposes no identity self-certification or direct mode-command route',async()=>{
    const id=randomUUID();for(const url of [`/api/chats/${id}/identity-binding`,`/api/chats/${id}/members/${id}/verify`,`/api/chats/${id}/members/${id}/mode`])expect((await app.inject({method:'POST',url,payload:{verified:true},headers})).statusCode).toBe(404);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('isolated revamp route integration',()=>{
  let app:FastifyInstance,admin:Database,db:Database,cache:AppCache,usage:UsageStore,media:MediaService,members:MembersService;
  let schema:string,directory:string,chatId:string,otherChatId:string,memberId:string,secondMemberId:string,unknownMemberId:string,modelId:string;
  const runs:RunInput[]=[],changed=vi.fn();
  beforeAll(async()=>{
    const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Requires isolated liino_test');
    schema='revamp_routes_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();
    directory=await mkdtemp(join(tmpdir(),'liino-revamp-routes-'));cache=new AppCache();usage=new UsageStore(db,cache);members=new MembersService(db);
    const gateway={run:async(input:RunInput)=>{runs.push(input);return {text:'{"emotion":["开心"],"scene":["欢迎"],"intensity":["轻"]}',usage:{}};}} as unknown as ModelGateway;
    media=new MediaService(db,directory,gateway,{get:async()=>undefined} as unknown as SecretStore,changed);
    const community=new CommunityService(db,{randomInt:max=>max-1});
    app=testApp({db,memory:new MemoryManager(db),members,community,media,usage,cache,changed});
    chatId=(await db.createChat({name:'路由隔离群',bindingKey:randomUUID()})).id;otherChatId=(await db.createChat({name:'其他隔离群',bindingKey:randomUUID()})).id;
    memberId=randomUUID();secondMemberId=randomUUID();unknownMemberId=randomUUID();
    for(const [index,id] of [memberId,secondMemberId,unknownMemberId].entries())await db.query('INSERT INTO members(id,chat_id,number,sender_key,nickname,identity_status) VALUES($1,$2,$3,$4,$5,$6)',[id,chatId,index+1,'fixture-internal-sender-'+index,'成员'+(index+1),index===2?'unknown':'verified']);
    modelId=randomUUID();await db.query('INSERT INTO models(id,config) VALUES($1,$2)',[modelId,{id:modelId,name:'fixture vision',model:'fixture',baseUrl:'http://fixture.invalid',protocol:'openai-compatible',contextWindow:32768,supportsTools:false,supportsVision:true}]);await db.updateSettings(value=>({...value,chatModelId:modelId}));
  },30000);
  afterAll(async()=>{
    await app?.close();await cache?.close();await db?.close();
    if(admin){if(!/^revamp_routes_[a-f0-9]{32}$/.test(schema))throw new Error('Unexpected schema');await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
    if(directory){const path=resolve(directory),base=resolve(tmpdir()),part=relative(base,path);if(!part||part.startsWith('..')||isAbsolute(part)||!part.startsWith('liino-revamp-routes-'))throw new Error('Unsafe test directory cleanup');await rm(path,{recursive:true,force:true});}
  });
  const request=(method:HTTPMethods,url:string,payload?:unknown)=>app.inject({method,url,payload:payload as any,headers});

  it('freezes actual filtered memory IDs and pinned consent while excluding later records',async()=>{
    const marker='route-memory-'+randomUUID(),first=await db.saveMemory({content:marker,category:'事实',pinned:true}),second=await db.saveMemory({content:marker,category:'事实'});
    const freeze=await request('POST','/api/memories/selection',{filters:{q:marker,visibility:'global'}});expect(freeze.statusCode).toBe(200);
    const selection=freeze.json();expect(selection).toMatchObject({count:2,pinnedCount:1});
    const later=await db.saveMemory({content:marker,category:'事实'});
    expect((await request('POST','/api/memories/bulk-delete',{token:selection.token,includePinned:false})).statusCode).toBe(409);
    const removed=await request('POST','/api/memories/bulk-delete',{token:selection.token,includePinned:true});expect(removed.json()).toEqual({deletedCount:2});
    expect((await request('GET',`/api/memories/${first.id}`)).statusCode).toBe(404);expect((await request('GET',`/api/memories/${second.id}`)).statusCode).toBe(404);
    expect((await request('GET',`/api/memories/${later.id}`)).json()).toMatchObject({id:later.id,visibility:'global',sourceMessages:[]});
  });
  it('returns real same-source memory evidence without message raw identity payloads',async()=>{
    const messageId=await db.ingest({eventId:randomUUID(),chatId,accountId:'fixture',content:'真实路由测试依据',observedAt:new Date().toISOString(),type:'text',isSelf:false,mentioned:false});
    const entry=await db.saveMemory({content:'有来源的测试记忆',category:'事实',visibility:'chat',scopeChatId:chatId,sourceChatId:chatId,sourceMessageIds:[messageId!]});
    const response=await request('GET',`/api/memories/${entry.id}`);expect(response.statusCode).toBe(200);expect(response.json().sourceMessages[0]).toMatchObject({id:messageId,content:'真实路由测试依据'});expect(response.body).not.toContain('accountId');
  });
  it('edits bounded profiles and returns safe version snapshots with the frontend timestamp key',async()=>{
    const list=await request('GET',`/api/chats/${chatId}/members?pageSize=20&q=成员`);expect(list.json()).toMatchObject({total:3,page:1,pageSize:20});
    const edit=await request('PATCH',`/api/chats/${chatId}/members/${memberId}`,{profile:{summary:'实际维护的画像',interests:['阅读'],preferences:['简洁'],communication:'自然'},pinned:true});expect(edit.statusCode).toBe(200);expect(edit.json().profile.summary).toBe('实际维护的画像');
    const history=await request('GET',`/api/chats/${chatId}/members/${memberId}/versions`);expect(history.json()[0]).toHaveProperty('created_at');expect(history.body).not.toContain('sender_key');expect(history.body).not.toContain('fixture-internal-sender');
    expect((await request('GET',`/api/chats/${otherChatId}/members/${memberId}`)).statusCode).toBe(404);
  });
  it('limits plan grants to at most two verified same-chat members and preserves real mode overrides',async()=>{
    expect((await request('PUT',`/api/chats/${chatId}/plan-members`,{memberIds:[memberId,secondMemberId,unknownMemberId]})).statusCode).toBe(400);
    expect((await request('PUT',`/api/chats/${chatId}/plan-members`,{memberIds:[unknownMemberId]})).statusCode).toBe(400);
    expect((await request('PUT',`/api/chats/${otherChatId}/plan-members`,{memberIds:[memberId]})).statusCode).toBe(400);
    expect((await request('PUT',`/api/chats/${chatId}/plan-members`,{memberIds:[memberId,secondMemberId]})).json().memberIds).toEqual([memberId,secondMemberId]);
    expect((await request('PUT','/api/mode-settings',{jeropsPrompt:'全局特殊提示',planPrompt:'全局计划提示'})).statusCode).toBe(200);
    const group=await request('PUT','/api/mode-settings',{chatId,jeropsPrompt:'本群特殊提示',planPrompt:null});expect(group.json()).toEqual({jeropsPrompt:'本群特殊提示',planPrompt:'全局计划提示',overrides:{jeropsPrompt:'本群特殊提示',planPrompt:null}});
    expect((await members.modeCommand(chatId,memberId,'jerops')).ok).toBe(true);expect((await request('POST',`/api/chats/${chatId}/members/${memberId}/reset-mode`,{})).json().mode).toBe('normal');
  });
  it('uploads validated actual media, streams bytes without paths and protects manual tags',async()=>{
    const uploaded=await request('POST','/api/media-assets',{name:'真实图片',kind:'image',mimeType:'image/png',data:png});expect(uploaded.statusCode,uploaded.body).toBe(200);const asset=uploaded.json();expect(asset.manualTags).toBe(false);expect(uploaded.body).not.toContain(directory);expect(uploaded.body).not.toContain('file_path');
    const content=await request('GET',asset.url);expect(content.headers['content-type']).toContain('image/png');expect(content.headers['x-content-type-options']).toBe('nosniff');expect(content.rawPayload.subarray(0,8)).toEqual(Buffer.from('89504e470d0a1a0a','hex'));
    const tagged=await request('POST',`/api/media-assets/${asset.id}/tag`,{});expect(tagged.statusCode,tagged.body).toBe(200);expect(runs.at(-1)?.images?.[0].data).toBe(png);
    expect((await request('PATCH',`/api/media-assets/${asset.id}`,{tags:{emotion:['人工'],scene:[],intensity:[]},manualTags:true})).statusCode).toBe(200);
    expect((await request('POST',`/api/media-assets/${asset.id}/tag`,{})).statusCode).toBe(409);
    const list=await request('GET','/api/media-assets?page=1&pageSize=20&kind=image');expect(list.json().items.some((item:any)=>item.id===asset.id)).toBe(true);
    expect((await request('DELETE',`/api/media-assets/${asset.id}`)).statusCode).toBe(200);expect((await request('GET',asset.url)).statusCode).toBe(404);
  },30000);
  it('registers native metadata without pretending send or preview support',async()=>{
    const response=await request('POST','/api/media-assets',{name:'原生表情',kind:'native-sticker',nativeRef:{id:'fixture-native-stable',hash:'f'.repeat(64)}});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({url:null,status:'unverified',capability:{verified:false,send:false,nativeSend:false}});
    expect((await request('GET',`/api/media-assets/${response.json().id}/content`)).statusCode).toBe(400);
    await db.query('UPDATE media_assets SET file_path=$2,mime_type=$3 WHERE id=$1',[response.json().id,'media/'+randomUUID()+'.png','image/png']);
    const missing=await request('GET',`/api/media-assets/${response.json().id}/content`);expect(missing.statusCode).toBe(404);expect(missing.body).not.toContain(directory);expect(missing.body).not.toContain('ENOENT');
  });
  it('maintains group food selections and renders a real preview without sends or official draw writes',async()=>{
    const a=await request('POST','/api/foods',{name:'米饭',category:'',imageAssetId:null}),b=await request('POST','/api/foods',{name:'面条'});expect(a.statusCode,a.body).toBe(200);expect(b.statusCode,b.body).toBe(200);
    const imageId=(await db.query("SELECT id FROM media_assets WHERE kind='image' AND file_path IS NOT NULL ORDER BY created_at LIMIT 1")).rows[0].id;
    await media.update(imageId,{enabled:true});
    const linked=await request('PATCH',`/api/foods/${a.json().id}`,{imageAssetId:imageId});expect(linked.statusCode,linked.body).toBe(200);expect(linked.json()).toMatchObject({imageAssetId:imageId,imageUrl:`/api/media-assets/${imageId}/content`});
    expect((await request('PATCH',`/api/foods/${a.json().id}`,{description:'新的真实说明'})).json().name).toBe('米饭');
    expect((await request('GET','/api/foods?pageSize=20')).json()).toMatchObject({page:1,pageSize:20,total:2});
    expect((await request('PUT',`/api/chats/${chatId}/foods`,{foodIds:[a.json().id,b.json().id]})).statusCode).toBe(200);
    expect((await request('GET',`/api/chats/${otherChatId}/foods`)).json().foodIds).toEqual([]);
    const before=(await db.query('SELECT (SELECT count(*) FROM sends)::int sends,(SELECT count(*) FROM food_draws)::int draws')).rows[0];
    const preview=await request('POST','/api/foods/preview',{chatId});expect(preview.statusCode,preview.body).toBe(200);expect(preview.json().candidates).toHaveLength(2);expect((await request('GET',preview.json().imageUrl)).headers['content-type']).toContain('image/png');
    expect((await db.query('SELECT (SELECT count(*) FROM sends)::int sends,(SELECT count(*) FROM food_draws)::int draws')).rows[0]).toEqual(before);
    expect((await request('DELETE',`/api/foods/${a.json().id}`)).statusCode).toBe(200);expect((await request('GET',`/api/chats/${chatId}/foods`)).json().foodIds).toEqual([b.json().id]);
  },30000);
  it('returns actual unknown telemetry, complete run rounds and zero application cache counters',async()=>{
    const common={runId:randomUUID(),modelId,modelName:'fixture',protocol:'openai-compatible',purpose:'preview',chatId,round:1,attempt:1,status:'success',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),pricing:null,cost:null,currency:null};
    const first=await usage.record({...common,usage:normalizeUsage(undefined)});await usage.record({...common,round:2,usage:normalizeUsage({prompt_tokens:50,completion_tokens:8,prompt_tokens_details:{cached_tokens:10}})});
    const summary=await request('GET',`/api/usage/summary?chatId=${chatId}`);expect(summary.json()).toMatchObject({calls:2,knownCounts:{inputTotal:1},usage:{inputTotal:50},costs:[{currency:null,cost:null,knownCalls:0}]});
    expect((await request('GET',`/api/usage/calls?pageSize=20&chatId=${chatId}`)).json().items).toHaveLength(2);
    const detail=await request('GET',`/api/usage/calls/${first}`);expect(detail.json().usage.inputTotal).toBeNull();expect(detail.json().rounds).toHaveLength(2);expect(detail.json().runCost).toBeNull();
    expect((await request('GET','/api/cache/stats')).json().search).toEqual({hits:0,misses:0,expired:0,errors:0});expect((await request('GET',`/api/usage/calls/${randomUUID()}`)).statusCode).toBe(404);
  });
  it('validates and persists ranking controls without treating fetched dates as publication dates',async()=>{
    const response=await request('PUT','/api/search-settings',{trustedDomains:['example.com'],timeRange:'week'});expect(response.statusCode,response.body).toBe(200);expect((await request('GET','/api/search-settings')).json()).toMatchObject({trustedDomains:['example.com'],timeRange:'week'});
    expect((await request('PUT','/api/search-settings',{trustedDomains:['http://127.0.0.1/private'],timeRange:'all'})).statusCode).toBe(400);expect((await request('PUT','/api/search-settings',{trustedDomains:[],timeRange:'invalid'})).statusCode).toBe(400);
  });
});
