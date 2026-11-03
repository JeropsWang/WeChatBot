/** 记忆重置默认预览；实际清理前备份，以 epoch 拒绝旧任务结果。 */
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {Database} from '../apps/server/db.js';
import {config} from '../apps/server/config.js';
import {resetMemories} from '../apps/server/memory-lifecycle.js';

const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(arg=>!['--apply','--dry-run'].includes(arg)))throw new Error('用法：npx tsx scripts/reset-memory.ts [--apply]，默认只预览');
const db=new Database(config.databaseUrl);
let pausedBefore:boolean|undefined;let restorePause=true;
try {
  const counts=(await db.query('SELECT (SELECT count(*)::int FROM memories) memories,(SELECT count(*)::int FROM members) members,(SELECT count(*)::int FROM documents) documents')).rows[0];
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',...counts,retains:'用户身份、知识库、人设、授权及离线备份；清空全部运行记忆、画像历史和当前个人模式'},null,2));
  if(apply){
    // The existing backup script targets this local deployment. Refuse mismatched targets.
    const url=new URL(config.databaseUrl);
    if(url.hostname!=='127.0.0.1'||url.port!=='54329')throw new Error('现有备份工具仅覆盖本机54329部署，拒绝对未备份的其他数据库重置');
    const destination=resolve('backups','memory-reset-'+new Date().toISOString().replace(/[:.]/g,'-'));
    pausedBefore=(await db.settings()).paused;
    await db.updateSettings(s=>({...s,paused:true}));
    await new Promise<void>((resolvePromise,reject)=>{
      const child=spawn(process.execPath,['scripts/backup.mjs',destination],{stdio:'inherit',windowsHide:true});
      child.on('error',reject);child.on('exit',code=>code===0?resolvePromise():reject(new Error('备份失败，未清空记忆')));
    });
    await db.migrate();
    const preserved=(await db.query('SELECT id,chat_id,number,sender_key,nickname,aliases,identity_status FROM members ORDER BY id')).rows;
    const result=await resetMemories(db);
    const after=(await db.query('SELECT id,chat_id,number,sender_key,nickname,aliases,identity_status FROM members ORDER BY id')).rows;
    const remaining=(await db.query('SELECT (SELECT count(*)::int FROM memories) memories,(SELECT count(*)::int FROM documents) documents')).rows[0];
    if(JSON.stringify(preserved)!==JSON.stringify(after)||remaining.memories!==0||remaining.documents!==counts.documents){restorePause=false;throw new Error('重置核对失败；保留暂停状态，请检查备份及数据库');}
    console.log(JSON.stringify({ok:true,...result,backup:destination,remaining},null,2));
  }
} finally {
  if(pausedBefore!==undefined&&restorePause)await db.updateSettings(s=>({...s,paused:pausedBefore!}));
  await db.close();
}
