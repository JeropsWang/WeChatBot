import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../apps/server/db.js';
import {MembersService} from '../apps/server/members.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('manual member review',()=>{
 let admin:Database,db:Database,service:MembersService,schema:string,chat:any,memberId:string,message:any;
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw Error('Requires test database');
  admin=new Database(url.href);schema='review_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
  url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();service=new MembersService(db);
  chat=await db.createChat({name:'人工核实',bindingKey:randomUUID()});const eventId=randomUUID();
  const resolved=await service.resolveUiName(chat.id,'甲','a'.repeat(64),eventId);if(resolved.status!=='matched')throw Error('fixture');memberId=resolved.memberId;
  const id=await db.ingest({eventId,chatId:chat.id,accountId:'test',content:'本人发言',isSelf:false,mentioned:true,type:'text',observedAt:new Date().toISOString()});
  await db.query('UPDATE messages SET raw=$2 WHERE id=$1',[id,{uiIdentityStatus:'matched',uiMemberId:memberId,identitySource:'wechat-ui-profile',uiAppearanceHash:'a'.repeat(64)}]);
  message=(await db.query('SELECT * FROM messages WHERE id=$1',[id])).rows[0];
 });
 afterAll(async()=>{await db?.close();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}});
 it('requires review and separate plan authorization without promoting identity',async()=>{
  expect((await service.authorization(chat.id,memberId,message)).allowed).toBe(false);
  await service.reviewMember(chat.id,memberId,{action:'approve',evidenceMessageId:message.id});
  expect((await service.authorization(chat.id,memberId,message)).allowed).toBe(true);
  expect((await service.detail(chat.id,memberId)).identityStatus).toBe('unknown');
  await service.saveModeSettings({jeropsPrompt:'特殊',planPrompt:'计划'});
  expect((await service.modeCommand(chat.id,memberId,'plan')).ok).toBe(false);
  await service.setPlanMembers(chat.id,[memberId]);expect((await service.modeCommand(chat.id,memberId,'plan')).ok).toBe(true);
  expect((await service.authorization(chat.id,memberId,{...message,raw:{...message.raw,uiAppearanceHash:'b'.repeat(64)}})).allowed).toBe(false);
 });
 it('retains approval after original evidence expires, and revocation removes authority',async()=>{
  const before=await service.authorization(chat.id,memberId);await db.query('DELETE FROM messages WHERE id=$1',[message.id]);
  expect((await service.authorization(chat.id,memberId)).allowed).toBe(true);
  await service.reviewMember(chat.id,memberId,{action:'revoke'});
  const after=await service.authorization(chat.id,memberId);expect(after.allowed).toBe(false);expect(after.version).toBeGreaterThan(before.version);
  expect((await service.activeMode(chat.id,memberId)).mode).toBe('normal');expect((await service.planMembers(chat.id)).memberIds).toEqual([]);
 });
 it('keeps ordinary name attribution separate from exact evidence needed for special permissions',async()=>{
  const eventId=randomUUID(),resolved=await service.resolveUiName(chat.id,'乙','c'.repeat(64),eventId);if(resolved.status!=='matched')throw Error('fixture');
  const id=await db.ingest({eventId,chatId:chat.id,accountId:'test',content:'核实乙',isSelf:false,mentioned:true,type:'text',observedAt:new Date().toISOString()});
  await db.query('UPDATE messages SET raw=$2 WHERE id=$1',[id,{uiIdentityStatus:'matched',uiMemberId:resolved.memberId,identitySource:'wechat-ui-profile',uiAppearanceHash:'c'.repeat(64)}]);
  await service.reviewMember(chat.id,resolved.memberId,{action:'approve',evidenceMessageId:id!});
  await service.setPlanMembers(chat.id,[resolved.memberId]);await service.modeCommand(chat.id,resolved.memberId,'plan');
  const before=await service.authorization(chat.id,resolved.memberId);
  expect((await service.resolveUiName(chat.id,'乙','d'.repeat(64),randomUUID())).status).toBe('matched');
  const after=await service.authorization(chat.id,resolved.memberId);expect(after.allowed).toBe(true);expect(after.version).toBe(before.version);
  expect((await service.authorization(chat.id,resolved.memberId,{chat_id:chat.id,raw:{uiIdentityStatus:'matched',uiMemberId:resolved.memberId,identitySource:'wechat-ui-profile',uiAppearanceHash:'c'.repeat(64),uiObservedAppearanceHash:'d'.repeat(64)}})).allowed).toBe(false);
  expect((await service.detail(chat.id,resolved.memberId)).manualReview.status).toBe('approved');
  await expect(service.reviewMember(randomUUID(),resolved.memberId,{action:'approve',evidenceMessageId:id!})).rejects.toThrow();
 });
 it('requires explicit review of exact observed evidence before tolerant matches use special permissions',async()=>{
  const descriptor={version:1,hash:'a5'.repeat(16),colors:Array(12).fill(100)},hashA='1'.repeat(64),hashB='2'.repeat(64);
  const member=await service.resolveUiName(chat.id,'容差权限测试',hashA,randomUUID(),undefined,descriptor);if(member.status!=='matched')throw Error('fixture');
  const save=async(hash:string)=>{
   const id=await db.ingest({eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'审核依据',isSelf:false,mentioned:true,type:'text',observedAt:new Date().toISOString()});
   await db.query('UPDATE messages SET raw=$2 WHERE id=$1',[id,{uiIdentityStatus:'matched',uiMemberId:member.memberId,identitySource:'wechat-ui-profile',uiAppearanceHash:hashA,uiObservedAppearanceHash:hash}]);
   return (await db.query('SELECT * FROM messages WHERE id=$1',[id])).rows[0];
  };
  const a=await save(hashA);await service.reviewMember(chat.id,member.memberId,{action:'approve',evidenceMessageId:a.id});
  expect((await service.resolveUiName(chat.id,'容差权限测试',hashB,randomUUID(),undefined,descriptor)).status).toBe('matched');
  const b=await save(hashB);expect((await service.authorization(chat.id,member.memberId,b)).allowed).toBe(false);
  await service.reviewMember(chat.id,member.memberId,{action:'approve',evidenceMessageId:b.id});
  expect((await service.authorization(chat.id,member.memberId,b)).allowed).toBe(true);
 });
 it('accepts any same-member same-appearance evidence rather than only the latest profile event',async()=>{
  const resolved=await service.resolveUiName(chat.id,'丙','e'.repeat(64),randomUUID());if(resolved.status!=='matched')throw Error('fixture');
  const event={eventId:randomUUID(),chatId:chat.id,accountId:'test',content:'另一条真实发言',isSelf:false,mentioned:true,type:'text' as const,observedAt:new Date().toISOString()};
  const id=await db.ingest(event),raw={uiIdentityStatus:'matched',uiMemberId:resolved.memberId,identitySource:'wechat-ui-profile',uiAppearanceHash:'e'.repeat(64)};
  await db.query('UPDATE messages SET raw=$2 WHERE id=$1',[id,raw]);
  await service.reviewMember(chat.id,resolved.memberId,{action:'approve',evidenceMessageId:id!});
  expect((await service.authorization(chat.id,resolved.memberId)).allowed).toBe(true);
  await db.query('UPDATE messages SET raw=$2 WHERE id=$1',[id,{...raw,uiAppearanceHash:'f'.repeat(64)}]);
  await expect(service.reviewMember(chat.id,resolved.memberId,{action:'approve',evidenceMessageId:id!})).rejects.toThrow(/依据/);
  await db.query('UPDATE messages SET raw=$2 WHERE id=$1',[id,{...raw,uiMemberId:memberId}]);
  await expect(service.reviewMember(chat.id,resolved.memberId,{action:'approve',evidenceMessageId:id!})).rejects.toThrow(/依据/);
 });
});
