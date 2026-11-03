/** 管理群内互动与公共资料。互动命令在事务中执行配额和冷却检查，不能依赖仅存在于进程内的时间判断。 */
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Database } from './db.js';

const error = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
type Queryable = {
  query(sql: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
const foodInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    enabled: z.boolean().optional(),
    imageAssetId: z.string().uuid().nullable().optional(),
  })
  .strict();
const filtersSchema = z
  .object({
    q: z.string().max(1000).optional(),
    category: z.string().max(100).optional(),
    enabled: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((x) => x === 'true')])
      .optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce
      .number()
      .refine((n) => [20, 50, 100].includes(n))
      .default(20),
  })
  .strict();
export type FoodInput = z.input<typeof foodInput>;
export type FoodFilters = z.input<typeof filtersSchema>;
export interface FoodRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  enabled: boolean;
  imageAssetId: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FoodDraw {
  id: string;
  chatId: string;
  foodId: string;
  foodName: string;
  imageAssetId: string | null;
  candidates: FoodRecord[];
  createdAt: string;
}
export type DrawResult =
  | { status: 'drawn'; draw: FoodDraw }
  | { status: 'cooldown' }
  | { status: 'empty' };
const timestamp = (value: any) => (value instanceof Date ? value.toISOString() : value);
const foodRow = (row: any): FoodRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  category: row.category,
  tags: row.tags,
  enabled: row.enabled,
  imageAssetId: row.image_asset_id ?? null,
  imageUrl: row.image_asset_id ? '/api/media-assets/' + row.image_asset_id + '/content' : null,
  createdAt: timestamp(row.created_at),
  updatedAt: timestamp(row.updated_at),
});
const drawRow = (row: any): FoodDraw => ({
  id: row.id,
  chatId: row.chat_id,
  foodId: row.food_id,
  foodName: row.food_name,
  imageAssetId:
    row.candidates.find((food: FoodRecord) => food.id === row.food_id)?.imageAssetId ?? null,
  candidates: row.candidates,
  createdAt: timestamp(row.created_at),
});
const like = (value: string) => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';

export function parseFoodTrigger(text: string): boolean {
  const root = text
    .replace(/\r\n/g, '\n')
    .replace(/^\s*>.*$/gmu, '')
    .replace(
      /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》|"[^"]*"|'[^']*'/gu,
      '',
    );
  return root.replace(/[\s\p{P}\p{Z}]/gu, '').includes('今天吃什么');
}

export class CommunityService {
  private choose: (max: number) => number;
  constructor(
    private db: Database,
    options: { randomInt?: (max: number) => number } = {},
  ) {
    this.choose = options.randomInt ?? randomInt;
  }
  private async lockChat(c: PoolClient, chatId: string) {
    if (!(await c.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE', [chatId])).rowCount)
      throw error('群聊不存在', 404);
  }
  private async invalidate(c: PoolClient, chatIds: string[] = []) {
    await this.db.invalidateData(c, ['foods', ...chatIds.map((id) => 'chat:' + id)]);
  }
  private pick(foods: FoodRecord[]) {
    if (!foods.length) throw error('本群尚未选择可用的菜品，请先在菜库设置');
    const index = this.choose(foods.length);
    if (!Number.isSafeInteger(index) || index < 0 || index >= foods.length)
      throw new Error('随机菜品索引无效');
    return foods[index];
  }
  async listFoods(filters: FoodFilters = {}) {
    const f = filtersSchema.parse(filters),
      values: any[] = [],
      clauses: string[] = [];
    if (f.q?.trim()) {
      values.push(like(f.q.trim()));
      clauses.push(`(name ILIKE $1 OR description ILIKE $1 OR tags::text ILIKE $1)`);
    }
    for (const [column, value] of [
      ['category', f.category],
      ['enabled', f.enabled],
    ] as const)
      if (value !== undefined) {
        values.push(value);
        clauses.push(column + '=$' + values.length);
      }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '',
      total = Number(
        (await this.db.query('SELECT count(*) total FROM foods' + where, values)).rows[0].total,
      );
    const rows = (
      await this.db.query(
        'SELECT * FROM foods' +
          where +
          ` ORDER BY updated_at DESC,id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, f.pageSize, (f.page - 1) * f.pageSize],
      )
    ).rows;
    return { items: rows.map(foodRow), total, page: f.page, pageSize: f.pageSize };
  }
  async saveFood(id: string | undefined, input: FoodInput): Promise<FoodRecord> {
    const value = foodInput.parse(input);
    if (id) z.string().uuid().parse(id);
    return this.db.tx(async (c) => {
      const old = id
        ? (await c.query('SELECT * FROM foods WHERE id=$1 FOR UPDATE', [id])).rows[0]
        : undefined;
      if (id && !old) throw error('菜品不存在', 404);
      const imageAssetId =
        value.imageAssetId !== undefined ? value.imageAssetId : (old?.image_asset_id ?? null);
      if (
        imageAssetId &&
        !(
          await c.query(
            "SELECT id FROM media_assets WHERE id=$1 AND enabled=true AND kind='image' FOR SHARE",
            [imageAssetId],
          )
        ).rowCount
      )
        throw error('菜品图片必须是已启用的受管理图片素材');
      const row = (
        await c.query(
          `INSERT INTO foods(id,name,description,category,tags,enabled,image_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,tags=EXCLUDED.tags,enabled=EXCLUDED.enabled,image_asset_id=EXCLUDED.image_asset_id,updated_at=now() RETURNING *`,
          [
            id ?? randomUUID(),
            value.name,
            value.description ?? old?.description ?? '',
            value.category ?? old?.category ?? '菜品',
            JSON.stringify(value.tags ?? old?.tags ?? []),
            value.enabled ?? old?.enabled ?? true,
            imageAssetId,
          ],
        )
      ).rows[0];
      const chats = (
        await c.query('SELECT chat_id FROM chat_foods WHERE food_id=$1', [row.id])
      ).rows.map((row) => row.chat_id);
      if (!row.enabled) await c.query('DELETE FROM chat_foods WHERE food_id=$1', [row.id]);
      await this.invalidate(c, chats);
      return foodRow(row);
    });
  }
  async deleteFood(id: string) {
    z.string().uuid().parse(id);
    await this.db.tx(async (c) => {
      const old = (await c.query('SELECT id FROM foods WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!old) throw error('菜品不存在', 404);
      const chats = (
        await c.query('SELECT chat_id FROM chat_foods WHERE food_id=$1', [id])
      ).rows.map((row) => row.chat_id);
      await c.query('UPDATE foods SET enabled=false,updated_at=now() WHERE id=$1', [id]);
      await c.query('DELETE FROM chat_foods WHERE food_id=$1', [id]);
      await this.invalidate(c, chats);
    });
    return { ok: true };
  }
  async chatFoods(chatId: string) {
    return {
      foodIds: (
        await this.db.query('SELECT food_id FROM chat_foods WHERE chat_id=$1 ORDER BY food_id', [
          chatId,
        ])
      ).rows.map((row) => row.food_id as string),
    };
  }
  async setChatFoods(chatId: string, ids: string[]) {
    const foodIds = [...new Set(z.array(z.string().uuid()).max(100000).parse(ids))];
    await this.db.tx(async (c) => {
      await this.lockChat(c, chatId);
      const found = await c.query(
        'SELECT id FROM foods WHERE id=ANY($1::uuid[]) AND enabled=true ORDER BY id FOR SHARE',
        [foodIds],
      );
      if (found.rowCount !== foodIds.length) throw error('所选菜品不存在或已禁用');
      await c.query('DELETE FROM chat_foods WHERE chat_id=$1', [chatId]);
      await c.query(
        'INSERT INTO chat_foods(chat_id,food_id) SELECT $1,food_id FROM unnest($2::uuid[]) food_id',
        [chatId, foodIds],
      );
      await this.invalidate(c, [chatId]);
    });
    return this.chatFoods(chatId);
  }
  private async selected(c: Queryable, chatId: string, locking = false): Promise<FoodRecord[]> {
    return (
      await c.query(
        `SELECT f.* FROM foods f JOIN chat_foods cf ON cf.food_id=f.id WHERE cf.chat_id=$1 AND f.enabled=true ORDER BY f.id${locking ? ' FOR SHARE OF f' : ''}`,
        [chatId],
      )
    ).rows.map(foodRow);
  }
  async candidates(chatId: string) {
    return this.selected(this.db, chatId);
  }
  async preview(chatId: string) {
    const candidates = await this.candidates(chatId);
    return { food: this.pick(candidates), candidates };
  }
  async draw(chatId: string, messageId: string): Promise<DrawResult> {
    z.string().uuid().parse(messageId);
    return this.db.tx(async (c) => {
      await this.lockChat(c, chatId);
      if (
        !(
          await c.query("SELECT id FROM messages WHERE id=$1 AND chat_id=$2 AND direction='in'", [
            messageId,
            chatId,
          ])
        ).rowCount
      )
        throw error('抽签来源消息不属于当前群聊');
      const prior = (
        await c.query('SELECT * FROM food_draws WHERE source_message_id=$1', [messageId])
      ).rows[0];
      if (prior) return { status: 'drawn', draw: drawRow(prior) };
      if (
        (
          await c.query(
            "SELECT 1 FROM food_draws WHERE chat_id=$1 AND created_at>now()-interval '60 seconds' LIMIT 1",
            [chatId],
          )
        ).rowCount
      )
        return { status: 'cooldown' };
      const candidates = await this.selected(c, chatId, true);
      if (!candidates.length) return { status: 'empty' };
      const food = this.pick(candidates);
      const row = (
        await c.query(
          'INSERT INTO food_draws(id,chat_id,source_message_id,food_id,food_name,candidates) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [randomUUID(), chatId, messageId, food.id, food.name, JSON.stringify(candidates)],
        )
      ).rows[0];
      return { status: 'drawn', draw: drawRow(row) };
    });
  }
}
