/** 联网配置与独立测试。搜索和网页读取使用保存的服务设置；可用状态来自实际响应，不影响普通聊天配置。 */
import { useEffect, useState } from 'react';
import {
  FloppyDisk,
  MagnifyingGlass,
  ArrowSquareOut,
  Globe,
  FileText,
  SlidersHorizontal,
} from '@phosphor-icons/react';
import {
  api,
  dateTime,
  useAction,
  useResource,
  parseTags,
  type Bootstrap,
  type SearchHit,
  type SaveSettings,
} from './api';
import {
  Badge,
  Button,
  Empty,
  Feedback,
  Field,
  Notice,
  PageHeading,
  ResourceState,
  Toggle,
} from './ui';
import { safeHref } from './KnowledgePage';
import './network.css';

const providerName = (provider?: string) => (provider === 'deepseek' ? 'DeepSeek' : 'SearXNG');

export function NetworkPage({
  data,
  saveSettings,
  onDirty,
}: {
  data: Bootstrap;
  saveSettings: SaveSettings;
  onDirty: (value: boolean) => void;
}) {
  const [secondaryDirty, setSecondaryDirty] = useState(false);
  const [network, setNetwork] = useState(data.settings.network),
    [dirty, setDirty] = useState(false);
  const [apiKey, setApiKey] = useState(''),
    [clearApiKey, setClearApiKey] = useState(false);
  const save = useAction(),
    saved = data.settings.network,
    deepseek = network.provider === 'deepseek';
  useEffect(() => {
    if (!dirty) setNetwork(data.settings.network);
  }, [data.settings.network, dirty]);
  useEffect(() => {
    onDirty(dirty || secondaryDirty);
    return () => onDirty(false);
  }, [dirty, secondaryDirty, onDirty]);
  const change = (patch: Partial<typeof network>) => {
    setNetwork((p) => ({ ...p, ...patch }));
    setDirty(true);
  };

  return (
    <main className="standard-page network-page" id="main-content">
      <PageHeading
        title="联网工具"
        description="让回答有据可查。配置搜索服务，检验搜索与网页读取效果。"
        action={
          <a className="button secondary" href="#network-lab-heading">
            测试联网
            <ArrowSquareOut size={16} aria-hidden="true" />
          </a>
        }
      />
      <div className="network-status" aria-label="已保存的联网状态">
        <div>
          <Globe size={21} aria-hidden="true" />
          <strong>
            {saved.enabled ? providerName(saved.provider) + ' · 已启用' : '联网工具未启用'}
          </strong>
          <Badge tone={saved.enabled ? 'good' : 'neutral'}>
            {saved.enabled ? '已保存' : '已关闭'}
          </Badge>
        </div>
        <p>
          {saved.enabled
            ? '模型工具与 /搜索 命令使用此服务；连接情况以实际测试为准。'
            : '启用并保存后，模型可以搜索信息、读取公网网页。'}
        </p>
      </div>
      <div className="network-workspace">
        <aside className="network-config" aria-label="联网配置">
          <section className="network-config-section" aria-labelledby="network-service-heading">
            <h2 id="network-service-heading">服务配置</h2>
            <p className="hint">选择搜索与网页读取所用的服务。</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save.run(async () => {
                  const result = await saveSettings({
                    network: {
                      ...network,
                      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                      clearApiKey,
                    },
                  });
                  setNetwork(result.network);
                  setApiKey('');
                  setClearApiKey(false);
                  setDirty(false);
                }, '联网配置已保存。可以继续测试。');
              }}
            >
              <fieldset disabled={save.busy}>
                <Toggle
                  checked={network.enabled}
                  onChange={(enabled) => change({ enabled })}
                  label="允许联网"
                  hint="关闭后，对话使用已有知识与记忆。"
                />
                <Field label="联网服务">
                  <select
                    value={network.provider ?? 'searxng'}
                    onChange={(e) => change({ provider: e.target.value as 'searxng' | 'deepseek' })}
                  >
                    <option value="deepseek">DeepSeek · 官方 Search / Fetch</option>
                    <option value="searxng">SearXNG · 自建搜索</option>
                  </select>
                </Field>
                {deepseek ? (
                  <>
                    <p className="network-provider-help">
                      使用官方 API 搜索信息并读取网页正文，无需部署搜索服务。
                    </p>
                    <Field
                      label="DeepSeek API 密钥"
                      hint={
                        saved.hasApiKey
                          ? '已保存密钥。留空保留，填写新值可替换。'
                          : '填写 DeepSeek 开放平台密钥，保存后不会回显。'
                      }
                    >
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={apiKey}
                        disabled={clearApiKey}
                        required={network.enabled && !saved.hasApiKey}
                        maxLength={8192}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          setDirty(true);
                        }}
                        placeholder={saved.hasApiKey ? '已保存，留空保留' : '输入 API 密钥'}
                      />
                    </Field>
                    {saved.hasApiKey && (
                      <label className="checkbox-label network-clear-key">
                        <input
                          type="checkbox"
                          checked={clearApiKey}
                          onChange={(e) => {
                            setClearApiKey(e.target.checked);
                            setApiKey('');
                            setDirty(true);
                          }}
                        />
                        删除已保存的密钥
                      </label>
                    )}
                    {clearApiKey && network.enabled && (
                      <p className="error-text">删除密钥前，请先关闭联网或切换服务。</p>
                    )}
                    <details className="network-advanced">
                      <summary>服务地址</summary>
                      <Field label="DeepSeek API 地址" hint="通常保留官方地址，也支持以 /v1 结尾。">
                        <input
                          type="url"
                          required
                          value={network.deepseekBaseUrl ?? 'https://api.deepseek.com'}
                          onChange={(e) => change({ deepseekBaseUrl: e.target.value })}
                        />
                      </Field>
                    </details>
                    <a
                      className="network-doc-link"
                      href="https://api-docs.deepseek.com/guides/search/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看官方文档
                      <ArrowSquareOut size={15} aria-hidden="true" />
                    </a>
                  </>
                ) : (
                  <Field label="SearXNG 服务地址" hint="搜索需启用 JSON 输出；网页正文由本机读取。">
                    <input
                      type="url"
                      required
                      value={network.searxngUrl}
                      onChange={(e) => change({ searxngUrl: e.target.value })}
                      placeholder="http://127.0.0.1:43889"
                    />
                  </Field>
                )}
                <div className="network-save">
                  <Button
                    type="submit"
                    variant="primary"
                    busy={save.busy}
                    disabled={deepseek && clearApiKey && network.enabled}
                  >
                    <FloppyDisk size={18} aria-hidden="true" />
                    保存配置
                  </Button>
                  {dirty && <span className="hint">有未保存的修改</span>}
                </div>
              </fieldset>
              <Feedback error={save.error} success={save.success} />
            </form>
          </section>
          <SearchSettings onDirty={setSecondaryDirty} />
        </aside>
        <NetworkTest
          key={JSON.stringify([
            saved.enabled,
            saved.provider,
            saved.searxngUrl,
            saved.deepseekBaseUrl,
            saved.hasApiKey,
          ])}
          network={saved}
          dirty={dirty}
        />
      </div>
    </main>
  );
}

function NetworkTest({
  network,
  dirty,
}: {
  network: Bootstrap['settings']['network'];
  dirty: boolean;
}) {
  const [mode, setMode] = useState<'search' | 'fetch'>('search'),
    [query, setQuery] = useState(''),
    [url, setUrl] = useState('');
  const [result, setResult] = useState<{
    mode: 'search' | 'fetch';
    input: string;
    hits: SearchHit[];
  }>();
  const action = useAction(),
    isSearch = mode === 'search',
    input = isSearch ? query : url;
  const limit = network.provider === 'deepseek' ? 128 : 1000,
    tooLong = isSearch && [...query.trim()].length > limit;
  return (
    <section className="network-lab" aria-labelledby="network-lab-heading">
      <div className="network-lab-heading">
        <div>
          <h2 id="network-lab-heading">试一试联网效果</h2>
          <p className="hint">测试只在工作台展示，不会发送到微信。</p>
        </div>
        <Badge>{providerName(network.provider)}</Badge>
      </div>
      <div className="network-test-modes" role="group" aria-label="测试类型">
        <button
          type="button"
          aria-pressed={isSearch}
          disabled={action.busy}
          onClick={() => setMode('search')}
        >
          <MagnifyingGlass size={18} aria-hidden="true" />
          搜索信息
        </button>
        <button
          type="button"
          aria-pressed={!isSearch}
          disabled={action.busy}
          onClick={() => setMode('fetch')}
        >
          <FileText size={18} aria-hidden="true" />
          读取网页
        </button>
      </div>
      {!network.enabled && <Notice>先在服务配置中启用联网并保存，再运行测试。</Notice>}
      {dirty && (
        <p className="network-draft-note" role="status">
          测试使用已保存的配置。修改服务或密钥后，请先保存。
        </p>
      )}
      <form
        className="network-test-form"
        onSubmit={(e) => {
          e.preventDefault();
          const submitted = input.trim(),
            submittedMode = mode;
          void action.run(async () => {
            setResult(undefined);
            const response = await api<SearchHit[] | SearchHit>(
              '/api/network/' + submittedMode,
              'POST',
              submittedMode === 'search' ? { query: submitted } : { url: submitted },
            );
            setResult({
              mode: submittedMode,
              input: submitted,
              hits: Array.isArray(response) ? response : [response],
            });
          });
        }}
      >
        <fieldset disabled={action.busy}>
          {isSearch ? (
            <Field
              label="想查找什么？"
              hint={
                '输入简短关键词' +
                (network.provider === 'deepseek' ? '，支持 site:、after: 检索语法' : '') +
                '。最多 ' +
                limit +
                ' 个字符。'
              }
            >
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例如：DeepSeek Search API 官方文档"
                required
                aria-invalid={tooLong || undefined}
              />
            </Field>
          ) : (
            <Field label="网页地址" hint="填写公网 HTTP / HTTPS 页面，读取正文并保留来源。">
              <input
                type="url"
                value={url}
                maxLength={8192}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/article"
                required
              />
            </Field>
          )}
          <div className="network-test-actions">
            <Button
              type="submit"
              variant="primary"
              busy={action.busy}
              disabled={!network.enabled || !input.trim() || tooLong}
            >
              {isSearch ? (
                <MagnifyingGlass size={18} aria-hidden="true" />
              ) : (
                <FileText size={18} aria-hidden="true" />
              )}
              {isSearch ? '开始搜索' : '读取正文'}
            </Button>
            <span className={tooLong ? 'error-text' : 'hint'}>
              {isSearch ? [...query.trim()].length + ' / ' + limit + ' 字符' : '仅访问公网网页'}
            </span>
          </div>
        </fieldset>
      </form>
      <Feedback error={action.error} />
      <div className="network-results" aria-live="polite" aria-busy={action.busy}>
        {action.busy ? (
          <div className="network-test-wait">
            <Globe size={30} aria-hidden="true" />
            <strong>{isSearch ? '正在检索信息…' : '正在读取网页…'}</strong>
            <p>正在等待 {providerName(network.provider)} 返回结果。</p>
          </div>
        ) : result ? (
          <>
            <div className="network-result-heading">
              <h3>
                {result.mode === 'search' ? '搜索结果 · ' + result.hits.length + ' 条' : '网页正文'}
              </h3>
              <span>{result.input}</span>
            </div>
            {result.hits.length ? (
              result.hits.map((hit, i) => (
                <NetworkResult key={hit.url + i} hit={hit} markdown={result.mode === 'fetch'} />
              ))
            ) : (
              <Empty title="没有找到相关结果">换一组关键词，或调整来源与时效设置后重试。</Empty>
            )}
          </>
        ) : (
          !action.error && (
            <div className="network-test-wait">
              <Globe size={32} aria-hidden="true" />
              <strong>从一个问题，或一个网址开始</strong>
              <p>搜索结果、网页正文和来源信息将在这里显示。</p>
            </div>
          )
        )}
      </div>
    </section>
  );
}

function NetworkResult({ hit, markdown }: { hit: SearchHit; markdown: boolean }) {
  const source = {
    official: '可信域名',
    authoritative: '权威来源',
    community: '社区来源',
    unknown: '来源待核实',
  }[hit.sourceType ?? 'unknown'];
  return (
    <article className="network-result">
      <div className="network-result-source">
        <Badge tone={hit.sourceType === 'official' ? 'good' : 'neutral'}>{source}</Badge>
        <span>{safeHref(hit.url) ? new URL(hit.url).hostname : '来源地址无效'}</span>
      </div>
      <h3>
        <a href={safeHref(hit.url)} target="_blank" rel="noreferrer">
          {hit.title || hit.url}
          <ArrowSquareOut size={16} aria-hidden="true" />
        </a>
      </h3>
      <p className={markdown ? 'network-markdown' : ''}>{hit.content}</p>
      <details className="network-result-details">
        <summary>来源与时间</summary>
        <dl>
          <div>
            <dt>来源地址</dt>
            <dd>
              <a href={safeHref(hit.url)} target="_blank" rel="noreferrer">
                {hit.url}
              </a>
            </dd>
          </div>
          <div>
            <dt>发布时间</dt>
            <dd>{hit.publishedAt ? dateTime(hit.publishedAt) : '未知'}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{hit.updatedAt ? dateTime(hit.updatedAt) : '未知'}</dd>
          </div>
          <div>
            <dt>抓取时间</dt>
            <dd>{dateTime(hit.fetchedAt)}</dd>
          </div>
          <div>
            <dt>阅读量</dt>
            <dd>{hit.readCount == null ? '未知' : hit.readCount.toLocaleString()}</dd>
          </div>
          {hit.rankReason && (
            <div>
              <dt>排序依据</dt>
              <dd>{hit.rankReason}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
}

function SearchSettings({ onDirty }: { onDirty: (value: boolean) => void }) {
  const resource = useResource<{ trustedDomains: string[]; timeRange: string }>(
      '/api/search-settings',
      0,
    ),
    action = useAction();
  const [domains, setDomains] = useState(''),
    [timeRange, setTimeRange] = useState('auto'),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (resource.data && !dirty) {
      setDomains(resource.data.trustedDomains.join('，'));
      setTimeRange(resource.data.timeRange || 'auto');
    }
  }, [resource.data, dirty]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  return (
    <details className="network-source-settings">
      <summary>
        <SlidersHorizontal size={20} aria-hidden="true" />
        <span>来源与时效{dirty && <small> · 未保存</small>}</span>
      </summary>
      <p className="hint">按可信域名与信息时效辅助排序；未知日期与阅读量保持未知。</p>
      <ResourceState {...resource} retry={resource.reload} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api('/api/search-settings', 'PUT', {
              trustedDomains: parseTags(domains),
              timeRange,
            });
            setDirty(false);
            await resource.reload();
          }, '来源与时效设置已保存。');
        }}
      >
        <fieldset disabled={action.busy || !resource.data}>
          <Field label="可信域名" hint="用逗号分隔，不包含协议或路径。">
            <textarea
              rows={3}
              value={domains}
              onChange={(e) => {
                setDomains(e.target.value);
                setDirty(true);
              }}
              placeholder="例如：api-docs.deepseek.com"
            />
          </Field>
          <Field label="搜索时间范围">
            <select
              value={timeRange}
              onChange={(e) => {
                setTimeRange(e.target.value);
                setDirty(true);
              }}
            >
              <option value="auto">按问题自动判断</option>
              <option value="all">不限时间</option>
              <option value="day">最近一天</option>
              <option value="week">最近一周</option>
              <option value="month">最近一月</option>
              <option value="year">最近一年</option>
            </select>
          </Field>
          <Button type="submit" busy={action.busy} disabled={!resource.data}>
            <FloppyDisk size={18} aria-hidden="true" />
            保存来源设置
          </Button>
        </fieldset>
        <Feedback error={action.error} success={action.success} />
      </form>
    </details>
  );
}
