/** 处理头像外观描述的受限结构。外观相似只是匹配证据，不能单独授予身份或权限。 */
import { z } from 'zod';
export const avatarDescriptorSchema = z
  .object({
    version: z.literal(1),
    hash: z.string().regex(/^[a-f0-9]{32}$/),
    colors: z.array(z.number().int().min(0).max(255)).length(12),
  })
  .strict();
export function sameAvatarDescriptor(left: unknown, right: unknown) {
  const a = avatarDescriptorSchema.safeParse(left),
    b = avatarDescriptorSchema.safeParse(right);
  if (!a.success || !b.success) return false;
  let bits = BigInt('0x' + a.data.hash) ^ BigInt('0x' + b.data.hash),
    distance = 0;
  while (bits) {
    distance++;
    bits &= bits - 1n;
  }
  const differences = a.data.colors.map((v, i) => Math.abs(v - b.data.colors[i]));
  return (
    distance <= 8 &&
    Math.max(...differences) <= 20 &&
    differences.reduce((n, v) => n + v, 0) / 12 <= 8
  );
}
