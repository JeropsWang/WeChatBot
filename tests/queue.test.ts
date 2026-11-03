import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Database } from '../apps/server/db.js';
import { Pipeline } from '../apps/server/pipeline.js';
import { ModelGateway } from '../apps/server/models.js';
import { defaultSettings,type ChannelAdapter } from '../packages/contracts.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('real Redis delivery without background-job starvation',()=>{
  let admin:Database,db:Database,engine:Pipeline,schema:string,chat:any,prefix:string,release:()=>void;
  const sent:string[]=[];
  beforeAll(async()=>{
    const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Requires liino_test');
    schema='queue_'+randomUUID().replaceAll('-','');prefix='liino-test-'+randomUUID();admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();
    await db.saveSettings({...structuredClone(defaultSettings),paused:false});chat=await db.createChat({name:'fixture',bindingKey:randomUUID()});await db.query('UPDATE chats SET enabled=true,verified=true,proactive=false WHERE id=$1',[chat.id]);
    const blocked=new Promise<void>(r=>release=r);
    const channel:ChannelAdapter={status:()=>({connected:true,capabilities:{}}),listChats:async()=>[],send:async c=>{sent.push(c.text);return {status:'sent'};}};
    engine=new Pipeline(db,channel,new ModelGateway(),{get:async()=>undefined} as any,{index:()=>blocked,search:async()=>[],extract:async()=>{}} as any,()=>{},'redis://127.0.0.1:63799',prefix);
  });
  afterAll(async()=>{
    release?.();await engine?.close();
    for(const name of [prefix+'-index',prefix+'-chat-'+chat.id,prefix+'-route-'+chat.id,prefix+'-send']){const q=new Queue(name,{connection:{host:'127.0.0.1',port:63799}});await q.obliterate({force:true});await q.close();}
    await db?.close();if(schema&&!/^queue_[a-f0-9]{32}$/.test(schema))throw new Error('Unexpected schema');if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
  });
  it('publishes a fresh chat ahead of200 already-published pending index tasks, then delivers it once',async()=>{
    await db.tx(async c=>{for(let i=0;i<200;i++)await db.addJob(c,'index',null,{memoryId:randomUUID()},randomUUID());});
    await engine.start();
    const event={eventId:randomUUID(),chatId:chat.id,accountId:'fixture',content:'/帮助',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text' as const};await engine.ingest(event);await engine.flushOutbox();
    const publishDeadline=Date.now()+5000;let admitted:any;
    do{await engine.flushOutbox();admitted=(await db.query('SELECT published_at FROM outbox WHERE unique_key=$1',['chat-'+event.eventId])).rows[0];if(!admitted.published_at)await new Promise(r=>setTimeout(r,100));}while(!admitted.published_at&&Date.now()<publishDeadline);
    expect(admitted.published_at).not.toBeNull();
    const deadline=Date.now()+10000;while(!sent.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));expect(sent).toHaveLength(1);
    await engine.flushOutbox();await new Promise(r=>setTimeout(r,100));expect(sent).toHaveLength(1);
  },20000);
});
