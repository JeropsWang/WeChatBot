实验探测前必须显式设置 `WECHATBOT_TEST_GROUP` 为自有测试群名；未设置默认拒绝。下方群名仅为合成示例。

# 微信桌面桥接

从项目根目录运行（Windows、已锁定的 `.venv`）：

```powershell
.venv/Scripts/python.exe bridge/main.py diagnose --output artifacts/bridge-diagnosis.json
.venv/Scripts/python.exe bridge/main.py run
.venv/Scripts/python.exe bridge/main.py probe --group 合成验收群
.venv/Scripts/python.exe bridge/main.py test-send --group 合成验收群
.venv/Scripts/python.exe bridge/diagnose_accessibility.py
```

`diagnose` 只读取微信进程路径、版本、窗口类和 UIA 节点数。`run` 连接 `ws://127.0.0.1:4310/bridge`，从环境变量 `BRIDGE_TOKEN` 或 `data/bridge.token` 读取认证令牌。服务端 `configure` 白名单控制可以打开和监听的群。初始空配置不读取聊天。`probe` 和 `test-send` 仅允许环境变量明确配置的测试群；`test-send` 只发送带随机标识的连接测试消息。探测与真实运行使用不同的 SQLite 状态文件。

桥接不会调用 wx4py 的 `connect()`/`refresh()`，不写辅助功能注册表，不改变屏幕阅读器标志，不登录、不启动或重启微信。需要现有已登录的 4.x `mmui::MainWindow` 和完整 UIA 树；当前状态不可用时展示诊断并拒绝发送。运行实例通过命名互斥锁避免同时控制窗口。所有 UIA 操作在唯一 COM 线程执行。

收件箱在网络发布前持久化；事件 ID 在重连时不变，只有服务端 ACK 才删除。消息快照与新增事件在同一 SQLite 事务提交。按有序快照定位新增位置，不将 runtime ID 当消息 ID，不按内容去重。无法衔接的快照会报告缺口并建立新基线，不能恢复不可见消息。初次连接不回放历史；可见区域若完全由相同内容组成且滚动后序列完全相同，UIA 无法证明出现了新消息，这类不可观测变化不能恢复。

发送前记录命令 ID；已发送、结果不确定或仍在执行的重复 ID 不再次操作微信。只有明确确认未执行发送的 `not_sent` 命令可在条件恢复后，使用相同目标、内容和 ID 重新请求；SQLite 原子领取保证一次只有一个执行者。发送必须匹配已绑定群 ID 和 bindingKey。输入框已有草稿或无法校验时不发送；只执行一次发送键，不做后备重试。唯一新增匹配气泡与清空的输入框确认本地发送成功，不能证明对方收到。确认的本地发送只把对应新增位置标为 `isSelf`，不会忽略随后相同文本。异常或确认不足返回 `unknown`，需要人工核查，禁止自动重发。

发送者身份与客户端手动发送方向不可靠，保留 `senderId/senderName/sourceMessageId=null`。`mentions` 只有读取到全部已绑定群的真实本群昵称才为 true。列表仅返回已验证绑定为群的名称；不会抓取私人聊天历史。新增群需在本地应用中输入确切名称，重名和不完整搜索结果拒绝猜测。

测试（只使用临时 SQLite 和本机 WebSocket，无微信收发）：

```powershell
$env:PYTHONPATH='bridge'
.venv/Scripts/python.exe -m unittest discover -s bridge/tests -v
```

受限执行环境需要允许本机回环网络及用户桌面访问；网络被沙箱拒绝时，集成测试会明确失败。
