import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../apps/server/db.js';
import {createApp} from '../apps/server/app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('versioned hunt reference gallery',()=>{
 let runtime:Awaited<ReturnType<typeof createApp>>,admin:Database,schema:string,dir:string,cookie:string,uploaded:string;
 let fail=false;const prepared:{version:string;manifest:string}[]=[];
 const png='iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGM8YRTAAAZMEIqBgQEAF+gBTt22usoAAAAASUVORK5CYII=';
 const get=async(url='/api/hunt')=>runtime.app.inject({url,headers:{cookie}});
 const save=async(payload:any)=>runtime.app.inject({method:'PUT',url:'/api/hunt/settings',headers:{cookie},payload});
 const upload=async(payload:any={name:'自己的触发图',mimeType:'image/png',data:png})=>runtime.app.inject({method:'POST',url:'/api/hunt/references',headers:{cookie},payload});
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw Error('Requires liino_test');
  schema='gallery_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');dir=await mkdtemp(join(tmpdir(),'hunt-gallery-'));
  const fixturePath=join(dir,'references.json');
  await writeFile(join(dir,'fixture.png'),Buffer.concat([Buffer.from(png,'base64'),Buffer.from('synthetic-builtin')]));
  await writeFile(fixturePath,JSON.stringify({references:Array.from({length:10},(_,i)=>({id:i===0?'01-yellow':'fixture-'+i,path:'fixture.png',crop:null,category:'合成测试'}))}));
  runtime=await createApp({databaseUrl:url.href,dataDir:dir,huntSeedManifest:fixturePath,startWorkers:false,bridgeToken:'gallery-test-bridge-token-abcdefghijklmnopqrstuvwxyz',imageMatcher:{prepareGallery:async(version,manifest)=>{prepared.push({version,manifest});if(fail)throw Error('fixture preparation failure');},match:async()=>({status:'ok',metric:'cosine_similarity',calibrated:false,similarity:.9,matchedReference:'01-yellow',category:'合成表情',matches:[]}),close(){},status:()=>({running:true,ready:true,referenceCount:10})}});
  const response=await runtime.app.inject({method:'POST',url:'/api/setup',payload:{password:'gallery-test-password-1234'}});expect(response.statusCode).toBe(200);cookie=response.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
 },30000);
 afterAll(async()=>{await runtime?.app.close();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}if(dir?.startsWith(join(tmpdir(),'hunt-gallery-')))await rm(dir,{recursive:true,force:true});});
 it('imports all ten builtin IDs and crops, initially enabled, and authenticates image reads',async()=>{
  const result=(await get()).json();expect(result.references).toHaveLength(10);expect(result.settings.enabledReferenceIds).toHaveLength(10);expect(result.settings.galleryVersion).toBeTypeOf('string');
  const manifest=JSON.parse(await readFile(join(dir,'references.json'),'utf8'));
  const rows=(await runtime.db.query('SELECT id,crop,category FROM hunt_references ORDER BY id')).rows;
  expect(rows).toEqual(manifest.references.map((r:any)=>({id:r.id,crop:r.crop,category:r.category})));
  expect((await runtime.app.inject({url:result.references[0].previewUrl})).statusCode).toBe(401);
  const image=await get(result.references[0].previewUrl);expect(image.statusCode).toBe(200);expect(image.headers['content-type']).toBe('image/png');
 });
 it('uploads a decoded static image disabled, deduplicates without enabling, and paginates/searches',async()=>{
  const first=await upload();expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({duplicate:false,item:{enabled:false,name:'自己的触发图',source:'upload',status:'ready'}});uploaded=first.json().item.id;
  expect((await upload()).json()).toMatchObject({duplicate:true,item:{id:uploaded,enabled:false}});
  expect((await get('/api/hunt/references?source=upload&q='+encodeURIComponent('触发')+'&pageSize=1')).json()).toMatchObject({total:1,page:1,pageSize:1,items:[{id:uploaded}]});
  expect((await get('/api/hunt/references?page=2&pageSize=5')).json().items).toHaveLength(5);
  for(const suffix of ['?page=0','?source=fake','?pageSize=501'])expect((await get('/api/hunt/references'+suffix)).statusCode).toBe(400);
 });
 it('rejects malformed bytes, MIME spoofing and oversized uploads without catalog records',async()=>{
  for(const payload of [{name:'bad',mimeType:'image/png',data:'!!!!'},{name:'bad',mimeType:'image/png',data:Buffer.from('<svg/>').toString('base64')},{name:'bad',mimeType:'image/jpeg',data:png},{name:'bad',mimeType:'image/png',data:Buffer.alloc(5*1024*1024+1).toString('base64')}])expect((await upload(payload)).statusCode).toBe(400);
  expect((await get('/api/hunt/references?source=upload')).json().total).toBe(1);
 });
 it('prepares an immutable selected subset before committing and preserves legacy saves',async()=>{
  const settings=(await get()).json().settings;
  const response=await save({...settings,enabledReferenceIds:[uploaded]});expect(response.statusCode).toBe(200);const next=response.json();expect(next.version).toBe(settings.version+1);expect(next.galleryVersion).not.toBe(settings.galleryVersion);
  const manifest=JSON.parse(await readFile(prepared.at(-1)!.manifest,'utf8'));expect(manifest.references.map((r:any)=>r.id)).toEqual([uploaded]);
  const {enabledReferenceIds, ...legacy}=next;expect((await save(legacy)).json().enabledReferenceIds).toEqual([uploaded]);
  expect(JSON.parse(await readFile(prepared[0].manifest,'utf8'))).toEqual(manifest);
 });
 it('rolls back draft deletion and selection on stale versions or failed preparation',async()=>{
  const old=(await get()).json().settings;await save({...old,threshold:.8});
  expect((await save({...old,enabledReferenceIds:['01-yellow'],deletedReferenceIds:[uploaded]})).statusCode).toBe(409);
  const before=(await get()).json().settings;fail=true;
  expect((await save({...before,enabledReferenceIds:['01-yellow'],deletedReferenceIds:[uploaded]})).statusCode).toBe(503);fail=false;
  expect((await get()).json().settings).toEqual(before);expect((await get('/api/hunt/references?source=upload')).json().total).toBe(1);
 });
 it('prevents builtin deletion and empty enabled selections, softdeletes only on save and retains history previews',async()=>{
  const old=(await get()).json().settings;
  expect((await save({...old,enabledReferenceIds:[]})).statusCode).toBe(400);
  expect((await save({...old,enabledReferenceIds:[uploaded],deletedReferenceIds:['01-yellow']})).statusCode).toBe(409);
  const response=await save({...old,enabledReferenceIds:['01-yellow'],deletedReferenceIds:[uploaded]});expect(response.statusCode).toBe(200);expect(response.json().deletedReferenceIds).toBeUndefined();
  expect((await get('/api/hunt/references?source=upload')).json().total).toBe(0);
  expect((await get('/api/hunt/references/'+uploaded+'/content')).statusCode).toBe(200);
  const current=(await get()).json().settings;expect((await save({...current,enabledReferenceIds:[uploaded]})).statusCode).toBe(409);
  expect((await upload()).json()).toMatchObject({duplicate:true,item:{id:uploaded,enabled:false}});
  expect((await get('/api/hunt/references?source=upload')).json()).toMatchObject({total:1,items:[{id:uploaded,enabled:false}]});
 });
 it('serializes competing saves so exactly one version commits',async()=>{
  const old=(await get()).json().settings;
  const responses=await Promise.all([save({...old,threshold:.81}),save({...old,threshold:.82})]);expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
 });
 it('permits a disabled empty selection while still rejecting a full catalog upload',async()=>{
  const old=(await get()).json().settings;expect((await save({...old,enabled:false,enabledReferenceIds:[]})).statusCode).toBe(200);
  await runtime.db.query(`INSERT INTO hunt_references(id,name,source,category,path,digest,thumbnail) SELECT 'limit-'||g,'limit','upload','limit','unused','limit-'||g,'unused' FROM generate_series(1,489) g`);
  const other=await readFile(join(dir,'hunt-gallery','builtin-01-yellow.png'));
  expect((await upload({name:'full',mimeType:'image/png',data:Buffer.concat([other,Buffer.from('capacity-fixture')]).toString('base64')})).statusCode).toBe(409);
 });
});
