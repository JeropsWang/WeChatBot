/** 人设迁移保留既有业务要求，显式应用时保存版本供回滚。 */
import {readFile} from 'node:fs/promises';
import {Database} from '../apps/server/db.js';
import {config} from '../apps/server/config.js';
import type {Persona} from '../packages/contracts.js';

// User-requested natural conversation setup. Preview by default; apply is atomic and versioned.
if(process.argv.slice(2).some(arg=>!['--apply','--dry-run'].includes(arg)))throw new Error('仅支持 --dry-run 或 --apply');
const apply=process.argv.includes('--apply');
const base=JSON.parse(await readFile(new URL('../data-seeds/persona-natural-grounded.json',import.meta.url),'utf8')) as Persona;
const db=new Database(config.databaseUrl);
const knowledgeRules=(prompt:string)=>prompt.split('\n').map(line=>line.trim()).filter(line=>line.startsWith('主动参与时')||line.includes('涉及明日方舟'));
const configure=(current:Partial<Persona>,global:Persona):Persona=>{
 const retained=[...new Set([...knowledgeRules(global.prompt),...knowledgeRules(current.prompt??'')])];
 return {...base,prompt:base.prompt+(retained.length?'\n\n【保留的知识与主动参与要求】\n'+retained.join('\n'):'')};
};
const canonical=(persona:Partial<Persona>)=>JSON.stringify(Object.keys(persona).sort().map(key=>[key,(persona as any)[key]]));
try{
 const settings=await db.settings(),groups=await db.chats();
 const next=configure(settings.persona,settings.persona);
 const overrides=groups.filter(group=>group.persona.prompt?.trim()).map(group=>({id:group.id,persona:configure(group.persona,settings.persona),current:group.persona}));
 const changed=canonical(next)!==canonical(settings.persona),groupChanges=overrides.filter(group=>canonical(group.current)!==canonical(group.persona));
 console.log(JSON.stringify({mode:apply?'apply':'dry-run',globalChanged:changed,groupOverridesChanged:groupChanges.map(group=>group.id),fixedCharacterIdentity:false,preservesKnowledgeRequirements:true},null,2));
 if(apply&&(changed||groupChanges.length)){
  await db.updateSettings(async(current,c)=>{
   // Abort if the user edited the persona after previewing this run's snapshot.
   if(canonical(current.persona)!==canonical(settings.persona))throw new Error('全局人设已被修改，请重试');
   for(const group of groupChanges){
    const row=(await c.query('SELECT persona FROM chats WHERE id=$1 FOR UPDATE',[group.id])).rows[0];
    if(!row||canonical(row.persona)!==canonical(group.current))throw new Error('群人设已被修改，请重试');
    await c.query('UPDATE chats SET persona=$2,generation_epoch=generation_epoch+1 WHERE id=$1',[group.id,group.persona]);
    await c.query('INSERT INTO persona_versions(chat_id,persona) VALUES($1,$2)',[group.id,group.persona]);
   }
   return {...current,persona:next};
  });
  if(canonical((await db.settings()).persona)!==canonical(next))throw new Error('人设写入核对失败');
  for(const group of groupChanges)if(canonical((await db.chat(group.id))!.persona)!==canonical(group.persona))throw new Error('群人设写入核对失败');
  console.log(JSON.stringify({ok:true,verified:true,versioned:true,groupOverridesUpdated:groupChanges.length}));
 }
}finally{await db.close();}
