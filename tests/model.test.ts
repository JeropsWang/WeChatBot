import { createServer } from 'node:http';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { ModelGateway,textTool } from '../apps/server/models.js';
import type { ModelConfig } from '../packages/contracts.js';
import {conversationReplyStyle} from '../apps/server/reply-length.js';
let server:ReturnType<typeof createServer>,baseUrl:string;
const payloads:any[]=[];
beforeAll(async()=>{
  server=createServer((req,res)=>{
    let body='';req.on('data',part=>body+=part);req.on('end',()=>{
      const payload=JSON.parse(body);payloads.push(payload);
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:payload.model==='verbose'?'先歇一会儿。'+('事情实在太多的时候就先处理最紧急的那一件。'.repeat(15)):'已收到测试消息'},finish_reason:null}]})+'\n\n');
      res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');
    });
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));baseUrl='http://127.0.0.1:'+(server.address() as any).port+'/v1';
});
afterAll(()=>new Promise<void>(r=>server.close(()=>r())));
it('executes actual Pi SDK loop against an OpenAI-compatible streaming endpoint without tools',async()=>{
  const model:ModelConfig={id:'fixture',name:'测试服务',protocol:'openai-compatible',model:'fixture',baseUrl,contextWindow:32768,supportsTools:false};
  const gateway=new ModelGateway();
  const result=await gateway.run({model,systemPrompt:'保持自然简短',input:'你好',history:[],tools:[]});
  expect(result.text).toBe('已收到测试消息');expect(payloads.at(-1).tools).toBeUndefined();
  expect(payloads.at(-1).messages.some((m:any)=>m.role==='user'&&(typeof m.content==='string'?m.content:m.content.map((p:any)=>p.text??'').join(''))==='你好')).toBe(true);
});
it('cancels a tool wait promptly even when its read-only handler never settles',async()=>{
  const controller=new AbortController();const tool=textTool('read','read','read','query',()=>new Promise(()=>{}));
  const result=tool.execute('call',{query:'x'},controller.signal).then(()=> 'resolved',()=> 'cancelled');controller.abort();
  expect(await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('still-waiting'),100))])).toBe('cancelled');
});
it('caps the actual chat answer and preview deltas while allowing a requested explanation',async()=>{
 const model:ModelConfig={id:'fixture',name:'fixture',protocol:'openai-compatible',model:'verbose',baseUrl,contextWindow:32768,supportsTools:false};
 const deltas:string[]=[];const gateway=new ModelGateway();
 const short=await gateway.run({model,systemPrompt:'自然聊天',input:'今天好累',history:[],replyStyle:'brief',onDelta:text=>deltas.push(text)});
 expect([...short.text].length).toBeLessThanOrEqual(50);expect(deltas.join('')).toBe(short.text);
 const briefPayload=payloads.at(-1);expect(briefPayload.max_tokens??briefPayload.max_completion_tokens).toBeLessThanOrEqual(256);
 const long=await gateway.run({model,systemPrompt:'自然聊天',input:'详细解释一下原因',history:[],replyStyle:conversationReplyStyle('详细解释一下原因')});
 expect(long.text.length).toBeGreaterThan(50);
});
