import {expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({requests:[] as any[],dnsHangs:false}));
vi.mock('node:dns/promises',()=>({lookup:async()=>fixture.dnsHangs?new Promise(()=>{}):[{address:'8.8.8.8',family:4}]}));
vi.mock('node:http',async()=>{const {EventEmitter}=await import('node:events');return {default:{request:(_url:any,_options:any,callback:any)=>{
  const request:any=new EventEmitter();fixture.requests.push(request);request.setTimeout=()=>request;
  request.end=()=>queueMicrotask(()=>{const response:any=new EventEmitter();response.statusCode=200;response.headers={};response.resume=()=>{};callback(response);const tick=setInterval(()=>response.emit('data',Buffer.from('x')),1000);request.once('close',()=>clearInterval(tick));});
  request.destroy=(error:Error)=>{request.emit('error',error);request.emit('close');};return request;
}}};});
import {fetchPage,SearchProvider} from '../apps/server/network.js';
it('bounds total response time even if a public server keeps trickling bytes',async()=>{
  vi.useFakeTimers();let state='pending';void fetchPage('http://public.example').then(()=>state='done',()=>state='failed');
  try{await vi.advanceTimersByTimeAsync(11000);expect(state).toBe('failed');}
  finally{fixture.requests.forEach(r=>r.destroy(new Error('fixture cleanup')));fixture.requests.length=0;vi.clearAllTimers();vi.useRealTimers();}
});
it('bounds DNS resolution as part of the same page deadline',async()=>{
  vi.useFakeTimers();fixture.dnsHangs=true;let state='pending';void fetchPage('http://public.example').then(()=>state='done',()=>state='failed');
  try{await vi.advanceTimersByTimeAsync(11000);expect(state).toBe('failed');}
  finally{fixture.dnsHangs=false;vi.clearAllTimers();vi.useRealTimers();}
});
it('bounds DeepSeek target DNS validation within the same ten-second Fetch deadline',async()=>{
  vi.useFakeTimers();fixture.dnsHangs=true;let state='pending';
  const provider=new SearchProvider('http://unused.invalid',{provider:'deepseek',apiKey:async()=> 'fixture'});
  void provider.fetch('https://public.example').then(()=>state='done',()=>state='failed');
  try{await vi.advanceTimersByTimeAsync(10001);expect(state).toBe('failed');}
  finally{fixture.dnsHangs=false;vi.clearAllTimers();vi.useRealTimers();}
});
it('bounds a stalled DeepSeek key read and accepts cancellation while it waits',async()=>{
  vi.useFakeTimers();let state='pending';
  const provider=new SearchProvider('http://unused.invalid',{provider:'deepseek',apiKey:()=>new Promise(()=>{})});
  void provider.search('widget').then(()=>state='done',()=>state='failed');
  try{await vi.advanceTimersByTimeAsync(12001);expect(state).toBe('failed');}
  finally{vi.clearAllTimers();vi.useRealTimers();}
  const controller=new AbortController(),result=provider.search('widget',controller.signal).catch(()=> 'cancelled');
  controller.abort();expect(await result).toBe('cancelled');
});
