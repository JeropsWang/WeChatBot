/** 人设导入默认预览；显式 --apply 才写入并保留历史快照。 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '../apps/server/db.js';
import { config } from '../apps/server/config.js';
import type { Persona } from '../packages/contracts.js';

// Installs a persona payload (see data-seeds/persona-*.json) into the live settings row.
// Preview is the default; --apply writes one version row so the change is auditable.
const args = process.argv.slice(2);
if (args.some((arg) => !['--apply', '--dry-run'].includes(arg) && !arg.startsWith('--file=')))
  throw new Error(
    '用法：npx tsx scripts/set-persona.ts [--file=data-seeds/persona-natural-grounded.json] [--apply]，默认只预览',
  );
const apply = args.includes('--apply');
const file = resolve(
  args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length) ??
    'data-seeds/persona-natural-grounded.json',
);

const lengths = ['简短', '适中', '详细'] as const,
  formalities = ['自然', '正式'] as const,
  humors = ['克制', '偶尔幽默', '活泼'] as const,
  emojis = ['不用', '偶尔', '经常'] as const;
function readPersona(raw: string): Persona {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${file} 不是合法 JSON`);
  }
  const p = value as Record<string, unknown>;
  const pick = <T extends string>(key: string, allowed: readonly T[]): T => {
    const found = String(p[key] ?? '') as T;
    if (!allowed.includes(found))
      throw new Error(`${key} 必须是 ${allowed.join('/')}，当前为 ${String(p[key])}`);
    return found;
  };
  const prompt = String(p.prompt ?? ''),
    examples = String(p.examples ?? '');
  if (!prompt.trim()) throw new Error('prompt 不能为空');
  if (prompt.length > 30000) throw new Error(`prompt 超过30000字（当前${prompt.length}）`);
  if (examples.length > 10000) throw new Error(`examples 超过10000字（当前${examples.length}）`);
  return {
    prompt,
    examples,
    length: pick('length', lengths),
    formality: pick('formality', formalities),
    humor: pick('humor', humors),
    emoji: pick('emoji', emojis),
  };
}

const persona = readPersona(await readFile(file, 'utf8'));
// jsonb stores object keys sorted, so compare by field order-independently.
const canonical = (p: Persona) =>
  JSON.stringify(
    Object.keys(p)
      .sort()
      .map((key) => [key, (p as unknown as Record<string, string>)[key]]),
  );
const db = new Database(config.databaseUrl);
try {
  const current = (await db.settings()).persona;
  const changed = canonical(current) !== canonical(persona);
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        file,
        changed,
        current: {
          promptLength: current.prompt.length,
          examplesLength: current.examples.length,
          length: current.length,
          humor: current.humor,
          headline: current.prompt.slice(0, 40),
        },
        next: {
          promptLength: persona.prompt.length,
          examplesLength: persona.examples.length,
          length: persona.length,
          humor: persona.humor,
          headline: persona.prompt.slice(0, 40),
        },
        note: changed
          ? '加 --apply 写入；会新增一条 persona_versions 快照，不需要重启服务'
          : '内容相同，无需写入',
      },
      null,
      2,
    ),
  );
  if (apply && changed) {
    const before = (
      await db.query('SELECT count(*)::int count FROM persona_versions WHERE chat_id IS NULL')
    ).rows[0].count;
    await db.updateSettings((s) => ({ ...s, persona }));
    const after = (
      await db.query('SELECT count(*)::int count FROM persona_versions WHERE chat_id IS NULL')
    ).rows[0].count;
    const stored = (await db.settings()).persona;
    if (canonical(stored) !== canonical(persona))
      throw new Error('写入核对失败：数据库中的设置与请求不一致，请检查数据库');
    if (after !== before + 1)
      throw new Error(`写入核对失败：人设快照数应增加1（${before}→${after}），请检查数据库`);
    console.log(JSON.stringify({ ok: true, versions: after, verified: true }, null, 2));
  }
} finally {
  await db.close();
}
