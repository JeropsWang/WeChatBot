/** 桥接与群聊配置。兼容授权按本次启动明确确认，群开关和实际收发验收分开；失败不得显示为已生效。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowClockwise,
  Play,
  Plus,
  CheckCircle,
  ChatCircleText,
  Stop,
  PaperPlaneTilt,
  CaretDown,
  PlugsConnected,
} from '@phosphor-icons/react';
import {
  api,
  dateTime,
  useAction,
  useResource,
  type Bootstrap,
  type Chat,
  type SaveSettings,
} from './api';
import { GroupFeatures } from './GroupFeatures';
import {
  Badge,
  Button,
  Confirm,
  Empty,
  Feedback,
  Field,
  Modal,
  Notice,
  PageHeading,
  ResourceState,
  Toggle,
} from './ui';

export function ChatsPage(props: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  revision: number;
  saveSettings: SaveSettings;
  onDirty: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState('settings'),
    dirty = useRef(false);
  const markDirty = useCallback(
    (value: boolean) => {
      dirty.current = value;
      props.onDirty(value);
    },
    [props.onDirty],
  );
  const switchTab = (next: string) => {
    if (dirty.current && !window.confirm('当前修改尚未保存。放弃并切换？')) return;
    markDirty(false);
    setTab(next);
  };
  return (
    <main className="standard-page chats-page" id="main-content">
      <PageHeading title="微信与群聊" description="按群管理成员画像、指令权限与互动玩法。" />
      <div className="tabs" role="tablist" aria-label="微信与群聊">
        {[
          ['settings', '群聊设置'],
          ['members', '成员画像'],
          ['permissions', '指令与权限'],
          ['games', '群玩法'],
        ].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => switchTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'settings' ? (
        <ChatSettings {...props} onDirty={markDirty} />
      ) : (
        <GroupFeatures
          key={tab}
          tab={tab}
          data={props.data}
          revision={props.revision}
          onDirty={markDirty}
        />
      )}
    </main>
  );
}
function ChatSettings({
  data,
  refresh,
  revision,
  saveSettings,
  onDirty,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  revision: number;
  saveSettings: SaveSettings;
  onDirty: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(''),
    [discover, setDiscover] = useState<{ name: string; bindingKey: string }[]>(),
    [testChat, setTestChat] = useState<Chat>(),
    [messagesChat, setMessagesChat] = useState<Chat>();
  const [proactive, setProactive] = useState(data.settings.proactive),
    [dirty, setDirty] = useState(false),
    action = useAction();
  const [compatibility, setCompatibility] = useState(false);
  useEffect(() => {
    if (!dirty) setProactive(data.settings.proactive);
  }, [data.settings.proactive, dirty]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  async function patch(chat: Chat, value: Partial<Chat>) {
    await api(`/api/chats/${chat.id}`, 'PATCH', value);
    await refresh();
  }
  const bridge = data.bridge;
  return (
    <div className="chat-settings">
      <div className="toolbar">
        <h2>群聊设置</h2>
        <Button busy={action.busy} onClick={() => action.run(refresh)}>
          <ArrowClockwise size={18} />
          刷新状态
        </Button>
      </div>
      <section className="surface connection-panel">
        <div className="connection-heading">
          <div>
            <h2>
              <PlugsConnected size={24} />
              微信桥接
            </h2>
            <p>
              {bridge.account ? `当前账号：${bridge.account}` : '等待可识别的微信账号与群聊窗口'}
            </p>
          </div>
          <Badge tone={bridge.connected ? 'good' : 'warn'}>
            {bridge.connected
              ? '已连接'
              : bridge.transportConnected
                ? '桥接在线 · 微信未就绪'
                : '未连接'}
          </Badge>
        </div>
        <p className="bridge-detail">
          {bridge.detail || '桥接尚未报告微信状态，请启动桥接后重新检查。'}
        </p>
        <div className="capabilities">
          {[
            ['groupListening', '群聊监听'],
            ['mentions', '识别 @'],
            ['send', '消息发送'],
          ].map(([key, label]) => (
            <span key={key}>
              <span className={`status-dot ${bridge.capabilities[key] ? 'good' : ''}`} />
              {label}：{bridge.capabilities[key] ? '支持' : '未确认'}
            </span>
          ))}
        </div>
        <label className="compatibility-consent">
          <input
            type="checkbox"
            checked={compatibility}
            disabled={action.busy || bridge.managed || bridge.transportConnected}
            onChange={(e) => setCompatibility(e.target.checked)}
          />
          <span>
            本次启动允许临时无障碍兼容（微信 4.1.15.56）
            <small>
              临时修改当前微信进程的一个标志，可能导致异常退出。停止桥接后恢复原值；不修改客户端文件。每次启动需重新勾选。
            </small>
          </span>
        </label>
        {bridge.compatibility && (
          <Notice>临时无障碍兼容正在运行。停止桥接后，独立守护进程会恢复原标志。</Notice>
        )}
        <div className="button-row">
          <Button
            variant="primary"
            busy={action.busy}
            disabled={bridge.managed || bridge.transportConnected}
            onClick={() =>
              action.run(async () => {
                const result = await api('/api/bridge/start', 'POST', { compatibility });
                setCompatibility(false);
                await refresh();
                action.setSuccess(result.message || '已读取桥接状态。');
              })
            }
          >
            <Play size={17} weight="fill" />
            启动桥接
          </Button>
          <Button
            busy={action.busy}
            disabled={!bridge.managed}
            onClick={() =>
              action.run(async () => {
                const result = await api('/api/bridge/stop', 'POST', {});
                setCompatibility(false);
                await refresh();
                action.setSuccess(result.message);
              })
            }
          >
            <Stop size={17} />
            停止桥接
          </Button>
          <Button
            busy={action.busy}
            onClick={() =>
              action.run(async () => {
                await api('/api/bridge/refresh', 'POST', {});
                await refresh();
              }, '已重新读取桥接配置。')
            }
          >
            <ArrowClockwise size={17} />
            重新检查
          </Button>
          <Button
            busy={action.busy}
            onClick={() => action.run(async () => setDiscover(await api('/api/bridge/chats')))}
          >
            <ChatCircleText size={18} />
            读取可用群聊
          </Button>
        </div>
        {Object.keys(bridge.diagnostics || {}).length > 0 && (
          <details className="diagnostics">
            <summary>
              查看诊断详情 <CaretDown size={15} />
            </summary>
            <dl>
              {Object.entries(bridge.diagnostics).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {discover && (
          <div className="discovered-chats">
            <h3>桥接已识别的群聊</h3>
            {discover.length ? (
              <div className="button-row">
                {discover.map((c) => (
                  <Button
                    key={c.bindingKey}
                    disabled={data.chats.some((chat) => chat.name === c.name) || action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api('/api/chats', 'POST', { name: c.name });
                        await refresh();
                      }, '群聊已添加，默认关闭监听。')
                    }
                  >
                    <Plus size={16} />
                    {c.name}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="hint">
                尚未读取到可绑定的群聊。请查看桥接诊断，也可以手动填写准确群名。
              </p>
            )}
          </div>
        )}
      </section>
      <Feedback error={action.error} success={action.success} />
      {data.settings.paused && (
        <Notice>
          全局暂停：机器人不会自动回应群消息，手动“发送测试”仍有效。配置模型并完成群验收后，点击顶部“开始运行”。
        </Notice>
      )}
      <section className="page-section">
        <div className="section-title">
          <h2>管理群聊</h2>
          <span className="hint">{data.chats.length} 个已添加</span>
        </div>
        <form
          className="inline-form add-chat"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api('/api/chats', 'POST', { name: name.trim() });
              setName('');
              await refresh();
            }, '群聊已添加。请按需开启监听并进行测试。');
          }}
        >
          <Field label="准确的微信群名">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：机器人测试群"
              required
              maxLength={150}
            />
          </Field>
          <Button type="submit" busy={action.busy} disabled={!name.trim()}>
            <Plus size={18} />
            添加群聊
          </Button>
        </form>
        {!data.chats.length ? (
          <Empty title="还没有添加群聊">填写准确群名，或从桥接读取的列表中添加。</Empty>
        ) : (
          <div className="chat-list">
            {data.chats.map((chat) => (
              <article className="chat-item" key={chat.id}>
                <div className="chat-item-heading">
                  <div className="group-avatar">
                    <ChatCircleText size={24} />
                  </div>
                  <div>
                    <h3>{chat.name}</h3>
                    <p>{chat.verified ? '已通过真实收发验收' : '请完成发送测试与群内 @ 验证'}</p>
                  </div>
                  <Badge tone={chat.verified ? 'good' : 'warn'}>
                    {chat.verified ? '已验收' : '待验收'}
                  </Badge>
                </div>
                <div className="chat-switches">
                  <Toggle
                    checked={chat.enabled}
                    onChange={(enabled) => {
                      void action.run(() => patch(chat, { enabled }));
                    }}
                    disabled={action.busy}
                    label="监听此群"
                    hint="开启后才会接收此群消息"
                  />
                  <Toggle
                    checked={chat.proactive}
                    onChange={(proactive) => {
                      void action.run(() => patch(chat, { proactive }));
                    }}
                    disabled={action.busy}
                    label="主动参与"
                    hint="仍受全局暂停与验收状态约束"
                  />
                </div>
                <div className="chat-actions">
                  <Button disabled={!chat.enabled || action.busy} onClick={() => setTestChat(chat)}>
                    <PaperPlaneTilt size={17} />
                    发送测试
                  </Button>
                  <Button
                    busy={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api(`/api/chats/${chat.id}/verify`, 'POST', {});
                        await refresh();
                      }, `${chat.name} 已通过收发验收。`)
                    }
                  >
                    <CheckCircle size={18} />
                    验证收发
                  </Button>
                  <Button onClick={() => setMessagesChat(chat)}>
                    <ChatCircleText size={18} />
                    最近消息
                  </Button>
                  <Button
                    variant="ghost"
                    busy={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api(`/api/chats/${chat.id}/stop`, 'POST', {});
                        await refresh();
                      }, `已停止 ${chat.name} 当前回复。`)
                    }
                  >
                    <Stop size={17} />
                    停止当前回复
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="hint verification-help">
          验收方式：开启该群监听 → 发送测试并在微信中确认收到 → 在群中 @机器人发送一句话 →
          点击“验证收发”。验证失败会显示实际原因。
        </p>
      </section>
      <section className="surface page-section">
        <h2>主动参与节奏</h2>
        <p className="hint">主动参与只在已启用、已验收且允许主动参与的群中运行。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await saveSettings({ proactive });
              setDirty(false);
            }, '主动参与节奏已保存。');
          }}
        >
          <div className="form-grid three">
            <Field label="两次主动回复间隔（秒）">
              <input
                type="number"
                min={10}
                max={86400}
                required
                value={proactive.cooldownSeconds}
                onChange={(e) => {
                  setProactive((p) => ({ ...p, cooldownSeconds: Number(e.target.value) }));
                  setDirty(true);
                }}
              />
            </Field>
            <Field label="每小时最多回复">
              <input
                type="number"
                min={1}
                max={100}
                required
                value={proactive.hourlyLimit}
                onChange={(e) => {
                  setProactive((p) => ({ ...p, hourlyLimit: Number(e.target.value) }));
                  setDirty(true);
                }}
              />
            </Field>
            <Field label="判断间隔（秒）">
              <input
                type="number"
                min={20}
                max={600}
                required
                value={proactive.judgeIntervalSeconds}
                onChange={(e) => {
                  setProactive((p) => ({ ...p, judgeIntervalSeconds: Number(e.target.value) }));
                  setDirty(true);
                }}
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" busy={action.busy}>
            保存参与节奏
          </Button>
        </form>
      </section>
      {testChat && (
        <Confirm
          title="向所选群发送测试消息"
          confirm="确认发送测试"
          onClose={() => setTestChat(undefined)}
          onConfirm={async () => {
            await api(`/api/chats/${testChat.id}/test`, 'POST', {});
            await refresh();
            action.setSuccess(
              `已为「${testChat.name}」提交测试。请到微信核对【WeChatBot工作台测试】消息。`,
            );
          }}
        >
          将向「{testChat.name}
          」发送一条带有【WeChatBot工作台测试】标记的真实微信消息。请确认所选群正确。
        </Confirm>
      )}
      {messagesChat && (
        <MessagesDialog
          chat={messagesChat}
          revision={revision}
          onClose={() => setMessagesChat(undefined)}
        />
      )}
    </div>
  );
}
function MessagesDialog({
  chat,
  revision,
  onClose,
}: {
  chat: Chat;
  revision: number;
  onClose: () => void;
}) {
  const resource = useResource<any[]>(`/api/chats/${chat.id}/messages`, revision);
  return (
    <Modal title={`${chat.name} · 最近消息`} onClose={onClose} wide>
      <ResourceState {...resource} retry={resource.reload} />
      {resource.data &&
        (resource.data.length ? (
          <div className="actual-messages">
            {resource.data.map((m) => (
              <article key={m.id} className={m.direction === 'out' ? 'outgoing' : ''}>
                <div>
                  <strong>
                    {m.direction === 'out' ? '机器人' : m.sender_name || '未知发言者'}
                  </strong>
                  <time>{dateTime(m.observed_at || m.created_at)}</time>
                  {m.mentioned && <Badge tone="accent">@提及</Badge>}
                </div>
                <p>{m.content}</p>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="暂无真实消息">消息将在桥接实际捕获后出现在这里。</Empty>
        ))}
      <p className="hint">无法识别的发言者保留为未知，不会归属到其他群成员。</p>
    </Modal>
  );
}
