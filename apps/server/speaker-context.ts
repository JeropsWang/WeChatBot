/** 生成模型可见的发言者上下文。身份未知时明确标注，不能通过昵称猜测权限或把群聊文本提升为系统指令。 */
export function commandContent(text:string,botNickname?:string):string {
 if(!botNickname)return text;
 const prefix='@'+botNickname;
 return text.startsWith(prefix)&&/^[\s\u2005]/u.test(text.slice(prefix.length))?text.slice(prefix.length).trimStart():text;
}
export function speakerContent(message:any):string {
 if(message.direction==='out')return message.content;
 const raw=message.raw??{};
 const id=raw.identityStatus==='verified'?raw.memberId:raw.uiIdentityStatus==='matched'?raw.uiMemberId:undefined;
 return JSON.stringify({speaker:id?{status:'identified',memberId:id,number:message.member_number??undefined,name:message.sender_name??undefined}:{status:'unknown'},content:message.content});
}
