import {it,expect,afterEach} from 'vitest';
import {resolve} from 'node:path';
import {LocalImageMatcher} from '../apps/server/image-matcher.js';
const clients:LocalImageMatcher[]=[];
afterEach(()=>{for(const client of clients)client.close();clients.length=0;});
const create=()=>{const client=new LocalImageMatcher({python:process.execPath,script:resolve('tests/fixtures/image-matcher.mjs'),timeoutMs:300,startupTimeoutMs:5000});clients.push(client);return client;};
it('serializes requests and preserves the exact numeric score',async()=>{
 const client=create();const results=await Promise.all(['one','two'].map(path=>client.match({path,sha256:'a'.repeat(64)})));
 expect(results.map(r=>r.similarity)).toEqual([0.75,0.75]);expect(client.status().ready).toBe(true);
});
it('rejects another request ID, rather than accepting a score for the wrong image',async()=>{
 await expect(create().match({path:'wrong-id',sha256:'a'.repeat(64)})).rejects.toThrow(/协议/);
});
it('rejects malformed scores, worker exits, and timeouts',async()=>{
 for(const path of ['bad-score','exit','slow'])await expect(create().match({path,sha256:'a'.repeat(64)})).rejects.toThrow();
});
it('does not start a process for an already cancelled request',async()=>{
 const client=create(),abort=new AbortController();abort.abort();
 await expect(client.match({path:'one',sha256:'a'.repeat(64)},abort.signal)).rejects.toThrow(/停止/);
 expect(client.status().running).toBe(false);
});
it('cancels queued work immediately without killing another active image request',async()=>{
 const client=create();await client.match({path:'one',sha256:'a'.repeat(64)});
 let settled=false;const active=client.match({path:'slow',sha256:'a'.repeat(64)});void active.catch(()=>{settled=true;});
 await new Promise(r=>setTimeout(r,20));const abort=new AbortController();const queued=client.match({path:'one',sha256:'a'.repeat(64)},abort.signal);abort.abort();
 await expect(queued).rejects.toThrow(/停止/);expect(settled).toBe(false);expect(client.status().running).toBe(true);
 client.close();await expect(active).rejects.toThrow();
});
it('requires the exact prepared version and preserves the previous worker until activation',async()=>{
 const client=create();
 await client.prepareGallery('before','unused-fixture-manifest');client.activateGallery('before');
 await client.prepareGallery('candidate','unused-fixture-manifest');
 await expect(client.match({path:'one',sha256:'a'.repeat(64),galleryVersion:'before'})).resolves.toMatchObject({similarity:.75});
 client.discardGallery('candidate');
 await expect(client.match({path:'one',sha256:'a'.repeat(64),galleryVersion:'before'})).resolves.toMatchObject({similarity:.75});
 await client.prepareGallery('after','unused-fixture-manifest');client.activateGallery('after');
 await expect(client.match({path:'one',sha256:'a'.repeat(64),galleryVersion:'before'})).rejects.toThrow('尚未准备');
 await expect(client.match({path:'one',sha256:'a'.repeat(64),galleryVersion:'after'})).resolves.toMatchObject({similarity:.75});
});
