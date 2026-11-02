# -*- coding: utf-8 -*-
"""生成「我要报告」iOS 1024 图标 —— 与安卓同款：红底白圈印章风格。
改文字只需改 TEXT 后重跑（如 ICON_TEXT=举报 python _make_icon.py）。"""
import os
from PIL import Image, ImageDraw, ImageFont

TEXT = os.environ.get('ICON_TEXT', '报告')      # 图标中间文字
BG   = (202, 66, 66, 255)                       # 红底 #CA4242
RING = (255, 255, 255, 255)                     # 白环/白字
FONT_PATH = 'C:/Windows/Fonts/msyhbd.ttc'       # 微软雅黑 Bold
OUT = os.path.join(os.path.dirname(__file__),
                   'ios/Assets.xcassets/AppIcon.appiconset/icon1024.png')


def make(size, path):
    S = size
    pad = round(S * 4 / 192) if S >= 96 else 1
    box = S - pad * 2
    corner = round(box * 40 / 184)
    ring_r = round(S * 62 / 192)
    ring_w = max(2, round(S * 8 / 192))

    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([pad, pad, pad + box - 1, pad + box - 1],
                        radius=corner, fill=BG)
    d.ellipse([S / 2 - ring_r, S / 2 - ring_r, S / 2 + ring_r, S / 2 + ring_r],
              outline=RING, width=ring_w)

    inner = ring_r - ring_w / 2 - ring_w * 0.35
    fs = round(S * 46 / 192)
    font = ImageFont.truetype(FONT_PATH, fs)
    chars = list(TEXT)
    widths = [d.textlength(c, font=font) for c in chars]
    gap = round(S * 4 / 192)
    total = sum(widths) + gap * (len(chars) - 1)
    safe = inner * 1.62
    if total > safe:
        fs = max(8, int(fs * safe / total))
        font = ImageFont.truetype(FONT_PATH, fs)
        widths = [d.textlength(c, font=font) for c in chars]
        gap = round(S * 4 / 192)
        total = sum(widths) + gap * (len(chars) - 1)

    x = S / 2 - total / 2
    for c, w in zip(chars, widths):
        d.text((x + w / 2, S / 2), c, font=font, fill=RING, anchor='mm')
        x += w + gap

    img.save(path)
    print('saved %s (%dx%d, text=%s, fontsize=%d)' % (path, S, S, TEXT, fs))


if __name__ == '__main__':
    make(1024, OUT)
