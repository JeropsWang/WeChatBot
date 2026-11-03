/** 群权限与附加能力。成员操作绑定群 ID 与成员 ID，不以昵称作为跨群身份；写入失败保留编辑状态。 */
import { MemberCreator, ManagedMemberEditor } from './MemberManagement';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowCounterClockwise,
  ClockCounterClockwise,
  CaretLeft,
  CaretRight,
  Copy,
  FloppyDisk,
  MagnifyingGlass,
  Plus,
  Trash,
  User,
} from '@phosphor-icons/react';
import {
  api,
  dateTime,
  parseTags,
  queryString,
  useAction,
  useResource,
  type Bootstrap,
  type PageResult,
} from './api';
import {
  Badge,
  Button,
  Confirm,
  Empty,
  Feedback,
  Field,
  Modal,
  Notice,
  Pagination,
  ResourceState,
  Toggle,
} from './ui';

export interface GroupMember {
  id: string;
  chatId: string;
  number: number;
  nickname: string;
  aliases: string[];
  identityStatus: string;
  identitySource?: string;
  profile: any;
  impression?: { id: string; content: string; tags: string[]; updatedAt: string } | null;
  pinned: boolean;
  mode: string;
  evidence: any[];
  version: number;
  manualReview?: {
    status: 'unreviewed' | 'approved' | 'revoked' | 'needs-review';
    version: number;
    reviewedAt: string | null;
  };
}
const identityNames: Record<string, string> = {
  verified: '已确认',
  unknown: '未确认',
  conflicted: '身份冲突',
};
const identityLabel = (member: GroupMember) =>
  member.identityStatus === 'conflicted'
    ? '身份冲突'
    : member.manualReview?.status === 'approved'
      ? '人工已核实'
      : member.manualReview?.status === 'needs-review'
        ? '需重新核实'
        : member.manualReview?.status === 'revoked'
          ? '已撤销核实'
          : member.identitySource === 'wechat-ui-profile'
            ? '界面已匹配'
            : identityNames[member.identityStatus] || '身份未确认';
const modeNames: Record<string, string> = {
  normal: '普通人格',
  ordinary: '普通人格',
  default: '普通人格',
  jerops: '#JEROPS',
  plan: '/plan',
};

export function GroupFeatures({
  tab,
  data,
  revision,
  onDirty,
}: {
  tab: string;
  data: Bootstrap;
  revision: number;
  onDirty: (value: boolean) => void;
}) {
  const [chatId, setChatId] = useState(() => data.chats[0]?.id || ''),
    dirty = useRef(false);
  const markDirty = (value: boolean) => {
    dirty.current = value;
    onDirty(value);
  };
  const switchGroup = (next: string) => {
    if (dirty.current && !window.confirm('此群的修改尚未保存。放弃修改并切换群聊？')) return;
    markDirty(false);
    setChatId(next);
  };
  useEffect(() => () => onDirty(false), [onDirty]);
  if (!data.chats.length)
    return (
      <Empty title="请先添加群聊">
        在“群聊设置”中添加真实微信群后，再维护该群的成员、权限和玩法。
      </Empty>
    );
  return (
    <>
      <div className="group-selector">
        <Field label="当前群聊">
          <select value={chatId} onChange={(e) => switchGroup(e.target.value)}>
            {data.chats.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chat.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="hint">成员画像、模式与权限只在此群使用。</p>
      </div>
      <div key={`${chatId}:${tab}`}>
        {tab === 'members' ? (
          <Members
            chatId={chatId}
            chatName={data.chats.find((chat) => chat.id === chatId)?.name || '未命名群聊'}
            revision={revision}
            onDirty={markDirty}
          />
        ) : tab === 'permissions' ? (
          <Permissions chatId={chatId} revision={revision} onDirty={markDirty} />
        ) : (
          <>
            <StickerSettings chatId={chatId} revision={revision} />
            <Foods chatId={chatId} revision={revision} onDirty={markDirty} />
          </>
        )}
      </div>
    </>
  );
}

function StickerSettings({ chatId, revision }: { chatId: string; revision: number }) {
  const resource = useResource<{ enabled: boolean }>(
      `/api/chats/${chatId}/sticker-settings`,
      revision,
    ),
    action = useAction();
  return (
    <section className="panel">
      <h3>自动表情</h3>
      <p className="hint">
        文字发送确认后，根据回复场景选择最多一张已启用的 PNG 表情；无明确匹配时只发文字。
      </p>
      <ResourceState {...resource} retry={resource.reload} />
      {resource.data && (
        <Toggle
          label="在此群启用自动表情"
          checked={resource.data.enabled}
          onChange={(enabled) =>
            void action.run(
              async () => {
                await api(`/api/chats/${chatId}/sticker-settings`, 'PUT', { enabled });
                await resource.reload();
              },
              enabled ? '本群自动表情已启用。' : '本群自动表情已关闭。',
            )
          }
        />
      )}
      <Feedback error={action.error} success={action.success} />
    </section>
  );
}

function Members({
  chatId,
  chatName,
  revision,
  onDirty,
}: {
  chatId: string;
  chatName: string;
  revision: number;
  onDirty: (value: boolean) => void;
}) {
  const [q, setQ] = useState(''),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20),
    [selected, setSelected] = useState<GroupMember>(),
    [mobileDetail, setMobileDetail] = useState(false);
  const dirty = useRef(false),
    deletedIds = useRef(new Set<string>()),
    [adding, setAdding] = useState(false);
  const resource = useResource<PageResult<GroupMember>>(
    `/api/chats/${chatId}/members?${queryString({ q, page, pageSize })}`,
    revision,
  );
  const items = (resource.data?.items || []).filter((member) => !deletedIds.current.has(member.id));
  useEffect(() => {
    if (!selected && items.length) setSelected(items[0]);
  }, [items, selected]);
  useEffect(() => {
    if (selected && !dirty.current) {
      const updated = items.find((m) => m.id === selected.id);
      if (updated && updated !== selected) setSelected(updated);
    }
  }, [items, selected]);
  const selectMember = (member: GroupMember) => {
    if (dirty.current && !window.confirm('成员画像尚未保存。放弃修改并切换？')) return;
    dirty.current = false;
    onDirty(false);
    setSelected(member);
    setMobileDetail(true);
  };
  return (
    <div className={`master-detail members-workspace ${mobileDetail ? 'show-detail' : ''}`}>
      <section className="master-pane">
        <div className="search-field">
          <MagnifyingGlass size={21} />
          <input
            aria-label="搜索成员昵称或群内序号"
            placeholder="昵称或群内序号"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="section-title member-list-heading">
          <h3>本群成员</h3>
          <Button
            onClick={() => {
              if (dirty.current && !window.confirm('成员修改尚未保存。放弃修改并添加成员？'))
                return;
              dirty.current = false;
              onDirty(false);
              setAdding(true);
            }}
          >
            <Plus size={18} />
            添加成员
          </Button>
          <span className="hint">共 {resource.data?.total ?? '—'} 人</span>
        </div>
        <ResourceState {...resource} retry={resource.reload} />
        {resource.data &&
          (items.length ? (
            <div className="member-rows">
              {items.map((member) => (
                <button
                  key={member.id}
                  className={`member-row ${selected?.id === member.id ? 'selected' : ''}`}
                  onClick={() => selectMember(member)}
                >
                  <span className="member-avatar">
                    <User size={28} />
                  </span>
                  <span className="member-number">#{String(member.number).padStart(3, '0')}</span>
                  <strong>{member.nickname || '未命名成员'}</strong>
                  <Badge tone={member.identityStatus === 'verified' ? 'good' : 'warn'}>
                    {identityLabel(member)}
                  </Badge>
                  <CaretRight size={18} />
                </button>
              ))}
            </div>
          ) : (
            <Empty title={q ? '没有匹配的成员' : '尚无可识别成员'}>
              昵称不能作为授权依据。桥接未提供可验证身份时，消息会保留为未知发言者。
            </Empty>
          ))}
        {resource.data && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={resource.data.total}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            busy={resource.loading}
          />
        )}
      </section>
      <aside className="detail-pane">
        <button className="text-button mobile-detail-back" onClick={() => setMobileDetail(false)}>
          <CaretLeft size={18} />
          返回成员列表
        </button>
        {selected ? (
          <MemberEditor
            key={selected.id}
            member={selected}
            chatId={chatId}
            chatName={chatName}
            onDirty={(value) => {
              dirty.current = value;
              onDirty(value);
            }}
            onSaved={async (member) => {
              setSelected(member);
              await resource.reload();
            }}
            onDeleted={async () => {
              if (selected) deletedIds.current.add(selected.id);
              dirty.current = false;
              onDirty(false);
              setSelected(undefined);
              setMobileDetail(false);
              await resource.reload();
            }}
          />
        ) : (
          <Empty title="选择成员查看画像" />
        )}
      </aside>
      {adding && (
        <MemberCreator
          chatId={chatId}
          onDirty={(value) => {
            dirty.current = value;
            onDirty(value);
          }}
          onClose={() => {
            if (dirty.current && !window.confirm('成员尚未添加。放弃输入？')) return;
            dirty.current = false;
            onDirty(false);
            setAdding(false);
          }}
          onSaved={async (member) => {
            dirty.current = false;
            onDirty(false);
            setAdding(false);
            setSelected(member);
            setMobileDetail(true);
            await resource.reload();
          }}
        />
      )}
    </div>
  );
}

function MemberEvidence({ evidence }: { evidence: any[] }) {
  const heading = useId();
  return (
    <section className="source-section member-evidence">
      <h3 id={heading}>消息依据</h3>
      {evidence.length ? (
        <div className="member-evidence-list" role="region" aria-labelledby={heading} tabIndex={0}>
          {evidence.map((item, index) => (
            <EvidenceMessage key={item.id || index} evidence={item} />
          ))}
        </div>
      ) : (
        <p className="hint">尚无可展示的消息原文依据，不会填入示例画像。</p>
      )}
    </section>
  );
}
function EvidenceMessage({ evidence }: { evidence: any }) {
  const id = useId(),
    text =
      typeof evidence === 'string'
        ? '关联消息 ID：' + evidence
        : evidence.content ||
          evidence.text ||
          '已关联消息 ' + (evidence.messageId || evidence.id || '');
  const [expanded, setExpanded] = useState(false),
    [overflow, setOverflow] = useState(false),
    ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      if (!expanded) setOverflow(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <article className="source-evidence">
      <span>{dateTime(evidence.observedAt || evidence.createdAt || evidence.created_at)}</span>
      <p id={id} ref={ref} className={expanded ? 'evidence-body expanded' : 'evidence-body'}>
        {text}
      </p>
      {(overflow || expanded) && (
        <button
          type="button"
          className="text-button evidence-expand"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </article>
  );
}
function MemberReview({
  member,
  chatId,
  chatName,
  onSaved,
}: {
  member: GroupMember;
  chatId: string;
  chatName: string;
  onSaved: (member: GroupMember) => Promise<void>;
}) {
  const [review, setReview] = useState<'approve' | 'revoke'>(),
    [source, setSource] = useState(''),
    action = useAction();
  const approved = member.manualReview?.status === 'approved';
  return (
    <section className="member-review">
      <div className="section-title">
        <div>
          <h3>人工核实</h3>
          <p className="hint">核实身份后，仍需在“指令与权限”单独授予 /plan 权限。</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setSource(member.evidence?.[0]?.id || '');
            setReview(approved ? 'revoke' : 'approve');
          }}
        >
          {approved ? '撤销核实' : '人工核实身份'}
        </Button>
      </div>
      {member.manualReview?.reviewedAt && (
        <p className="hint">最近核实操作：{dateTime(member.manualReview.reviewedAt)}</p>
      )}
      {review && (
        <Modal
          title={review === 'approve' ? '人工核实成员身份' : '撤销成员核实'}
          onClose={() => setReview(undefined)}
        >
          <p>
            所属群聊：<strong>{chatName}</strong>
          </p>
          <p>
            当前群内成员 #{String(member.number).padStart(3, '0')} ·{' '}
            {member.nickname || '未命名成员'}
          </p>
          <p className="hint">成员 ID：{member.id}</p>
          {review === 'approve' ? (
            <>
              <Field label="选择真实消息依据">
                <select value={source} onChange={(event) => setSource(event.target.value)}>
                  <option value="">请选择依据消息</option>
                  {member.evidence.map((item) => (
                    <option key={item.id} value={item.id}>
                      {dateTime(item.observedAt)} · {String(item.content || '').slice(0, 60)}
                    </option>
                  ))}
                </select>
              </Field>
              {source && (
                <p className="review-evidence-text">
                  {member.evidence.find((item) => item.id === source)?.content}
                </p>
              )}
              <Notice>
                请核对发言者与当前成员确为同一人。核实仅在此群生效，不会自动授予 plan 权限。
              </Notice>
            </>
          ) : (
            <Notice>
              撤销后退出此成员的特殊模式，并移除本群 plan 授权；未发送的特殊模式回答会取消。
            </Notice>
          )}
          <Feedback error={action.error} />
          <div className="button-row">
            <Button
              type="button"
              variant="primary"
              busy={action.busy}
              disabled={review === 'approve' && !source}
              onClick={() =>
                action.run(async () => {
                  const saved = await api<GroupMember>(
                    `/api/chats/${chatId}/members/${member.id}/review`,
                    'POST',
                    {
                      action: review,
                      ...(review === 'approve' ? { evidenceMessageId: source } : {}),
                    },
                  );
                  await onSaved(saved);
                  setReview(undefined);
                })
              }
            >
              {review === 'approve' ? '确认此成员身份' : '确认撤销核实'}
            </Button>
            <Button type="button" onClick={() => setReview(undefined)}>
              取消
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function MemberEditor({
  member,
  chatId,
  chatName,
  onDirty,
  onSaved,
  onDeleted,
}: {
  member: GroupMember;
  chatId: string;
  chatName: string;
  onDirty: (value: boolean) => void;
  onSaved: (member: GroupMember) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [history, setHistory] = useState(false);
  return (
    <>
      <ManagedMemberEditor
        member={member}
        chatId={chatId}
        onDirty={onDirty}
        onSaved={onSaved}
        onDeleted={onDeleted}
        onHistory={() => setHistory(true)}
        review={
          <MemberReview member={member} chatId={chatId} chatName={chatName} onSaved={onSaved} />
        }
        evidence={<MemberEvidence evidence={member.evidence || []} />}
      />
      {history && (
        <MemberHistory member={member} chatId={chatId} onClose={() => setHistory(false)} />
      )}
    </>
  );
}

function MemberHistory({
  chatId,
  member,
  onClose,
}: {
  chatId: string;
  member: GroupMember;
  onClose: () => void;
}) {
  const resource = useResource<{ version: number; snapshot: any; created_at: string }[]>(
    `/api/chats/${chatId}/members/${member.id}/versions`,
    member.version,
  );
  return (
    <Modal title={`${member.nickname || '成员'} · 画像版本`} onClose={onClose} wide>
      <p className="hint">
        群内序号 #{String(member.number).padStart(3, '0')} · ID: {member.id}
      </p>
      <ResourceState {...resource} retry={resource.reload} />
      {resource.data?.length ? (
        <div className="history-list">
          {resource.data.map((item) => {
            const profile = item.snapshot.profile || item.snapshot;
            return (
              <article key={item.version}>
                <div>
                  <Badge>版本 {item.version}</Badge>
                  <time>{dateTime(item.created_at)}</time>
                </div>
                <p>
                  {typeof profile === 'string'
                    ? profile
                    : profile.summary || profile.notes || '该版本没有画像补充'}
                </p>
                {Array.isArray(profile.interests) && (
                  <p>兴趣：{profile.interests.join('，') || '未记录'}</p>
                )}
                {Array.isArray(profile.preferences) && (
                  <p>偏好：{profile.preferences.join('，') || '未记录'}</p>
                )}
                {typeof profile.communication === 'string' && profile.communication && (
                  <p>交流习惯：{profile.communication}</p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        !resource.loading && !resource.error && <Empty title="暂无画像历史版本" />
      )}
    </Modal>
  );
}

function Permissions({
  chatId,
  revision,
  onDirty,
}: {
  chatId: string;
  revision: number;
  onDirty: (value: boolean) => void;
}) {
  const resource = useResource<{ memberIds: string[] }>(
      `/api/chats/${chatId}/plan-members`,
      revision,
    ),
    [page, setPage] = useState(1),
    [q, setQ] = useState('');
  const members = useResource<PageResult<GroupMember>>(
    `/api/chats/${chatId}/members?${queryString({ page, pageSize: 100, q })}`,
    revision,
  );
  const [slots, setSlots] = useState<string[]>(['', '']),
    [dirty, setDirty] = useState(false),
    action = useAction();
  useEffect(() => {
    if (resource.data && !dirty)
      setSlots([resource.data.memberIds[0] || '', resource.data.memberIds[1] || '']);
  }, [resource.data, dirty]);
  return (
    <section className="permissions-panel">
      <h2>指令与权限</h2>
      <p className="hint">
        每群最多 2 位 /plan 授权成员。权限绑定稳定成员 ID，昵称变化不会转移授权。
      </p>
      <Notice>
        #JEROPS 与 /plan 仅影响当前群、当前成员，互斥保留至 #CANCEL。未配置的特殊模式不会启用。
      </Notice>
      <ResourceState {...resource} retry={resource.reload} />
      <div className="toolbar">
        <div className="search-field">
          <MagnifyingGlass size={19} />
          <input
            value={q}
            aria-label="查找可授权成员"
            placeholder="查找已确认成员"
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>
      <ResourceState {...members} retry={members.reload} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const memberIds = slots.filter(Boolean);
            if (new Set(memberIds).size !== memberIds.length)
              throw new Error('两个授权位置不能选择同一位成员。');
            await api(`/api/chats/${chatId}/plan-members`, 'PUT', { memberIds });
            setDirty(false);
            onDirty(false);
            await resource.reload();
          }, '本群 /plan 权限已保存。');
        }}
      >
        <div className="form-grid">
          {[0, 1].map((index) => (
            <Field key={index} label={`/plan 授权成员 ${index + 1}`}>
              <select
                value={slots[index]}
                disabled={!resource.data}
                onChange={(e) => {
                  setSlots((previous) =>
                    previous.map((value, i) => (i === index ? e.target.value : value)),
                  );
                  setDirty(true);
                  onDirty(true);
                }}
              >
                <option value="">不设置</option>
                {slots[index] &&
                  !members.data?.items.some((member) => member.id === slots[index]) && (
                    <option value={slots[index]}>已授权成员 · {slots[index]}</option>
                  )}
                {members.data?.items
                  .filter(
                    (member) =>
                      (member.identityStatus === 'verified' &&
                        !['revoked', 'needs-review'].includes(member.manualReview?.status || '')) ||
                      member.manualReview?.status === 'approved',
                  )
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      #{String(member.number).padStart(3, '0')} {member.nickname || '未命名成员'}
                    </option>
                  ))}
              </select>
            </Field>
          ))}
        </div>
        {members.data && members.data.total > 100 && (
          <Pagination page={page} pageSize={100} total={members.data.total} onPage={setPage} />
        )}
        <p className="hint">
          {members.data &&
          !members.data.items.some(
            (member) =>
              member.identityStatus === 'verified' || member.manualReview?.status === 'approved',
          )
            ? '当前页没有已确认成员。先在成员详情人工核实身份，再选择授权；不能仅凭昵称授权。'
            : '下拉列表提供本群人工核实或已验证的成员。'}
        </p>
        <Feedback error={action.error} success={action.success} />
        <Button type="submit" variant="primary" busy={action.busy} disabled={!resource.data}>
          <FloppyDisk size={18} />
          保存权限
        </Button>
      </form>
      <section className="command-reference">
        <h3>群内指令</h3>
        <dl>
          <div>
            <dt>#JEROPS</dt>
            <dd>切换当前成员的特殊人格，需已配置提示词。</dd>
          </div>
          <div>
            <dt>/plan</dt>
            <dd>仅本群已授权且身份已确认的成员可用。</dd>
          </div>
          <div>
            <dt>#CANCEL</dt>
            <dd>退出当前成员的特殊模式，恢复普通人格。</dd>
          </div>
        </dl>
      </section>
    </section>
  );
}

interface Food {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  imageAssetId?: string | null;
  imageUrl?: string | null;
  enabled?: boolean;
}
function Foods({
  chatId,
  revision,
  onDirty,
}: {
  chatId: string;
  revision: number;
  onDirty: (value: boolean) => void;
}) {
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20);
  const foods = useResource<PageResult<Food>>(
      `/api/foods?${queryString({ page, pageSize })}`,
      revision,
    ),
    selected = useResource<{ foodIds: string[] }>(`/api/chats/${chatId}/foods`, revision);
  const [chosen, setChosen] = useState<string[]>([]),
    [dirty, setDirty] = useState(false),
    [editing, setEditing] = useState<Food | 'new'>(),
    [remove, setRemove] = useState<Food>(),
    [preview, setPreview] = useState<any>(),
    action = useAction();
  const [editorDirty, setEditorDirty] = useState(false);
  useEffect(() => {
    onDirty(dirty || editorDirty);
  }, [dirty, editorDirty]);
  const editFood = (food: Food | 'new') => {
    if (editorDirty && !window.confirm('菜品修改尚未保存。放弃并编辑其他菜品？')) return;
    setEditorDirty(false);
    setEditing(food);
  };
  useEffect(() => {
    if (selected.data && !dirty) setChosen(selected.data.foodIds);
  }, [selected.data, dirty]);
  return (
    <section className="foods-panel">
      <div className="section-title">
        <div>
          <h2>今天吃什么</h2>
          <p className="hint">
            统一菜库，各群选择参与菜品。均匀随机、不调用模型；群内有 60 秒冷却。
          </p>
        </div>
        <Button onClick={() => editFood('new')}>
          <Plus size={18} />
          添加菜品
        </Button>
      </div>
      <ResourceState {...foods} retry={foods.reload} />
      <ResourceState {...selected} retry={selected.reload} />
      <Notice>
        网页预览不会向微信发送消息。图片发送能力以桥接实际报告为准，未验证时不会宣称支持。
      </Notice>
      {foods.data &&
        (foods.data.items.length ? (
          <div className="food-list">
            {foods.data.items.map((food) => (
              <article key={food.id}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={chosen.includes(food.id)}
                    disabled={!selected.data}
                    onChange={(e) => {
                      setChosen((previous) =>
                        e.target.checked
                          ? [...previous, food.id]
                          : previous.filter((id) => id !== food.id),
                      );
                      setDirty(true);
                      onDirty(true);
                    }}
                  />
                  {food.imageUrl && <img src={food.imageUrl} alt="" />}
                  <strong>{food.name}</strong>
                </label>
                <span className="hint">
                  {food.imageAssetId ? '已关联托管图片' : '尚未关联图片'}
                </span>
                <Button onClick={() => editFood(food)}>编辑</Button>
                <button
                  className="icon-button danger-text"
                  aria-label={`删除菜品 ${food.name}`}
                  onClick={() => setRemove(food)}
                >
                  <Trash size={19} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="菜库还是空的">先添加真实菜名，并从素材库关联图片。</Empty>
        ))}
      <>
        {foods.data && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={foods.data.total}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            busy={foods.loading}
          />
        )}
      </>
      <Feedback error={action.error} success={action.success} />
      <div className="button-row">
        <Button
          variant="primary"
          busy={action.busy}
          disabled={!selected.data}
          onClick={() =>
            action.run(async () => {
              await api(`/api/chats/${chatId}/foods`, 'PUT', { foodIds: chosen });
              setDirty(false);
              onDirty(false);
              await selected.reload();
            }, '本群菜品已保存。')
          }
        >
          <FloppyDisk size={18} />
          保存本群选择
        </Button>
        <Button
          busy={action.busy}
          disabled={dirty || !selected.data?.foodIds.length}
          onClick={() =>
            action.run(async () => setPreview(await api('/api/foods/preview', 'POST', { chatId })))
          }
        >
          网页抽签预览
        </Button>
        {dirty && <span className="hint">请先保存本群选择，再预览。</span>}
      </div>
      {preview && (
        <div className="food-preview">
          <h3>本次网页预览</h3>
          {(preview.imageUrl || preview.food?.imageUrl) && (
            <img src={preview.imageUrl || preview.food?.imageUrl} alt="抽中的菜品" />
          )}
          <p>{preview.name || preview.food?.name || '服务未返回菜名'}</p>
          {preview.capability?.reason && <p className="hint">{preview.capability.reason}</p>}
        </div>
      )}
      {editing && (
        <FoodEditor
          key={editing === 'new' ? 'new' : editing.id}
          food={editing === 'new' ? undefined : editing}
          revision={revision}
          onDirty={setEditorDirty}
          onClose={() => {
            if (!editorDirty || window.confirm('菜品修改尚未保存。放弃修改？')) {
              setEditing(undefined);
              setEditorDirty(false);
            }
          }}
          onSaved={async () => {
            setEditing(undefined);
            setEditorDirty(false);
            await foods.reload();
          }}
        />
      )}
      {remove && (
        <Confirm
          title="从统一菜库删除"
          danger
          confirm="删除菜品"
          onClose={() => setRemove(undefined)}
          onConfirm={async () => {
            await api(`/api/foods/${remove.id}`, 'DELETE');
            setChosen((previous) => previous.filter((id) => id !== remove.id));
            await foods.reload();
            await selected.reload();
          }}
        >
          删除「{remove.name}」将影响所有使用该菜品的群聊。
        </Confirm>
      )}
    </section>
  );
}
function FoodEditor({
  food,
  revision,
  onClose,
  onSaved,
  onDirty,
}: {
  food?: Food;
  revision: number;
  onDirty: (value: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(food?.name || ''),
    [imageAssetId, setImageAssetId] = useState(food?.imageAssetId || ''),
    [description, setDescription] = useState(food?.description || ''),
    [category, setCategory] = useState(food?.category || ''),
    [tags, setTags] = useState(food?.tags?.join('，') || ''),
    [enabled, setEnabled] = useState(food?.enabled ?? true),
    action = useAction();
  const [page, setPage] = useState(1),
    [q, setQ] = useState('');
  const assets = useResource<PageResult<{ id: string; name: string; kind: string }>>(
    `/api/media-assets?${queryString({ kind: 'image', page, pageSize: 20, q })}`,
    revision,
  );
  return (
    <div className="food-editor">
      <h3>{food ? '编辑菜品' : '添加菜品'}</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(food ? `/api/foods/${food.id}` : '/api/foods', food ? 'PATCH' : 'POST', {
              name: name.trim(),
              imageAssetId: imageAssetId || null,
              description,
              category,
              tags: tags
                .split(/[,，]/)
                .map((value) => value.trim())
                .filter(Boolean),
              enabled,
            });
            await onSaved();
          });
        }}
      >
        <div className="form-grid">
          <Field label="菜名">
            <input
              required
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
                onDirty(true);
              }}
            />
          </Field>
          <Field label="分类">
            <input
              value={category}
              maxLength={100}
              onChange={(e) => {
                setCategory(e.target.value);
                onDirty(true);
              }}
            />
          </Field>
        </div>
        <Field label="说明">
          <textarea
            value={description}
            rows={2}
            onChange={(e) => {
              setDescription(e.target.value);
              onDirty(true);
            }}
          />
        </Field>
        <Field label="标签（逗号分隔）">
          <input
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              onDirty(true);
            }}
          />
        </Field>
        <Toggle
          label="在统一菜库中启用"
          checked={enabled}
          onChange={(value) => {
            setEnabled(value);
            onDirty(true);
          }}
        />
        <Field label="查找托管图片">
          <input
            placeholder="素材名称"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <ResourceState {...assets} retry={assets.reload} />
        <Field label="托管图片素材" hint="在“人设与风格 → 表情素材”中上传图片；下方可翻页选择。">
          <select
            value={imageAssetId}
            onChange={(e) => {
              setImageAssetId(e.target.value);
              onDirty(true);
            }}
          >
            <option value="">不关联素材</option>
            {imageAssetId && !assets.data?.items.some((asset) => asset.id === imageAssetId) && (
              <option value={imageAssetId}>当前关联 · {imageAssetId}</option>
            )}
            {assets.data?.items
              .filter((asset) => asset.kind === 'image')
              .map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
          </select>
        </Field>
        {assets.data && (
          <Pagination
            page={page}
            pageSize={20}
            total={assets.data.total}
            onPage={setPage}
            busy={assets.loading}
          />
        )}
        <Feedback error={action.error} />
        <div className="button-row">
          <Button type="submit" busy={action.busy} variant="primary">
            保存菜品
          </Button>
          <Button type="button" onClick={onClose}>
            取消
          </Button>
        </div>
      </form>
    </div>
  );
}
