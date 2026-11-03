import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Database } from '../apps/server/db.js';
import { MemoryManager } from '../apps/server/memory-management.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'paginated memory management and frozen deletion',
  () => {
    let db: Database, admin: Database, manager: MemoryManager, schema: string;
    beforeAll(async () => {
      const url = new URL(process.env.TEST_DATABASE_URL!);
      if (url.pathname !== '/liino_test') throw new Error('Requires liino_test');
      schema = 'memory_management_' + randomUUID().replaceAll('-', '');
      admin = new Database(url.href);
      await admin.query('CREATE SCHEMA ' + schema);
      url.searchParams.set('options', '-c search_path=' + schema + ',public');
      db = new Database(url.href);
      await db.migrate();
      manager = new MemoryManager(db);
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        if (!/^memory_management_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected schema');
        await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
        await admin.close();
      }
    });
    it('paginates more than 500 records with stable ordering and combined filters', async () => {
      const marker = randomUUID();
      await db.query(
        `INSERT INTO memories(id,content,category,confidence,status,search_text,visibility,pinned)
      SELECT gen_random_uuid(),$1||n,'事实',1,'active',to_tsvector('simple',$1),'global',n=1 FROM generate_series(1,603) n`,
        [marker],
      );
      const first = await manager.list({
        q: marker,
        category: '事实',
        visibility: 'global',
        status: 'active',
        pageSize: 100,
      });
      const last = await manager.list({ q: marker, page: 7, pageSize: 100 });
      expect(first).toMatchObject({ total: 603, page: 1, pageSize: 100 });
      expect(first.items).toHaveLength(100);
      expect(first.items[0].pinned).toBe(true);
      expect(last.items).toHaveLength(3);
      expect((await manager.list({ q: marker, status: 'candidate' })).total).toBe(0);
    });
    it('freezes all filtered IDs, excludes future inserts and retries deletion without duplicate history', async () => {
      const marker = randomUUID();
      const a = await db.saveMemory({ content: marker, category: '事实' });
      const b = await db.saveMemory({ content: marker, category: '事实' });
      const selection = await manager.createSelection({ filters: { q: marker } });
      const future = await db.saveMemory({ content: marker, category: '事实' });
      expect(selection.count).toBe(2);
      expect(
        await manager.deleteSelection({ token: selection.token, includePinned: false }),
      ).toEqual({ deletedCount: 2 });
      expect(
        await manager.deleteSelection({ token: selection.token, includePinned: false }),
      ).toEqual({ deletedCount: 2 });
      expect((await manager.list({ q: marker })).items.map((x) => x.id)).toEqual([future.id]);
      expect(
        (
          await db.query(
            'SELECT count(*)::int n FROM memory_versions WHERE memory_id=ANY($1::uuid[])',
            [[a.id, b.id]],
          )
        ).rows[0].n,
      ).toBe(2);
    });
    it('requires explicit pinned consent and freezes versions against intervening edits', async () => {
      const a = await db.saveMemory({ content: randomUUID(), category: '事实', pinned: true });
      const b = await db.saveMemory({ content: randomUUID(), category: '事实' });
      const selected = await manager.createSelection({ ids: [a.id, b.id, a.id] });
      expect(selected).toMatchObject({ count: 2, pinnedCount: 1 });
      await expect(
        manager.deleteSelection({ token: selected.token, includePinned: false }),
      ).rejects.toThrow(/置顶/);
      await db.saveMemory({ id: b.id, content: 'changed', category: '事实' });
      await expect(
        manager.deleteSelection({ token: selected.token, includePinned: true }),
      ).rejects.toThrow(/变化|重选/);
      expect(
        (await db.query('SELECT status FROM memories WHERE id=$1', [a.id])).rows[0].status,
      ).toBe('active');
    });
    it('rejects expired selections', async () => {
      const selection = await manager.createSelection({ ids: [] });
      await db.query(
        "UPDATE memory_selections SET expires_at=now()-interval '1 second' WHERE token=$1",
        [selection.token],
      );
      await expect(
        manager.deleteSelection({ token: selection.token, includePinned: true }),
      ).rejects.toThrow(/过期/);
    });
    it('deletes a filtered snapshot larger than 500 without deleting a later matching insert', async () => {
      const marker = randomUUID();
      await db.query(
        `INSERT INTO memories(id,content,category,confidence,status,search_text,visibility,pinned)
      SELECT gen_random_uuid(),$1||n,'事件',1,'active',to_tsvector('simple',$1),'global',n%101=0 FROM generate_series(1,541) n`,
        [marker],
      );
      const selection = await manager.createSelection({
        filters: { q: marker, page: 3, pageSize: 20 },
      });
      expect(selection).toMatchObject({ count: 541, pinnedCount: 5 });
      const future = await db.saveMemory({ content: marker + 'future', category: '事件' });
      expect(
        await manager.deleteSelection({ token: selection.token, includePinned: true }),
      ).toEqual({ deletedCount: 541 });
      expect((await manager.list({ q: marker })).items.map((x) => x.id)).toEqual([future.id]);
    });
    it('selects explicit IDs across pages and invalidates affected scope versions', async () => {
      const marker = randomUUID(),
        source = await db.createChat({ name: '范围版本', bindingKey: randomUUID() });
      await db.query(
        `INSERT INTO memories(id,content,category,confidence,status,search_text,visibility,scope_chat_id)
      SELECT gen_random_uuid(),$1||n,'事实',1,'active',to_tsvector('simple',$1),'chat',$2 FROM generate_series(1,25) n`,
        [marker, source.id],
      );
      const first = await manager.list({ q: marker, page: 1 }),
        second = await manager.list({ q: marker, page: 2 });
      const ids = [first.items[0].id, second.items[0].id];
      const selection = await manager.createSelection({ ids });
      expect(
        await manager.deleteSelection({ token: selection.token, includePinned: false }),
      ).toEqual({ deletedCount: 2 });
      expect((await manager.list({ q: marker, chatId: source.id })).total).toBe(23);
      expect(
        (
          await db.query('SELECT scope FROM data_versions WHERE scope=ANY($1::text[])', [
            ['knowledge', 'memory', 'chat:' + source.id],
          ])
        ).rowCount,
      ).toBe(3);
    });
    it('paginates global imported documents using document status and arbitrary categories', async () => {
      const marker = randomUUID();
      await db.query(
        `INSERT INTO documents(id,title,source,category,content,status)
      SELECT gen_random_uuid(),$1||n,'fixture','操作流程','正文','keyword-only' FROM generate_series(1,24) n`,
        [marker],
      );
      const page = await manager.listDocuments({
        q: marker,
        category: '操作流程',
        status: 'keyword-only',
        page: 2,
      });
      expect(page).toMatchObject({ total: 24, page: 2, pageSize: 20 });
      expect(page.items).toHaveLength(4);
      expect((await manager.listDocuments({ q: marker, visibility: 'member' })).total).toBe(0);
    });
    it('quarantines legacy records while preserving original pin, evidence and historical snapshot', async () => {
      const legacySchema = 'memory_legacy_' + randomUUID().replaceAll('-', '');
      await admin.query('CREATE SCHEMA ' + legacySchema);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', '-c search_path=' + legacySchema + ',public');
      const legacy = new Database(url.href);
      try {
        await legacy.query(
          await readFile(
            new URL('../apps/server/migrations/001_initial.sql', import.meta.url),
            'utf8',
          ),
        );
        await legacy.query(
          await readFile(
            new URL('../apps/server/migrations/003_members_features.sql', import.meta.url),
            'utf8',
          ),
        );
        const chatId = randomUUID(),
          id = randomUUID(),
          evidence = randomUUID();
        await legacy.query('INSERT INTO chats(id,name,binding_key) VALUES($1,$2,$3)', [
          chatId,
          '旧群',
          randomUUID(),
        ]);
        await legacy.query(
          `INSERT INTO memories(id,content,category,confidence,status,pinned,version,source_chat_id,source_message_ids,search_text,embedding,embedding_version)
        VALUES($1,'原有正文','偏好',1,'active',true,5,$2,$3,to_tsvector('simple','原有正文'),'[1,0]'::vector,1)`,
          [id, chatId, JSON.stringify([evidence])],
        );
        await legacy.query(
          await readFile(
            new URL('../apps/server/migrations/004_memory_management.sql', import.meta.url),
            'utf8',
          ),
        );
        expect(
          (await legacy.query('SELECT * FROM memories WHERE id=$1', [id])).rows[0],
        ).toMatchObject({
          content: '原有正文',
          pinned: true,
          status: 'candidate',
          visibility: 'unassigned',
          scope_chat_id: chatId,
          member_id: null,
          version: 6,
          source_message_ids: [evidence],
          embedding: null,
          embedding_version: null,
        });
        expect(
          (
            await legacy.query('SELECT version,snapshot FROM memory_versions WHERE memory_id=$1', [
              id,
            ])
          ).rows[0],
        ).toMatchObject({
          version: 5,
          snapshot: { status: 'active', pinned: true, content: '原有正文' },
        });
      } finally {
        await legacy.close();
        if (!/^memory_legacy_[a-f0-9]{32}$/.test(legacySchema))
          throw new Error('Unexpected schema');
        await admin.query('DROP SCHEMA ' + legacySchema + ' CASCADE');
      }
    });
  },
);
