/** 追猎设置、图库与群成员白名单。保存携带版本和成员 ID；失败保留草稿，检测结果不等同于微信已发送。 */
import { useAppearance } from './Appearance';
import { useEffect, useState } from 'react';
import { api, queryString, useAction, useResource, type Bootstrap, type PageResult } from './api';
import { Badge, Button, Feedback, Field, Notice, ResourceState, Toggle } from './ui';
import { HuntQueue } from './HuntQueue';
import { HuntGallery, type HuntReference } from './HuntGallery';
import './HuntSettings.css';

interface WhitelistEntry {
  chatId: string;
  memberId: string;
}
interface MemberChoice {
  id: string;
  nickname: string;
  number: number;
}
interface WhitelistMember extends WhitelistEntry {
  nickname: string;
  number: number;
}
interface Settings {
  enabled: boolean;
  threshold: number;
  cooldownSeconds: number;
  prompt: string;
  version: number;
  enabledAt: string;
  whitelist: WhitelistEntry[];
  enabledReferenceIds: string[];
  deletedReferenceIds?: string[];
}
interface Image {
  id: string;
  number: string;
  ownerName?: string;
  observedAt: string;
  status: string;
}
interface Detection {
  similarity: number;
  threshold: number;
  trigger: boolean;
  matchedReference: string;
  category: string;
}

export function HuntSettings({
  data,
  revision,
  onDirty,
}: {
  data: Bootstrap;
  revision: number;
  onDirty: (dirty: boolean) => void;
}) {
  // 复用同一追猎草稿与接口状态，仅按主题改变布局，不维护两份配置。
  const { appearance } = useAppearance();
  const [addOpen, setAddOpen] = useState(false),
    [testOpen, setTestOpen] = useState(false);
  const formal = appearance === 'formal';
  const saved = useResource<{
    settings: Settings;
    whitelistMembers: WhitelistMember[];
    references: HuntReference[];
    galleryVersion: string;
    matcher: { running: boolean; ready: boolean; referenceCount: number };
  }>('/api/hunt', revision);
  const [form, setForm] = useState<Settings>(),
    [dirty, setDirty] = useState(false),
    [chatId, setChatId] = useState(''),
    [imageId, setImageId] = useState(''),
    [result, setResult] = useState<Detection & { attachmentId: string; chatId: string }>();
  const save = useAction(),
    test = useAction();
  const [whitelistChat, setWhitelistChat] = useState(''),
    [memberId, setMemberId] = useState(''),
    [memberSearch, setMemberSearch] = useState(''),
    [memberPage, setMemberPage] = useState(1),
    [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const members = useResource<PageResult<MemberChoice>>(
    whitelistChat
      ? `/api/chats/${whitelistChat}/members?${queryString({ q: memberSearch, page: memberPage, pageSize: 20 })}`
      : '',
    revision,
  );
  const images = useResource<Image[]>(
    chatId ? `/api/hunt/images?chatId=${encodeURIComponent(chatId)}` : '',
    revision,
  );
  const [queueRevision, setQueueRevision] = useState(0);
  const [uploaded, setUploaded] = useState<HuntReference[]>([]);
  const references = [
    ...new Map(
      [...(saved.data?.references ?? []), ...uploaded].map((item) => [item.id, item]),
    ).values(),
  ];
  useEffect(() => {
    if (saved.data && !dirty)
      setForm((previous) =>
        !previous || saved.data!.settings.version >= previous.version
          ? {
              ...saved.data!.settings,
              whitelist: saved.data!.settings.whitelist ?? [],
              enabledReferenceIds:
                saved.data!.settings.enabledReferenceIds ??
                saved.data!.references?.filter((item) => item.enabled).map((item) => item.id) ??
                [],
              deletedReferenceIds: [],
            }
          : previous,
      );
  }, [saved.data, dirty]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const change = (patch: Partial<Settings>) => {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous));
    setDirty(true);
  };
  const selected = images.data?.find((image) => image.id === imageId && image.status === 'ready');
  return (
    <main className="mode-settings hunt-settings" id="main-content">
      <div className="hunt-settings-column">
        <h2>{formal ? '追猎设置' : '追猎人格'}</h2>
        <p className="hint">开启后，系统将根据配置的参考图，在群聊中自动追猎并回复。</p>
        <ResourceState {...saved} retry={saved.reload} />
        {form && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save.run(async () => {
                const next = await api<Settings>('/api/hunt/settings', 'PUT', {
                  ...form,
                  enabledReferenceIds: form.enabledReferenceIds.filter(
                    (id) => !form.deletedReferenceIds?.includes(id),
                  ),
                });
                setForm({ ...next, deletedReferenceIds: [] });
                setUploaded([]);
                setDirty(false);
                setQueueRevision((value) => value + 1);
                await saved.reload();
              }, '追猎设置已保存，旧的待发送结果已取消。');
            }}
          >
            <fieldset className="hunt-form-controls" disabled={save.busy} aria-label="追猎设置">
              <Toggle
                checked={form.enabled}
                onChange={(enabled) => change({ enabled })}
                label="启用图片追猎"
                hint="处理之后收到的新图片；仍遵守全局暂停、群开关和停止指令。"
              />
              <HuntGallery
                references={references}
                enabledIds={form.enabledReferenceIds}
                deletedIds={form.deletedReferenceIds ?? []}
                savedIds={
                  saved.data?.settings.enabledReferenceIds ??
                  references.filter((item) => item.enabled).map((item) => item.id)
                }
                onChange={(enabledReferenceIds, deletedReferenceIds) =>
                  change({ enabledReferenceIds, deletedReferenceIds })
                }
                onUploaded={(item) => {
                  setUploaded((previous) => [
                    ...previous.filter((value) => value.id !== item.id),
                    item,
                  ]);
                  void saved.reload();
                }}
                revision={revision}
              />
              <div className="hunt-fields">
                <Field label="触发阈值" hint="相似度必须严格大于此值。0.75 是分数，不是识别概率。">
                  <input
                    type="number"
                    required
                    min={0}
                    max={1}
                    step={0.01}
                    value={form.threshold}
                    onChange={(event) => change({ threshold: Number(event.target.value) })}
                  />
                </Field>
                <Field label="同一群友冷却秒数" hint="0 表示不设冷却；同一图片事件始终只处理一次。">
                  <input
                    type="number"
                    required
                    min={0}
                    max={3600}
                    step={1}
                    value={form.cooldownSeconds}
                    onChange={(event) => change({ cooldownSeconds: Number(event.target.value) })}
                  />
                </Field>
              </div>
              <Field
                label="追猎提示词"
                hint="模型会收到已确认的群内称呼和检测结果。不会写入成员的长期人格模式。"
              >
                <textarea
                  required
                  rows={6}
                  maxLength={10000}
                  value={form.prompt}
                  onChange={(event) => change({ prompt: event.target.value })}
                />
              </Field>
              <section className="hunt-whitelist" aria-labelledby="hunt-whitelist-heading">
                <div className="hunt-whitelist-title">
                  <h3 id="hunt-whitelist-heading">
                    {formal ? (
                      <button
                        type="button"
                        className="hunt-disclosure"
                        aria-expanded={addOpen}
                        onClick={() => setAddOpen(!addOpen)}
                      >
                        追猎白名单
                      </button>
                    ) : (
                      '追猎白名单'
                    )}
                  </h3>
                  {formal && addOpen && (
                    <Button
                      type="button"
                      aria-expanded={addOpen}
                      onClick={() => setAddOpen(!addOpen)}
                    >
                      添加成员
                    </Button>
                  )}
                </div>
                <div hidden={formal && !addOpen}>
                  <p className="hint">
                    加入后，该成员在所选群发图不会触发自动追猎，普通聊天不受影响。按成员身份匹配，改昵称仍有效。修改后请保存追猎设置。
                  </p>
                  <div hidden={formal && !addOpen}>
                    <div className="hunt-fields">
                      <Field label="白名单所属群聊">
                        <select
                          value={whitelistChat}
                          onChange={(event) => {
                            setWhitelistChat(event.target.value);
                            setMemberId('');
                            setMemberSearch('');
                            setMemberPage(1);
                          }}
                        >
                          <option value="">请选择群聊</option>
                          {data.chats.map((chat) => (
                            <option key={chat.id} value={chat.id}>
                              {chat.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="查找白名单成员">
                        <input
                          type="search"
                          disabled={!whitelistChat}
                          value={memberSearch}
                          placeholder="输入群内昵称"
                          onChange={(event) => {
                            setMemberSearch(event.target.value);
                            setMemberId('');
                            setMemberPage(1);
                          }}
                        />
                      </Field>
                    </div>
                    {whitelistChat && (
                      <>
                        <ResourceState {...members} retry={members.reload} />
                        <div className="hunt-member-add">
                          <Field label="选择白名单成员">
                            <select
                              disabled={members.loading || Boolean(members.error)}
                              value={memberId}
                              onChange={(event) => setMemberId(event.target.value)}
                            >
                              <option value="">请选择成员</option>
                              {members.data?.items.map((member) => (
                                <option
                                  key={member.id}
                                  value={member.id}
                                  disabled={form.whitelist.some(
                                    (item) =>
                                      item.chatId === whitelistChat && item.memberId === member.id,
                                  )}
                                >
                                  #{String(member.number).padStart(3, '0')} · {member.nickname}
                                  {form.whitelist.some(
                                    (item) =>
                                      item.chatId === whitelistChat && item.memberId === member.id,
                                  )
                                    ? '（已加入）'
                                    : ''}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Button
                            type="button"
                            disabled={
                              !whitelistChat ||
                              !memberId ||
                              members.loading ||
                              Boolean(members.error) ||
                              form.whitelist.length >= 1000 ||
                              form.whitelist.some(
                                (item) =>
                                  item.chatId === whitelistChat && item.memberId === memberId,
                              )
                            }
                            onClick={() => {
                              const member = members.data?.items.find(
                                (item) => item.id === memberId,
                              );
                              if (!member) return;
                              setDraftNames((previous) => ({
                                ...previous,
                                [whitelistChat + ':' + memberId]:
                                  `#${String(member.number).padStart(3, '0')} · ${member.nickname}`,
                              }));
                              change({
                                whitelist: [...form.whitelist, { chatId: whitelistChat, memberId }],
                              });
                              setMemberId('');
                            }}
                          >
                            加入白名单
                          </Button>
                        </div>
                        {members.data?.total === 0 && (
                          <p className="hint">没有匹配的群成员，可先在成员页面确认档案。</p>
                        )}
                        {members.data && (
                          <nav className="pagination" aria-label="白名单成员分页">
                            <span>
                              共 {members.data.total} 位 · 每页20位 · 第 {memberPage} 页
                            </span>
                            <Button
                              type="button"
                              disabled={members.loading || memberPage <= 1}
                              onClick={() => {
                                setMemberPage((value) => value - 1);
                                setMemberId('');
                              }}
                            >
                              上一页
                            </Button>
                            <Button
                              type="button"
                              disabled={members.loading || memberPage * 20 >= members.data.total}
                              onClick={() => {
                                setMemberPage((value) => value + 1);
                                setMemberId('');
                              }}
                            >
                              下一页
                            </Button>
                          </nav>
                        )}
                      </>
                    )}

                    {!whitelistChat && (
                      <Button type="button" disabled>
                        加入白名单
                      </Button>
                    )}
                    {!whitelistChat && <p className="hint">先选择群聊，再查找并添加白名单成员。</p>}
                  </div>
                  {form.whitelist.length === 0 ? (
                    <p className="hint">尚未添加白名单成员。</p>
                  ) : (
                    <ul className="hunt-whitelist-list" aria-label="已选白名单成员">
                      {form.whitelist.map((entry) => {
                        const key = entry.chatId + ':' + entry.memberId,
                          member = saved.data?.whitelistMembers?.find(
                            (item) =>
                              item.chatId === entry.chatId && item.memberId === entry.memberId,
                          ),
                          name =
                            draftNames[key] ??
                            (member
                              ? `#${String(member.number).padStart(3, '0')} · ${member.nickname}`
                              : '成员已删除或暂不可读取');
                        return (
                          <li key={key}>
                            <span className="hunt-member-legacy">
                              {data.chats.find((chat) => chat.id === entry.chatId)?.name ??
                                '群聊不可用'}{' '}
                              · {name}
                            </span>
                            <span className="hunt-member-identity">
                              <strong>
                                {member?.nickname ??
                                  draftNames[key]?.split(' · ').slice(1).join(' · ') ??
                                  '成员已删除或暂不可读取'}
                              </strong>
                              <small>
                                {data.chats.find((chat) => chat.id === entry.chatId)?.name ??
                                  '群聊不可用'}{' '}
                                ·{' '}
                                {member
                                  ? `#${String(member.number).padStart(3, '0')}`
                                  : (draftNames[key]?.split(' · ')[0] ?? '编号不可用')}
                              </small>
                            </span>
                            <Button
                              type="button"
                              aria-label={`移除白名单成员 ${name}`}
                              onClick={() =>
                                change({
                                  whitelist: form.whitelist.filter(
                                    (item) =>
                                      item.chatId !== entry.chatId ||
                                      item.memberId !== entry.memberId,
                                  ),
                                })
                              }
                            >
                              移除
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </section>
              <Feedback error={save.error} success={save.success} />
              <div className="button-row">
                <Button type="submit" variant="primary" busy={save.busy}>
                  保存追猎设置
                </Button>
                {dirty && <span className="unsaved">有未保存的修改</span>}
              </div>
            </fieldset>
          </form>
        )}
        <section className="hunt-test hunt-detection">
          {formal ? (
            <button
              className="hunt-disclosure"
              aria-expanded={testOpen}
              onClick={() => setTestOpen(!testOpen)}
            >
              仅检测图片
            </button>
          ) : (
            <h2>仅检测图片</h2>
          )}
          <div hidden={formal && !testOpen}>
            <p className="hint">
              使用已收取的图片计算本地匹配分数。不会调用聊天模型或发送微信消息；使用已保存的阈值。
            </p>
            <p className="hint" role="status">
              {saved.data?.matcher.ready
                ? `本地匹配进程已加载 ${saved.data.matcher.referenceCount} 张参考图。`
                : '匹配进程尚未加载；首次检测会读取本地模型权重。'}
            </p>
            <Field label="选择群聊">
              <select
                disabled={test.busy}
                value={chatId}
                onChange={(event) => {
                  setChatId(event.target.value);
                  setImageId('');
                  setResult(undefined);
                }}
              >
                <option value="">请选择群聊</option>
                {data.chats.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.name}
                  </option>
                ))}
              </select>
            </Field>
            {chatId && (
              <>
                <ResourceState {...images} retry={images.reload} />
                <Field label="最近收到的图片">
                  <select
                    disabled={test.busy}
                    value={imageId}
                    onChange={(event) => {
                      setImageId(event.target.value);
                      setResult(undefined);
                    }}
                  >
                    <option value="">请选择图片编号</option>
                    {images.data?.map((image) => (
                      <option key={image.id} value={image.id} disabled={image.status !== 'ready'}>
                        {image.number} · {image.ownerName ?? '未知发送者'} ·{' '}
                        {new Date(image.observedAt).toLocaleString('zh-CN')} ·{' '}
                        {image.status === 'ready' ? '可检测' : '暂不可检测'}
                      </option>
                    ))}
                  </select>
                </Field>
                {images.data?.length === 0 && <Notice>当前群还没有已收取的图片。</Notice>}
              </>
            )}
            <Button
              busy={test.busy}
              disabled={!selected}
              onClick={() =>
                void test.run(async () => {
                  setResult(undefined);
                  const attachmentId = imageId,
                    group = chatId;
                  setResult({
                    ...(await api<Detection>('/api/hunt/test', 'POST', {
                      attachmentId,
                      chatId: group,
                    })),
                    attachmentId,
                    chatId: group,
                  });
                  await saved.reload();
                })
              }
            >
              仅检测，不发送
            </Button>
            <Feedback error={test.error} />
            {result && selected && result.attachmentId === imageId && result.chatId === chatId && (
              <div className="hunt-result" role="status">
                <Badge tone={result.trigger ? 'accent' : 'neutral'}>
                  {result.trigger ? '超过阈值' : '未超过阈值'}
                </Badge>
                <p>
                  相似度 {result.similarity.toFixed(4)}，阈值 {result.threshold}；匹配参考图{' '}
                  {result.matchedReference}。
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
      <HuntQueue
        chats={data.chats}
        chatId={chatId}
        onChatChange={(id) => {
          setChatId(id);
          setImageId('');
          setResult(undefined);
        }}
        revision={`${revision}:${queueRevision}`}
      />
    </main>
  );
}
