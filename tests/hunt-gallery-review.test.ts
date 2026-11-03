import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../apps/server/db.js';
import {createApp} from '../apps/server/app.js';
import {HuntGallery} from '../apps/server/hunt-gallery.js';
import {getHuntSettings} from '../apps/server/hunt.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('gallery degradation and stale preparation regressions',()=>{
 let runtime:Awaited<ReturnType<typeof createApp>>,admin:Database,schema:string,dir:string,cookie:string;
 let initialization:ReturnType<typeof vi.spyOn>;
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw Error('Requires liino_test');
  schema='gallery_review_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');dir=await mkdtemp(join(tmpdir(),'hunt-gallery-review-'));
  initialization=vi.spyOn(HuntGallery.prototype,'init').mockRejectedValue(new Error('fixture: image Python environment unavailable'));
  runtime=await createApp({databaseUrl:url.href,dataDir:dir,startWorkers:false,bridgeToken:'gallery-review-bridge-token-abcdefghijklmnopqrstuvwxyz',imageMatcher:{prepareGallery:async()=>{},activateGallery(){},discardGallery(){},match:async()=>({status:'ok',metric:'cosine_similarity',calibrated:false,similarity:.9,matchedReference:'01-yellow',category:'合成表情',matches:[]}),close(){},status:()=>({running:false,ready:false,referenceCount:0})}});
 },30000);
 afterAll(async()=>{
  initialization?.mockRestore();vi.restoreAllMocks();await runtime?.app.close();
  if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
  if(dir?.startsWith(join(tmpdir(),'hunt-gallery-review-')))await rm(dir,{recursive:true,force:true});
 });
 it('keeps setup and unrelated APIs available when gallery initialization fails, and retries hunt initialization',async()=>{
  const setup=await runtime.app.inject({method:'POST',url:'/api/setup',payload:{password:'gallery-review-password-1234'}});expect(setup.statusCode).toBe(200);cookie=setup.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
  const bootstrap=await runtime.app.inject({url:'/api/bootstrap',headers:{cookie}});expect(bootstrap.statusCode).toBe(200);
  const before=initialization.mock.calls.length;
  const failed=await runtime.app.inject({url:'/api/hunt',headers:{cookie}});expect(failed.statusCode).toBe(503);expect(initialization.mock.calls.length).toBeGreaterThan(before);
  expect((await runtime.app.inject({url:'/api/bootstrap',headers:{cookie}})).statusCode).toBe(200);
  initialization.mockRestore();
  const recovered=await runtime.app.inject({url:'/api/hunt',headers:{cookie}});expect(recovered.statusCode).toBe(200);expect(recovered.json().references).toHaveLength(0);expect(recovered.json().settings.galleryVersion).toBeTypeOf('string');
 },30000);
 it('discards the prepared old worker when settings change while preparation awaits',async()=>{
  const old=await getHuntSettings(runtime.db);expect(old.galleryVersion).toBeTypeOf('string');
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const prepare=vi.spyOn(runtime.gallery,'prepare').mockImplementation(async()=>{entered();await gate;});
  const discard=vi.spyOn(runtime.gallery,'discard');
  const pending=runtime.hunt.matchGallery(old.version);
  // Attach the rejection observer before releasing the delayed preparation.
  const rejected=expect(pending).rejects.toMatchObject({statusCode:409});
  try{
   await started;
   await runtime.db.query("UPDATE settings SET value=value||$1::jsonb WHERE key='hunt'",[JSON.stringify({version:old.version+1,galleryVersion:randomUUID()})]);
   release();await rejected;
   expect(prepare).toHaveBeenCalledWith(old.galleryVersion);expect(discard).toHaveBeenCalledWith(old.galleryVersion);
  }finally{release();prepare.mockRestore();discard.mockRestore();}
 });
 it('refuses matching when the persisted gallery version is unavailable',async()=>{
  await runtime.db.query("UPDATE settings SET value=value-'galleryVersion' WHERE key='hunt'");
  const settings=await getHuntSettings(runtime.db),prepare=vi.spyOn(runtime.gallery,'prepare');
  try{await expect(runtime.hunt.matchGallery(settings.version)).rejects.toMatchObject({statusCode:503});expect(prepare).not.toHaveBeenCalled();}finally{prepare.mockRestore();}
 });
});
