/** 启动本机工作台并注册退出信号。关闭通过统一运行时释放连接和工作进程，不重启或关闭用户微信。 */
import { createApp } from './app.js';
import { config } from './config.js';
const runtime=await createApp();
await runtime.app.listen({host:config.host,port:config.port});
console.log(`WeChatBot 工作台已启动：http://${config.host}:${config.port}`);
let closing=false;const close=async()=>{if(closing)return;closing=true;await runtime.app.close();process.exit(0);};
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
