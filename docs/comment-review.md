# app.ts 注释核对记录

注释应说明“当前实现做什么、为什么需要、边界是什么”，不把未来设想写成已经实现的架构。

| 原思路 | 更正 | 理由 |
| --- | --- | --- |
| app.ts 主要初始化字段 | 应用装配根：创建依赖、注册校验和路由、管理生命周期 | Schema 常量只是一部分，实际工作还包括认证、SSE、桥接进程和业务服务连接。 |
| 参数多以后拆微服务 | 优先按职责拆模块，微服务按独立部署、隔离和团队边界决定 | 文件大小不能单独证明需要分布式事务、网络调用等额外复杂度。 |
| Pi 用 TypeScript 所以更轻量 | 语言实现不能直接推出系统轻重 | 当前项目仍有数据库、队列、模型服务和 Windows 桥接，成本由这些运行需求决定。 |
| endpoint 存放公共模型 API 地址 | 可复用的 HTTP(S) URL 校验器，允许本地地址且拒绝 URL 内嵌用户名密码 | 不只用于模型；也不是网页工具的 SSRF 防护，公网读取另走 validatePublicUrl。 |
| modelSchema 是兼容性设置 | 模型配置输入校验，protocol 指定适配路径 | 配置 supportsTools / supportsVision 是能力声明，并不证明厂商或模型确实支持，需要连通性测试。 |
| memorySchema 是模型记忆参数 | 长期记忆条目的内容、状态与归属校验 | 不修改模型权重或上下文窗口；visibility、scopeChatId、memberId 限定检索归属。 |

## 注释写法约定

- Schema 的每个关键字段解释用途、单位、默认值与空值语义；数据库的最终字段结构见 [database.md](database.md)。不要把 HTTP Schema 当数据库表。
- TypeScript 类型服务于编译检查，Zod parse/refine 才在运行时检查外部 JSON；optional 允许缺省，nullable 允许 null，两者不同。
- 罕见 API 在调用处说明：例如 wx 是排他创建，timingSafeEqual 要先核对长度，scrypt 是密码派生而 SHA-256 会话摘要不是密码存储方案。
- 安全描述应有限定：哈希不是加密，Base64 不是加密，记录 hasApiKey 不意味着接口应回传密钥；检查 Origin 也不是所有攻击的完整防线。
- 状态注释说明状态何时过期、谁负责重试或回滚；不把 unknown 发送结果当成确认失败而自动重发。

本轮仅更正说明与展开排版，保持原有接口、数据结构、默认值和执行逻辑。既有 v0.6.1 标签不移动，维护更新分别提交到 main 与 linuo。
