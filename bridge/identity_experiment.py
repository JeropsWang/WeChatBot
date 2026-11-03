# 一次资料卡探测的可取消检查流程。点击可能发生后不能盲目重试，候选身份仍需上层根据证据验证。
"""Experimental click coordination. Results are candidates, never verified identities."""
from identity_preflight import select_unique_observation,select_current_row

def run_identity_probe(driver,candidate,name_probe=False,production=False):
    select=select_current_row if name_probe else select_unique_observation
    clicked=False
    def unknown(reason,code,retryable=False):
        result={'status':'unknown','reason':reason}
        if production:result.update(reasonCode=code,clicked=clicked,retryable=retryable and not clicked)
        return result
    try:
        if driver.has_draft() or driver.has_profile_popup():return unknown('存在草稿或资料卡','draft_or_popup')
        if select(candidate,driver.observations())['status']!='current':return unknown('目标消息不唯一或已变化','target_changed')
        if not driver.target_hit_is_current(candidate):
            reason=getattr(driver,'hit_reason','头像位置未通过窗口与消息命中校验')
            return unknown(reason,reason,reason=='foreground_unavailable')
        if driver.has_draft() or driver.has_profile_popup() or select(candidate,driver.observations())['status']!='current':
            return unknown('点击前状态已变化','target_changed')
        # Once invocation starts, conservatively treat even an exception as possibly clicked.
        clicked=True
        driver.click_avatar(candidate)
        try:name=driver.read_new_profile()
        finally:
            close=getattr(driver,'close_new_profile',None)
            if callable(close):
                try:close()
                except Exception:pass
        if not isinstance(name,str) or not name.strip() or len(name)>200:return unknown('未读取到唯一名称','name_unavailable')
        return {'status':'candidate','name':name.strip()}
    except Exception:
        return unknown('界面检查或资料卡读取失败','probe_error')
