import { expect,it } from 'vitest';
import { isPublicAddress, validatePublicUrl } from '../apps/server/network.js';
it('rejects local, private, mapped IPv6 and unsafe URL schemes', async()=>{
  for(const address of ['127.0.0.1','10.1.1.1','192.168.1.1','169.254.169.254','::1','fc00::1','::ffff:127.0.0.1','0.0.0.0'])expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress('8.8.8.8')).toBe(true);
  await expect(validatePublicUrl('file:///etc/passwd')).rejects.toThrow();
  await expect(validatePublicUrl('http://localhost/')).rejects.toThrow();
});
