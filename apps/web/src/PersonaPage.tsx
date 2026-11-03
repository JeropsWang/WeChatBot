/** 人设草稿与持久配置分离。预览只请求预览接口；保存成功后才解除脏状态，切换群或标签前确认未保存修改。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FloppyDisk,
  PaperPlaneTilt,
  ChatsCircle,
  Cube,
  Database,
  ArrowCounterClockwise,
  User,
  CaretUp,
  CaretDown,
  TextAlignLeft,
  ChatCircle,
  Smiley,
} from '@phosphor-icons/react';
import {
  api,
  useAction,
  type Bootstrap,
  type Persona,
  type SaveSettings,
  type KnowledgeHit,
} from './api';
import { MediaLibrary, ModeSettings } from './PersonalityExtras';
import { HuntSettings } from './HuntSettings';
import { Badge, Button, Feedback, Field, Notice } from './ui';
type Preview = {
  text: string;
  sources: KnowledgeHit[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
};
export function PersonaPage(props: {
  data: Bootstrap;
  full: boolean;
  revision: number;
  saveSettings: SaveSettings;
  refresh: () => Promise<void>;
  onDirty: (value: boolean) => void;
}) {
  const [tab, setTab] = useState('ordinary'),
    dirty = useRef(false);
  const markDirty = useCallback(
    (value: boolean) => {
      dirty.current = value;
      props.onDirty(value);
    },
    [props.onDirty],
  );
  if (!props.full)
    return (
      <div className="persona-page ordinary-page">
        <OrdinaryPersona {...props} />
      </div>
    );
  return (
    <div className={`persona-page ${tab === 'ordinary' ? 'ordinary-page' : ''}`}>
      <div className="personality-tabs">
        <div className="page-heading">
          <div>
            <h1>人设与风格</h1>
            <p>普通人格、特殊模式与表情素材，在这里一起管理。</p>
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="人设与风格">
          {[
            ['ordinary', '普通人格'],
            ['modes', '特殊人格'],
            ['hunt', '追猎人格'],
            ['media', '表情素材'],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                if (dirty.current && !window.confirm('当前人格修改尚未保存。放弃并切换？')) return;
                markDirty(false);
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'ordinary' ? (
        <OrdinaryPersona {...props} onDirty={markDirty} />
      ) : tab === 'modes' ? (
        <ModeSettings data={props.data} revision={props.revision} onDirty={markDirty} />
      ) : tab === 'hunt' ? (
        <HuntSettings data={props.data} revision={props.revision} onDirty={markDirty} />
      ) : (
        <MediaLibrary revision={props.revision} />
      )}
    </div>
  );
}
function OrdinaryPersona({
  data,
  full,
  saveSettings,
  refresh,
  onDirty,
}: {
  data: Bootstrap;
  full: boolean;
  saveSettings: SaveSettings;
  refresh: () => Promise<void>;
  onDirty: (value: boolean) => void;
}) {
  const [previewClosed, setPreviewClosed] = useState(false);
  const [scope, setScope] = useState(''),
    chat = data.chats.find((c) => c.id === scope);
  const savedPersona = {
    ...data.settings.persona,
    ...chat?.persona,
  };
  const [persona, setPersona] = useState<Persona>(savedPersona),
    [dirty, setDirty] = useState(false);
  const [input, setInput] = useState(''),
    [conversation, setConversation] = useState<
      {
        input: string;
        result?: Preview;
        error?: string;
      }[]
    >([]);
  const save = useAction(),
    preview = useAction();
  const signature = JSON.stringify(savedPersona);
  useEffect(() => {
    if (!dirty) setPersona(JSON.parse(signature));
  }, [signature, dirty]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const change = <K extends keyof Persona>(key: K, value: Persona[K]) => {
    setPersona((p) => ({
      ...p,
      [key]: value,
    }));
    setDirty(true);
    save.setSuccess('');
  };
  const switchScope = (id: string) => {
    if (dirty && !window.confirm('当前人设尚未保存。放弃修改并切换？')) return;
    setScope(id);
    setDirty(false);
    setConversation([]);
    save.setError('');
    save.setSuccess('');
  };
  // 群覆盖单独 PATCH；全局写入通过合并最新设置，避免覆盖其他配置页的修改。
  const persist = () =>
    save.run(
      async () => {
        if (scope)
          await api(`/api/chats/${scope}`, 'PATCH', {
            persona,
          });
        else
          await saveSettings({
            persona,
          });
        setDirty(false);
        await refresh();
      },
      scope ? '已保存此群的人设。' : '人设已保存，后续回复将使用这份配置。',
    );
  // 使用当前草稿发送预览请求，不调用微信发送接口，也不提交正式记忆。
  async function sendPreview(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || preview.busy) return;
    setInput('');
    setConversation((items) => [
      ...items,
      {
        input: text,
      },
    ]);
    const result = await preview.run(() =>
      api<Preview>('/api/preview', 'POST', {
        text,
        persona,
        ...(scope
          ? {
              chatId: scope,
            }
          : {}),
      }),
    );
    if (result)
      setConversation((items) =>
        items.map((item, i) =>
          i === items.length - 1
            ? {
                ...item,
                result,
              }
            : item,
        ),
      );
  }
  return (
    <div className="persona-layout">
      <main className="persona-editor" id="main-content">
        <div className={`persona-heading ${full ? 'full-persona-heading' : ''}`}>
          <h1>{full ? '人设与风格' : '总览'}</h1>
          <p>
            {full
              ? '全局人设是共同的底色，也可以为某个群保留专属的表达。'
              : '配置机器人的人设与风格，在下方测试回复效果。完成后即可保存并应用到你的微信机器人。'}
          </p>
        </div>
        {full && (
          <div className="scope-row">
            <Field label="应用范围">
              <select value={scope} onChange={(e) => switchScope(e.target.value)}>
                <option value="">全局默认人设</option>
                {data.chats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            {scope && (
              <Badge tone="accent">
                {Object.keys(chat?.persona || {}).length ? '此群有专属配置' : '继承全局人设'}
              </Badge>
            )}
          </div>
        )}
        <section className="persona-prompt">
          <label className="section-label" htmlFor="persona-prompt">
            人设提示词
          </label>
          <div className="textarea-wrap">
            <textarea
              id="persona-prompt"
              maxLength={30000}
              value={persona.prompt}
              onChange={(e) => change('prompt', e.target.value)}
              placeholder="描述你希望它成为怎样的群聊伙伴…"
            />
            <span className="character-count">
              {persona.prompt.length.toLocaleString()} / 30,000
            </span>
          </div>
        </section>
        <section className="style-section">
          <h2>回复风格</h2>
          <div className="style-options">
            {(
              [
                [
                  'length',
                  '回复长度',
                  ['简短', '适中', '详细'],
                  '控制回复内容的详略程度。',
                  TextAlignLeft,
                ],
                [
                  'formality',
                  '表达方式',
                  ['自然', '正式'],
                  '调整说话的语气与表达风格。',
                  ChatCircle,
                ],
                [
                  'humor',
                  '幽默程度',
                  ['克制', '偶尔幽默', '活泼'],
                  '设置回复中幽默元素的使用频率。',
                  Smiley,
                ],
              ] as const
            ).map(([key, label, options, hint, Icon]) => (
              <div className="formal-style-row" key={key}>
                <Icon size={22} />
                <div className="style-description">
                  <strong>{label}</strong>
                  <p>{hint}</p>
                </div>
                <fieldset className="style-segment">
                  <legend className="sr-only">{label}</legend>
                  {options.map((value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={`persona-${key}`}
                        value={value}
                        checked={persona[key] === value}
                        onChange={() => change(key, value as never)}
                      />
                      <span>{value}</span>
                    </label>
                  ))}
                </fieldset>
              </div>
            ))}
          </div>
        </section>
        {full && (
          <details className="persona-advanced" open={undefined}>
            <summary>
              更多表达设置<span>表情使用与对话示例</span>
            </summary>
            <section className="persona-extra">
              <Field label="表情使用">
                <select
                  value={persona.emoji}
                  onChange={(e) => change('emoji', e.target.value as Persona['emoji'])}
                >
                  <option>不用</option>
                  <option>偶尔</option>
                  <option>经常</option>
                </select>
              </Field>
              <Field label="对话示例" hint="用你希望它采用的问答方式，补充具体的表达习惯。">
                <textarea
                  rows={5}
                  value={persona.examples}
                  maxLength={10000}
                  onChange={(e) => change('examples', e.target.value)}
                  placeholder="用户：…\n机器人：…"
                />
              </Field>
            </section>
          </details>
        )}
        <section className={`preview-section ${previewClosed ? 'is-collapsed' : ''}`}>
          <div className="section-title">
            <h2>
              {<ChatsCircle size={22} />}
              {'测试回复'}
            </h2>
            {
              <button
                className="preview-collapse icon-button"
                type="button"
                aria-label={previewClosed ? '展开测试回复' : '收起测试回复'}
                aria-expanded={!previewClosed}
                aria-controls="persona-preview-content"
                onClick={() => setPreviewClosed((v) => !v)}
              >
                {previewClosed ? <CaretDown size={19} /> : <CaretUp size={19} />}
              </button>
            }
          </div>
          <div
            id="persona-preview-content"
            className="preview-box"
            aria-live="polite"
            hidden={previewClosed}
          >
            {!conversation.length && (
              <div className="preview-empty">
                {<ChatsCircle size={52} weight="thin" />}
                <div>
                  <strong>{'试一句，听听回应。'}</strong>
                  <p>{'预览当前草稿的回复效果。'}</p>
                </div>
              </div>
            )}
            {conversation.map((item, index) => (
              <div className="preview-turn" key={index}>
                <div className="chat-message user">
                  <p>{item.input}</p>
                  <span className="user-avatar">
                    <User size={20} weight="fill" />
                  </span>
                </div>
                {item.result && (
                  <div className="chat-message assistant">
                    {<ChatsCircle size={26} aria-label="机器人" />}
                    <div>
                      <p>{item.result.text || '模型未返回文字。'}</p>
                      {item.result.sources?.length > 0 && (
                        <details className="sources">
                          <summary>查看 {item.result.sources.length} 条参考来源</summary>
                          {item.result.sources.map((s) => (
                            <p key={s.id}>
                              <strong>{s.title || s.source}</strong>
                              <span>{s.content}</span>
                            </p>
                          ))}
                        </details>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {preview.busy && (
              <p className="preview-thinking" role="status">
                正在等待模型回复…
              </p>
            )}
            <Feedback error={preview.error} />
            <form className="preview-input" onSubmit={sendPreview}>
              <input
                aria-label="测试消息"
                value={input}
                maxLength={8000}
                onChange={(e) => setInput(e.target.value)}
                placeholder="例如：今天有点累，想找人聊聊天"
              />
              <button type="submit" disabled={!input.trim() || preview.busy} aria-label="测试回复">
                <PaperPlaneTilt size={20} weight="fill" />
              </button>
            </form>
          </div>
          <p className="preview-note" hidden={previewClosed}>
            测试回复仅在此处显示，不会发送到微信，也不会写入长期记忆。
          </p>
        </section>
        <div className="persona-save-feedback">
          <Feedback error={save.error} success={save.success} />
        </div>
        <div className="persona-actions">
          <Button variant="primary" busy={save.busy} onClick={persist}>
            <FloppyDisk size={21} />
            保存配置
          </Button>
          {dirty && <span className="unsaved">有未保存的修改</span>}
          {scope && (
            <Button
              variant="ghost"
              onClick={() =>
                save.run(async () => {
                  await api(`/api/chats/${scope}`, 'PATCH', {
                    persona: {},
                  });
                  setDirty(false);
                  await refresh();
                }, '已恢复继承全局人设。')
              }
            >
              <ArrowCounterClockwise size={17} />
              恢复全局
            </Button>
          )}
        </div>
        <div className="overview-status">
          <button
            onClick={() =>
              document.dispatchEvent(
                new CustomEvent('liino-navigate', {
                  detail: 'chats',
                }),
              )
            }
          >
            <ChatsCircle size={24} />
            <span>微信</span>
            <Badge tone={data.bridge.connected ? 'good' : 'neutral'}>
              {data.bridge.connected ? '已连接' : '未连接'}
            </Badge>
          </button>
          <button
            onClick={() =>
              document.dispatchEvent(
                new CustomEvent('liino-navigate', {
                  detail: 'models',
                }),
              )
            }
          >
            <Cube size={24} />
            <span>模型</span>
            <span className="status-value">
              {data.models.find((m) => m.id === data.settings.chatModelId)?.name || '未配置'}
            </span>
          </button>
          <button
            onClick={() =>
              document.dispatchEvent(
                new CustomEvent('liino-navigate', {
                  detail: 'knowledge',
                }),
              )
            }
          >
            <Database size={24} />
            <span>长期记忆</span>
            <Badge tone="accent">按范围召回</Badge>
          </button>
        </div>
        {data.settings.paused && full && (
          <Notice>全局当前已暂停，保存人设后不会自动恢复微信回复。</Notice>
        )}
      </main>
    </div>
  );
}
