# 资料卡打开前检查目标唯一性、草稿及窗口状态，任何歧义都返回未知。
"""Fail-closed comparison of ephemeral UI observations, not identity verification."""
import re


def validate_observation(candidate, current):
    """比较会话、控件 runtimeId、矩形及图像/文字摘要，确认候选仍指向同一可见行。
    这些值是短期定位证据而非成员身份；缺字段、非正矩形、非 SHA-256 或任何变化都返回 unknown。
    """
    fields = ('chatId', 'sessionId', 'runtimeId', 'rect', 'imageHash', 'textHash', 'visible')

    def well_formed(value):
        if not isinstance(value, dict) or any(k not in value for k in fields):
            return False
        if not all(isinstance(value[k], str) and value[k] for k in ('chatId', 'sessionId')):
            return False
        if (
            not isinstance(value['runtimeId'], list)
            or not value['runtimeId']
            or not all(isinstance(x, int) for x in value['runtimeId'])
        ):
            return False
        rect = value['rect']
        if (
            not isinstance(rect, list)
            or len(rect) != 4
            or not all(isinstance(x, int) for x in rect)
            or rect[0] >= rect[2]
            or rect[1] >= rect[3]
        ):
            return False
        if any(
            not isinstance(value[k], str) or not re.fullmatch(r'[a-f0-9]{64}', value[k])
            for k in ('imageHash', 'textHash')
        ):
            return False
        return value['visible'] is True

    if not well_formed(candidate) or not well_formed(current):
        return {'status': 'unknown', 'reason': '消息不完整或不可见'}
    if any(candidate[k] != current[k] for k in fields):
        return {'status': 'unknown', 'reason': '消息或窗口已变化'}
    return {'status': 'current'}


def select_unique_observation(candidate, observations):
    """要求目标行唯一，且不存在无法区分的同头像同文字行。
    重复 runtimeId 或不完整观察会使整次选择失败，不能从多个候选中取第一个。
    """
    if (
        not isinstance(observations, list)
        or validate_observation(candidate, candidate)['status'] != 'current'
    ):
        return {'status': 'unknown', 'reason': '定位信息不完整'}
    if any(
        not isinstance(row, dict) or validate_observation(row, row)['status'] != 'current'
        for row in observations
    ):
        return {'status': 'unknown', 'reason': '可见消息观察不完整'}
    comparable = [
        row
        for row in observations
        if row['chatId'] == candidate['chatId'] and row['sessionId'] == candidate['sessionId']
    ]
    runtime_ids = [tuple(row['runtimeId']) for row in comparable]
    if len(runtime_ids) != len(set(runtime_ids)):
        return {'status': 'unknown', 'reason': '界面控件标识重复'}
    if sum(validate_observation(candidate, row)['status'] == 'current' for row in comparable) != 1:
        return {'status': 'unknown', 'reason': '目标消息不唯一或已变化'}
    if (
        sum(
            row['textHash'] == candidate['textHash'] and row['imageHash'] == candidate['imageHash']
            for row in comparable
        )
        != 1
    ):
        return {'status': 'unknown', 'reason': '相同文字和头像无法区分'}
    return {'status': 'current'}


def select_current_row(candidate, observations):
    """确认候选在当前会话中仍唯一存在；不要求同头像消息只出现一次。
    它校验的是消息行定位，不能据此将头像外观绑定为永久用户身份。
    """
    if (
        not isinstance(observations, list)
        or validate_observation(candidate, candidate)['status'] != 'current'
    ):
        return {'status': 'unknown', 'reason': '定位信息不完整'}
    if any(validate_observation(row, row)['status'] != 'current' for row in observations):
        return {'status': 'unknown', 'reason': '可见消息观察不完整'}
    rows = [
        row
        for row in observations
        if row['chatId'] == candidate['chatId'] and row['sessionId'] == candidate['sessionId']
    ]
    ids = [tuple(row['runtimeId']) for row in rows]
    if (
        len(ids) != len(set(ids))
        or sum(validate_observation(candidate, row)['status'] == 'current' for row in rows) != 1
    ):
        return {'status': 'unknown', 'reason': '消息或窗口已变化'}
    return {'status': 'current'}
