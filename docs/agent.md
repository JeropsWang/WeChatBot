# 开发者与 Agent 接手指南

## 先建立可复现环境

先读根 README、architecture.md、CONTRIBUTING.md、SECURITY.md 和 CHANGELOG.md，确认当前分支。`main` 只能包含正式 UI，`linuo` 才包含主题资源及切换。不要把源码快照、真实数据、环境配置或本机验收截图加入提交。

按 README 安装两套 npm 锁文件及桥接锁定环境。开发模式中后端在 4310、前端在 4311。应用默认启动后台工作进程；浏览器 QA 和接口测试应通过 `createApp({startWorkers:false,...})` 创建隔离实例，并使用临时 `dataDir`、独立端口、独立数据库和队列前缀。

## 定位修改点

| 问题 | 入口与关联 |
| --- | --- |
| API、会话、配置校验 | app.ts、revamp-routes.ts、contracts.ts |
| 生成顺序、重复发送、停止 | pipeline.ts、db.ts、channel.ts、bridge engine/store |
| 模型适配、用量 | models.ts、prompt-cache.ts、usage.ts |
| 检索、删除、成员画像 | knowledge、memory、members 系列模块 |
| 图库和图片检测 | chat-images、hunt、hunt-gallery、image-matcher 与 Python 脚本 |
| 前端表单与草稿 | apps/web/src 对应页面及 api.ts/ui.tsx |

## 必须保留的约束

- 不按消息文字去重，不把未知发送自动重发；提交前检查同文不同事件、ACK 重连及 commandId 重复。
- 不用昵称授予权限，不跨群合并成员；身份失败继续普通聊天，但不能写入归属不明的个人记忆。
- 不在生成时绕过 epoch、白名单、暂停与发送前复查；任何中间结果都可能在排队期间过期。
- 不把网页、图片、记忆或聊天内容拼成可信系统指令，不把密钥写入提示词、日志或 API 回包。
- 不运行真实微信测试来验证纯代码修复；桌面诊断、探测和发送均须显式目标和授权。WECHATBOT_TEST_GROUP 默认空，不能通过删除门禁实现通用化。
- 保留生产身份模块之间的依赖；先追踪 import 和调用再移除实验文件。
- 不修改共享数据库、删除数据卷或重启用户微信；涉及数据变更先明确备份和恢复路径。

## 变更流程

新功能先描述触发条件与预期结果；缺陷先写能够复现的测试。公共契约更新时同时检查前端、Fastify schema、桥接验证和测试。迁移新增递增编号 SQL，不重写已在发布版本运行的旧迁移；迁移应支持空库和现有库，启动失败不能伪装成功。保留数据库名、队列前缀及 Cookie 的兼容性，产品改名不是数据迁移理由。

源文件注释解释职责、关键输入、失败和不变量；避免逐行翻译。复杂任务状态变更要说明为什么锁、事务和复查不能删除。所有界面读真实接口，未知统计显示未知；保存失败保留草稿。

## 验证

```powershell
npm run typecheck
npm --prefix apps/web run typecheck
npm test
npm run test:bridge
npm run simulate
npm run build
npm --prefix apps/web run test:sites
```

集成测试示例仅用于独立测试环境：

```powershell
docker compose exec -T postgres psql -U liino -d postgres -c 'CREATE DATABASE liino_test'
$env:TEST_DATABASE_URL='postgres://liino:liino_local@127.0.0.1:54329/liino_test'
npm test
```

确保测试中的队列前缀和数据目录隔离，不能指向应用数据库。记录通过、失败与跳过数量，不将跳过描述为通过。图库测试使用临时目录与合成 PNG，不能依赖电脑已有 data。浏览器验证 1440/768/390，覆盖导航、未保存草稿、删除确认、模型表单及窄屏操作按钮可见性，不启动真实后台发送。

## 发布与接手报告

更新根与网页 manifest/lock 的版本，更新变更记录；正式版测试通过后创建附注 tag `vX.Y.Z`，Release 指向 main。先发布 main，再从发布提交维护 linuo 的 UI 差异；禁止合并其专用资源到 main。使用显式 refs 推送，不使用 mirror 或 force。

发布前审查全部待上传文件与可达历史，运行密钥扫描，核对附件和图像来源。报告应写明：修改内容、行为变化、实际执行的测试、跳过及理由、人工验收范围、迁移/回退限制和仓库链接。任何外部登录问题不能用读取并展示 token 的方式解决。

## 阅读数据库与注释

数据库逐字段含义、设计目的与空值约束见 [database.md](database.md)。代码提交前运行 `npm run format:check`；需要整理格式时运行 `npm run format`。格式化不能替代注释：不常见 API 要解释在本处解决什么问题、为何选择它，以及不能保证什么。Schema 是运行时输入验证，TypeScript 类型不替代网络输入校验；格式重排不得改变接口、默认值或 SQL 行为。
