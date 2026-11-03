import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Database} from '../apps/server/db.js';
import {CommunityService,parseFoodTrigger} from '../apps/server/community.js';

describe('root food triggers',()=>{
  it('normalizes punctuation/space and rejects quoted and code text',()=>{
    expect(parseFoodTrigger('测试机器人，今天 吃 什么？')).toBe(true);
    for(const text of ['> 今天吃什么','他说「今天吃什么」','```今天吃什么```','"今天吃什么"','今天喝什么'])expect(parseFoodTrigger(text)).toBe(false);
  });
});
describe.skipIf(!process.env.TEST_DATABASE_URL)('shared foods and group-specific deterministic draws',()=>{
  let db:Database,admin:Database,service:CommunityService,schema:string;
  beforeAll(async()=>{const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Requires liino_test');schema='community_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();service=new CommunityService(db,{randomInt:max=>max-1});});
  afterAll(async()=>{await db?.close();if(admin){if(!/^community_[a-f0-9]{32}$/.test(schema))throw new Error('Unexpected schema');await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}});
  const chat=()=>db.createChat({name:'食物测试',bindingKey:randomUUID()});
  async function message(chatId:string){return (await db.ingest({eventId:randomUUID(),chatId,accountId:'fixture',content:'今天吃什么',observedAt:new Date().toISOString(),isSelf:false,mentioned:false,type:'text'}))!;}
  it('requires explicit per-chat choices, previews without writes and freezes/replays draws before cooldown',async()=>{
    const a=await chat(),b=await chat();const x=await service.saveFood(undefined,{name:'面条'}),y=await service.saveFood(undefined,{name:'米饭'});
    expect(await service.candidates(a.id)).toEqual([]);await expect(service.preview(a.id)).rejects.toMatchObject({statusCode:400});
    await service.setChatFoods(a.id,[x.id,y.id]);await service.setChatFoods(b.id,[x.id]);
    const before=(await db.query('SELECT count(*)::int n FROM food_draws')).rows[0].n;
    const preview=await service.preview(a.id);expect(preview.candidates).toHaveLength(2);expect(preview.food.id).toBe(preview.candidates[1].id);expect((await db.query('SELECT count(*)::int n FROM food_draws')).rows[0].n).toBe(before);
    const id=await message(a.id),drawn=await service.draw(a.id,id);expect(drawn.status).toBe('drawn');
    await service.setChatFoods(a.id,[x.id]);expect(await service.draw(a.id,id)).toEqual(drawn);
    expect(await service.draw(a.id,await message(a.id))).toEqual({status:'cooldown'});
    expect((await service.draw(b.id,await message(b.id))).status).toBe('drawn');
    await expect(service.draw(b.id,id)).rejects.toMatchObject({statusCode:400});
    await db.query("UPDATE food_draws SET created_at=now()-interval '61 seconds' WHERE chat_id=$1",[a.id]);
    expect((await service.draw(a.id,await message(a.id))).status).toBe('drawn');
  });
  it('soft-disables food, removes selections and retains existing frozen history',async()=>{
    const a=await chat(),food=await service.saveFood(undefined,{name:'历史食物',tags:['家常']});await service.setChatFoods(a.id,[food.id]);
    const source=await message(a.id),draw=await service.draw(a.id,source);await service.deleteFood(food.id);
    expect(await service.chatFoods(a.id)).toEqual({foodIds:[]});expect(await service.candidates(a.id)).toEqual([]);expect(await service.draw(a.id,source)).toEqual(draw);
    const b=await chat();expect(await service.draw(b.id,await message(b.id))).toEqual({status:'empty'});
    await expect(service.setChatFoods(a.id,[food.id])).rejects.toThrow(/菜|食|禁用/);
    expect((await service.listFoods({q:'历史食物'})).items[0].enabled).toBe(false);
  });
  it('reaches every candidate by a uniform index and serializes simultaneous group draws',async()=>{
    const a=await chat(),foods=[];
    for(let n=0;n<3;n++)foods.push(await service.saveFood(undefined,{name:'均匀候选'+n}));
    await service.setChatFoods(a.id,foods.map(row=>row.id));
    const candidateIds=(await service.candidates(a.id)).map(row=>row.id),picked=[];
    for(let index=0;index<3;index++){
      const fixed=new CommunityService(db,{randomInt:max=>{expect(max).toBe(3);return index;}});
      picked.push((await fixed.preview(a.id)).food.id);
    }expect(picked).toEqual(candidateIds);
    const first=await message(a.id),second=await message(a.id),results=await Promise.all([service.draw(a.id,first),service.draw(a.id,second)]);
    expect(results.map(row=>row.status).sort()).toEqual(['cooldown','drawn']);
  });
  it('paginates the maintained food library and filters disabled items',async()=>{
    const marker=randomUUID();
    await db.query(`INSERT INTO foods(id,name,enabled) SELECT gen_random_uuid(),$1||n,n<>1 FROM generate_series(1,27) n`,[marker]);
    expect(await service.listFoods({q:marker,page:2})).toMatchObject({total:27,page:2,pageSize:20});
    expect((await service.listFoods({q:marker,enabled:'false'})).total).toBe(1);
  });
  it('persists only enabled managed food images and freezes the image reference for replay',async()=>{
    const a=await chat(),imageId=randomUUID(),gifId=randomUUID(),disabledId=randomUUID();
    await db.query("INSERT INTO media_assets(id,name,kind,mime_type,enabled) VALUES($1,'菜图','image','image/png',true),($2,'动图','gif','image/gif',true),($3,'停用图','image','image/png',false)",[imageId,gifId,disabledId]);
    await expect(service.saveFood(undefined,{name:'错误动图',imageAssetId:gifId})).rejects.toThrow(/图片/);
    await expect(service.saveFood(undefined,{name:'停用图片',imageAssetId:disabledId})).rejects.toThrow(/图片/);
    const food=await service.saveFood(undefined,{name:'带图菜品',imageAssetId:imageId});expect(food).toMatchObject({imageAssetId:imageId,imageUrl:'/api/media-assets/'+imageId+'/content'});
    await service.setChatFoods(a.id,[food.id]);const source=await message(a.id),draw=await service.draw(a.id,source);expect(draw.status==='drawn'&&draw.draw.imageAssetId).toBe(imageId);
    await service.saveFood(food.id,{name:'已改名',imageAssetId:null});expect(await service.draw(a.id,source)).toEqual(draw);
    expect((await service.listFoods({q:'已改名'})).items[0].imageAssetId).toBeNull();
  });
});
