import { beforeAll,afterAll,describe,expect,it,vi } from 'vitest';
import { createApp } from '../apps/server/app.js';
import { Database } from '../apps/server/db.js';
import { randomUUID } from 'node:crypto';

describe.skipIf(!process.env.TEST_DATABASE_URL)('local authenticated configuration API',()=>{
  let runtime:Awaited<ReturnType<typeof createApp>>,cookie:string;
  beforeAll(async()=>{
    const db=new Database(process.env.TEST_DATABASE_URL!);await db.migrate();await db.query('DELETE FROM sessions');await db.query('DELETE FROM admins');await db.close();
    runtime=await createApp({databaseUrl:process.env.TEST_DATABASE_URL!,dataDir:'artifacts/api-test-'+randomUUID(),startWorkers:false,bridgeToken:'test-bridge-token-abcdefghijklmnopqrstuvwxyz'});
  });
  afterAll(async()=>{await runtime.app.close();});
  it('requires setup, rejects weak passwords and authenticates a session',async()=>{
    expect((await runtime.app.inject({method:'GET',url:'/api/settings'})).statusCode).toBe(401);
    expect((await runtime.app.inject({method:'POST',url:'/api/setup',payload:{password:'short'}})).statusCode).toBe(400);
    const response=await runtime.app.inject({method:'POST',url:'/api/setup',payload:{password:'test-password-very-long'}});expect(response.statusCode).toBe(200);cookie=response.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
    expect((await runtime.app.inject({method:'POST',url:'/api/setup',payload:{password:'another-long-password'}})).statusCode).toBe(409);
  });
  it('rejects cross-origin mutations and masks model credentials',async()=>{
    expect((await runtime.app.inject({method:'PUT',url:'/api/settings',headers:{cookie,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
    const response=await runtime.app.inject({method:'POST',url:'/api/models',headers:{cookie},payload:{name:'fixture',protocol:'openai-compatible',model:'test',baseUrl:'http://127.0.0.1:11434/v1',contextWindow:32768,supportsTools:false,apiKey:'never-return-this-secret'}});
    expect(response.statusCode).toBe(200);expect(response.body).not.toContain('never-return-this-secret');
    const list=await runtime.app.inject({method:'GET',url:'/api/models',headers:{cookie}});expect(list.body).not.toContain('never-return-this-secret');expect(list.json().some((m:any)=>m.hasApiKey)).toBe(true);
  });
  it('does not verify or activate an untested group',async()=>{
    const response=await runtime.app.inject({method:'POST',url:'/api/chats',headers:{cookie},payload:{name:'api-'+randomUUID()}});expect(response.statusCode).toBe(200);
    const verify=await runtime.app.inject({method:'POST',url:`/api/chats/${response.json().id}/verify`,headers:{cookie},payload:{}});expect(verify.statusCode).toBe(409);
  });
  it('stores network credentials outside settings, masks them and clears them explicitly',async()=>{
    const original=await runtime.db.settings();
    const update=(network:any)=>runtime.app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:{...original,network}});
    try{
      const saved=await update({...original.network,provider:'deepseek',enabled:true,apiKey:'fixture-network-secret'});
      expect(saved.statusCode,saved.body).toBe(200);expect(saved.body).not.toContain('fixture-network-secret');
      expect(saved.json().network).toMatchObject({provider:'deepseek',hasApiKey:true});
      expect((await runtime.db.settings()).network).not.toHaveProperty('apiKey');
      const listed=await runtime.app.inject({method:'GET',url:'/api/bootstrap',headers:{cookie}});
      expect(listed.body).not.toContain('fixture-network-secret');
      expect((await update({...saved.json().network,apiKey:''})).json().network.hasApiKey).toBe(true);
      const cleared=await update({...saved.json().network,enabled:false,clearApiKey:true});
      expect(cleared.statusCode).toBe(200);expect(cleared.json().network.hasApiKey).toBe(false);
      expect((await update({...saved.json().network,clearApiKey:true})).statusCode).toBe(400);
      const old=await update({enabled:false,searxngUrl:original.network.searxngUrl});
      expect(old.json().network.provider).toBe('searxng');
      expect((await runtime.app.inject({method:'POST',url:'/api/network/fetch',headers:{cookie},payload:{url:'https://example.com'}})).statusCode).toBe(500);
    }finally{await runtime.secrets.set('network:deepseek','');await runtime.db.saveSettings(original);}
  });
  it('reports observation and delivery independently in task logs',async()=>{
    const chat=await runtime.db.createChat({name:'日志-'+randomUUID(),bindingKey:randomUUID()});
    const messageId=await runtime.db.ingest({eventId:randomUUID(),chatId:chat.id,accountId:'fixture',content:'暂停期间的@',mentioned:true,isSelf:false,type:'text',observedAt:new Date().toISOString()});
    await runtime.db.query("UPDATE messages SET state='observed' WHERE id=$1",[messageId]);
    const task=(await runtime.db.query("SELECT id FROM outbox WHERE payload->>'messageId'=$1",[messageId])).rows[0];
    await runtime.db.query("UPDATE tasks SET state='completed',result=$2 WHERE id=$1",[task.id,{status:'skipped',reason:'全局暂停'}]);
    const logs=(await runtime.app.inject({method:'GET',url:'/api/tasks',headers:{cookie}})).json().items;
    expect(logs.find((t:any)=>t.id===task.id)).toMatchObject({observation_state:'observed',delivery_status:null,result:{status:'skipped',reason:'全局暂停'}});
  });
  it('records a manually confirmed unknown send once, rejecting duplicate resolution',async()=>{
    const chat=await runtime.db.createChat({name:'核查-'+randomUUID(),bindingKey:randomUUID()}),id=randomUUID();
    await runtime.db.query("INSERT INTO sends(id,chat_id,content,kind,epoch,status) VALUES($1,$2,'核查后的回复','explicit',0,'unknown')",[id,chat.id]);
    const response=await runtime.app.inject({method:'POST',url:`/api/sends/${id}/resolve`,headers:{cookie},payload:{action:'sent'}});expect(response.statusCode).toBe(200);
    expect((await runtime.db.query('SELECT count(*)::int n FROM messages WHERE event_id=$1',['sent-'+id])).rows[0].n).toBe(1);
    expect((await runtime.app.inject({method:'POST',url:`/api/sends/${id}/resolve`,headers:{cookie},payload:{action:'sent'}})).statusCode).toBe(409);
  });
  it('preserves image content and associations when manually retrying an unknown delivery',async()=>{
    const chat=await runtime.db.createChat({name:'图片重试-'+randomUUID(),bindingKey:randomUUID()});
    const originalId=randomUUID(),parentId=randomUUID(),assetId=randomUUID(),memberId=randomUUID();
    await runtime.db.query("INSERT INTO members(id,chat_id,number,sender_key,nickname) VALUES($1,$2,1,$3,'图片测试者')",[memberId,chat.id,'ui-profile:'+randomUUID()]);
    await runtime.db.query("INSERT INTO media_assets(id,name,kind,mime_type) VALUES($1,'图片夹具','image','image/png')",[assetId]);
    await runtime.db.query("INSERT INTO sends(id,chat_id,content,kind,epoch,status) VALUES($1,$2,'已发送的父消息','explicit',0,'sent')",[parentId,chat.id]);
    await runtime.db.query("INSERT INTO sends(id,chat_id,content,kind,epoch,status,content_kind,asset_id,parent_id,actor_member_id) VALUES($1,$2,'[场景表情]','sticker',0,'unknown','image',$3,$4,$5)",[originalId,chat.id,assetId,parentId,memberId]);
    const response=await runtime.app.inject({method:'POST',url:`/api/sends/${originalId}/resolve`,headers:{cookie},payload:{action:'retry'}});
    expect(response.statusCode,response.body).toBe(200);
    const retries=(await runtime.db.query('SELECT * FROM sends WHERE chat_id=$1 AND id<>$2 AND id<>$3',[chat.id,originalId,parentId])).rows;
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({content_kind:'image',asset_id:assetId,parent_id:parentId,actor_member_id:memberId,kind:'sticker',status:'pending'});
    expect((await runtime.db.query('SELECT status FROM sends WHERE id=$1',[originalId])).rows[0].status).toBe('cancelled');
    expect((await runtime.db.query("SELECT id FROM outbox WHERE kind='send' AND payload->>'sendId'=$1",[retries[0].id])).rowCount).toBe(1);
  });
  it('rejects a nonvisual model for the image recognition role',async()=>{
    const id=randomUUID(),settings=await runtime.db.settings();
    await runtime.db.query('INSERT INTO models(id,config) VALUES($1,$2)',[id,{id,name:'text-only',model:'fixture',protocol:'openai-compatible',baseUrl:'http://fixture.invalid',supportsVision:false}]);
    const response=await runtime.app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:{...settings,visionModelId:id}});
    expect(response.statusCode).toBe(400);
    expect((await runtime.db.settings()).visionModelId??'').toBe(settings.visionModelId??'');
  });
  it('rejects unauthenticated bridge attachment uploads before accepting data',async()=>{
    const response=await runtime.app.inject({method:'POST',url:'/bridge/attachments',payload:{}});
    expect(response.statusCode).toBe(401);
  });
  it('allocates distinct embedding versions for overlapping configuration changes',async()=>{
    const original=await runtime.db.settings();let reads=0,release!:()=>void;const bothRead=new Promise<void>(r=>release=r);const actual=runtime.db.settings.bind(runtime.db);
    const spy=vi.spyOn(runtime.db,'settings').mockImplementation(async()=>{const snapshot=await actual();const index=++reads;if(index===2)release();if(index<=2)await bothRead;return snapshot;});
    try{
      const request=(model:string)=>runtime.app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:{...original,embedding:{...original.embedding,model}}});
      const results=await Promise.all([request('version-a-'+randomUUID()),request('version-b-'+randomUUID())]);expect(results.map(r=>r.statusCode)).toEqual([200,200]);
      expect((await actual()).embedding.version).toBe(original.embedding.version+2);
    }finally{spy.mockRestore();await runtime.db.saveSettings(original);}
  });
});
