import { expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../apps/server/db.js';
it.skipIf(!process.env.TEST_DATABASE_URL)('migrates the explicitly selected schema rather than inheriting public tables',async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Requires liino_test');
  const schema='isolation_'+randomUUID().replaceAll('-','');const admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);
  url.searchParams.set('options','-c search_path='+schema+',public');const db=new Database(url.href);
  try{await db.migrate();const result=await admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name='settings'",[schema]);expect(result.rowCount).toBe(1);}
  finally{await db.close();if(!/^isolation_[a-f0-9]{32}$/.test(schema))throw new Error('Unexpected schema');await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
});
