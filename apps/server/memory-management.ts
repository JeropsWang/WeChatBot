/** 提供记忆检索、筛选、冻结选择与删除操作。跨页全选使用服务端快照，删除不得重跑可能已变化的过滤条件。 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { memoryRow, type Database } from './db.js';

const filtersSchema = z.object({
  q: z.string().max(2000).optional(), status: z.enum(['active','candidate','conflicted','deleted']).optional(),
  category: z.enum(['事实','偏好','关系','事件','经验']).optional(),
  visibility: z.enum(['global','chat','member','unassigned']).optional(),
  chatId: z.string().uuid().optional(), memberId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().refine(n => [20,50,100].includes(n), '每页只允许20、50或100条').default(20),
}).strict();
const documentFiltersSchema = filtersSchema.extend({ status:z.string().max(100).optional(),category:z.string().max(100).optional() });
export type MemoryFilters = z.input<typeof filtersSchema>;
export type DocumentFilters = z.input<typeof documentFiltersSchema>;
const fail = (message: string, statusCode=409) => Object.assign(new Error(message), { statusCode });
const like = (value: string) => '%' + value.replace(/[\\%_]/g,'\\$&') + '%';

function memoryFilter(filters: MemoryFilters = {}) {
  const f = filtersSchema.parse(filters), values: unknown[] = [], clauses: string[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', '$' + values.length)); };
  if (f.status) add('m.status=?', f.status); else clauses.push("m.status<>'deleted'");
  if (f.q?.trim()) { values.push(like(f.q.trim())); clauses.push(`(m.content ILIKE $${values.length} OR m.tags::text ILIKE $${values.length})`); }
  if (f.category) add('m.category=?',f.category);
  if (f.visibility) add('m.visibility=?',f.visibility);
  if (f.chatId) add('m.scope_chat_id=?',f.chatId);
  if (f.memberId) add('m.member_id=?',f.memberId);
  return { f, values, where: clauses.join(' AND ') || 'true' };
}

export class MemoryManager {
  constructor(private db: Database) {}
  async list(filters: MemoryFilters = {}) {
    const { f, values, where } = memoryFilter(filters);
    const total = Number((await this.db.query(`SELECT count(*) total FROM memories m WHERE ${where}`,values)).rows[0].total);
    const rows = await this.db.query(`SELECT m.*,c.name source_name FROM memories m LEFT JOIN chats c ON c.id=m.source_chat_id
      WHERE ${where} ORDER BY m.pinned DESC,m.updated_at DESC,m.id LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values,f.pageSize,(f.page-1)*f.pageSize]);
    return { items: rows.rows.map(memoryRow), total, page: f.page, pageSize: f.pageSize };
  }
  async createSelection(input: { ids?: string[]; filters?: MemoryFilters }) {
    if ((input.ids === undefined) === (input.filters === undefined)) throw fail('请指定记忆ID或筛选条件之一',400);
    const token = randomBytes(32).toString('hex');
    return this.db.tx(async c => {
      let rows: any[];
      if (input.ids !== undefined) {
        const ids = [...new Set(z.array(z.string().uuid()).max(100000).parse(input.ids))];
        rows = (await c.query("SELECT id,version,pinned FROM memories WHERE id=ANY($1::uuid[]) AND status<>'deleted' ORDER BY id FOR SHARE",[ids])).rows;
        if (rows.length !== ids.length) throw fail('部分记忆已删除，请重新选择');
      } else {
        const { values, where } = memoryFilter(input.filters);
        rows = (await c.query(`SELECT m.id,m.version,m.pinned FROM memories m WHERE ${where} AND m.status<>'deleted' ORDER BY m.id FOR SHARE`,values)).rows;
      }
      const stored = await c.query("INSERT INTO memory_selections(token,snapshot,expires_at) VALUES($1,$2,now()+interval '10 minutes') RETURNING expires_at",[token,JSON.stringify(rows)]);
      return { token, count: rows.length, pinnedCount: rows.filter(row => row.pinned).length, expiresAt: stored.rows[0].expires_at.toISOString() };
    });
  }
  async deleteSelection(input: { token: string; includePinned: boolean }) {
    const token = z.string().regex(/^[a-f0-9]{64}$/).parse(input.token);
    const includePinned = z.boolean().parse(input.includePinned);
    return this.db.tx(async c => {
      const selection = (await c.query('SELECT *,expires_at<=now() expired FROM memory_selections WHERE token=$1 FOR UPDATE',[token])).rows[0];
      if (!selection || selection.expired) throw fail('选择已过期，请重新选择',410);
      if (selection.deleted_count !== null) return { deletedCount: selection.deleted_count as number };
      const snapshot = selection.snapshot as { id:string; version:number; pinned:boolean }[];
      if (!includePinned && snapshot.some(row => row.pinned)) throw fail('选择包含置顶记忆，请明确确认删除置顶记忆');
      const rows = (await c.query('SELECT * FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[snapshot.map(row => row.id)])).rows;
      const live = new Map(rows.map(row => [row.id,row]));
      if (snapshot.some(row => !live.has(row.id) || live.get(row.id).version !== row.version || live.get(row.id).status==='deleted')) throw fail('所选记忆已变化，请重新选择');
      await this.db.softDeleteMemories(c,rows);
      await c.query('UPDATE memory_selections SET deleted_count=$2 WHERE token=$1',[token,rows.length]);
      return { deletedCount: rows.length };
    });
  }
  async listDocuments(filters: DocumentFilters = {}) {
    const f = documentFiltersSchema.parse(filters), values: unknown[] = [], clauses = ['true'];
    if (f.visibility && f.visibility!=='global') clauses.push('false');
    if (f.chatId || f.memberId) clauses.push('false');
    for (const [field,value] of [['status',f.status],['category',f.category]] as const) if (value) { values.push(value); clauses.push(`${field}=$${values.length}`); }
    if (f.q?.trim()) { values.push(like(f.q.trim())); clauses.push(`(title ILIKE $${values.length} OR content ILIKE $${values.length} OR source ILIKE $${values.length})`); }
    const where = clauses.join(' AND ');
    const total = Number((await this.db.query(`SELECT count(*) total FROM documents WHERE ${where}`,values)).rows[0].total);
    const items = (await this.db.query(`SELECT * FROM documents WHERE ${where} ORDER BY created_at DESC,id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,f.pageSize,(f.page-1)*f.pageSize])).rows;
    return { items, total, page: f.page, pageSize: f.pageSize };
  }
}
