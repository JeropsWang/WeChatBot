import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HuntGallery } from '../apps/server/hunt-gallery.js';
it('initializes a missing seed as a disabled empty gallery without invoking Python', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-first-'));
  let saved: any;
  const client = {
    query: async (sql: string, args?: any[]) => {
      if (sql.startsWith('SELECT value')) return { rows: [{ value: { enabled: true } }] };
      if (sql.startsWith('SELECT * FROM hunt_references')) return { rows: [] };
      if (sql.startsWith('UPDATE settings')) saved = JSON.parse(args![0]);
      return { rows: [] };
    },
  };
  const db = { tx: async (fn: any) => fn(client) } as any;
  const matcher = {
    prepareGallery: async () => {
      throw Error('must not start');
    },
  } as any;
  try {
    await new HuntGallery(db, dir, matcher, { seedManifest: join(dir, 'absent.json') }).init();
    expect(saved.enabled).toBe(false);
    expect(saved.enabledReferenceIds).toEqual([]);
    expect(saved.galleryVersion).toBeTypeOf('string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
