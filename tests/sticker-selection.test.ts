import {describe,it,expect} from 'vitest';
import {selectSticker,type StickerCandidate} from '../apps/server/sticker-selection.js';
const item=(id:string,scene:string,extra:Partial<StickerCandidate>={}):StickerCandidate=>({id,kind:'image',enabled:true,status:'ready',tags:{scene:[scene]},...extra});
describe('sticker selection',()=>{
  it('uses the reply context and only an available matching asset',()=>{
    const images=[item('1','道歉'),item('2','致谢'),item('3','致谢',{enabled:false})];
    expect(selectSticker('谢谢你，辛苦了',images)?.id).toBe('2');
  });
  it('does not guess when context is ambiguous or no scene matches',()=>{
    const images=[item('1','道歉'),item('2','致谢')];
    expect(selectSticker('谢谢，抱歉',images)).toBeNull();
    expect(selectSticker('今天的天气很好',images)).toBeNull();
    expect(selectSticker('谢谢', [item('3','致谢',{kind:'native-sticker'})])).toBeNull();
  });
  it('matches the new waiting, respect, praise and tiredness labels',()=>{
    const images=[item('a','等待'),item('b','敬意'),item('c','称赞'),item('d','疲惫')];
    expect(selectSticker('稍等一下',images)?.id).toBe('a');
    expect(selectSticker('向你致敬',images)?.id).toBe('b');
    expect(selectSticker('太帅了',images)?.id).toBe('c');
    expect(selectSticker('今天太累了',images)?.id).toBe('d');
  });
  it.each([
    ['早上好呀，博士','问候'],['收到啦','回应'],['冲鸭，加油！','加油'],
    ['哈哈哈哈，笑死我了','开心'],['晚安，早点休息','晚安'],['先溜了，拜拜','告别'],
    ['摸鱼时间到','摸鱼'],['饿了，想吃饭','吃饭'],['让我想想','思考'],
    ['摸摸头，抱抱你','安慰'],['吓我一跳','惊讶'],['不要慌，有我在','安慰'],
    ['盼一个出货，欧气满满','祈愿'],['你好，收到，谢谢你','致谢'],
    ['气死我了','生气'],['喜欢你，比心','喜爱'],['尴尬住了','尴尬'],
    ['无语了，沉默','无语'],['小丑竟是我','自嘲'],
  ])('matches common chat replies: %s',(reply,scene)=>{
    expect(selectSticker(reply,[item('target',scene)])?.id).toBe('target');
  });
  it('can match compatible scenes without requiring every scene on one image',()=>{
    const selected=selectSticker('收到，谢谢你！',[item('a','回应'),item('b','致谢')]);
    expect(['a','b']).toContain(selected?.id);
    expect(selectSticker('太开心了，可是很难过',[item('a','开心'),item('b','难过')])).toBeNull();
  });
  it('varies images across send IDs while keeping a retry stable and ignoring input order',()=>{
    const images=[item('a','致谢'),item('b','致谢'),item('c','致谢')];
    const selected=new Set(Array.from({length:24},(_,i)=>selectSticker('谢谢你',images,String(i))?.id));
    expect(selected.size).toBe(3);
    expect(selectSticker('谢谢你',images,'same')?.id).toBe(selectSticker('谢谢你',[...images].reverse(),'same')?.id);
  });
  it('does not use quoted, negated, disabled or unavailable scenes',()=>{
    const images=[item('a','开心'),item('b','道歉'),item('c','回应',{status:'disabled'}),item('d','问候',{enabled:false})];
    expect(selectSticker('我不开心',images)).toBeNull();
    expect(selectSticker('不用道歉',images)).toBeNull();
    expect(selectSticker('这段代码写了 `哈哈`',images)).toBeNull();
    expect(selectSticker('有人说“抱歉”，然后离开了',images)).toBeNull();
    expect(selectSticker('收到',images)).toBeNull();
    expect(selectSticker('你好',images)).toBeNull();
  });
  it.each(['我不快乐','我不爱你','不是很开心','我没有很开心','我不太喜欢你','请检查 token 是否过期','这个 book 很厚'])(
    'does not send a positive reaction for negation or an embedded OK: %s',reply=>{
      const images=[item('happy','开心'),item('love','喜爱'),item('ok','回应')];
      expect(selectSticker(reply,images)).toBeNull();
    });
  it.each(['别难过','不要伤心','别害怕','不要生气'])(
    'preserves comforting meaning while suppressing the negative emotion: %s',reply=>{
      const images=[item('comfort','安慰'),item('sad','难过'),item('angry','生气'),item('fear','害怕')];
      expect(selectSticker(reply,images)?.id).toBe('comfort');
    });
  it.each(['我不赞同','不可以的','我不太同意'])(
    'matches explicit refusal without an agreement conflict: %s',reply=>{
      expect(selectSticker(reply,[item('yes','赞同'),item('no','拒绝')])?.id).toBe('no');
    });
  it.each(['OK啦','ok，收到','okay!'])(
    'still accepts an explicit acknowledgement: %s',reply=>{
      expect(selectSticker(reply,[item('ok','回应')])?.id).toBe('ok');
    });
});
