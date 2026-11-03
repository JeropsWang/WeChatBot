/** 特殊人格与表情素材。模式按群成员隔离，媒体资产独立持久化；不写入界面设计样例。 */
import { useEffect, useRef, useState } from 'react';
import { FloppyDisk, MagicWand, Plus, Trash, UploadSimple } from '@phosphor-icons/react';
import {
  api,
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

interface Modes {
  jeropsPrompt: string;
  planPrompt: string;
  overrides?: { jeropsPrompt?: string | null; planPrompt?: string | null };
}
export function ModeSettings({
  data,
  revision,
  onDirty,
}: {
  data: Bootstrap;
  revision: number;
  onDirty: (value: boolean) => void;
}) {
  const [chatId, setChatId] = useState(''),
    [dirty, setDirty] = useState(false),
    [form, setForm] = useState({ jeropsPrompt: '', planPrompt: '' }),
    [override, setOverride] = useState({ jeropsPrompt: false, planPrompt: false });
  const resource = useResource<Modes>(
      `/api/mode-settings${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`,
      revision,
    ),
    action = useAction();
  useEffect(() => {
    if (resource.data && !dirty) {
      setForm({
        jeropsPrompt: resource.data.jeropsPrompt || '',
        planPrompt: resource.data.planPrompt || '',
      });
      setOverride({
        jeropsPrompt: resource.data.overrides?.jeropsPrompt != null,
        planPrompt: resource.data.overrides?.planPrompt != null,
      });
    }
  }, [resource.data, dirty]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const switchScope = (id: string) => {
    if (dirty && !window.confirm('特殊人格尚未保存。放弃并切换范围？')) return;
    setDirty(false);
    setChatId(id);
    setForm({ jeropsPrompt: '', planPrompt: '' });
  };
  return (
    <main className="mode-settings" id="main-content">
      <h2>特殊人格</h2>
      <Field label="应用范围">
        <select value={chatId} onChange={(e) => switchScope(e.target.value)}>
          <option value="">全局默认</option>
          {data.chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.name}
            </option>
          ))}
        </select>
      </Field>
      <Notice>
        #JEROPS 与 /plan 只影响当前群当前成员，互斥并保留至 #CANCEL。提示词未配置时不会启用；/plan
        仍需本群授权与已确认身份。
      </Notice>
      <ResourceState {...resource} retry={resource.reload} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api('/api/mode-settings', 'PUT', {
              ...(chatId ? { chatId } : {}),
              jeropsPrompt: chatId && !override.jeropsPrompt ? null : form.jeropsPrompt,
              planPrompt: chatId && !override.planPrompt ? null : form.planPrompt,
            });
            setDirty(false);
            await resource.reload();
          }, '特殊人格设置已保存。现有成员模式未被更改。');
        }}
      >
        {(
          [
            ['jeropsPrompt', '#JEROPS 人格提示词'],
            ['planPrompt', '/plan 人格提示词'],
          ] as const
        ).map(([key, label]) => (
          <section key={key} className="mode-prompt-section">
            {chatId && (
              <Toggle
                label={`为此群覆盖 ${key === 'jeropsPrompt' ? '#JEROPS' : '/plan'} 提示词`}
                hint="关闭时继承全局；开启并留空可禁用此群的该模式。"
                checked={override[key]}
                onChange={(value) => {
                  setOverride((previous) => ({ ...previous, [key]: value }));
                  setDirty(true);
                }}
              />
            )}
            <Field
              label={label}
              hint={
                !resource.data
                  ? '等待读取已保存配置。'
                  : !form[key]?.trim()
                    ? '当前未配置；该模式不会伪装启用。'
                    : chatId && !override[key]
                      ? '继承全局提示词。'
                      : '将作为该模式的人格提示词。'
              }
            >
              <textarea
                rows={7}
                maxLength={30000}
                disabled={!resource.data || (!!chatId && !override[key])}
                value={form[key]}
                onChange={(e) => {
                  setForm((previous) => ({ ...previous, [key]: e.target.value }));
                  setDirty(true);
                }}
              />
            </Field>
          </section>
        ))}
        <Feedback error={action.error} success={action.success} />
        <div className="button-row">
          <Button type="submit" variant="primary" disabled={!resource.data} busy={action.busy}>
            <FloppyDisk size={19} />
            保存特殊人格
          </Button>
          {dirty && <span className="unsaved">有未保存的修改</span>}
        </div>
        <p className="hint">网页对话预览仅用于普通人格，不会切换正式成员模式。</p>
      </form>
    </main>
  );
}

type Tags = { emotion: string[]; scene: string[]; intensity: string[] };
interface Asset {
  id: string;
  name: string;
  kind: 'image' | 'gif' | 'native-sticker';
  tags: Tags;
  manualTags?: boolean | Tags;
  status?: string;
  enabled?: boolean;
  capability?:
    | { available?: boolean; supported?: boolean; reason?: string; [key: string]: unknown }
    | string;
  url?: string;
  readURL?: string;
  readUrl?: string;
  nativeRef?: { id?: string; hash?: string };
}
const emptyTags = (): Tags => ({ emotion: [], scene: [], intensity: [] });
const kindNames = { image: '图片', gif: 'GIF', 'native-sticker': '原生表情' };
export function MediaLibrary({ revision }: { revision: number }) {
  const [kind, setKind] = useState(''),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20),
    [upload, setUpload] = useState(false),
    [editing, setEditing] = useState<Asset>(),
    [remove, setRemove] = useState<Asset>();
  const resource = useResource<PageResult<Asset>>(
      `/api/media-assets?${queryString({ kind, page, pageSize })}`,
      revision,
    ),
    action = useAction();
  return (
    <main className="media-library" id="main-content">
      <div className="toolbar">
        <h2>表情素材</h2>
        <select
          aria-label="素材类型筛选"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部类型</option>
          {Object.entries(kindNames).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button variant="primary" onClick={() => setUpload(true)}>
          <UploadSimple size={18} />
          上传 / 登记素材
        </Button>
      </div>
      <Notice>
        图片、GIF
        与微信原生表情分别管理。原生收藏需稳定标识与哈希，不能按位置定位；未经桥接实测的发送能力保持未确认。
      </Notice>
      <Feedback error={action.error} success={action.success} />
      <ResourceState {...resource} retry={resource.reload} />
      {resource.data &&
        (resource.data.items.length ? (
          <div className="media-list">
            {resource.data.items.map((asset) => (
              <article key={asset.id} className="media-item">
                <div className="asset-preview">
                  {asset.kind !== 'native-sticker' &&
                  (asset.url || asset.readURL || asset.readUrl) ? (
                    <img
                      loading="lazy"
                      src={asset.url || asset.readURL || asset.readUrl}
                      alt={asset.name}
                    />
                  ) : (
                    <span>
                      {asset.kind === 'native-sticker' ? '原生表情元数据' : '此素材尚无可用预览'}
                    </span>
                  )}
                </div>
                <div className="media-item-body">
                  <h3>{asset.name}</h3>
                  <div className="media-kind">
                    <Badge tone="accent">{kindNames[asset.kind]}</Badge>
                    <Badge>{asset.status || '状态未报告'}</Badge>
                  </div>
                  <div className="tags">
                    {(['emotion', 'scene', 'intensity'] as const).flatMap((key) =>
                      (asset.tags?.[key] || []).map((tag) => (
                        <span key={`${key}:${tag}`}>{tag}</span>
                      )),
                    )}
                  </div>
                  <p className="hint">
                    {typeof asset.capability === 'string'
                      ? asset.capability
                      : asset.capability?.reason || '发送能力尚未报告；以实际桥接验收为准。'}
                  </p>
                  <div className="button-row">
                    <Button onClick={() => setEditing(asset)}>编辑标签</Button>
                    <Button
                      busy={action.busy}
                      disabled={asset.kind === 'native-sticker'}
                      onClick={() =>
                        action.run(async () => {
                          await api(`/api/media-assets/${asset.id}/tag`, 'POST', {});
                          await resource.reload();
                        }, '已完成实际素材的 AI 标注，人工标签予以保留。')
                      }
                    >
                      <MagicWand size={16} />
                      AI 标注
                    </Button>
                    <button
                      className="icon-button danger-text"
                      aria-label={`删除素材 ${asset.name}`}
                      onClick={() => setRemove(asset)}
                    >
                      <Trash size={18} />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="还没有托管素材">上传真实图片或 GIF，或登记具备稳定标识的原生表情。</Empty>
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
      {upload && (
        <AssetUpload
          onClose={() => setUpload(false)}
          onSaved={async () => {
            setUpload(false);
            await resource.reload();
          }}
        />
      )}
      {editing && (
        <AssetTags
          asset={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await resource.reload();
          }}
        />
      )}
      {remove && (
        <Confirm
          title="删除素材"
          confirm="删除素材"
          danger
          onClose={() => setRemove(undefined)}
          onConfirm={async () => {
            await api(`/api/media-assets/${remove.id}`, 'DELETE');
            await resource.reload();
          }}
        >
          删除「{remove.name}」后，它将不再可供选择；关联菜品可能需要重新选择图片。
        </Confirm>
      )}
    </main>
  );
}
function AssetUpload({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [kind, setKind] = useState<Asset['kind']>('image'),
    [name, setName] = useState(''),
    [file, setFile] = useState<File>(),
    [nativeId, setNativeId] = useState(''),
    [hash, setHash] = useState(''),
    action = useAction(),
    dirty = useRef(false);
  const close = () => {
    if (!action.busy && (!dirty.current || window.confirm('素材尚未保存。放弃此次登记？')))
      onClose();
  };
  return (
    <Modal title="上传 / 登记素材" onClose={close} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const payload: Record<string, unknown> = { name: name.trim(), kind };
            if (kind === 'native-sticker') {
              if (!nativeId.trim() || !hash.trim())
                throw new Error('原生表情必须提供稳定 ID 与哈希。');
              payload.nativeRef = { id: nativeId.trim(), hash: hash.trim() };
            } else {
              if (!file) throw new Error('请选择素材文件。');
              if (file.size > 5 * 1024 * 1024)
                throw new Error('素材不能超过 5MB，以免超过请求限制。');
              if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
                throw new Error('只支持 PNG、JPEG、WebP 和 GIF 图片。');
              if (kind === 'gif' && file.type !== 'image/gif')
                throw new Error('GIF 类型需选择真实 GIF 文件。');
              payload.mimeType = file.type;
              payload.data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('无法读取文件，请重新选择。'));
                reader.readAsDataURL(file);
              });
            }
            await api('/api/media-assets', 'POST', payload);
            await onSaved();
          });
        }}
      >
        <Field label="素材类型">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Asset['kind']);
              setFile(undefined);
              dirty.current = true;
            }}
          >
            {Object.entries(kindNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="素材名称">
          <input
            autoFocus
            required
            maxLength={150}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              dirty.current = true;
            }}
          />
        </Field>
        {kind === 'native-sticker' ? (
          <>
            <Notice>
              登记只保存元数据。未完成稳定匹配与真实发送验收前，原生表情保持不可发送。
            </Notice>
            <Field label="稳定原生 ID">
              <input
                required
                value={nativeId}
                onChange={(e) => {
                  setNativeId(e.target.value);
                  dirty.current = true;
                }}
              />
            </Field>
            <Field label="素材哈希">
              <input
                required
                value={hash}
                onChange={(e) => {
                  setHash(e.target.value);
                  dirty.current = true;
                }}
              />
            </Field>
          </>
        ) : (
          <Field label="选择素材文件" hint="最大 5MB；上传后由工作台管理，不使用任意本地路径。">
            <input
              type="file"
              required
              accept={kind === 'gif' ? 'image/gif' : 'image/png,image/jpeg,image/webp'}
              onChange={(e) => {
                const selected = e.target.files?.[0];
                setFile(selected);
                if (!name && selected) setName(selected.name);
                dirty.current = true;
              }}
            />
          </Field>
        )}
        <Feedback error={action.error} />
        <div className="dialog-actions">
          <Button type="button" disabled={action.busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            <Plus size={18} />
            保存素材
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function AssetTags({
  asset,
  onClose,
  onSaved,
}: {
  asset: Asset;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(asset.name),
    [tags, setTags] = useState({
      emotion: (
        (typeof asset.manualTags === 'object' ? asset.manualTags.emotion : undefined) ||
        asset.tags?.emotion ||
        []
      ).join('，'),
      scene: (
        (typeof asset.manualTags === 'object' ? asset.manualTags.scene : undefined) ||
        asset.tags?.scene ||
        []
      ).join('，'),
      intensity: (
        (typeof asset.manualTags === 'object' ? asset.manualTags.intensity : undefined) ||
        asset.tags?.intensity ||
        []
      ).join('，'),
    }),
    action = useAction();
  return (
    <Modal
      title="编辑人工标签"
      onClose={() => {
        if (!action.busy) onClose();
      }}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const manualTags = {
              emotion: parseTags(tags.emotion),
              scene: parseTags(tags.scene),
              intensity: parseTags(tags.intensity),
            };
            await api(`/api/media-assets/${asset.id}`, 'PATCH', {
              name: name.trim(),
              tags: manualTags,
              manualTags: true,
            });
            await onSaved();
          });
        }}
      >
        <Field label="素材名称">
          <input required value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="tag-fields">
          {(
            [
              ['emotion', '情绪'],
              ['scene', '场景'],
              ['intensity', '强度'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label} hint="多个标签用逗号分隔。">
              <input
                value={tags[key]}
                onChange={(e) => setTags((previous) => ({ ...previous, [key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
        <p className="hint">本次保存为人工标签，后续 AI 标注不会覆盖它们。</p>
        <Feedback error={action.error} />
        <div className="dialog-actions">
          <Button type="button" disabled={action.busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            保存标签
          </Button>
        </div>
      </form>
    </Modal>
  );
}
