# 单一 COM 线程协调桌面读写；先持久化收件再确认，发送按 commandId 记账。不确定结果进入待核查，禁止自动重复发送。
import os
"""Protocol-independent bridge logic. Called only by the single UI worker."""
from datetime import datetime, timezone
import hashlib
import json
import re
import uuid
import base64
import time
from urllib.parse import quote
from copy import deepcopy
from store import reconcile, snapshot_fingerprints
from identity_occurrences import OccurrenceRegistry
from identity_event_capture import bind_new_observations
from identity_preflight import validate_observation


def binding_key(name):
    # Matches JavaScript encodeURIComponent.
    return 'wx4py:group:' + quote(name, safe="~()*!.'-")


class BridgeEngine:
    def __init__(self, store, adapter):
        self.store, self.adapter = store, adapter
        self.chats = {}
        self.nicknames = {}
        self.binding_errors = {}
        self.snapshot_gaps = {}
        self.identity_registry=OccurrenceRegistry(ttl=300)
        self.identity_session=uuid.uuid4().hex
        self.identity_arm_state=None
        self.identity_reasons={}
        self.identity_names={}
        self.reply_identity_locations={}
        self.reply_identity_results={}
        self.live_snapshots={}
        self.image_batch_started={}
        self.observation_deferred=False
        self.image_capture_verified=False
        self.visual_snapshots={}

    def configure(self, chats):
        self.identity_registry.clear();self.identity_session=uuid.uuid4().hex;self.identity_arm_state=None;self.identity_reasons.clear();self.identity_names.clear();self.reply_identity_locations.clear();self.reply_identity_results.clear()
        self.live_snapshots.clear()
        self.visual_snapshots.clear()
        ids, names, keys = set(), set(), set()
        for chat in chats:
            uuid.UUID(chat['id'])
            if not isinstance(chat['name'], str) or not chat['name'].strip() or chat['bindingKey'] != binding_key(chat['name']):
                raise ValueError('群名或绑定标识无效')
            if chat['id'] in ids or chat['name'] in names or chat['bindingKey'] in keys:
                raise ValueError('存在重名群或重复绑定；拒绝猜测目标')
            ids.add(chat['id']); names.add(chat['name']); keys.add(chat['bindingKey'])
        self.adapter.unbind_except(names)
        self.chats = {chat['id']: dict(chat) for chat in chats}
        self.nicknames = {}
        self.binding_errors = {}
        for chat in chats:
            try:
                metadata = self.adapter.bind(chat['name'])
                self.nicknames[chat['id']] = metadata.get('nickname')
                # First connection establishes a baseline; old history is never replayed.
                self._observe(chat, self.adapter.read(chat['name']))
            except Exception as exc:
                self.binding_errors[chat['id']] = str(exc)
        return self.status()

    def status(self):
        state = self.adapter.status()
        state.setdefault('capabilities', {})
        listening = bool(state.get('connected') and self.chats and not self.binding_errors)
        mentions = listening and all(self.nicknames.get(x) for x in self.chats)
        state['capabilities']['groupListening'] = listening
        state['capabilities']['mentions'] = mentions
        state['capabilities']['selfEchoFiltering'] = listening
        state['capabilities']['senderIdentity'] = False
        state['capabilities']['uiReplyIdentity'] = listening and callable(getattr(self.adapter,'identity_message',None))
        state['capabilities']['durableReplay'] = True
        state['capabilities']['receiveImages'] = listening and self.image_capture_verified
        state['capabilities']['originalImage'] = False
        state['capabilities']['quotedImage'] = False
        state['diagnostics'] = {**state.get('diagnostics', {}), 'expiredInboxCount': self.store.expired_inbox_count}
        if self.binding_errors:
            state['detail'] = '；'.join(self.binding_errors.values())[:1000]
            state['diagnostics'] = {**state.get('diagnostics', {}), 'bindingErrors': self.binding_errors}
        active_gaps = {key: value for key, value in self.snapshot_gaps.items() if key in self.chats}
        if active_gaps:
            state['diagnostics'] = {**state.get('diagnostics', {}), 'snapshotGaps': active_gaps}
            state['detail'] = (state.get('detail', '') + '；' + '；'.join(active_gaps.values()))[:1500]
        return {'type': 'status', **state}

    def _observe(self, chat, current, self_indices=(), send_result=None):
        self.observation_deferred=False
        previous = self.store.snapshot(chat['id'])
        previous_live = self.live_snapshots.get(chat['id'], [])
        normalized=[{k:v for k,v in row.items() if not k.startswith('_')} for row in current]
        fingerprints=snapshot_fingerprints(normalized)
        added, gap = (normalized, False) if not previous and self.store.has_snapshot(chat['id']) else reconcile(previous, fingerprints)
        start = len(current) - len(added)
        if not added and not gap and previous==fingerprints:
            continuation=self._visual_continuation(chat,current)
            if continuation is not None:start=continuation
        has_new_images=any(row.get('kind')=='image' for row in normalized[start:])
        image_deadline=self.image_batch_started.setdefault(chat['id'],time.monotonic())+5 if has_new_images else 0
        if has_new_images:
            prepare=getattr(self.adapter,'prepare_image_capture',None)
            if callable(prepare) and prepare(chat['name']):
                # Restoring changes virtualized geometry and can replace controls.
                # Keep the old cursor and retry the whole batch from a fresh read.
                if time.monotonic()<image_deadline:
                    self.observation_deferred=True
                    return None
        # Capture every new visual row before profile-card probes can wait or
        # change the viewport. This remains entirely on the single UI worker.
        captured={}
        for index,item in enumerate(normalized[start:],start=start):
            if item.get('kind')!='image' or not item.get('name','').strip() or index in self_indices:continue
            row=current[index];capture=getattr(self.adapter,'capture_image',None)
            try:
                result=capture(chat['name'],row.get('_runtimeId'),row.get('_rect')) if callable(capture) else {'status':'unavailable','reason':'图片取图能力未提供'}
            except Exception:result={'status':'unavailable','reason':'图片取图或发图者识别失败'}
            if result.get('reason') in ('无法安全区分图片区域与头像/文字','截图为空或纯色，需重新发送','图片行不完整','图片气泡已移动','截图期间图片气泡变化','图片气泡不再唯一可见') and time.monotonic()<image_deadline:
                self.observation_deferred=True
                return None
            captured[index]=result
        events = [];event_rows=[];image_uploads=[]
        for index, item in enumerate(normalized[start:], start=start):
            if item.get('kind') not in ('message','image') or not item.get('name', '').strip():
                continue
            nickname = self.nicknames.get(chat['id'])
            text = item['name']
            events.append({'eventId': 'sent-'+send_result[0] if send_result and send_result[1]=='sent' and index in self_indices else str(uuid.uuid4()), 'chatId': chat['id'], 'accountId': 'local-wechat',
                           'content': text, 'observedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                           'sourceMessageId': None, 'senderId': None, 'senderName': None,
                           'isSelf': index in self_indices, 'botNickname': nickname,
                           'mentioned': bool(nickname and re.search(r'@' + re.escape(nickname) + r'(?=$|[\s\u2005，。！？、:：;；,!.?])', text)), 'type': 'text'})
            event=events[-1]
            if item.get('unresolvedQuote'):event['unresolvedQuote']=True
            if item.get('kind')=='image':
                event['type']='image';event['mentioned']=False
                attachment_id=str(uuid.uuid4())
                event['image']={'attachmentId':attachment_id,'status':'unavailable','quality':'thumbnail'}
                if not event['isSelf']:
                    row=current[index];runtime=row.get('_runtimeId');rect=row.get('_rect')
                    try:
                        result=captured[index]
                        if isinstance(result.get('reason'),str):event['image']['reason']=result['reason']
                        if result.get('isSelf') is True:
                            event['isSelf']=True
                            event_rows.append((event,index))
                            continue
                        if result.get('status')=='ready':
                            event['image']['status']='pending'
                            image_uploads.append({'attachmentId':attachment_id,'eventId':event['eventId'],'chatId':chat['id'],**{key:result[key] for key in ('mimeType','width','height','sha256','quality','data')}})
                        observation=self._reply_observation(chat,event['content'],runtime,source_row=item)
                        event['uiIdentityFailure']={'reasonCode':'observation_unavailable','reason':'当前图片的消息或头像定位证据不可用'}
                        if observation:
                            # Production capture binds its frame to the avatar in that
                            # exact screenshot. Do not name a reused row's later author.
                            same_avatar=result.get('avatarHash')==observation['imageHash'] if 'avatarHash' in result else observation['rect']==rect
                            if same_avatar:
                                try:probe=self.adapter.identity_message(chat['name'],chat['id'],self.identity_session,event['content'],runtime,observation['rect'],observation)
                                except Exception:probe={'status':'unknown','reasonCode':'probe_error','reason':'资料卡识人调用异常'}
                                if probe.get('status')=='candidate':
                                    event['uiCandidate']={'name':probe['name'],'appearanceHash':observation['imageHash'],'eventId':event['eventId']}
                                    if observation.get('appearanceDescriptor'):event['uiCandidate']['appearanceDescriptor']=observation['appearanceDescriptor']
                                    event.pop('uiIdentityFailure',None)
                                else:event['uiIdentityFailure']={'reasonCode':str(probe.get('reasonCode') or 'profile_failed')[:100],'reason':str(probe.get('reason') or '资料卡未返回唯一名称')[:500]}
                            else:event['uiIdentityFailure']={'reasonCode':'avatar_target_changed','reason':'截图与当前消息的头像定位证据发生变化'}
                    except Exception:event['image'].update(status='unavailable',reason='图片取图或发图者识别失败')
            event_rows.append((events[-1],index))
        self._refresh_reply_locations(chat, current, gap)
        if not gap:
            now=time.monotonic()
            self.reply_identity_locations={key:value for key,value in self.reply_identity_locations.items() if 0<=now-value['at']<=120}
            ids=[tuple(row.get('_runtimeId') or ()) for row in current if row.get('kind') in ('message','image')]
            for event,index in event_rows:
                row=current[index];runtime=tuple(row.get('_runtimeId') or ());rect=row.get('_rect')
                if event['isSelf'] or not runtime or ids.count(runtime)!=1 or not isinstance(rect,list) or len(rect)!=4:continue
                evidence=self._reply_observation(chat,event['content'],list(runtime))
                if not evidence or evidence.get('rect')!=rect:continue
                self.reply_identity_locations[event['eventId']]={'chatId':chat['id'],'sessionId':self.identity_session,'at':now,'text':event['content'],'runtime':list(runtime),'rect':list(rect),'evidence':deepcopy(evidence)}
            if len(self.reply_identity_locations)>500:self.reply_identity_locations=dict(list(self.reply_identity_locations.items())[-500:])
        self.store.commit_observation(chat['id'], normalized, events, send_result,image_uploads=image_uploads)
        if image_uploads:self.image_capture_verified=True
        self.image_batch_started.pop(chat['id'],None)
        self.live_snapshots[chat['id']]=deepcopy(normalized)
        self._remember_visual_tail(chat,current)
        arm=self.identity_arm_state
        if arm and arm['chatId']==chat['id'] and time.monotonic()<arm['expires'] and any(e['content']=='认人实时测试' and not e['isSelf'] for e in events):
            event_ids=[e['eventId'] for e in events if e['content']=='认人实时测试' and not e['isSelf']]
            reason='capture_error'
            try:
                observations=self.adapter.identity_observations(chat['name'],chat['id'],self.identity_session,'认人实时测试')
                after=self.adapter.identity_observations(chat['name'],chat['id'],self.identity_session,'认人实时测试')
                reason='snapshot_changed'
                if self.adapter.read(chat['name'])!=current:raise ValueError('截图期间消息控件已改变')
                reason='duplicate_runtime'
                marker_rows=[row for row in current if row.get('kind')=='message' and row.get('name')=='认人实时测试']
                marker_ids=[tuple(row.get('_runtimeId',())) for row in marker_rows]
                if any(not value for value in marker_ids) or len(marker_ids)!=len(set(marker_ids)):raise ValueError('消息控件标识缺失或重复')
                runtime_ids=[tuple(row['runtimeId']) for row in observations]
                if len(runtime_ids)!=len(set(runtime_ids)):raise ValueError('界面控件标识重复')
                by_runtime={tuple(row['runtimeId']):row for row in observations}
                evidence=[]
                for row in current:
                    obs=by_runtime.get(tuple(row.get('_runtimeId',())))
                    evidence.append(obs if obs and row.get('_rect')==obs.get('rect') else None)
                reason='evidence_mismatch' if any(evidence[i] is None for i,row in enumerate(current) if row in marker_rows) else 'association_rejected'
                details={}
                bound=bind_new_observations(self.identity_registry,chat['id'],self.identity_session,previous_live,normalized,evidence,after,[e['eventId'] for e in events],self_indices,diagnostics=details,name_probe=True)
                for event_id in event_ids:
                    if not bound.get(event_id):self.identity_reasons[event_id]=details.get(event_id,reason)
                if arm.get('readName') and not arm.get('nameAttempted'):
                    for event_id in event_ids:
                        if not bound.get(event_id):continue
                        arm['nameAttempted']=True
                        located=self.identity_registry.resolve(event_id,chat['id'],self.identity_session,after,name_probe=True)
                        if located['status']!='current':self.identity_reasons[event_id]='target_changed';break
                        probe=getattr(self.adapter,'identity_name',None)
                        reason='name_read_error'
                        result=probe(chat['name'],chat['id'],self.identity_session,located['observation']) if callable(probe) else {'status':'unknown','reason':'名称读取未提供'}
                        name=result.get('name')
                        self.identity_names[event_id]=({'status':'candidate','name':name.strip(),'identitySource':'wechat-ui-profile'}
                            if result.get('status')=='candidate' and isinstance(name,str) and 0<len(name.strip())<=200
                            else {'status':'unknown','reason':result.get('reason','名称读取失败')})
                        break
            except Exception:
                for event_id in event_ids:self.identity_reasons[event_id]=reason
            if len(self.identity_reasons)>500:self.identity_reasons=dict(list(self.identity_reasons.items())[-500:])
        if gap:
            detail = f"群「{chat['name']}」消息快照出现无法定位的缺口；已建立新基线，未回放历史"
            self.snapshot_gaps[chat['id']] = detail
            return detail
        return None

    def poll(self):
        diagnostics = []
        for chat in self.chats.values():
            if chat['id'] in self.binding_errors:
                continue
            try:
                prepare=getattr(self.adapter,'prepare_listener_view',None)
                if callable(prepare) and prepare(chat['name']):
                    # The explicit unread navigation invalidates every old live locator.
                    self.reply_identity_locations={key:value for key,value in self.reply_identity_locations.items() if value['chatId']!=chat['id']}
                    self.visual_snapshots.pop(chat['id'],None)
                    break
                detail = self._observe(chat, self.adapter.read(chat['name']))
                if detail: diagnostics.append(detail)
                if self.observation_deferred:break
            except Exception as exc:
                self.binding_errors[chat['id']] = f"群「{chat['name']}」读取失败：{exc}"
                diagnostics.append(self.binding_errors[chat['id']])
        return diagnostics

    def _visual_continuation(self,chat,current):
        """An identical media-only window may have advanced by one actual message.

        Require an uninterrupted row/author anchor and previously unseen runtimes.
        Animation pixels are deliberately not event identity. No persisted runtime
        is trusted across a reconnect, and control reuse cannot count as arrival.
        """
        state=self.visual_snapshots.get(chat['id'])
        if not state or state['seen'] is None or not state['proof'] or time.monotonic()-state['at']>120:return None
        old=state['rows']
        if not old or not current or any(r.get('kind')!='image' for r in current):return None
        before=[tuple(r.get('_runtimeId') or ()) for r in old];after=[tuple(r.get('_runtimeId') or ()) for r in current]
        if not all(before+after) or len(set(before))!=len(before) or len(set(after))!=len(after):return None
        overlap=next((n for n in range(min(len(before),len(after)),0,-1) if before[-n:]==after[:n]),0)
        if not overlap or overlap==len(after) or any(key in state['seen'] for key in after[overlap:]):return None
        anchor=current[overlap-1];proof=self._reply_observation(chat,anchor['name'],list(after[overlap-1]));old_proof=state['proof']
        if not proof or proof.get('visible') is not True or proof.get('rect')!=anchor.get('_rect'):return None
        if any(proof.get(k)!=old_proof.get(k) for k in ('chatId','sessionId','runtimeId','imageHash','textHash')):return None
        return overlap

    def _remember_visual_tail(self,chat,current):
        previous=self.visual_snapshots.get(chat['id']);seen=set() if not previous else previous['seen']
        if seen is not None:
            seen=seen|{tuple(r.get('_runtimeId') or ()) for r in current if r.get('kind')=='image' and r.get('_runtimeId')}
            if len(seen)>5000:seen=None
        rows=current if 0<len(current)<=500 and all(r.get('kind')=='image' for r in current) else []
        last=rows[-1] if rows else None
        proof=self._reply_observation(chat,last['name'],last.get('_runtimeId')) if last and last.get('_runtimeId') else None
        self.visual_snapshots[chat['id']]={'rows':deepcopy(rows),'proof':deepcopy(proof),'seen':seen,'at':time.monotonic()}

    def send(self, command):
        required = ('commandId', 'chatId', 'bindingKey', 'text')
        if not isinstance(command, dict) or any(not isinstance(command.get(k), str) or not command[k] for k in required):
            return {'status': 'not_sent', 'detail': '发送参数无效'}
        if len(command['text']) > 16000 or not command['text'].strip() or len(command['commandId']) > 150:
            return {'status': 'not_sent', 'detail': '消息为空或超过长度限制'}
        chat = self.chats.get(command['chatId'])
        if not chat or chat['bindingKey'] != command['bindingKey']:
            return {'status': 'not_sent', 'detail': '目标不在启用群白名单或绑定标识不匹配'}
        context = hashlib.sha256(json.dumps({k: command[k] for k in required[1:]}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        old = self.store.send_result(command['commandId'])
        if old:
            if self.store.send_context(command['commandId']) != context:
                return {'status': 'not_sent', 'detail': '发送ID已用于不同内容或群聊'}
            if old['status'] == 'executing':
                return {'status': 'unknown', 'detail': '原发送仍在执行，禁止重复发送'}
            if old['status'] != 'not_sent':
                return old
        if chat['id'] in self.binding_errors or not self.adapter.status().get('connected'):
            return {'status': 'not_sent', 'detail': self.binding_errors.get(chat['id'], '微信未安全连接')}
        # Drain arrivals before the send; an identical incoming message remains a separate occurrence.
        try:
            self._observe(chat, self.adapter.read(chat['name']))
        except Exception as exc:
            return {'status': 'not_sent', 'detail': f'发送前群窗口校验失败：{exc}'}
        if not self.store.begin_send(command['commandId'], context):
            return self.store.send_result(command['commandId']) or {'status': 'unknown'}
        try:
            result = self.adapter.send(chat['name'], command['text'])
            status = result.get('status', 'unknown')
            if status not in {'sent', 'not_sent', 'unknown'}: status = 'unknown'
            detail = str(result.get('detail', ''))
            if 'snapshot' in result:
                self._observe(chat, result['snapshot'], result.get('selfIndices', []), (command['commandId'], status, detail))
            else:
                self.store.finish_send(command['commandId'], status, detail)
            return {'status': status, 'detail': detail}
        except Exception as exc:
            self.store.finish_send(command['commandId'], 'unknown', f'UI操作可能已发生，禁止自动重发：{type(exc).__name__}')
            return self.store.send_result(command['commandId'])

    def request(self, message):
        action = message.get('action')
        if action == 'send': result = self.send(message.get('payload'))
        elif action == 'send_image': result = self.send_image(message.get('payload'))
        elif action == 'identity_sample': result = self.identity_sample(message.get('payload'))
        elif action == 'identity_arm': result = self.identity_arm(message.get('payload'))
        elif action == 'identity_status': result = self.identity_status(message.get('payload'))
        elif action == 'identity_reply': result = self.identity_reply(message.get('payload'))
        elif action == 'list': result = {'chats': self.adapter.list_chats()}
        else: result = {'status': 'not_sent', 'detail': '不支持的桥接动作'}
        return {'type': 'result', 'requestId': message.get('requestId'), 'result': result}

    def identity_arm(self,payload):
        if not isinstance(payload,dict) or not {'chatId','bindingKey'}<=set(payload) or set(payload)-{'chatId','bindingKey','readName'} or ('readName' in payload and not isinstance(payload['readName'],bool)):return {'status':'unknown'}
        chat=self.chats.get(payload.get('chatId'))
        if not chat or (not os.environ.get('WECHATBOT_TEST_GROUP') or chat['name']!=os.environ.get('WECHATBOT_TEST_GROUP')) or chat['bindingKey']!=payload.get('bindingKey') or chat['id'] in self.binding_errors or not self.adapter.status().get('connected'):return {'status':'unknown'}
        self.identity_registry.clear();self.identity_reasons.clear();self.identity_names.clear();self.identity_arm_state={'chatId':chat['id'],'expires':time.monotonic()+300,'readName':payload.get('readName',False)}
        return {'status':'armed','expiresInSeconds':300}

    def _reply_observation(self,chat,text,runtime,source_row=None):
        capture=getattr(self.adapter,'identity_message_observation',None)
        if not callable(capture):return None
        try:
            before=self.adapter.read(chat['name'])
            observation=capture(chat['name'],chat['id'],self.identity_session,text,runtime)
            after=self.adapter.read(chat['name'])
            def targets(rows):
                return [row for row in rows if row.get('_runtimeId')==runtime]
            left,right=targets(before),targets(after)
            if len(left)!=1 or len(right)!=1 or left[0]!=right[0] or left[0].get('name')!=text:return None
            if source_row is not None and any(left[0].get(key)!=source_row.get(key) for key in ('kind','class','name')):return None
            if validate_observation(observation,observation)['status']!='current':return None
            if observation['chatId']!=chat['id'] or observation['sessionId']!=self.identity_session or observation['runtimeId']!=runtime:return None
            if observation['textHash']!=hashlib.sha256(text.encode()).hexdigest() or observation['rect']!=right[0].get('_rect'):return None
            return observation
        except Exception:return None

    def _refresh_reply_locations(self,chat,current,gap=False):
        now=time.monotonic()
        for event_id,location in list(self.reply_identity_locations.items()):
            if location['chatId']!=chat['id']:continue
            rows=[row for row in current if row.get('_runtimeId')==location['runtime']]
            valid=not gap and 0<=now-location['at']<=120 and len(rows)==1 and rows[0].get('name')==location['text']
            if valid and rows[0].get('_rect')!=location['rect']:
                observation=self._reply_observation(chat,location['text'],location['runtime'])
                valid=bool(observation and observation['imageHash']==location['evidence']['imageHash'])
                if valid:location['rect']=list(observation['rect']);location['evidence']=deepcopy(observation)
            if not valid:self.reply_identity_locations.pop(event_id,None)

    def identity_reply(self,payload):
        if not isinstance(payload,dict) or set(payload)!={'chatId','bindingKey','eventId'}:return {'status':'unknown'}
        chat=self.chats.get(payload.get('chatId'));event_id=payload.get('eventId')
        if not chat or chat['bindingKey']!=payload.get('bindingKey') or not isinstance(event_id,str):return {'status':'unknown'}
        cache_key=(chat['id'],event_id)
        if cache_key in self.reply_identity_results:return dict(self.reply_identity_results[cache_key])
        self.reply_identity_results[cache_key]={'status':'unknown','eventId':event_id,'reason':'消息定位不可用','reasonCode':'location_unavailable'}
        if len(self.reply_identity_results)>500:self.reply_identity_results=dict(list(self.reply_identity_results.items())[-500:])
        try:
            if chat['id'] in self.binding_errors or not self.adapter.status().get('connected'):return dict(self.reply_identity_results[cache_key])
            self._refresh_reply_locations(chat,self.adapter.read(chat['name']))
            location=self.reply_identity_locations.get(event_id)
            if location and location['chatId']==chat['id']:self.reply_identity_locations.pop(event_id,None)
            if not location or location['chatId']!=chat['id'] or location['sessionId']!=self.identity_session:return dict(self.reply_identity_results[cache_key])
            observation=self._reply_observation(chat,location['text'],location['runtime'])
            if not observation or observation['imageHash']!=location['evidence']['imageHash']:
                self.reply_identity_results[cache_key].update(reason='目标消息证据已变化',reasonCode='target_changed')
                return dict(self.reply_identity_results[cache_key])
            probe=getattr(self.adapter,'identity_message',None)
            result={'status':'unknown','reason':'未提供认人能力','reasonCode':'unsupported'}
            if callable(probe):
                for attempt in range(2):
                    result=probe(chat['name'],chat['id'],self.identity_session,location['text'],location['runtime'],observation['rect'],observation)
                    if not isinstance(result,dict):result={'status':'unknown','reasonCode':'invalid_result'}
                    if attempt or not result.get('retryable') or result.get('clicked',True):break
                    refreshed=self._reply_observation(chat,location['text'],location['runtime'])
                    if not refreshed or refreshed['imageHash']!=observation['imageHash']:break
                    observation=refreshed
            name=result.get('name') if isinstance(result,dict) else None
            if result.get('status')=='candidate' and isinstance(name,str) and 0<len(name.strip())<=200:
                self.reply_identity_results[cache_key]={'status':'candidate','eventId':event_id,'name':name.strip(),'identitySource':'wechat-ui-profile','appearanceHash':observation['imageHash']}
                if observation.get('appearanceDescriptor'):self.reply_identity_results[cache_key]['appearanceDescriptor']=observation['appearanceDescriptor']
            else:self.reply_identity_results[cache_key].update(reason=result.get('reason','资料卡读取失败'),reasonCode=result.get('reasonCode','profile_failed'))
            return dict(self.reply_identity_results[cache_key])
        except Exception:return dict(self.reply_identity_results[cache_key])

    def identity_status(self,payload):
        if not isinstance(payload,dict) or set(payload)!={'chatId','eventId'}:return {'status':'unknown'}
        chat=self.chats.get(payload.get('chatId'));arm=self.identity_arm_state
        if not chat or not arm or chat['id']!=arm['chatId'] or time.monotonic()>=arm['expires']:return {'status':'unknown','reason':'experiment_inactive'}
        if payload.get('eventId') in self.identity_names:return dict(self.identity_names[payload['eventId']])
        if payload.get('eventId') in self.identity_reasons:return {'status':'unknown','reason':self.identity_reasons[payload['eventId']]}
        try:
            observations=self.adapter.identity_observations(chat['name'],chat['id'],self.identity_session,'认人实时测试')
            result=self.identity_registry.resolve(payload.get('eventId'),chat['id'],self.identity_session,observations,name_probe=True)
            return {'status':'current','avatarHash':result['observation']['imageHash']} if result['status']=='current' else {'status':'unknown','reason':result.get('reason','location_invalidated')}
        except Exception:return {'status':'unknown','reason':'status_capture_error'}

    def identity_sample(self, payload):
        # Isolated feasibility action. It never verifies or stores identity and
        # cannot be used to choose a message or coordinates outside the fixture.
        if not isinstance(payload,dict) or set(payload)!= {'commandId','chatId','bindingKey','avatarHash'}:
            return {'status':'unknown','reason':'参数无效'}
        chat=self.chats.get(payload.get('chatId'))
        if not chat or (not os.environ.get('WECHATBOT_TEST_GROUP') or chat['name']!=os.environ.get('WECHATBOT_TEST_GROUP')) or chat['bindingKey']!=payload.get('bindingKey'):
            return {'status':'unknown','reason':'仅支持已绑定的测试群'}
        digest=payload.get('avatarHash')
        if not isinstance(digest,str) or not re.fullmatch(r'[a-f0-9]{64}',digest):return {'status':'unknown','reason':'图像摘要无效'}
        command_id=payload.get('commandId')
        if not isinstance(command_id,str) or not 1<=len(command_id)<=150:return {'status':'unknown','reason':'实验标识无效'}
        if chat['id'] in self.binding_errors or not self.adapter.status().get('connected'):
            return {'status':'unknown','reason':'测试群不可用'}
        context=hashlib.sha256(json.dumps({'chatId':chat['id'],'bindingKey':chat['bindingKey'],'avatarHash':digest},sort_keys=True).encode()).hexdigest()
        if self.store.send_result(command_id):return {'status':'unknown','reason':'此实验已执行或状态不明，禁止重复点击'}
        if not self.store.begin_send(command_id,context):return {'status':'unknown','reason':'实验已被处理'}
        try:
            result=self.adapter.identity_sample(chat['name'],digest)
            self.store.finish_send(command_id,'unknown','实验已执行，禁止重复点击')
            return result
        except Exception:
            self.store.finish_send(command_id,'unknown','实验结果未确认，禁止重复点击')
            return {'status':'unknown','reason':'界面识别未完成'}

    def send_image(self, command):
        if not isinstance(command, dict): return {'status':'not_sent','detail':'图片参数无效'}
        required=('commandId','chatId','bindingKey','data','sha256')
        if any(not isinstance(command.get(k),str) or not command[k] for k in required): return {'status':'not_sent','detail':'图片参数无效'}
        chat=self.chats.get(command['chatId'])
        if not chat or chat['bindingKey']!=command['bindingKey']: return {'status':'not_sent','detail':'目标群不在白名单'}
        try: data=base64.b64decode(command['data'],validate=True)
        except Exception: return {'status':'not_sent','detail':'图片编码无效'}
        if not 0<len(data)<=180000 or not data.startswith(b'\x89PNG\r\n\x1a\n') or hashlib.sha256(data).hexdigest()!=command['sha256']:
            return {'status':'not_sent','detail':'仅支持校验通过且不超过180KB的 PNG 图片'}
        context=hashlib.sha256(json.dumps({'chatId':chat['id'],'bindingKey':chat['bindingKey'],'sha256':command['sha256']},sort_keys=True).encode()).hexdigest()
        old=self.store.send_result(command['commandId'])
        if old:
            if self.store.send_context(command['commandId'])!=context:return {'status':'not_sent','detail':'发送ID与原图片或群聊不一致'}
            if old['status']=='executing':return {'status':'unknown','detail':'原发送仍在执行，禁止重发'}
            if old['status']!='not_sent':return old
        if chat['id'] in self.binding_errors or not self.adapter.status().get('connected'):return {'status':'not_sent','detail':'目标群未安全连接'}
        if not self.store.begin_send(command['commandId'],context):return self.store.send_result(command['commandId']) or {'status':'unknown'}
        try:
            result=self.adapter.send_image(chat['name'],data)
            status=result.get('status','unknown')
            if status not in {'sent','not_sent','unknown'}:status='unknown'
            detail=str(result.get('detail',''))
            self.store.finish_send(command['commandId'],status,detail)
            return {'status':status,'detail':detail}
        except Exception as exc:
            self.store.finish_send(command['commandId'],'unknown',f'图片操作结果需核查，禁止重发：{type(exc).__name__}')
            return self.store.send_result(command['commandId'])
