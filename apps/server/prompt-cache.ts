/** 生成稳定的提示词缓存标识，固定指令与动态资料分离。键不含明文聊天内容，供应商是否命中以实际返回统计为准。 */
import type { RunInput } from './models.js';
import type { ModelConfig } from '../../packages/contracts.js';
import { createHash } from 'node:crypto';

/** 群、用途、模型与固定系统提示共同决定稳定摘要。
 * 不加入本次问题或任务 UUID，否则每次请求都会生成新键，供应商难以复用固定前缀。
 * 不包含聊天明文不意味着完全匿名：调用方仍应把会话标识当作内部元数据。 */
export function promptCacheSessionId(input: RunInput): string {
  // Stable across requests and tool rounds; never put a task UUID or personal data in the key.
  return createHash('sha256')
    .update(
      JSON.stringify([
        'prompt-v1',
        input.model.id,
        input.model.model,
        input.context?.purpose ?? 'chat',
        input.context?.chatId ?? 'global',
        input.systemPrompt,
      ]),
    )
    .digest('hex');
}
/** 仅对代码明确允许的官方 Responses 模型修改缓存字段；第三方兼容接口可能拒绝这些参数。
 * 这是请求策略，不保证实际命中；费用与缓存读取量以供应商真实返回为准。 */
export function applyPromptCachePolicy(payload: any, model: ModelConfig): any {
  // Third-party "OpenAI compatible" servers may reject these newer fields.
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model.model);
  if (
    model.protocol !== 'openai' ||
    !version ||
    !(Number(version[1]) >= 6 || (Number(version[1]) === 5 && Number(version[2]) >= 6))
  )
    return payload;
  try {
    const url = new URL(model.baseUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.openai.com') return payload;
  } catch {
    return payload;
  }
  const instruction = payload.input?.[0];
  if (!instruction || !['system', 'developer'].includes(instruction.role)) return payload;
  const content =
    typeof instruction.content === 'string'
      ? [{ type: 'input_text', text: instruction.content }]
      : instruction.content;
  if (!Array.isArray(content) || !content.length || content.at(-1)?.type !== 'input_text')
    return payload;
  instruction.content = content.map((part: any, index: number) =>
    index === content.length - 1
      ? { ...part, prompt_cache_breakpoint: { mode: 'explicit' } }
      : part,
  );
  payload.prompt_cache_options = { mode: 'implicit', ttl: '30m' };
  return payload;
}
