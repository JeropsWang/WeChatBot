import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,beforeAll,afterAll,it,expect} from 'vitest';
import {Database} from '../apps/server/db.js';
import {MediaService} from '../apps/server/media.js';
import type {ModelGateway,RunInput} from '../apps/server/models.js';
import type {SecretStore} from '../apps/server/secrets.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGM8YRTAAAZMEIqBgQEAF+gBTt22usoAAAAASUVORK5CYII=';
describe.skipIf(!process.env.TEST_DATABASE_URL)('managed media and real wheel renderer',()=>{
  let db:Database,admin:Database,schema:string,directory:string,service:MediaService;const runs:RunInput[]=[];let modelId:string;
  let responder=(input:RunInput)=>Promise.resolve({text:JSON.stringify({emotion:['开心'],scene:['欢迎'],intensity:['轻']}),usage:{}});
  beforeAll(async()=>{const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Requires liino_test');schema='media_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();directory=await mkdtemp(join(tmpdir(),'liino-media-'));modelId=randomUUID();await db.query('INSERT INTO models(id,config) VALUES($1,$2)',[modelId,{id:modelId,name:'fixture',model:'fixture',baseUrl:'http://fixture.invalid',protocol:'openai-compatible',contextWindow:32768,supportsTools:false,supportsVision:true}]);await db.updateSettings(settings=>({...settings,chatModelId:modelId}));service=new MediaService(db,directory,{run:async(input:RunInput)=>{runs.push(input);return responder(input);}} as ModelGateway,{get:async()=>undefined} as unknown as SecretStore);});
  afterAll(async()=>{await db?.close();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.close();}if(directory)await rm(directory,{recursive:true,force:true});});
  it('stores validated PNGs, deduplicates and returns safe references',async()=>{
    const a=await service.upload({name:'真实测试图',kind:'image',mimeType:'image/png',data:png}),b=await service.upload({name:'重复',kind:'image',mimeType:'image/png',data:png});expect(a.id).toBe(b.id);expect(a.url).toBe('/api/media-assets/'+a.id+'/content');const content=await service.content(a.id);expect(content.bytes.subarray(0,8)).toEqual(Buffer.from('89504e470d0a1a0a','hex'));expect(await service.reference(a.id)).toEqual({assetId:a.id,kind:'image'});expect(a.capability.verified).toBe(false);
  });
  it('rejects invalid base64, mismatched formats, oversized images and caller paths',async()=>{
    const upload={name:'bad',kind:'image' as const,mimeType:'image/png',data:png};for(const input of [{...upload,data:'%%%notbase64'},{...upload,mimeType:'image/jpeg'},{...upload,data:Buffer.from('<svg/>').toString('base64')},{...upload,data:Buffer.alloc(5*1024*1024+1).toString('base64')},{...upload,filePath:'../../outside.png'}])await expect(service.upload(input as any)).rejects.toThrow();
  });
  it('passes actual source bytes to vision and marks AI tags',async()=>{
    const asset=await service.upload({name:'AI实际图片',kind:'image',mimeType:'image/png',data:png});const tagged=await service.tag(asset.id);expect(tagged.tags.emotion).toEqual(['开心']);expect(runs.at(-1)?.images?.[0]).toEqual({type:'image',mimeType:'image/png',data:png});expect(runs.at(-1)?.context?.purpose).toBe('asset-tag');expect(tagged.manualTags).toBe(false);
  });
  it('protects manual tags both before and during async AI tagging',async()=>{
    const asset=await service.upload({name:'race',kind:'image',mimeType:'image/png',data:png});let entered!:()=>void,resume!:(value:any)=>void;const waiting=new Promise<void>(resolve=>entered=resolve);responder=async()=>{entered();return new Promise(resolve=>resume=resolve);};const tagging=service.tag(asset.id);await waiting;await service.update(asset.id,{tags:{emotion:['人工'],scene:[],intensity:[]},manualTags:false});resume({text:JSON.stringify({emotion:['AI'],scene:[],intensity:[]}),usage:{}});await expect(tagging).rejects.toMatchObject({statusCode:409});await expect(service.tag(asset.id)).rejects.toMatchObject({statusCode:409});await service.update(asset.id,{name:'人工保护',manualTags:false});const protectedAsset=await service.get(asset.id);expect(protectedAsset?.tags.emotion).toEqual(['人工']);expect(protectedAsset?.manualTags).toBe(true);responder=async()=>({text:'{"emotion":[],"scene":[],"intensity":[]}',usage:{}});
  });
  it('requires vision and stable native IDs/hashes without fabricated thumbnails',async()=>{
    await expect(service.upload({name:'index',kind:'native-sticker',nativeRef:{index:2} as any})).rejects.toThrow();const asset=await service.upload({name:'原生',kind:'native-sticker',nativeRef:{id:'native-stable-id',hash:'a'.repeat(64)}});expect(asset.capability.verified).toBe(false);await expect(service.tag(asset.id)).rejects.toMatchObject({statusCode:400});
    await db.query("UPDATE models SET config=jsonb_set(config,'{supportsVision}','false') WHERE id=$1",[modelId]);await db.query("UPDATE media_assets SET manual_tags=false WHERE kind='image'");const image=await service.upload({name:'no vision',kind:'image',mimeType:'image/png',data:png});await expect(service.tag(image.id)).rejects.toMatchObject({statusCode:400});await db.query("UPDATE models SET config=jsonb_set(config,'{supportsVision}','true') WHERE id=$1",[modelId]);
  });
  it('soft deletes and blocks queued references/content; rejects DB path escape',async()=>{
    const asset=await service.upload({name:'disabled',kind:'native-sticker',nativeRef:{id:'another',hash:'b'.repeat(64)}});await service.remove(asset.id);await expect(service.reference(asset.id)).rejects.toThrow();
    const other=await service.upload({name:'path',kind:'native-sticker',nativeRef:{id:'path',hash:'c'.repeat(64)}});await db.query('UPDATE media_assets SET file_path=$2,mime_type=$3 WHERE id=$1',[other.id,'../../escape.png','image/png']);await expect(service.content(other.id)).rejects.toThrow();
  });
  it('reactivates explicit uploads, preserving manual tags and permanently cancelling old pending sends',async()=>{
    const asset=await service.upload({name:'删除再上传',kind:'image',mimeType:'image/png',data:png});await service.update(asset.id,{tags:{emotion:['保留人工'],scene:['手动'],intensity:[]}});
    const chat=await db.createChat({name:'素材取消测试',bindingKey:randomUUID()}),pending=randomUUID(),sent=randomUUID(),other=randomUUID();
    await db.query("INSERT INTO sends(id,chat_id,content,kind,epoch,asset_id,status) VALUES($1,$2,'image','fixture',0,$3,'pending'),($4,$2,'sent','fixture',0,$3,'sent'),($5,$2,'text','fixture',0,NULL,'pending')",[pending,chat.id,asset.id,sent,other]);
    await service.remove(asset.id);const statuses=(await db.query('SELECT id,status FROM sends WHERE chat_id=$1',[chat.id])).rows;expect(statuses.find(r=>r.id===pending)?.status).toBe('cancelled');expect(statuses.find(r=>r.id===sent)?.status).toBe('sent');expect(statuses.find(r=>r.id===other)?.status).toBe('pending');
    const restored=await service.upload({name:'重新上传',kind:'image',mimeType:'image/png',data:png});expect(restored).toMatchObject({id:asset.id,enabled:true,status:'ready',manualTags:true,tags:{emotion:['保留人工']}});expect((await service.content(restored.id)).bytes.toString('base64')).toBe(png);expect((await db.query('SELECT status FROM sends WHERE id=$1',[pending])).rows[0].status).toBe('cancelled');
    await expect(service.tag(restored.id)).rejects.toMatchObject({statusCode:409});
  });
  it('renders deterministic actual 900px PNG with selected food even beyond 40 candidates',async()=>{
    const candidates=Array.from({length:47},(_,i)=>({id:'food-'+i,name:'实际菜品 '+i})),food=candidates[46];const result=await service.wheel({food,candidates});expect(result.food.name).toBe(food.name);const image=await service.content(result.assetId);expect(image.mimeType).toBe('image/png');expect(image.bytes.readUInt32BE(16)).toBe(900);expect(image.bytes.readUInt32BE(20)).toBe(900);expect(image.bytes.length).toBeGreaterThan(10000);const again=await service.wheel({food,candidates});expect(again.assetId).toBe(result.assetId);await expect(service.wheel({food:{name:'不在列表'},candidates})).rejects.toThrow();expect((await service.list({kind:'image'})).total).toBeGreaterThan(0);
  });
});
