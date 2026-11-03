# 临时兼容租约仅在明确授权后运行；所有者退出或外部写入发生时终止维护，恢复责任交给独立守护进程。
"""Keep an explicitly authorized compatibility session active; no OS calls here."""
import time


def maintain_accessibility(read, enable, owner_alive, report,
                           clock=time.monotonic, sleep=time.sleep, max_repairs=30):
    repairs=[]
    total=0
    while owner_alive():
        value=read()
        if value not in (b'\x00',b'\x01'):
            raise RuntimeError('Unexpected accessibility flag value during lease')
        if value==b'\x00':
            # Recheck after reading: shutdown must never enable the flag again.
            if not owner_alive():return
            now=clock()
            repairs=[at for at in repairs if 0<=now-at<60]
            if len(repairs)>=max_repairs:
                raise RuntimeError('Accessibility flag repeatedly changed; refusing competing writers')
            # Caller rechecks the owner after validating the pinned module.
            if enable() is False:return
            repairs.append(now)
            total+=1
            report({'reactivations':total})
        sleep(.5)
