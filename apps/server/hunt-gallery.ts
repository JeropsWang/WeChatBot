/** 管理图库与不可变版本快照。空安装允许无素材且关闭追猎；新版本准备失败保持旧版本，队列引用的历史资源不能直接物理删除。 */
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Database } from './db.js';
import type { ImageMatcher } from './image-matcher.js';

const run = promisify(execFile);
const dataDirPath = (directory: string) => dirname(directory);
const error = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const referenceIds = z
  .array(z.string().min(1).max(100))
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, '图片不能重复');
export type HuntReference = {
  id: string;
  name: string;
  source: 'builtin' | 'upload';
  status: 'ready';
  previewUrl: string;
  enabled: boolean;
};
export const referenceView = (row: any, enabled: string[]): HuntReference => ({
  id: row.id,
  name: row.name,
  source: row.source,
  status: 'ready',
  previewUrl: '/api/hunt/references/' + encodeURIComponent(row.id) + '/content',
  enabled: enabled.includes(row.id),
});

/** Catalog records and version files are retained so queue/history snapshots stay meaningful. */
export class HuntGallery {
  private directory: string;
  constructor(
    private db: Database,
    dataDir: string,
    private matcher: ImageMatcher,
    private options: { seedManifest?: string } = {},
  ) {
    this.directory = resolve(dataDir, 'hunt-gallery');
  }
  private async normalize(
    source: string,
    output: string,
    thumbnail: string,
    mime: string,
    crop?: number[],
  ) {
    try {
      await access(
        resolve(
          process.platform === 'win32'
            ? '.venv-image-match/Scripts/python.exe'
            : '.venv-image-match/bin/python',
        ),
      );
    } catch {
      throw error('图像环境未安装，请运行 scripts/setup-image-matching.ps1', 503);
    }
    try {
      await run(
        resolve(
          process.platform === 'win32'
            ? '.venv-image-match/Scripts/python.exe'
            : '.venv-image-match/bin/python',
        ),
        [
          resolve('scripts/gallery_image.py'),
          source,
          output,
          thumbnail,
          mime,
          ...(crop ? [JSON.stringify(crop)] : []),
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 8192 },
      );
    } catch {
      throw error('无法读取图片；仅支持静态 PNG、JPEG、WebP，且不超过 1600 万像素');
    }
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    await this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('hunt-gallery'))");
      const settings = (await c.query("SELECT value FROM settings WHERE key='hunt' FOR UPDATE"))
        .rows[0].value;
      if (settings.galleryVersion) return;
      const manifestPath =
        this.options.seedManifest ??
        resolve(dataDirPath(this.directory), 'image-match/references.json');
      // 只有文件缺失可视为空安装；损坏清单必须报错，不能覆盖已有配置。
      let manifest: { references: any[] };
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        manifest = { references: [] };
      }
      for (const ref of manifest.references) {
        const path = resolve(dirname(manifestPath), ref.path),
          thumbnail = join(this.directory, 'builtin-' + ref.id + '.png');
        const normalized = join(this.directory, 'builtin-' + ref.id + '-source.png');
        const bytes = await readFile(path);
        await this.normalize(path, normalized, thumbnail, 'image/png', ref.crop);
        await c.query(
          `INSERT INTO hunt_references(id,name,source,category,path,crop,digest,thumbnail) VALUES($1,$2,'builtin',$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
          [
            ref.id,
            ref.name ?? ref.id,
            ref.category,
            path,
            ref.crop ? JSON.stringify(ref.crop) : null,
            digest(bytes),
            thumbnail,
          ],
        );
      }
      const ids = manifest.references.map((r: any) => r.id);
      const version = await this.snapshot(c, ids, false);
      await c.query("UPDATE settings SET value=value||$1::jsonb WHERE key='hunt'", [
        JSON.stringify({
          enabledReferenceIds: ids,
          galleryVersion: version,
          ...(!ids.length ? { enabled: false } : {}),
        }),
      ]);
    });
  }
  async all(c: Pick<Database, 'query'> = this.db): Promise<HuntReference[]> {
    const settings = (await c.query("SELECT value FROM settings WHERE key='hunt'")).rows[0].value;
    return (
      await c.query(
        'SELECT * FROM hunt_references WHERE deleted_at IS NULL ORDER BY source,created_at,id',
      )
    ).rows.map((r) => referenceView(r, settings.enabledReferenceIds ?? []));
  }
  async list(input: unknown) {
    const q = z
      .object({
        q: z.string().trim().max(100).optional(),
        source: z.enum(['builtin', 'upload']).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(input);
    const rows = (await this.all()).filter(
      (r) =>
        (!q.q || r.name.toLocaleLowerCase().includes(q.q.toLocaleLowerCase())) &&
        (!q.source || r.source === q.source),
    );
    return {
      items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      total: rows.length,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
  async upload(input: unknown) {
    const value = z
      .object({
        name: z.string().trim().min(1).max(100),
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        data: z.string().min(4).max(6990508),
      })
      .parse(input);
    if (value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))
      throw error('图片 base64 编码无效');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.toString('base64') !== value.data) throw error('图片 base64 编码无效');
    if (bytes.length > 5 * 1024 * 1024) throw error('图片不能超过 5 MiB');
    const id = randomUUID(),
      hash = digest(bytes),
      source = join(this.directory, id + '.upload'),
      path = join(this.directory, id + '.png'),
      thumbnail = join(this.directory, id + '-thumb.png');
    await writeFile(source, bytes, { flag: 'wx' });
    let kept = false;
    try {
      await this.normalize(source, path, thumbnail, value.mimeType);
      const result = await this.db.tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext('hunt-gallery'))");
        const settings = (await c.query("SELECT value FROM settings WHERE key='hunt'")).rows[0]
          .value;
        const existing = (
          await c.query(
            'SELECT * FROM hunt_references WHERE digest=$1 ORDER BY created_at,id LIMIT 1',
            [hash],
          )
        ).rows[0];
        if (existing && !existing.deleted_at)
          return {
            item: referenceView(existing, settings.enabledReferenceIds ?? []),
            duplicate: true,
          };
        const count = (
          await c.query('SELECT count(*)::int n FROM hunt_references WHERE deleted_at IS NULL')
        ).rows[0].n;
        if (count >= 500) throw error('触发图库最多保留 500 张图片，请先删除部分自定义图片', 409);
        if (existing) {
          await c.query('UPDATE hunt_references SET deleted_at=NULL WHERE id=$1', [existing.id]);
          return { item: referenceView(existing, []), duplicate: true };
        }
        const row = (
          await c.query(
            `INSERT INTO hunt_references(id,name,source,category,path,digest,thumbnail) VALUES($1,$2,'upload',$2,$3,$4,$5) RETURNING *`,
            [id, value.name, path, hash, thumbnail],
          )
        ).rows[0];
        return { item: referenceView(row, settings.enabledReferenceIds ?? []), duplicate: false };
      });
      kept = !result.duplicate;
      return result;
    } finally {
      await rm(source, { force: true });
      if (!kept) await Promise.all([rm(path, { force: true }), rm(thumbnail, { force: true })]);
    }
  }
  async content(id: string) {
    z.string().min(1).max(100).parse(id);
    const row = (await this.db.query('SELECT thumbnail FROM hunt_references WHERE id=$1', [id]))
      .rows[0];
    if (!row) throw error('触发图片不存在', 404);
    return readFile(row.thumbnail);
  }
  async snapshot(c: PoolClient, ids: string[], prepare = true) {
    const rows = (
      await c.query(
        'SELECT * FROM hunt_references WHERE id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY id',
        [ids],
      )
    ).rows;
    if (rows.length !== ids.length) throw error('所选图片不存在或已被删除，请刷新图库', 409);
    const version = randomUUID(),
      manifest = join(this.directory, 'gallery-' + version + '.json');
    await writeFile(
      manifest,
      JSON.stringify({
        version,
        references: rows.map((r) => ({
          id: r.id,
          name: r.name,
          category: r.category,
          path: r.path,
          ...(r.crop ? { crop: r.crop } : {}),
        })),
      }),
      { flag: 'wx' },
    );
    try {
      if (prepare && ids.length) await this.matcher.prepareGallery?.(version, manifest);
      await c.query('INSERT INTO hunt_galleries(version,manifest,reference_ids) VALUES($1,$2,$3)', [
        version,
        manifest,
        JSON.stringify(ids),
      ]);
    } catch (e) {
      this.matcher.discardGallery?.(version);
      await rm(manifest, { force: true });
      throw error('图库准备失败，原设置和图片保持不变。请检查本地图像匹配环境后重试', 503);
    }
    return version;
  }
  async prepare(version: string) {
    const row = (
      await this.db.query('SELECT manifest FROM hunt_galleries WHERE version=$1', [version])
    ).rows[0];
    if (!row) throw error('图库版本不存在', 409);
    await access(row.manifest);
    await this.matcher.prepareGallery?.(version, row.manifest);
  }
  committed(version: string) {
    this.matcher.activateGallery?.(version);
  }
  discard(version: string) {
    this.matcher.discardGallery?.(version);
  }
  async lock(c: PoolClient) {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('hunt-gallery'))");
  }
  private async validate(
    c: PoolClient,
    old: any,
    value: { enabled: boolean; enabledReferenceIds?: string[]; deletedReferenceIds?: string[] },
  ) {
    const deleted = value.deletedReferenceIds ?? [],
      ids = value.enabledReferenceIds ?? old.enabledReferenceIds ?? [];
    if (deleted.length) {
      const rows = (
        await c.query(
          'SELECT id,source FROM hunt_references WHERE id=ANY($1::text[]) AND deleted_at IS NULL',
          [deleted],
        )
      ).rows;
      if (rows.length !== deleted.length || rows.some((r) => r.source !== 'upload'))
        throw error('只能删除仍存在的自定义触发图片', 409);
    }
    if (ids.some((id: string) => deleted.includes(id))) throw error('待删除图片不能同时启用');
    if (value.enabled && !ids.length) throw error('开启追猎时至少选择一张触发图片');
    const count = (
      await c.query(
        'SELECT id FROM hunt_references WHERE id=ANY($1::text[]) AND deleted_at IS NULL',
        [ids],
      )
    ).rowCount;
    if (count !== ids.length) throw error('所选图片不存在或已被删除，请刷新图库', 409);
    return { ids, deleted };
  }
  async stage(
    old: any,
    value: { enabled: boolean; enabledReferenceIds?: string[]; deletedReferenceIds?: string[] },
  ) {
    return this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('hunt-gallery'))");
      const { ids } = await this.validate(c, old, value);
      return this.snapshot(c, ids);
    });
  }
  async save(
    c: PoolClient,
    old: any,
    value: { enabled: boolean; enabledReferenceIds?: string[]; deletedReferenceIds?: string[] },
    version: string,
  ) {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('hunt-gallery'))");
    const { ids, deleted } = await this.validate(c, old, value);
    if (deleted.length)
      await c.query('UPDATE hunt_references SET deleted_at=now() WHERE id=ANY($1::text[])', [
        deleted,
      ]);
    return { enabledReferenceIds: ids, galleryVersion: version };
  }
}
