/** 读取兼容旧数据的搜索配置。缺字段使用明确默认值，密钥只通过密钥库引用，不复制到普通配置。 */
import {isIP} from 'node:net';
import type {Database} from './db.js';
export interface SearchSettings {trustedDomains:string[];timeRange:'auto'|'day'|'week'|'month'|'year'|'all';maxResults:number;candidateLimit:number}
export const defaultSearchSettings:SearchSettings={trustedDomains:[],timeRange:'auto',maxResults:6,candidateLimit:30};
export function validateSearchSettings(input:unknown):SearchSettings{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('搜索配置格式无效');
  const value={...defaultSearchSettings,...input} as SearchSettings;
  if(!Array.isArray(value.trustedDomains)||value.trustedDomains.length>200)throw new Error('可信域名最多200项');
  value.trustedDomains=[...new Set(value.trustedDomains.map(domain=>{if(typeof domain!=='string')throw new Error('域名格式无效');const host=domain.trim().toLowerCase().replace(/^www\./,'');if(host.length>253||isIP(host)||!host.includes('.')||!host.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p)))throw new Error('请填写可信域名，不包含协议或路径');return host;}))];
  if(!['auto','day','week','month','year','all'].includes(value.timeRange))throw new Error('时间范围无效');
  if(!Number.isInteger(value.maxResults)||value.maxResults<1||value.maxResults>20||!Number.isInteger(value.candidateLimit)||value.candidateLimit<value.maxResults||value.candidateLimit>100)throw new Error('搜索结果数量无效');
  return value;
}
export async function getSearchSettings(db:Database):Promise<SearchSettings>{const result=await db.query("SELECT value FROM settings WHERE key='search'");return validateSearchSettings(result.rows[0]?.value??defaultSearchSettings);}
export async function saveSearchSettings(db:Database,input:unknown){const settings=validateSearchSettings(input);await db.query("INSERT INTO settings(key,value) VALUES('search',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[settings]);return settings;}
