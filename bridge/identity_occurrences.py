# 对齐消息出现次数；重复文字可属于不同事件，不能简单按正文去重。
"""Short-lived, in-memory message-location registry; never an identity credential."""
from copy import deepcopy
from time import monotonic
from identity_preflight import select_unique_observation,select_current_row,validate_observation

class OccurrenceRegistry:
    def __init__(self,clock=monotonic,ttl=10,max_entries=500):
        self.clock=clock;self.ttl=ttl;self.max_entries=max_entries;self.entries={}
    def clear(self):self.entries.clear()
    def bind(self,event_id,observation):
        if not isinstance(event_id,str) or not event_id or validate_observation(observation,observation)['status']!='current':return False
        now=self.clock();self.entries={key:value for key,value in self.entries.items() if 0<=now-value[0]<=self.ttl}
        if event_id in self.entries:return False
        if len(self.entries)>=self.max_entries:return False
        self.entries[event_id]=(now,deepcopy(observation));return True
    def resolve(self,event_id,chat_id,session_id,observations,name_probe=False):
        item=self.entries.get(event_id)
        if not item:return {'status':'unknown','reason':'没有有效的消息定位'}
        created,expected=item;age=self.clock()-created
        if age<0 or age>self.ttl:
            self.entries.pop(event_id,None);return {'status':'unknown','reason':'消息定位已过期'}
        if expected['chatId']!=chat_id or expected['sessionId']!=session_id:return {'status':'unknown','reason':'群聊或桥接会话已变化'}
        if name_probe:
            result=select_current_row(expected,observations)
        else:result=select_unique_observation(expected,observations)
        return {'status':'current','observation':deepcopy(expected)} if result['status']=='current' else result
