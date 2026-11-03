# 临时兼容租约仅在明确授权后运行；所有者退出或外部写入发生时终止维护，恢复责任交给独立守护进程。
"""Keep an explicitly authorized compatibility session active; no OS calls here."""
import time


def maintain_accessibility(
    read, enable, owner_alive, report, clock=time.monotonic, sleep=time.sleep, max_repairs=30
):
    """维护已获本次授权的临时无障碍标志；具体进程读写由回调实现，本函数不直接调用操作系统。
    只接受单字节 0/1；重新启用前复查所有者仍存活。每分钟最多 max_repairs 次修复，拒绝与其他写入者无限竞争。
    使用单调时钟计算滑动窗口；退出/异常的恢复责任属于外层独立守护进程，不由此循环猜测原值。
    """
    repairs = []
    total = 0
    while owner_alive():
        value = read()
        if value not in (b'\x00', b'\x01'):
            raise RuntimeError('Unexpected accessibility flag value during lease')
        if value == b'\x00':
            # Recheck after reading: shutdown must never enable the flag again.
            if not owner_alive():
                return
            now = clock()
            repairs = [at for at in repairs if 0 <= now - at < 60]
            if len(repairs) >= max_repairs:
                raise RuntimeError(
                    'Accessibility flag repeatedly changed; refusing competing writers'
                )
            # Caller rechecks the owner after validating the pinned module.
            if enable() is False:
                return
            repairs.append(now)
            total += 1
            report({'reactivations': total})
        sleep(0.5)
