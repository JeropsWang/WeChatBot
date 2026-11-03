import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {Database} from '../apps/server/db.js';
import {createApp} from '../apps/server/app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('actual bridge image wire protocol',()=>{
 let runtime:Awaited<ReturnType<typeof createApp>>,admin:Database,schema:string,dir:string,origin:string,chat:any,socket:WebSocket;
 const token='bridge-protocol-fixture-token-abcdefghijklmnopqrstuvwxyz',frames:any[]=[];
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw Error('Requires liino_test');
  schema='bridge_wire_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');dir=await mkdtemp(join(tmpdir(),'bridge-wire-'));
  runtime=await createApp({databaseUrl:url.href,dataDir:dir,startWorkers:false,bridgeToken:token});
  chat=await runtime.db.createChat({name:'协议回归群',bindingKey:randomUUID()});
  origin=await runtime.app.listen({host:'127.0.0.1',port:0});socket=new WebSocket(origin.replace('http:','ws:')+'/bridge',{headers:{authorization:'Bearer '+token}});
  socket.on('message',raw=>frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 });
 afterAll(async()=>{socket?.close();await runtime?.app.close();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}if(dir?.startsWith(join(tmpdir(),'bridge-wire-')))await rm(dir,{recursive:true,force:true});});
 const event=(reason:any)=>({eventId:randomUUID(),chatId:chat.id,accountId:'local-wechat',content:'[动画表情]',type:'image',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,image:{attachmentId:randomUUID(),status:'pending',quality:'thumbnail',reason}});
 async function send(value:any){socket.send(JSON.stringify({type:'event',event:value}));const until=Date.now()+5000;while(Date.now()<until){const result=frames.find(f=>f.eventId===value.eventId);if(result)return result;await new Promise(r=>setTimeout(r,15));}throw Error('Missing bridge receipt');}
 it('accepts the legacy Python null reason, acknowledges the event, and uploads with the same IDs',async()=>{
  const value=event(null);expect(await send(value)).toMatchObject({type:'ack',eventId:value.eventId});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGM8YRTAAAZMEIqBgQEAF+gBTt22usoAAAAASUVORK5CYII=';
  const upload={attachmentId:value.image.attachmentId,eventId:value.eventId,chatId:chat.id,mimeType:'image/png',width:3,height:2,sha256:createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'),quality:'thumbnail',data:png};
  for(let i=0;i<2;i++){
   const response=await fetch(origin+'/bridge/attachments',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(upload)});expect(response.status).toBe(200);
  }
  expect((await runtime.db.query('SELECT status FROM chat_images WHERE id=$1',[value.image.attachmentId])).rows[0].status).toBe('ready');
  expect((await runtime.db.query('SELECT count(*)::int n FROM messages WHERE event_id=$1',[value.eventId])).rows[0].n).toBe(1);
 });
 it('retains the bridge profile failure reason while accepting the image event',async()=>{
  const value={...event(undefined),uiIdentityFailure:{reasonCode:'name_unavailable',reason:'资料卡名称尚未读取成功'}};
  expect(await send(value)).toMatchObject({type:'ack'});
  const row=(await runtime.db.query('SELECT raw FROM messages WHERE event_id=$1',[value.eventId])).rows[0];
  expect(row.raw).toMatchObject({uiIdentityStatus:'unknown',uiIdentityReason:'资料卡名称尚未读取成功',uiIdentityReasonCode:'name_unavailable'});
 });
 it('reports the invalid field without disclosing chat text or discarding the event',async()=>{
  const value={...event({invalid:true}),content:'PRIVATE-BODY-DO-NOT-LOG'};
  const receipt=await send(value);expect(receipt).toMatchObject({type:'nack',code:'invalid_event'});expect(receipt.detail).toContain('image.reason');expect(JSON.stringify(receipt)).not.toContain(value.content);
  expect((await runtime.db.query('SELECT 1 FROM messages WHERE event_id=$1',[value.eventId])).rowCount).toBe(0);
 });
});
