import {expect,it} from 'vitest';
import {conversationReplyStyle,limitConversationReply} from '../apps/server/reply-length.js';

it.each(['你好','今天累死了','你怎么不理我','别总结了，正常聊','总结这个词真烦','为什么你总是这么啰嗦','这段代码真难看'])('keeps ordinary chat brief: %s',input=>{
 expect(conversationReplyStyle(input)).toBe('brief');
});
it.each(['给我科普一下黑洞','总结一下上面的讨论','讲解一下缓存的工作原理','详细分析这份报告','帮我写一个Python脚本','翻译下面这段话','给我一份配置教程','为什么天空是蓝色的'])('allows requested substantive content: %s',input=>{
 expect(conversationReplyStyle(input)).toBe('expanded');
});
it('keeps automated participation and image hunts short even when their source mentions a summary',()=>{
 expect(conversationReplyStyle('请总结','proactive')).toBe('proactive');expect(conversationReplyStyle('请科普','hunt')).toBe('hunt');
});
it('keeps at most two complete sentences in everyday chat',()=>{
 expect(limitConversationReply('确实挺烦的。先把最急的处理了。剩下明天再说。','brief')).toBe('确实挺烦的。先把最急的处理了。');
});
it('uses the last complete sentence within the cap rather than sending a long paragraph',()=>{
 const first='先歇会儿。';const result=limitConversationReply(first+'这是很长的第二句'.repeat(20)+'。','brief');
 expect(result).toBe(first);
});
it('limits unpunctuated text and grapheme clusters without breaking emoji',()=>{
 const result=limitConversationReply('👨‍👩‍👧‍👦'.repeat(70),'brief');
 const segments=[...new Intl.Segmenter('zh-CN',{granularity:'grapheme'}).segment(result)].map(x=>x.segment);
 expect(segments.length).toBeLessThanOrEqual(50);expect(segments.every(x=>x==='👨‍👩‍👧‍👦'||x==='…')).toBe(true);
});
it('leaves expanded answers, code and links intact',()=>{
 const text='详细解释\n```js\n'+('console.log("你好");\n'.repeat(30))+'```\nhttps://example.com';
 expect(limitConversationReply(text,'expanded')).toBe(text);
});
it('keeps proactive/hunt output within 30 characters',()=>{
 for(const style of ['proactive','hunt'] as const)expect([...limitConversationReply('这是一个很长的主动参与发言'.repeat(20),style)].length).toBeLessThanOrEqual(30);
});
