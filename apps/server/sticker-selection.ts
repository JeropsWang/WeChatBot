/** 筛选可发送表情并应用重试与配额限制。生成候选不等于发送成功，最终发送仍须通过正常账本链路。 */
import { createHash } from 'node:crypto';

/** Select a matching managed image, with stable variety per outbound message. */
export type StickerCandidate = {
  id: string;
  kind: string;
  enabled: boolean;
  status: string;
  tags: { emotion?: string[]; scene?: string[]; intensity?: string[] };
};
const sceneWords: Record<string, RegExp> = {
  致谢: /(?<!不用|不必)谢谢|感谢|辛苦了|多谢|谢啦|谢了/u,
  道歉: /对不起|抱歉|不好意思|我的错/u,
  不解: /不明白|没懂|怎么回事|为什么|疑惑|啥情况|什么情况|[?？]{2,}/u,
  庆祝: /恭喜|庆祝|太好了|成功了|生日快乐/u,
  难过: /难过|伤心|委屈|失落/u,
  合作: /合作愉快|一起加油|配合得好/u,
  赞同: /(?<!不)同意|赞同|说得对|没问题|可以的|确实|有道理/u,
  等待: /等一下|稍等|马上就好|很快就好/u,
  敬意: /敬礼|致敬|辛苦守护/u,
  称赞: /真酷|好酷|太帅了|厉害了/u,
  疲惫: /累坏了|太累了|累死了|撑不住了/u,
  问候: /你好|你们好|大家好|早上好|早安|中午好|下午好|晚上好|早呀|早哇|嗨[呀啊～~！!，,\s]|^嗨$/u,
  回应: /收到|明白了|了解了|知道啦|知道了|好嘞|好哒|好滴|安排上|妥了|\b[oO][kK](?:[aA][yY])?\b|^[好行嗯][的呢呀啦啊哦～~！!。\s]*$/u,
  加油: /加油|冲鸭|冲呀|冲冲冲|一起冲|要上啦|你可以的|稳住|交给我/u,
  开心: /哈哈|嘿嘿|笑死|乐了|绷不住|(?<!不|没|不太|不怎么)开心|(?<!不|没|不太)高兴|好耶|芜湖|快乐/u,
  晚安: /晚安|早点休息|好梦|睡啦|睡了|睡觉去|困了/u,
  告别: /再见|拜拜|回头见|下次见|先溜了|先撤了|我撤了|走啦/u,
  摸鱼: /摸鱼|划水|摆烂|躺平|歇一会|休息一下|不想上班|不想干活/u,
  吃饭: /饿了|好饿|吃饭|开饭|干饭|想吃|吃点|夜宵|宵夜|好吃|吃饱|馋了/u,
  思考: /让我想想|我想想|思考|琢磨|研究一下|考虑一下|想一想/u,
  安慰: /摸摸|抱抱|别难过|别伤心|不要慌|别慌|有我在|会好起来|别怕/u,
  惊讶: /吓我一跳|震惊|惊了|居然|竟然|好家伙|不会吧/u,
  祈愿: /祈祷|保佑|求出货|盼.{0,4}出货|欧气|好运|一发入魂|十连双黄/u,
  围观: /吃瓜|围观|探头|蹲一个|看看热闹|前排/u,
  催促: /快一点|快点啦|请快些|搞快点|来不及了|抓紧/u,
  委屈: /委屈|可怜|呜呜|嘤嘤/u,
  害怕: /(?<!别|不|不要)害怕|瑟瑟发抖|救命|怕怕/u,
  拒绝: /不同意|不赞同|不可以|达咩|拒绝|不要这样/u,
  选择: /你先选|你请先选|我先选|我想先选|换个话题|换换项目|换个模式/u,
  生气: /(?<!别|不|不要)生气|气死我了|气鼓鼓|气炸了|好气/u,
  喜爱: /(?<!不)喜欢你|比心|爱你|心动|好可爱|太可爱|贴贴/u,
  尴尬: /尴尬|流汗了|汗流浃背|尬住/u,
  无语: /无语|沉默了|沉默|一言难尽|省略号/u,
  自嘲: /小丑竟是我|我成小丑|菜就多练|我是笨蛋|我太菜/u,
};
const conflicts = [
  ['致谢', '道歉'],
  ['庆祝', '难过'],
  ['开心', '难过'],
  ['赞同', '拒绝'],
  ['问候', '告别'],
  ['加油', '摸鱼'],
];
export function selectSticker(
  reply: string,
  items: StickerCandidate[],
  seed = reply,
): StickerCandidate | null {
  const text = reply
    .replace(/^\s*>.*$/gmu, '')
    .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '')
    .replace(/(?:不用|不必|无需|不要|别)(?:再|说)?(?:谢谢|感谢|道歉)/gu, '')
    // Keep the comforting intent, without also treating the quoted emotion as
    // the speaker's sadness, anger or fear.
    .replace(/(?:别|不要)(?:再|太|那么)?(?:难过|伤心|生气|害怕)/gu, '抱抱')
    .replace(
      /(?:不(?:是|会|能|想)?|没(?:有)?)(?:太|很|怎么|那么|这么|特别|十分|非常)?(?:开心|高兴|快乐|喜欢你|爱你|心动|同意|赞同|可以的|生气|害怕)/gu,
      (phrase) => (/(?:同意|赞同|可以的)$/u.test(phrase) ? '拒绝' : ''),
    )
    .replace(/生日快乐|节日快乐/gu, '庆祝');
  const matched = Object.entries(sceneWords)
    .filter(([, pattern]) => pattern.test(text))
    .map(([tag]) => tag);
  if (!matched.length || conflicts.some((pair) => pair.every((tag) => matched.includes(tag))))
    return null;
  const candidates = items.filter(
    (item) =>
      item.enabled &&
      item.kind === 'image' &&
      item.status === 'ready' &&
      item.tags.scene?.some((scene) => matched.includes(scene)),
  );
  if (!candidates.length) return null;
  // Prefer an image covering more of the reply, then vary ties without a mutable
  // global cursor. Input ordering and retries for the same send stay stable.
  const score = (item: StickerCandidate) =>
    matched.filter((scene) => item.tags.scene?.includes(scene)).length;
  const best = Math.max(...candidates.map(score));
  const tied = candidates
    .filter((item) => score(item) === best)
    .sort((a, b) => a.id.localeCompare(b.id));
  const index = createHash('sha256').update(seed).digest().readUInt32BE(0) % tied.length;
  return tied[index];
}
