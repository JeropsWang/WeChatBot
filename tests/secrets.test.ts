import { beforeEach,expect,it,vi } from 'vitest';
import { mkdtemp,mkdir,readFile,rename } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { SecretStore } from '../apps/server/secrets.js';
vi.mock('node:fs/promises',async original=>{const actual=await original<typeof import('node:fs/promises')>();return {...actual,rename:vi.fn(actual.rename)};});
beforeEach(()=>{vi.mocked(rename).mockClear();});
it('keeps the previous vault and in-memory values if an atomic replacement fails',async()=>{
  const parent=resolve('artifacts/tmp');await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,'vault-'));
  const store=new SecretStore(directory,false);await store.init();await store.set('provider','original-key');const previous=await readFile(join(directory,'secrets.json'),'utf8');
  vi.mocked(rename).mockRejectedValueOnce(new Error('simulated disk replacement failure'));
  await expect(store.set('provider','replacement-key')).rejects.toThrow('simulated disk');
  expect(await readFile(join(directory,'secrets.json'),'utf8')).toBe(previous);expect(await store.get('provider')).toBe('original-key');
  const reopened=new SecretStore(directory,false);await reopened.init();expect(await reopened.get('provider')).toBe('original-key');
});
