/** 统一服务端分页边界和结果结构；SQL 结构由可信调用代码提供，用户筛选值只能作为绑定参数传入。 */
import {z} from 'zod';
import type {Database} from './db.js';
const pageSchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().refine(n=>[20,50,100].includes(n),'每页数量只能为20、50或100').default(20)});
export function pageInput(input:unknown){return pageSchema.parse(input??{});}
export async function pageQuery(db:Database,input:unknown,select:string,from:string,order:string,where='TRUE',values:unknown[]=[]){
  const {page,pageSize}=pageInput(input);
  const total=(await db.query(`SELECT count(*)::int n ${from} WHERE ${where}`,values)).rows[0].n;
  const items=(await db.query(`SELECT ${select} ${from} WHERE ${where} ORDER BY ${order} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,pageSize,(page-1)*pageSize])).rows;
  return {items,total,page,pageSize};
}
