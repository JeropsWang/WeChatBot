/** 工作台外壳：管理登录、七项导航与服务端通知。未保存草稿通过 dirty 引用拦截离开；SSE 触发重新读取真实状态，不生成业务数据。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkle, Sun, House, ChatsCircle, Cube, PaintBrush, BookBookmark, Globe, Notebook, List, X, Pause, Play, SignOut, ArrowClockwise, UserCircle } from '@phosphor-icons/react';
import { api, useAction, type Bootstrap, type SetupStatus, type SaveSettings } from './api';
import { Button, Feedback } from './ui';
import { PersonaPage } from './PersonaPage';
import { ChatsPage } from './ChatsPage';
import { ModelsPage } from './ModelsPage';
import { KnowledgePage } from './KnowledgePage';
import { NetworkPage } from './NetworkPage';
import { LogsPage } from './LogsPage';
import { useAppearance, type Appearance } from './Appearance';

const navigation = [ { id: 'overview', text: '总览', icon: House }, { id: 'chats', text: '微信与群聊', icon: ChatsCircle }, { id: 'models', text: '模型', icon: Cube }, { id: 'persona', text: '人设与风格', icon: PaintBrush }, { id: 'knowledge', text: '知识与记忆', icon: BookBookmark }, { id: 'network', text: '联网工具', icon: Globe }, { id: 'logs', text: '运行记录', icon: Notebook } ];
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(id); }, []);
  return <time dateTime={now.toISOString()} className="header-clock">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)}<span> (Asia/Shanghai)</span></time>;
}
export function App() {
  const { appearance, setAppearance } = useAppearance();
  const formal = appearance === 'formal';
  const [setup, setSetup] = useState<SetupStatus>(), [data, setData] = useState<Bootstrap>(), [error, setError] = useState(''), [booting, setBooting] = useState(true);
  const [page, setPage] = useState('overview'), [menuOpen, setMenuOpen] = useState(false), [revision, setRevision] = useState(0), [eventsOnline, setEventsOnline] = useState(true);
  const dirty = useRef(false), action = useAction();
  // 切换只更新 Provider；保留挂载中的草稿，脏状态需用户确认。
  const switchAppearance = (next: Appearance) => {
    if (dirty.current && !window.confirm('当前有未保存的修改。切换界面会保留草稿，是否继续？')) return;
    setAppearance(next);
  };
  const markDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const refresh = useCallback(async () => { const next = await api<Bootstrap>('/api/bootstrap'); setData(next); setRevision(v => v + 1); setError(''); }, []);
  const initialize = useCallback(async () => {
    setBooting(true); setError('');
    try { const state = await api<SetupStatus>('/api/setup/status'); setSetup(state); if (state.ready && state.authenticated) await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBooting(false); }
  }, [refresh]);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    const expired = () => { setSetup(s => s ? { ...s, authenticated: false } : s); setData(undefined); };
    window.addEventListener('liino-session-expired', expired); return () => window.removeEventListener('liino-session-expired', expired);
  }, []);
  useEffect(() => {
    if (!setup?.authenticated) return;
    let timeout: ReturnType<typeof setTimeout>;
    const events = new EventSource('/api/events', { withCredentials: true });
    events.onopen = () => setEventsOnline(true);
    events.onerror = () => setEventsOnline(false);
    events.addEventListener('state', () => { clearTimeout(timeout); timeout = setTimeout(() => { void refresh().catch(e => setError(e.message)); }, 220); });
    return () => { clearTimeout(timeout); events.close(); };
  }, [setup?.authenticated, refresh]);
  // 真正离开页面会卸载编辑器，因此先确认未保存的修改。
  const navigate = useCallback((next: string) => {
    if (!navigation.some(n => n.id === next)) return;
    if (next === page) { setMenuOpen(false); return; }
    if (dirty.current && !window.confirm('当前页面有未保存的修改。放弃修改并离开？')) return;
    dirty.current = false; setPage(next); setMenuOpen(false);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }, [page]);
  useEffect(() => { const listener = (event: Event) => navigate((event as CustomEvent).detail); document.addEventListener('liino-navigate', listener); return () => document.removeEventListener('liino-navigate', listener); }, [navigate]);
  useEffect(() => { const before = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, []);
  const saveSettings: SaveSettings = async patch => { const latest = await api<Bootstrap['settings']>('/api/settings'); const saved = await api<Bootstrap['settings']>('/api/settings', 'PUT', { ...latest, ...patch }); await refresh(); return saved; };
  const authenticated = !!setup?.authenticated && !!data;
  const header = <header className="topbar"><div className="brand"><ChatsCircle size={29} weight="regular" /><strong>WeChatBot工作台</strong></div><div className="formal-breadcrumb"><House size={19} /><span>/</span><span>{navigation.find(n => n.id === page)?.text}</span></div><div className="header-tools">{formal && authenticated && <span className="run-state">{data!.settings.paused ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}{data!.settings.paused ? '已暂停' : '运行中'}</span>}{authenticated && <Button className={`global-pause ${data!.settings.paused ? 'is-paused' : ''}`} busy={action.busy} aria-label={data!.settings.paused ? '开始运行自动回复' : '暂停自动回复'} title={data!.settings.paused ? '当前已暂停，点击开始自动回复' : '当前运行中，点击暂停自动回复'} onClick={() => action.run(() => saveSettings({ paused: !data!.settings.paused }), data!.settings.paused ? '已恢复运行。仅已启用且通过收发验证的群可自动回复。' : '已全局暂停。')} >{data!.settings.paused ? <Play size={16} weight="fill" /> : <Pause size={16} weight="fill" />}<span>{data!.settings.paused ? '开始运行' : '暂停回复'}</span></Button>}{!formal && <><Sun size={23} className="header-sun" /><Clock /></>}<label className="appearance-picker"><span>界面</span><select aria-label="界面样式" value={appearance} onChange={e => switchAppearance(e.target.value as Appearance)}><option value="formal">正式版</option><option value="original">原版</option></select></label>{authenticated ? <button className="icon-button account-button" title="退出登录" aria-label="退出登录" onClick={() => action.run(async () => { if (dirty.current && !window.confirm('有未保存的修改，仍要退出登录？')) return; await api('/api/logout', 'POST', {}); dirty.current = false; setData(undefined); setSetup(s => s ? { ...s, authenticated: false } : s); })}><SignOut size={23} /></button> : <UserCircle size={30} weight="fill" />}</div></header>;
  if (!authenticated) return <>{header}<AuthPage setup={setup} loading={booting} error={error} retry={initialize} onAuthenticated={initialize} /></>;
  return <>{header}<a className="skip-link" href="#main-content">跳到主要内容</a><button className="mobile-menu button secondary" onClick={() => setMenuOpen(v => !v)} aria-expanded={menuOpen} aria-controls="sidebar">{menuOpen ? <X size={20} /> : <List size={20} />}{navigation.find(n => n.id === page)?.text}</button><div className={`app-shell ${menuOpen ? 'menu-open' : ''}`}>
    <aside className="sidebar" id="sidebar"><nav aria-label="工作台导航" style={{ '--active-index': navigation.findIndex(n => n.id === page) } as React.CSSProperties}>{navigation.map(({ id, text, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={`nav-item ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined}><Icon size={24} weight={formal ? 'regular' : page === id ? 'fill' : 'regular'} /><span>{text}</span></button>)}</nav><div className="sidebar-footer"><span className={`status-dot ${data.bridge.connected ? 'good' : ''}`} /><span>{data.bridge.connected ? '微信桥接已连接' : '等待微信桥接'}</span><small>仅在本机运行</small></div></aside>
    <div className={`workspace ${['overview', 'persona'].includes(page) ? 'persona-workspace' : ''}`}>
      {(error || action.error || action.success || !eventsOnline) && <div className="global-feedback"><Feedback error={error || action.error} success={action.success} />{error && <Button onClick={() => refresh().catch(e => setError(e.message))}><ArrowClockwise size={16} />重新读取</Button>}{!eventsOnline && <p className="hint">实时状态连接暂时中断，正在重连。<button className="text-button" onClick={() => refresh().catch(e => setError(e.message))}>手动刷新</button></p>}</div>}
      {['overview', 'persona'].includes(page) && <PersonaPage key={page} data={data} revision={revision} full={page === 'persona'} saveSettings={saveSettings} refresh={refresh} onDirty={markDirty} />}
      {page === 'chats' && <ChatsPage data={data} refresh={refresh} revision={revision} saveSettings={saveSettings} onDirty={markDirty} />}
      {page === 'models' && <ModelsPage data={data} revision={revision} refresh={refresh} saveSettings={saveSettings} onDirty={markDirty} />}
      {page === 'knowledge' && <KnowledgePage revision={revision} refresh={refresh} data={data} saveSettings={saveSettings} onDirty={markDirty} />}
      {page === 'network' && <NetworkPage data={data} saveSettings={saveSettings} onDirty={markDirty} />}
      {page === 'logs' && <LogsPage revision={revision} refresh={refresh} />}
    </div></div></>;
}
function AuthPage({ setup, loading, error, retry, onAuthenticated }: { setup?: SetupStatus; loading: boolean; error: string; retry: () => Promise<void>; onAuthenticated: () => Promise<void> }) {
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), action = useAction();
  const first = !setup?.initialized;
  return <div className="auth-layout"><main className="auth-content" id="main-content"><Sparkle size={38} className="auth-star" weight="duotone" /><h1>{loading ? '正在打开工作台…' : !setup?.ready ? '工作台正在等待服务。' : first ? '欢迎来到WeChatBot工作台。' : '欢迎回到WeChatBot工作台。'}</h1><p className="auth-intro">为每一次群聊，留一点温柔与机智。</p>
    {loading ? <p className="loading" role="status">正在检查本机服务…</p> : error || !setup?.ready ? <><Feedback error={error || (setup?.error ? `数据库尚未就绪：${setup.error}` : '无法读取工作台服务状态。')} /><p className="hint">服务恢复后可继续登录，你的配置会保存在本机。</p><Button variant="primary" onClick={retry}><ArrowClockwise size={18} />重新检查</Button></> : <form onSubmit={e => { e.preventDefault(); if (first && password !== confirmation) { action.setError('两次输入的密码不一致，请检查。'); return; } void action.run(async () => { await api(first ? '/api/setup' : '/api/login', 'POST', { password }); setPassword(''); setConfirmation(''); await onAuthenticated(); }); }}>
      <h2>{first ? '创建管理员密码' : '登录工作台'}</h2><p className="hint">{first ? '设置至少 12 位的密码，用于保护本机工作台。' : '使用首次设置的管理员密码。'}</p><label className="field"><span className="field-label">管理员密码</span><input type="password" autoComplete={first ? 'new-password' : 'current-password'} autoFocus minLength={first ? 12 : 1} maxLength={200} required value={password} onChange={e => setPassword(e.target.value)} placeholder={first ? '至少 12 位' : '输入密码'} /></label>{first && <label className="field"><span className="field-label">再次输入密码</span><input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}<Feedback error={action.error} /><Button type="submit" variant="primary" busy={action.busy}>{first ? '创建并进入工作台' : '进入工作台'}</Button></form>}
    <p className="auth-footnote">本机配置 · 独立管理 · 通用记忆共享，成员画像按群隔离</p>
  </main><aside className="auth-portrait"><img src="/assets/liino-portrait.png" alt="梨诺角色立绘" /></aside></div>;
}
