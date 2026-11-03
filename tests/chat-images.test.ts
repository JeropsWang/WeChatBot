import { expect, it, describe, beforeAll, afterAll } from 'vitest';
import { imageRequestTarget, ChatImagesService } from '../apps/server/chat-images.js';
import { Database } from '../apps/server/db.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
it('does not silently choose another image after an unresolved quote or identifier', () => {
  expect(imageRequestTarget('/识图 I0012')).toEqual({ number: 12 });
  expect(imageRequestTarget('引用 某人：[图片] 帮我识图')).toEqual({ unresolvedQuote: true });
  expect(imageRequestTarget('/识图')).toEqual({});
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGM8YRTAAAZMEIqBgQEAF+gBTt22usoAAAAASUVORK5CYII=';
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'chat image ownership and vision integration',
  () => {
    let db: Database,
      admin: Database,
      schema: string,
      dir: string,
      service: ChatImagesService,
      chat: any,
      owner: string,
      other: string;
    const runs: any[] = [];
    beforeAll(async () => {
      const url = new URL(process.env.TEST_DATABASE_URL!);
      if (url.pathname !== '/liino_test') throw Error('Requires isolated liino_test');
      schema = 'images_' + randomUUID().replaceAll('-', '');
      admin = new Database(url.href);
      await admin.query('CREATE SCHEMA ' + schema);
      url.searchParams.set('options', '-c search_path=' + schema + ',public');
      db = new Database(url.href);
      await db.migrate();
      dir = await mkdtemp(join(tmpdir(), 'chat-img-'));
      chat = await db.createChat({ name: '图片夹具', bindingKey: randomUUID() });
      owner = randomUUID();
      other = randomUUID();
      for (const [n, id] of [owner, other].entries())
        await db.query(
          'INSERT INTO members(id,chat_id,number,sender_key,nickname) VALUES($1,$2,$3,$4,$5)',
          [id, chat.id, n + 1, 'ui-profile:' + id, '成员' + n],
        );
      const model = randomUUID();
      await db.query('INSERT INTO models(id,config) VALUES($1,$2)', [
        model,
        {
          id: model,
          name: 'vision',
          model: 'fixture',
          supportsVision: true,
          protocol: 'openai-compatible',
          baseUrl: 'http://fixture.invalid',
          contextWindow: 32768,
        },
      ]);
      await db.updateSettings((s) => ({ ...s, chatModelId: model }));
      service = new ChatImagesService(
        db,
        dir,
        {
          run: async (input: any) => {
            runs.push(input);
            return { text: '这是实际图片', usage: {} };
          },
        } as any,
        { get: async () => undefined } as any,
      );
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
        await admin.close();
      }
      if (dir?.startsWith(join(tmpdir(), 'chat-img-')))
        await rm(dir, { recursive: true, force: true });
    });
    async function image(member: string | null = owner) {
      const eventId = randomUUID(),
        attachmentId = randomUUID(),
        messageId = randomUUID();
      await db.query(
        "INSERT INTO messages(id,event_id,chat_id,content,direction,observed_at,state) VALUES($1,$2,$3,'[图片]','in',now(),'observed')",
        [messageId, eventId, chat.id],
      );
      const event = {
        type: 'image',
        eventId,
        chatId: chat.id,
        observedAt: new Date().toISOString(),
        image: { attachmentId, status: 'pending' },
      };
      await service.registerEvent(event, messageId, member ?? undefined);
      return {
        event,
        messageId,
        payload: {
          attachmentId,
          eventId,
          chatId: chat.id,
          mimeType: 'image/png',
          width: 3,
          height: 2,
          sha256: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'),
          quality: 'thumbnail',
          data: png,
        },
      };
    }
    it('keeps occurrence IDs distinct, validates uploads, and passes source bytes and plan prompt', async () => {
      const a = await image(),
        b = await image(other);
      await service.upload(a.payload);
      await service.upload(b.payload);
      expect((await service.list(chat.id)).slice(0, 2).map((x) => x.id)).toEqual([
        b.payload.attachmentId,
        a.payload.attachmentId,
      ]);
      await expect(service.upload({ ...a.payload, width: 9 })).rejects.toThrow(/尺寸/);
      await expect(service.upload({ ...a.payload, data: 'not-base64' })).rejects.toThrow();
      const number = (
        await db.query('SELECT number FROM chat_images WHERE id=$1', [b.payload.attachmentId])
      ).rows[0].number;
      const result = await service.recognize({
        chatId: chat.id,
        memberId: owner,
        input: '/识图 I' + number,
        systemPrompt: '计划人格',
        dynamicContext: '本轮图片背景',
        priority: 1,
      });
      expect(result.attachmentId).toBe(b.payload.attachmentId);
      expect(runs.at(-1)).toMatchObject({
        images: [{ type: 'image', mimeType: 'image/png', data: png }],
        priority: 1,
        dynamicContext: '本轮图片背景',
      });
      expect(runs.at(-1).systemPrompt).toContain('计划人格');
    });
    it('counts the screenshot note inside the brief limit but preserves requested detailed analysis', async () => {
      const a = await image();
      await service.upload(a.payload);
      const number = (
        await db.query('SELECT number FROM chat_images WHERE id=$1', [a.payload.attachmentId])
      ).rows[0].number;
      const talkative = new ChatImagesService(
        db,
        dir,
        { run: async () => ({ text: '图片中能看到一片蓝色区域'.repeat(30), usage: {} }) } as any,
        { get: async () => undefined } as any,
      );
      const brief = await talkative.recognize({
        chatId: chat.id,
        memberId: owner,
        input: '/识图 I' + number,
      });
      expect(brief.text).toContain('截图');
      expect([...brief.text].length).toBeLessThanOrEqual(50);
      const detailed = await talkative.recognize({
        chatId: chat.id,
        memberId: owner,
        input: '/识图 I' + number + ' 请详细分析图片内容',
      });
      expect(detailed.text.length).toBeGreaterThan(50);
      expect(detailed.text).toContain('可能不够清晰');
    });
    it('does not pick another author by default, nor fall back past a newer unknown image', async () => {
      const a = await image();
      await service.upload(a.payload);
      const b = await image(null);
      await service.upload(b.payload);
      const before = runs.length;
      expect(
        (await service.recognize({ chatId: chat.id, memberId: owner, input: '/识图' })).text,
      ).toContain('发图者未能确认');
      expect(runs).toHaveLength(before);
      expect(
        (await service.recognize({ chatId: chat.id, memberId: owner, input: '引用：[图片] 识图' }))
          .text,
      ).toContain('不能唯一');
    });
    it('uses request observation time for the default window even after a long queue wait', async () => {
      const a = await image();
      await service.upload(a.payload);
      await db.query("UPDATE chat_images SET observed_at=now()-interval '25 minutes' WHERE id=$1", [
        a.payload.attachmentId,
      ]);
      const messageId = randomUUID(),
        eventId = randomUUID();
      const request = (
        await db.query(
          "INSERT INTO messages(id,event_id,chat_id,content,direction,observed_at,state) VALUES($1,$2,$3,'/识图','in',now()-interval '20 minutes','observed') RETURNING seq",
          [messageId, eventId, chat.id],
        )
      ).rows[0];
      const result = await service.recognize({
        chatId: chat.id,
        memberId: owner,
        input: '/识图',
        requestSeq: request.seq,
      });
      expect(result.attachmentId).toBe(a.payload.attachmentId);
    });
    it('expires attachments and cancels dependent sends while retaining tombstone metadata', async () => {
      const a = await image();
      await service.upload(a.payload);
      const send = randomUUID();
      await db.query(
        "INSERT INTO sends(id,chat_id,content,kind,status,epoch,attachment_id) VALUES($1,$2,'旧结果','explicit','pending',0,$3)",
        [send, chat.id, a.payload.attachmentId],
      );
      await db.query("UPDATE chat_images SET observed_at=now()-interval '31 days' WHERE id=$1", [
        a.payload.attachmentId,
      ]);
      expect(await service.cleanup()).toBeGreaterThan(0);
      expect(await service.available(a.payload.attachmentId, chat.id)).toBe(false);
      expect((await db.query('SELECT status FROM sends WHERE id=$1', [send])).rows[0].status).toBe(
        'cancelled',
      );
      await expect(service.upload(a.payload)).rejects.toMatchObject({ statusCode: 410 });
    });
  },
);
