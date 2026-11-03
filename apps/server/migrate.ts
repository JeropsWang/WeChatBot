/** 显式运行数据库迁移；只连接配置指定的数据库，执行前应确认目标与备份。 */
import { Database } from './db.js';
import { config } from './config.js';
const db = new Database(config.databaseUrl);
try {
  await db.migrate();
  console.log('数据库迁移完成');
} finally {
  await db.close();
}
