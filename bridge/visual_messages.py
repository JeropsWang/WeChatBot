# 解析可见消息行的受限信息，未知控件保持未知，不凭邻近元素猜测发送者。
"""Classify only proven WeChat visual rows, never text by its wording alone."""
IMAGE_CLASS='mmui::ChatImageItemView'
ANIMATION_CLASSES=frozenset(('mmui::ChatBubbleReferItemView','mmui::ChatBubbleItemView'))
ANIMATION_NAMES=frozenset(('动画表情','[动画表情]'))

def visual_kind(class_name,name):
    if class_name==IMAGE_CLASS:return 'image'
    if class_name in ANIMATION_CLASSES and (name or '').strip() in ANIMATION_NAMES:return 'animated-sticker'
    return None

def visual_marker(kind):return '[动画表情]' if kind=='animated-sticker' else '[图片]'

def matches_visual_marker(class_name,name,marker):
    kind=visual_kind(class_name,name)
    return bool(kind and marker==visual_marker(kind))
