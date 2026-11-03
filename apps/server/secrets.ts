/** 密钥库只保存密文。Windows DPAPI 绑定当前用户；其他系统使用本地随机 AES-GCM 密钥。写入串行化并以临时文件原子替换，避免并发丢失。 */
import { spawn } from 'node:child_process';
import { randomBytes,randomUUID,createCipheriv,createDecipheriv } from 'node:crypto';
import { readFile,writeFile,mkdir,open,rename,unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Secrets never live in application JSON or model-visible context. Windows binds ciphertext to the current user.
async function dpapi(value:string,decrypt:boolean):Promise<string>{
  const operation=decrypt?'Unprotect':'Protect';
  const script=`Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::${operation}($v,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve,reject)=>{
    const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']}); let output='';
    p.stdout.on('data',chunk=>output+=chunk); p.stderr.resume(); p.on('error',()=>reject(new Error('Windows 密钥保护服务不可用'))); p.on('close',code=>code===0?resolve(output.trim()):reject(new Error('密钥无法由当前 Windows 用户解密'))); p.stdin.end(value);
  });
}
export class SecretStore {
  private values:Record<string,string>={}; private key?:Buffer; private chain:Promise<void>=Promise.resolve();
  constructor(private directory:string,private windows=process.platform==='win32'){}
  async init(){ await mkdir(this.directory,{recursive:true,mode:0o700}); try{this.values=JSON.parse(await readFile(join(this.directory,'secrets.json'),'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
    if(!this.windows){try{this.key=await readFile(join(this.directory,'secret.key'));}catch(e:any){if(e.code!=='ENOENT')throw e;this.key=randomBytes(32);await writeFile(join(this.directory,'secret.key'),this.key,{mode:0o600,flag:'wx'});}}
  }
  has(id:string){return Boolean(this.values[id]);}
  async get(id:string):Promise<string|undefined>{const value=this.values[id];if(!value)return undefined;if(this.windows)return Buffer.from(await dpapi(value,true),'base64').toString('utf8');const bytes=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',this.key!,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');}
  async set(id:string,value:string){
    this.chain=this.chain.catch(()=>{}).then(async()=>{
      const next={...this.values};
      if(!value)delete next[id];
      else if(this.windows)next[id]=await dpapi(Buffer.from(value).toString('base64'),false);
      else{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key!,iv),body=Buffer.concat([c.update(value,'utf8'),c.final()]);next[id]=Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
      const temporary=join(this.directory,'.secrets-'+randomUUID()+'.tmp');
      try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(next));await handle.sync();}finally{await handle.close();}await rename(temporary,join(this.directory,'secrets.json'));this.values=next;}
      finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    });return this.chain;
  }
}
