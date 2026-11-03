# 维护消息视觉证据与帧信息；证据变更后旧候选不可继续使用。
"""Experimental fail-closed avatar candidate detector; never clicks or identifies people."""
from collections import Counter

def avatar_candidates(image):
    image=image.convert('RGB');width,height=image.size
    if width<250 or height<50:return []
    bg=Counter(image.getdata()).most_common(1)[0][0]
    pixels=image.load();edge=min(width//5,200)
    spans=[]
    for start,end in ((0,edge),(width-edge,width)):
        columns=[]
        for x in range(start,end):
            ys=[y for y in range(height) if max(abs(pixels[x,y][k]-bg[k]) for k in range(3))>35]
            columns.append((x,ys) if len(ys)>=20 else (x,[]))
        active=[]
        # Dark hair/masks can leave several sparse columns inside one avatar.
        # Bridge only a bounded horizontal gap; the combined component must still
        # satisfy the existing square/size limits and global uniqueness check.
        for x,ys in [item for item in columns if item[1]]+[(end+13,[])]:
            if active and x-active[-1][0]>13:
                x1,x2=active[0][0],active[-1][0]+1
                ys_all=[y for _,values in active for y in values];y1,y2=min(ys_all),max(ys_all)+1
                w,h=x2-x1,y2-y1
                if 30<=w<=100 and 30<=h<=100 and .7<=w/h<=1.3:spans.append((x1,y1,x2,y2))
                active=[]
            if ys:active.append((x,ys))
    return spans if len(spans)==1 else []
