/** HTTP 与异步状态工具。请求携带管理员会话，401 广播过期；卸载后不更新状态，历史事件名保持兼容。 */
import { useCallback, useEffect, useRef, useState } from 'react';
export type { AppSettings, Persona, Chat, ModelConfig, MemoryEntry, MemoryCategory, KnowledgeHit, SearchHit } from '../../../packages/contracts';
import type { AppSettings, Chat, ModelConfig } from '../../../packages/contracts';

export interface BridgeStatus { connected: boolean; transportConnected: boolean; managed?: boolean; compatibility?: boolean; account?: string; detail: string; capabilities: Record<string, boolean>; diagnostics: Record<string, unknown> }
export interface Bootstrap { settings: AppSettings; models: ModelConfig[]; chats: Chat[]; bridge: BridgeStatus; counts: { memories: number; candidates: number; documents: number; pending: number; unknown: number } }
export interface SetupStatus { ready: boolean; initialized: boolean; authenticated: boolean; error?: string }
export interface PageResult<T> { items: T[]; total: number; page: number; pageSize: number }
export function queryString(values: Record<string, string | number | undefined | null>) { const q = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') q.set(key, String(value)); }); return q.toString(); }
/** 统一解析 JSON 错误；服务端拒绝必须传播到调用方，避免表单错误清空。 */
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method, credentials: 'include', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('无法连接工作台服务，请检查本机服务后重试。'); }
  let data: any;
  try { data = await response.json(); } catch { throw new Error('工作台服务暂时不可用，请稍后重试。'); }
  if (!response.ok) {
    if (response.status === 401 && !['/api/login', '/api/setup'].includes(path)) window.dispatchEvent(new Event('liino-session-expired'));
    throw new Error(data.message || `请求失败（${response.status}）`);
  }
  if (data?.ok === false) throw new Error(data.message || '操作未完成，请重试。');
  return data as T;
}
/** 将异步失败转为可展示反馈，调用方仅在获得成功结果后清理草稿。 */
export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async <T,>(work: () => Promise<T>, message = ''): Promise<T | undefined> => {
    setBusy(true); setError(''); setSuccess('');
      try { const result = await work(); if (mounted.current && message) setSuccess(message); return result; }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '操作失败，请重试。'); return undefined; }
    finally { if (mounted.current) setBusy(false); }
  };
  return { busy, error, success, run, setError, setSuccess };
}
/** generation 排除旧路径请求的迟到结果；切换群或筛选时不会覆盖新页面。 */
export function useResource<T>(path: string | undefined, revision: number) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!path) { setData(undefined); setLoading(false); setError(''); return; }
    const current = ++generation.current; setLoading(true);
    try { const next = await api<T>(path); if (generation.current === current) { setData(next); setError(''); } }
    catch (e) { if (generation.current === current) setError((e as Error).message); }
    finally { if (generation.current === current) setLoading(false); }
  }, [path]);
  useEffect(() => { setData(undefined); setError(''); void reload(); return () => { generation.current++; }; }, [reload]);
  const lastRevision = useRef(revision);
  useEffect(() => { if (lastRevision.current !== revision) { lastRevision.current = revision; void reload(); } }, [revision, reload]);
  return { data, error, loading, reload };
}
export type SaveSettings = (patch: Partial<AppSettings>) => Promise<AppSettings>;
export const dateTime = (value?: string | number) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
export const dateOnly = (value?: string | number) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '—';
export const parseTags = (text: string) => text.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 30);
