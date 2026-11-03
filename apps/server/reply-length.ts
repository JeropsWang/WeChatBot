/** 约束自然闲聊输出长度，明确展开请求允许完整回答。按句子边界收短，不为压缩输出额外调用模型。 */
export type ReplyStyle='brief'|'proactive'|'hunt'|'expanded';
export function conversationReplyStyle(input:string,kind:'explicit'|'proactive'|'hunt'='explicit'):ReplyStyle{
 if(kind!=='explicit')return kind;
 const text=input.trim().replace(/^@[^\s@]+[\s\u2005]+/u,'').replace(/^\/识图\s*(?:I\d+)?\s*/iu,'');
 if(/(?:别|不必|不要|不用|无需)(?:再|继续|给我|长篇)?(?:科普|总结|分析|解释|展开|啰嗦)|简短|短点|一句话|简单说|这个词|这两个字/u.test(text))return 'brief';
 const explain=/^(?:(?:请你?|麻烦你?|帮我|帮忙|给我|能不能|能否|你能|你可以|我想|我要|可以|一下|详细|系统地?|认真|深入|全面|具体)\s*)*(?:科普|总结|讲解|解释|分析|对比|比较|盘点|复盘|整理|介绍|翻译|归纳)/u;
 const artifact=/(?:给我|发我|帮我|请|来一?|提供|写一?|列一?|找一下|查一下)[\s\S]{0,50}(?:教程|攻略|步骤|方案|清单|代码|脚本|程序|文章|报告|链接|网址|命令)/u;
 const question=/^(?:什么是|如何(?:实现|配置|安装|修复|设计|部署)|怎么(?:实现|配置|安装|修复|部署)|为什么(?!你|我|他|她|它|大家|又|总|老|不理|这么))/u;
 return explain.test(text)||artifact.test(text)||question.test(text)?'expanded':'brief';
}
export function replyLengthInstruction(style:ReplyStyle):string{
 if(style==='expanded')return '本轮是明确请求的科普、总结、解释或内容创作，按任务完整回答，不套用闲聊字数上限；保持紧凑，不堆套话。';
 const max=style==='brief'?50:30;
 return `本轮是日常短回复：优先10至25字，最多${max}字，最多${style==='brief'?2:1}句；只说最重要的一点，不列清单，不复述背景，不追加追问或长篇辩解。冷淡、直接、克制；不讨好、不自贬，不因被辱骂就认错或道歉。`;
}
const graphemes=new Intl.Segmenter('zh-CN',{granularity:'grapheme'});
const characters=(text:string)=>[...graphemes.segment(text)].map(part=>part.segment);
export function limitConversationReply(text:string,style:ReplyStyle):string{
 if(style==='expanded')return text;
 const max=style==='brief'?50:30,maxSentences=style==='brief'?2:1;
 const normalized=text.trim().replace(/\s*\n+\s*/gu,' ');
 const sentences=normalized.match(/[^。！？!?]+(?:[。！？!?]+[”’」』"]*|$)/gu)??[normalized];
 let result='';
 for(const sentence of sentences.slice(0,maxSentences)){
  if(characters(result+sentence).length>max)break;
  result+=sentence;
 }
 if(result)return result.trim();
 const chars=characters(normalized);if(chars.length<=max)return normalized;
 const prefix=chars.slice(0,max-1).join('');
 const boundaries=[...prefix.matchAll(/[，,；;：:\s]/gu)];
 const last=boundaries.at(-1);
 if(last&&characters(prefix.slice(0,last.index)).length>=8)return prefix.slice(0,last.index).trimEnd()+'。';
 return prefix.trimEnd()+'…';
}
