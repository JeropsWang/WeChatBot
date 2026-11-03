# 第三方项目、来源与致谢

WeChatBot 自有代码按 AGPL-3.0-or-later 发布。下表说明实际用途，不表示第三方对本项目作出背书。安装包中的版权、LICENSE 和 NOTICE 继续有效；完整依赖与准确版本以两套 package-lock.json、bridge/requirements.lock.txt 和图像依赖清单为准。模型权重、素材和外部服务条款独立适用。

## 实际集成

| 项目 | 用途 | 来源与许可 |
| --- | --- | --- |
| Pi Agent / Pi AI | Agent 执行、模型协议 | [earendil-works/pi](https://github.com/earendil-works/pi)，MIT；当前 SDK 1.4.0 |
| wx4py | Windows 微信 UIA 桥接 | [claw-codes/wx4py](https://github.com/claw-codes/wx4py)，AGPL-3.0-or-later；锁定 0.2.1 |
| OpenCLIP | 本地图像编码 | [mlfoundations/open_clip](https://github.com/mlfoundations/open_clip)，MIT；权重许可需另外遵守其模型卡 |
| React / React DOM | 管理界面 | [facebook/react](https://github.com/facebook/react)，MIT |
| Vite | 前端开发与构建 | [vitejs/vite](https://github.com/vitejs/vite)，MIT |
| Phosphor Icons | 界面图标 | [phosphor-icons/react](https://github.com/phosphor-icons/react)，MIT |
| Fastify 及官方插件 | API、Cookie、静态文件、WebSocket、限流 | [fastify](https://github.com/fastify)，MIT，逐包保留声明 |
| BullMQ | 后台任务 | [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq)，MIT |
| PostgreSQL / pgvector | 持久存储与向量 | [PostgreSQL](https://www.postgresql.org/)、[pgvector](https://github.com/pgvector/pgvector)，PostgreSQL License |
| Redis | 队列与缓存服务 | [redis/redis](https://github.com/redis/redis)，许可证随版本变化，按实际 Redis 7 镜像版本附带许可核对 |
| SearXNG | 可选自建搜索 | [searxng/searxng](https://github.com/searxng/searxng)，AGPL-3.0-or-later |
| Mozilla Readability | 网页正文提取 | [mozilla/readability](https://github.com/mozilla/readability)，Apache-2.0 |
| linkedom | HTML DOM 解析 | [WebReflection/linkedom](https://github.com/WebReflection/linkedom)，ISC |
| unpdf | 文字 PDF 提取 | [unjs/unpdf](https://github.com/unjs/unpdf)，MIT |

此外使用 TypeScript、tsx、Vitest、Zod、pg、ioredis、ws、dotenv、Python websockets、Pillow、pywin32、comtypes、PyTorch、torchvision 等。它们并非全部采用同一种许可证，不能将项目总许可证覆盖到依赖本身。发布二进制或离线依赖包时，还应随包提供对应版本的完整许可与必要源代码材料，本仓库不打包这些运行依赖或权重。

## 思路参考与适配来源

- [MaiBot](https://github.com/Mai-with-u/MaiBot)：自然群聊与参与方式参考；不是本项目安装的机器人框架，不声称复制其实现。
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)：人设配置思路参考；不是运行依赖，不声称安装融合其完整框架。
- [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)：旧兼容研究参考 `tools/wake_uia.py` 的 Qt 无障碍激活思路；本项目的版本校验、每次授权和独立恢复守护属于本地适配边界。原始研究记录不足以证明全部代码逐行来源；后续移植任何上游代码必须先核对许可证并保留声明，不因列入致谢即视为获得授权。

## 模型、服务与素材

默认本地图像编码使用 ViT-B-32 / laion2b_s34b_b79k，模型权重不随仓库分发；准备时从公开模型源下载，使用者需核对对应模型卡。DeepSeek、其他云模型和微信是独立服务或产品，不是本项目重新授权的开源依赖。

main 不分发个人立绘、聊天截图或私有参考图库。用户上传的图片、知识文档、表情和人物素材版权属于原权利人，上传者应确认使用范围。linuo 的主题素材应保留来源记录，不将代码许可证当作角色或原始参考作品的授权。项目名称不表示腾讯、微信或其他项目的隶属与认可。

## linuo 主题立绘来源

本分支 `apps/web/public/assets/liino-portrait.png` 来自用户提供的本地参考并经图像生成工具制作，用户授权用于本项目主题发布。仓库只分发该主题资产，不包含原始参考文件、私人聊天截图或人物资料。

AGPL-3.0-or-later 适用于本项目代码，不扩张角色形象、原始参考作品或其他第三方素材的权利；主题图的使用不能据此视为获得角色商标、原作或商业用途的额外授权。使用者替换、再分发或另作他用时应独立确认相应权利范围。
