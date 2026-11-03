/** 知识与记忆工作区。记录由 API 提供；导入、检索和范围设置各自执行，切换目标前保护未保存草稿。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  PushPin,
  ClockCounterClockwise,
  GitMerge,
  ArrowClockwise,
  UploadSimple,
  FloppyDisk,
  PlugsConnected,
  ArrowSquareOut,
} from '@phosphor-icons/react';
import {
  api,
  dateTime,
  parseTags,
  queryString,
  useAction,
  useResource,
  type PageResult,
  type Bootstrap,
  type KnowledgeHit,
  type MemoryCategory,
  type MemoryEntry,
  type SaveSettings,
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
  PageHeading,
  ResourceState,
  Toggle,
  Pagination,
} from './ui';
import { MemoryPanel } from './MemoryPanel';

const categories: MemoryCategory[] = ['事实', '偏好', '关系', '事件', '经验'];
const statusNames: Record<string, string> = {
  active: '已生效',
  candidate: '待确认',
  conflicted: '有冲突',
  deleted: '已删除',
  pending: '待索引',
  indexed: '已索引',
  ready: '已就绪',
  failed: '失败',
};
interface DocumentEntry {
  id: string;
  title: string;
  source: string;
  category: string;
  tags: string[];
  status: string;
  created_at: string;
}
export function KnowledgePage({
  revision,
  refresh,
  data,
  saveSettings,
  onDirty,
}: {
  revision: number;
  refresh: () => Promise<void>;
  data: Bootstrap;
  saveSettings: SaveSettings;
  onDirty: (value: boolean) => void;
}) {
  const [tab, setTabValue] = useState('memories'),
    dirty = useRef(false);
  const setTab = (next: string) => {
    if (dirty.current && !window.confirm('向量配置尚未保存。放弃修改并切换？')) return;
    setTabValue(next);
  };
  const markDirty = useCallback(
    (value: boolean) => {
      dirty.current = value;
      onDirty(value);
    },
    [onDirty],
  );
  return (
    <main className="standard-page" id="main-content">
      <PageHeading title="知识与记忆" description="通用记忆共享，个人画像按群隔离。" />
      <div className="tabs" role="tablist" aria-label="知识与记忆">
        {[
          ['memories', '长期记忆'],
          ['documents', '知识资料'],
          ['embedding', '向量检索'],
        ].map(([id, text]) => (
          <button
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            id={`tab-${id}`}
            key={id}
            onClick={() => setTab(id)}
          >
            {text}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'memories' && (
          <MemoryPanel revision={revision} refresh={refresh} data={data} onDirty={markDirty} />
        )}
        {tab === 'documents' && <Documents revision={revision} refresh={refresh} />}
        {tab === 'embedding' && (
          <Embedding data={data} saveSettings={saveSettings} onDirty={markDirty} />
        )}
      </div>
    </main>
  );
}
function Documents({ revision, refresh }: { revision: number; refresh: () => Promise<void> }) {
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20);
  const resource = useResource<PageResult<DocumentEntry>>(
      `/api/documents?${queryString({ page, pageSize })}`,
      revision,
    ),
    [importing, setImporting] = useState(false),
    [remove, setRemove] = useState<DocumentEntry>(),
    [query, setQuery] = useState(''),
    [hits, setHits] = useState<KnowledgeHit[]>(),
    action = useAction();
  const reload = async () => {
    await Promise.all([resource.reload(), refresh()]);
  };
  return (
    <>
      <div className="toolbar">
        <h2>知识资料</h2>
        <div className="button-row">
          <Button
            busy={action.busy}
            onClick={() =>
              action.run(
                () => api('/api/knowledge/reindex', 'POST', {}),
                '已提交重新索引，请在运行记录中查看结果。',
              )
            }
          >
            <ArrowClockwise size={17} />
            重新索引
          </Button>
          <Button variant="primary" onClick={() => setImporting(true)}>
            <UploadSimple size={18} />
            导入资料
          </Button>
        </div>
      </div>
      <form
        className="inline-form knowledge-search"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () =>
            setHits(await api('/api/knowledge/search', 'POST', { query: query.trim() })),
          );
        }}
      >
        <div className="search-field">
          <MagnifyingGlass size={20} />
          <input
            aria-label="知识检索关键词"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={2000}
            placeholder="检索知识资料与共享记忆"
            required
          />
        </div>
        <Button type="submit" busy={action.busy}>
          检索
        </Button>
      </form>
      <Feedback error={action.error} success={action.success} />
      {hits && (
        <section className="search-results">
          <div className="section-title">
            <h3>检索结果 · {hits.length} 条</h3>
            <button className="text-button" onClick={() => setHits(undefined)}>
              收起结果
            </button>
          </div>
          {hits.length ? (
            hits.map((hit) => (
              <article key={hit.id}>
                <div className="section-title">
                  <h3>{hit.title || hit.source}</h3>
                  <Badge tone="accent">{hit.kind === 'memory' ? '记忆' : '知识'}</Badge>
                </div>
                <p>{hit.content}</p>
                <span className="hint">{hit.source}</span>
              </article>
            ))
          ) : (
            <Empty title="未找到匹配内容">尝试更具体的关键词，或先导入相关资料。</Empty>
          )}
        </section>
      )}
      <ResourceState
        loading={!resource.data && resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
      {resource.data &&
        (resource.data.items.length ? (
          <div className="document-list">
            {resource.data.items.map((doc) => (
              <article key={doc.id}>
                <div>
                  <h3>{doc.title}</h3>
                  <p className="document-source">
                    {doc.source.startsWith('http') ? (
                      <a href={safeHref(doc.source)} target="_blank" rel="noreferrer">
                        {doc.source}
                        <ArrowSquareOut size={14} />
                      </a>
                    ) : (
                      doc.source
                    )}
                  </p>
                  <div className="document-meta">
                    <Badge tone="accent">{doc.category}</Badge>
                    <Badge>{statusNames[doc.status] || doc.status}</Badge>
                    <time>{dateTime(doc.created_at)}</time>
                    {doc.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                </div>
                <button
                  className="icon-button danger-text"
                  aria-label={`删除资料 ${doc.title}`}
                  onClick={() => setRemove(doc)}
                >
                  <Trash size={20} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="添加机器人可以参考的资料">
            支持纯文本、网址、TXT、Markdown 与文字型 PDF。
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
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onSaved={async () => {
            await reload();
            setImporting(false);
            action.setSuccess('资料已导入，索引进度可在运行记录中查看。');
          }}
        />
      )}
      {remove && (
        <Confirm
          title="删除知识资料"
          danger
          confirm="删除资料"
          onClose={() => setRemove(undefined)}
          onConfirm={async () => {
            await api(`/api/documents/${remove.id}`, 'DELETE');
            await reload();
          }}
        >
          删除「{remove.title}」后，它将不再作为知识检索来源。
        </Confirm>
      )}
    </>
  );
}
function ImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState('text'),
    [title, setTitle] = useState(''),
    [content, setContent] = useState(''),
    [url, setUrl] = useState(''),
    [file, setFile] = useState<File>(),
    [category, setCategory] = useState('资料'),
    [tags, setTags] = useState(''),
    action = useAction();
  return (
    <Modal title="导入知识资料" onClose={onClose} wide>
      <div className="segmented">
        {[
          ['text', '粘贴文字'],
          ['url', '导入网址'],
          ['file', '上传文件'],
        ].map(([id, label]) => (
          <button key={id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)}>
            {label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            let payload: Record<string, unknown> = { title, category, tags: parseTags(tags) };
            if (mode === 'text') payload.content = content;
            if (mode === 'url') payload.url = url;
            if (mode === 'file') {
              if (!file) throw new Error('请先选择文件。');
              if (file.size > 5_000_000) throw new Error('文件不能超过 5MB。');
              if (!/\.(txt|md|pdf)$/i.test(file.name))
                throw new Error('仅支持 TXT、Markdown 和文字型 PDF。');
              const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('文件读取失败，请重新选择。'));
                reader.readAsDataURL(file);
              });
              payload = { ...payload, filename: file.name, base64 };
            }
            await api('/api/documents', 'POST', payload);
            await onSaved();
          });
        }}
      >
        <Field label="资料标题">
          <input
            autoFocus
            value={title}
            required
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一个便于查找的名字"
          />
        </Field>
        {mode === 'text' && (
          <Field label="资料内容">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              maxLength={500000}
              rows={7}
              placeholder="在这里粘贴原文…"
            />
          </Field>
        )}
        {mode === 'url' && (
          <Field label="网页地址" hint="服务会读取公开网页文字，并保留来源地址。">
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </Field>
        )}
        {mode === 'file' && (
          <Field
            label="选择文件"
            hint="TXT、Markdown 或文字型 PDF，最大 5MB。扫描版 PDF 需要先做文字识别。"
          >
            <input
              type="file"
              accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
              required
              onChange={(e) => {
                const selected = e.target.files?.[0];
                setFile(selected);
                if (!title && selected) setTitle(selected.name.replace(/\.[^.]+$/, ''));
              }}
            />
          </Field>
        )}
        <div className="form-grid">
          <Field label="分类">
            <input value={category} maxLength={50} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          <Field label="标签（逗号分隔）">
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        <Feedback error={action.error} />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            <UploadSimple size={18} />
            导入资料
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function Embedding({
  data,
  saveSettings,
  onDirty,
}: {
  data: Bootstrap;
  saveSettings: SaveSettings;
  onDirty: (value: boolean) => void;
}) {
  const [form, setForm] = useState({ ...data.settings.embedding, apiKey: '', clearApiKey: false }),
    [dirty, setDirty] = useState(false),
    action = useAction();
  useEffect(() => {
    if (!dirty) setForm({ ...data.settings.embedding, apiKey: '', clearApiKey: false });
  }, [data.settings.embedding, dirty]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const change = (key: string, value: string | boolean) => {
    setForm((p) => ({ ...p, [key]: value }));
    setDirty(true);
  };
  return (
    <section className="surface settings-surface">
      <h2>向量检索</h2>
      <p>使用独立的向量模型增强知识检索；关闭时仍可使用文字检索。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await saveSettings({ embedding: { ...form, apiKey: form.apiKey || undefined } });
            setDirty(false);
            setForm((p) => ({ ...p, apiKey: '', clearApiKey: false }));
          }, '向量配置已保存。模型变化时会重新建立索引。');
        }}
      >
        <Toggle
          label="启用向量检索"
          checked={form.enabled}
          onChange={(v) => change('enabled', v)}
        />
        <Field label="向量 API 地址">
          <input
            type="url"
            required
            value={form.baseUrl}
            onChange={(e) => change('baseUrl', e.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
          />
        </Field>
        <Field label="向量模型标识" hint="填写服务实际提供的向量模型名称，不与对话模型混用。">
          <input
            required={form.enabled}
            value={form.model}
            maxLength={200}
            onChange={(e) => change('model', e.target.value)}
          />
        </Field>
        <Field
          label="API 密钥"
          hint={
            data.settings.embedding.hasApiKey ? '密钥已配置，留空保留。' : '本机服务通常可留空。'
          }
        >
          <input
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => change('apiKey', e.target.value)}
            placeholder={data.settings.embedding.hasApiKey ? '已配置，留空不修改' : '按需填写密钥'}
          />
        </Field>
        {data.settings.embedding.hasApiKey && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.clearApiKey}
              onChange={(e) => change('clearApiKey', e.target.checked)}
            />
            清除已保存的密钥
          </label>
        )}
        <div className="button-row">
          <Button type="submit" variant="primary" busy={action.busy}>
            <FloppyDisk size={18} />
            保存向量配置
          </Button>
          <Button
            type="button"
            busy={action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await api<{ dimensions: number }>('/api/embedding/test', 'POST', {});
                action.setSuccess(`向量连接成功，实际返回 ${result.dimensions} 维。`);
              })
            }
          >
            <PlugsConnected size={18} />
            测试已保存配置
          </Button>
          <Button
            type="button"
            busy={action.busy}
            onClick={() =>
              action.run(
                () => api('/api/knowledge/reindex', 'POST', {}),
                '已提交重新索引，请在运行记录中查看结果。',
              )
            }
          >
            <ArrowClockwise size={18} />
            重新索引
          </Button>
        </div>
        <Feedback error={action.error} success={action.success} />
        <p className="hint">
          当前索引配置版本：{data.settings.embedding.version}
          {dirty ? ' · 有未保存的修改' : ''}
        </p>
      </form>
    </section>
  );
}
export function safeHref(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
