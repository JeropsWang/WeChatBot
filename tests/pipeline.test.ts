process.env.WECHATBOT_TEST_GROUP='合成验收群';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../apps/server/db.js';
import { Pipeline } from '../apps/server/pipeline.js';
import { ModelGateway,type RunInput } from '../apps/server/models.js';
import { SearchProvider } from '../apps/server/network.js';
import type { ChannelAdapter } from '../packages/contracts.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('durable reply processing',()=>{
  let db:Database,admin:Database,schema:string,engine:Pipeline,chat:any,original:any;let sendCalls=0;
  class TestGateway extends ModelGateway { override async run(_input:RunInput){return {text:'测试回复',usage:{}};} }
  const channel:ChannelAdapter={status:()=>({connected:true,capabilities:{}}),listChats:async()=>[],send:async()=>{sendCalls++;return {status:'sent'};}};
  beforeAll(async()=>{
    const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Requires isolated liino_test');schema='pipeline_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();original=await db.settings();
    chat=await db.createChat({name:'pipeline-'+randomUUID(),bindingKey:randomUUID()});
    await db.query('UPDATE chats SET enabled=true,verified=true,proactive=false WHERE id=$1',[chat.id]);
    const id=randomUUID();await db.query('INSERT INTO models(id,config) VALUES($1,$2)',[id,{id,name:'fixture',protocol:'openai-compatible',model:'fixture',baseUrl:'http://127.0.0.1:1/v1',contextWindow:32768,supportsTools:false}]);
    await db.saveSettings({...original,paused:false,chatModelId:id});
    engine=new Pipeline(db,channel,new TestGateway(),{get:async()=>undefined} as any,{search:async()=>[],index:async()=>{},extract:async()=>{}} as any,()=>{},'redis://127.0.0.1:63799','liino-test-'+randomUUID());
  });
  afterAll(async()=>{await engine.close();await db.saveSettings(original);await db.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();});
  it('keeps preview instructions stable while sending fresh retrieved context',async()=>{
    const inputs:RunInput[]=[];let content='第一轮记忆';
    const gateway={run:async(input:RunInput)=>{inputs.push(input);return {text:'预览',usage:{}};}} as ModelGateway;
    const local=new Pipeline(db,channel,gateway,{get:async()=>undefined} as any,{search:async()=>[{id:'memory-fixture',source:'本群',content}]} as any,()=>{},'redis://127.0.0.1:63799','cache-preview-'+randomUUID());
    try{
      await local.preview('第一个问题',chat.id);content='第二轮记忆';await local.preview('第二个问题',chat.id);
      expect(inputs[0].systemPrompt).toBe(inputs[1].systemPrompt);expect(inputs[0].systemPrompt).not.toContain('第一轮记忆');
      expect(inputs[0].dynamicContext).toContain('第一轮记忆');expect(inputs[1].dynamicContext).toContain('第二轮记忆');
      expect(inputs[0].replyStyle).toBe('brief');
      await local.preview('总结一下上面的讨论',chat.id);expect(inputs.at(-1)?.replyStyle).toBe('expanded');
    }finally{await local.close();}
  });
  it('creates one outbound intent on replay and sends once',async()=>{
    const event={eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'@bot 你好',observedAt:new Date().toISOString(),isSelf:false,mentioned:true,type:'text' as const};
    const messageId=await engine.ingest(event);const task=(await db.query("SELECT id FROM outbox WHERE chat_id=$1 AND kind='chat' ORDER BY created_at DESC LIMIT 1",[chat.id])).rows[0];
    await engine.process('chat',{messageId},task.id);await engine.process('chat',{messageId},task.id);
    const sends=(await db.query('SELECT * FROM sends WHERE source_message_id=$1',[messageId])).rows;expect(sends).toHaveLength(1);
    await engine.process('send',{sendId:sends[0].id},randomUUID());await engine.process('send',{sendId:sends[0].id},randomUUID());expect(sendCalls).toBe(1);
  });
  it('does not blindly resend ambiguous delivery',async()=>{
    const id=randomUUID();await db.query("INSERT INTO sends(id,chat_id,content,kind,epoch,status) VALUES($1,$2,'有歧义的回复','explicit',0,'unknown')",[id,chat.id]);
    expect((await engine.process('send',{sendId:id},randomUUID()) as any).status).toBe('unknown');expect(sendCalls).toBe(1);
  });
  it('queues one scene image only after text is confirmed and respects group switch',async()=>{
    const group=await db.createChat({name:'sticker-'+randomUUID(),bindingKey:randomUUID()});await db.query('UPDATE chats SET enabled=true,verified=true WHERE id=$1',[group.id]);
    const asset=randomUUID();await db.query("INSERT INTO media_assets(id,name,kind,mime_type,tags,status,enabled) VALUES($1,'fixture','image','image/png',$2,'ready',true)",[asset,{scene:['致谢'],emotion:[],intensity:[]}]);
    await db.query('INSERT INTO chat_sticker_settings(chat_id,enabled) VALUES($1,true)',[group.id]);
    let imageCalls=0;const localChannel:ChannelAdapter={...channel,sendImage:async()=>{imageCalls++;return {status:'sent'};}};
    const png=Buffer.from('89504e470d0a1a0a','hex');
    const local=new Pipeline(db,localChannel,new TestGateway(),{get:async()=>undefined} as any,{search:async()=>[]} as any,()=>{},'redis://127.0.0.1:63799','test-'+randomUUID(),{media:{content:async()=>({bytes:png,mimeType:'image/png'})} as any});
    try{
      const textId=randomUUID();expect(await local.reply(textId,group.id,null,'谢谢你','explicit')).toBe(true);
      expect((await db.query('SELECT id FROM sends WHERE parent_id=$1',[textId])).rowCount).toBe(0);
      await local.process('send',{sendId:textId},randomUUID());await local.process('send',{sendId:textId},randomUUID());
      const children=(await db.query('SELECT id FROM sends WHERE parent_id=$1',[textId])).rows;expect(children).toHaveLength(1);
      await db.query('UPDATE chat_sticker_settings SET enabled=false WHERE chat_id=$1',[group.id]);
      await expect(local.process('send',{sendId:children[0].id},randomUUID())).resolves.toMatchObject({status:'cancelled'});expect(imageCalls).toBe(0);
      await db.query('UPDATE chat_sticker_settings SET enabled=true WHERE chat_id=$1',[group.id]);
      const next=randomUUID();await local.reply(next,group.id,null,'谢谢你','explicit');await local.process('send',{sendId:next},randomUUID());
      const image=(await db.query('SELECT id FROM sends WHERE parent_id=$1',[next])).rows[0];
      await local.process('send',{sendId:image.id},randomUUID());await local.process('send',{sendId:image.id},randomUUID());expect(imageCalls).toBe(1);
      expect((await db.query('SELECT status FROM sends WHERE id=$1',[image.id])).rows[0].status).toBe('sent');
    }finally{await local.close();}
  });
  it('never writes anonymous /remember even on replay',async()=>{
    const event={eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'/记住 记忆重放'+randomUUID(),observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text' as const};
    const messageId=await engine.ingest(event),task=(await db.query("SELECT id FROM outbox WHERE unique_key=$1",['chat-'+event.eventId])).rows[0];
    await engine.process('chat',{messageId},task.id);
    await db.query("UPDATE messages SET state='pending' WHERE id=$1",[messageId]);
    await expect(engine.process('chat',{messageId},task.id)).resolves.toBeTruthy();
    expect((await db.query('SELECT count(*)::int n FROM memories WHERE source_batch=$1',['command-'+task.id])).rows[0].n).toBe(0);
  });
  it('preview never appends messages, memories or sends',async()=>{
    const count=async()=> (await db.query('SELECT (SELECT count(*) FROM messages)::text m,(SELECT count(*) FROM memories)::text k,(SELECT count(*) FROM sends)::text s')).rows[0];
    const before=await count();expect((await engine.preview('预览：'+randomUUID(),chat.id)).text).toBe('测试回复');expect(await count()).toEqual(before);
  });
  it('stop cancels the active response and prevents its queued replay from regenerating',async()=>{
    let entered!:()=>void,calls=0;const started=new Promise<void>(r=>entered=r);
    class WaitingGateway extends ModelGateway {override async run(input:RunInput):Promise<{text:string;usage:unknown}>{calls++;entered();return new Promise((_resolve,reject)=>input.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}}
    const stopping=new Pipeline(db,channel,new WaitingGateway(),{get:async()=>undefined} as any,{search:async()=>[]} as any,()=>{},'redis://127.0.0.1:63799','liino-test-'+randomUUID());
    try{
      const event={eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'@bot 稍后停止',observedAt:new Date().toISOString(),isSelf:false,mentioned:true,type:'text' as const};
      const messageId=await stopping.ingest(event),task=(await db.query('SELECT id FROM outbox WHERE unique_key=$1',['chat-'+event.eventId])).rows[0];
      const work=stopping.process('chat',{messageId},task.id);void work.catch(()=>{});await started;await stopping.stopChat(chat.id);
      await expect(work).resolves.toMatchObject({status:'cancelled'});
      await stopping.process('chat',{messageId},task.id);expect(calls).toBe(1);
    }finally{await stopping.close();}
  });
  it('does not consider an hours-old bridge inbox replay a fresh proactive trigger',async()=>{
    await db.query('UPDATE chats SET proactive=true,last_decision_seq=(SELECT coalesce(max(seq),0) FROM messages WHERE chat_id=$1) WHERE id=$1',[chat.id]);
    await engine.ingest({eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'离线时的旧话题',observedAt:new Date(Date.now()-7200000).toISOString(),isSelf:false,mentioned:false,type:'text'});
    await (engine as any).schedule();
    expect((await db.query("SELECT count(*)::int n FROM outbox WHERE chat_id=$1 AND kind='proactive'",[chat.id])).rows[0].n).toBe(0);
    await db.query('UPDATE chats SET proactive=false WHERE id=$1',[chat.id]);
  });
  it('does not reconsider the same pre-stop conversation after stopping',async()=>{
    await db.query('UPDATE chats SET proactive=true,last_decision_at=NULL,last_decision_seq=(SELECT coalesce(max(seq),0) FROM messages WHERE chat_id=$1) WHERE id=$1',[chat.id]);
    const id=await engine.ingest({eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'停止前的新话题',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text'});
    await engine.process('chat',{messageId:id},randomUUID());await engine.stopChat(chat.id);await (engine as any).schedule();
    expect((await db.query("SELECT count(*)::int n FROM outbox WHERE chat_id=$1 AND kind='proactive'",[chat.id])).rows[0].n).toBe(0);
  });
  it('returns a configuration error for a missing model rather than a database UUID error',async()=>{
    await expect(engine.model('')).rejects.toThrow('尚未配置');
  });
  it('restricts identity sample probes to a paused verified test group',async()=>{
    const group=await db.createChat({name:'合成验收群',bindingKey:randomUUID()});await db.query('UPDATE chats SET enabled=true,verified=true WHERE id=$1',[group.id]);
    let calls=0;const gated:ChannelAdapter={...channel,identitySample:async()=>{calls++;return {status:'candidate',name:'样本'};}};
    const local=new Pipeline(db,gated,new TestGateway(),{get:async()=>undefined} as any,{search:async()=>[]} as any,()=>{},'redis://127.0.0.1:63799','test-'+randomUUID());
    const original=await db.settings();
    try{
      await expect(local.process('identity-sample',{chatId:group.id,avatarHash:'a'.repeat(64)},randomUUID())).resolves.toMatchObject({status:'unknown'});expect(calls).toBe(0);
      await db.saveSettings({...original,paused:true});
      await expect(local.process('identity-sample',{chatId:chat.id,avatarHash:'a'.repeat(64)},randomUUID())).resolves.toMatchObject({status:'unknown'});expect(calls).toBe(0);
      await expect(local.process('identity-sample',{chatId:group.id,avatarHash:'a'.repeat(64)},randomUUID())).resolves.toMatchObject({status:'candidate'});expect(calls).toBe(1);
    }finally{await local.close();await db.saveSettings(original);}
  });
  it('restricts live identity diagnostics to paused test messages in their own group',async()=>{
    const group=await db.createChat({name:'合成验收群',bindingKey:randomUUID()});await db.query('UPDATE chats SET enabled=true,verified=true WHERE id=$1',[group.id]);
    let arms=0,lookups=0,readName=false,nameResult=false;const gated:ChannelAdapter={...channel,identityArm:async(command)=>{arms++;readName=command.readName===true;return {status:'armed'};},identityStatus:async()=>{lookups++;return nameResult?{status:'candidate',name:'测试名称',identitySource:'wechat-ui-profile'}:{status:'current',avatarHash:'a'.repeat(64)};}};
    const local=new Pipeline(db,gated,new TestGateway(),{get:async()=>undefined} as any,{search:async()=>[]} as any,()=>{},'redis://127.0.0.1:63799','test-'+randomUUID());const original=await db.settings();
    try{
      await db.saveSettings({...original,paused:true});
      await expect(local.process('identity-arm',{chatId:chat.id},randomUUID())).resolves.toMatchObject({status:'unknown'});expect(arms).toBe(0);
      await expect(local.process('identity-arm',{chatId:group.id},randomUUID())).resolves.toMatchObject({status:'armed'});expect(arms).toBe(1);
      expect(readName).toBe(false);
      await expect(local.process('identity-arm',{chatId:group.id,readName:true},randomUUID())).resolves.toMatchObject({status:'armed'});expect(readName).toBe(true);
      const event={eventId:randomUUID(),chatId:group.id,accountId:'test',content:'认人实时测试',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text' as const};await local.ingest(event);
      await expect(local.process('identity-status',{chatId:chat.id,eventId:event.eventId},randomUUID())).resolves.toMatchObject({status:'unknown'});expect(lookups).toBe(0);
      await expect(local.process('identity-status',{chatId:group.id,eventId:event.eventId},randomUUID())).resolves.toMatchObject({status:'current'});expect(lookups).toBe(1);
      nameResult=true;
      await expect(local.process('identity-status',{chatId:group.id,eventId:event.eventId},randomUUID())).resolves.toMatchObject({status:'candidate',name:'测试名称',match:{status:'new'}});expect(lookups).toBe(2);
      expect((await db.query('SELECT count(*)::int n FROM members WHERE chat_id=$1',[group.id])).rows[0].n).toBe(0);
      await db.saveSettings({...original,paused:false});
      await expect(local.process('identity-status',{chatId:group.id,eventId:event.eventId},randomUUID())).resolves.toMatchObject({status:'unknown'});expect(lookups).toBe(2);
    }finally{await local.close();await db.saveSettings(original);}
  });
  it('does not grant plan mode to an unverified sender',async()=>{
    const messageId=await engine.ingest({eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'/plan',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text'});
    const result=await engine.process('chat',{messageId},randomUUID());
    expect(result).toMatchObject({status:'completed',reply:'queued'});
    const row=(await db.query('SELECT content FROM sends WHERE source_message_id=$1',[messageId])).rows[0];
    expect(row.content).toContain('已验证的成员身份');
    expect((await db.query('SELECT count(*)::int n FROM member_modes WHERE chat_id=$1',[chat.id])).rows[0].n).toBe(0);
  });
  it('draws food once on replay without requiring a model',async()=>{
    const group=await db.createChat({name:'轮盘-'+randomUUID(),bindingKey:randomUUID()});
    await db.query('UPDATE chats SET enabled=true,verified=true WHERE id=$1',[group.id]);
    const food=randomUUID();await db.query("INSERT INTO foods(id,name) VALUES($1,'测试面条')",[food]);await db.query('INSERT INTO chat_foods(chat_id,food_id) VALUES($1,$2)',[group.id,food]);
    const messageId=await engine.ingest({eventId:randomUUID(),chatId:group.id,accountId:'test',content:'今天吃什么？',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text'});
    const taskId=randomUUID();await engine.process('chat',{messageId},taskId);await engine.process('chat',{messageId},taskId);
    expect((await db.query('SELECT count(*)::int n FROM food_draws WHERE source_message_id=$1',[messageId])).rows[0].n).toBe(1);
    expect((await db.query('SELECT content FROM sends WHERE source_message_id=$1',[messageId])).rows[0].content).toContain('测试面条');
  });
  it('does not send a command response when /stop was issued during the network wait',async()=>{
    const settings=await db.settings();await db.saveSettings({...settings,network:{...settings.network,enabled:true}});
    let release!:(value:any)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    const spy=vi.spyOn(SearchProvider.prototype,'search').mockImplementation(async()=>{entered();return new Promise(r=>release=r);});
    try{
      const event={eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'/搜索 停止竞态',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text' as const};
      const messageId=await engine.ingest(event),work=engine.process('chat',{messageId},randomUUID());await started;await engine.stopChat(chat.id);release([]);await work;
      expect((await db.query('SELECT count(*)::int n FROM sends WHERE source_message_id=$1',[messageId])).rows[0].n).toBe(0);
    }finally{spy.mockRestore();await db.saveSettings(settings);}
  });
  it('reports paused messages as skipped with a reason and never creates a reply',async()=>{
    const settings=await db.settings();await db.saveSettings({...settings,paused:true});
    try{
      const event={eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'@bot 暂停日志验收',observedAt:new Date().toISOString(),isSelf:false,mentioned:true,type:'text' as const};
      const messageId=await engine.ingest(event);
      await expect(engine.process('chat',{messageId},randomUUID())).resolves.toMatchObject({status:'skipped',reason:'全局暂停'});
      expect((await db.query('SELECT state FROM messages WHERE id=$1',[messageId])).rows[0].state).toBe('observed');
      expect((await db.query('SELECT count(*)::int n FROM sends WHERE source_message_id=$1',[messageId])).rows[0].n).toBe(0);
    }finally{await db.saveSettings(settings);}
  });
});
