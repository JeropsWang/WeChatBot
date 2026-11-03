# 将当前消息观察绑定到稳定事件，避免异步识别结果关联到新出现的消息。
"""Experimental, in-memory association of newly observed messages with UI evidence.

The caller must supply observations from the same UI worker and a second fresh
snapshot. This module cannot open windows, click, identify members, or persist data.
"""
import hashlib
from store import reconcile
from identity_preflight import select_unique_observation,select_current_row,validate_observation

def bind_new_observations(registry,chat_id,session_id,previous,current,evidence,after,event_ids,self_indices=(),diagnostics=None,name_probe=False):
    if not isinstance(event_ids,list) or any(not isinstance(x,str) or not x for x in event_ids) or len(set(event_ids))!=len(event_ids):return {}
    failed={event_id:False for event_id in event_ids}
    def reason(event_id,code):
        if diagnostics is not None:diagnostics[event_id]=code
    for event_id in event_ids:reason(event_id,'snapshot_alignment_failed')
    if not isinstance(previous,list) or not previous or not isinstance(current,list) or not isinstance(evidence,list) or len(evidence)!=len(current):return failed
    added,gap=reconcile(previous,current)
    if gap or not added:return failed
    start=len(current)-len(added)
    indices=[i for i in range(start,len(current)) if isinstance(current[i],dict) and current[i].get('kind')=='message' and isinstance(current[i].get('name'),str) and current[i]['name'].strip()]
    if len(indices)!=len(event_ids) or any(i in self_indices for i in indices):return failed
    for event_id,index in zip(event_ids,indices):
        obs=evidence[index]
        reason(event_id,'event_evidence_missing')
        if not isinstance(obs,dict) or obs.get('chatId')!=chat_id or obs.get('sessionId')!=session_id:continue
        if obs.get('textHash')!=hashlib.sha256(current[index]['name'].encode()).hexdigest():continue
        if name_probe:
            reason(event_id,'target_changed')
            if select_current_row(obs,after)['status']!='current':continue
            reason(event_id,'registry_rejected')
            failed[event_id]=registry.bind(event_id,obs)
            if failed[event_id] and diagnostics is not None:diagnostics.pop(event_id,None)
            continue
        # Every visually identical message in this snapshot must have matching
        # evidence; omitting an older row must not manufacture uniqueness.
        peers=[i for i,item in enumerate(current) if isinstance(item,dict) and item.get('kind')=='message' and item.get('name')==current[index]['name']]
        reason(event_id,'peer_evidence_missing')
        if any(not isinstance(evidence[i],dict) or evidence[i].get('chatId')!=chat_id or evidence[i].get('sessionId')!=session_id or evidence[i].get('textHash')!=obs['textHash'] for i in peers):continue
        reason(event_id,'peer_changed')
        if not isinstance(after,list) or any(sum(validate_observation(evidence[i],row)['status']=='current' for row in after)!=1 for i in peers):continue
        reason(event_id,'target_ambiguous')
        if select_unique_observation(obs,after)['status']!='current':continue
        reason(event_id,'registry_rejected')
        failed[event_id]=registry.bind(event_id,obs)
        if failed[event_id] and diagnostics is not None:diagnostics.pop(event_id,None)
    return failed
