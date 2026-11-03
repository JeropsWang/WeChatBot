/** 本地浏览器调试辅助，只在隔离验收实例使用，不用于真实微信操作。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
export class CDP {
  constructor(url) {
    this.next = 0;
    this.pending = new Map();
    this.errors = [];
    this.socket = new WebSocket(url);
    this.opened = new Promise((res, rej) => {
      this.socket.addEventListener('open', res, { once: true });
      this.socket.addEventListener('error', rej, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const p = this.pending.get(data.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(data.id);
          data.error ? p.reject(new Error(JSON.stringify(data.error))) : p.resolve(data.result);
        }
      } else if (data.method === 'Runtime.exceptionThrown')
        this.errors.push(data.params.exceptionDetails);
    });
  }
  async send(method, params = {}) {
    await this.opened;
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout ' + method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.text + ' ' + result.exceptionDetails.exception?.description,
      );
    return result.result?.value;
  }
  async wait(expression, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate('Boolean(' + expression + ')')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timed out: ' + expression);
  }
  async input(selector, value) {
    await this.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing input '+${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await new Promise((r) => setTimeout(r, 60));
  }
  async click(text) {
    const done = await this.evaluate(
      `(()=>{const root=document.querySelector('dialog[open]')||document;const e=[...root.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getClientRects().length);if(!e)throw new Error('missing button '+${JSON.stringify(text)});if(e.disabled)throw new Error('button disabled '+${JSON.stringify(text)});e.click();return true})()`,
    );
    await new Promise((r) => setTimeout(r, 150));
    return done;
  }
  async screenshot(filename, width = 1440, height = 1024) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 300));
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(resolve(filename), Buffer.from(shot.data, 'base64'));
    return filename;
  }
  close() {
    this.socket.close();
  }
}
export async function qaPage() {
  await mkdir('artifacts', { recursive: true });
  let target;
  try {
    target = JSON.parse(await readFile('artifacts/qa-target.json', 'utf8'));
    const list = await (await fetch('http://127.0.0.1:19323/json/list')).json();
    if (!list.some((t) => t.id === target.id)) target = undefined;
  } catch {}
  if (!target) {
    target = await (
      await fetch('http://127.0.0.1:19323/json/new?http://127.0.0.1:4330/', { method: 'PUT' })
    ).json();
    await writeFile('artifacts/qa-target.json', JSON.stringify(target));
  }
  const page = new CDP(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  return page;
}
