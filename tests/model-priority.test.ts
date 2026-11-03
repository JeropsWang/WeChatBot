import { expect, it } from 'vitest';
import { ModelSlots } from '../apps/server/models.js';
it('lets active work finish, then grants plan first with FIFO within a tier', async () => {
  const slots = new ModelSlots(1),
    order: string[] = [];
  await slots.acquire(5);
  const ordinary = slots.acquire(5).then(() => order.push('ordinary'));
  const plan = slots.acquire(1).then(() => order.push('plan'));
  const plan2 = slots.acquire(1).then(() => order.push('plan2'));
  expect(order).toEqual([]);
  slots.release();
  await plan;
  expect(order).toEqual(['plan']);
  slots.release();
  await plan2;
  slots.release();
  await ordinary;
  slots.release();
  expect(order).toEqual(['plan', 'plan2', 'ordinary']);
});
it('removes an aborted waiter without consuming a permit', async () => {
  const slots = new ModelSlots(1);
  await slots.acquire(5);
  const controller = new AbortController();
  const pending = slots.acquire(1, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('已停止');
  const normal = slots.acquire(5);
  slots.release();
  await normal;
  slots.release();
});
