# Judges for the agent-radar gauntlet: eight original robed judges, each in a powdered wig of their own cut, a robe
# colour and one signature thing (spectacles, monocle, side whiskers, a gold chain, a quill ...).
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chibi, chibi_studio as cs
import chibi_gladiators as cg
from chibi import W, H, put, stamp, rowset, hair, SKIN_ROWS, font, chip, paint
from chibi_gladiators import half, clear_hair

ROBE = {18: '.....cCCCW', 19: '....ccCCCW', 20: '...ccCCCCW', 21: '...ccCCCCC', 22: '..ccSSCCCC', 23: '..ccSSCCCC'}

def legs_j(g, pose):
    cs.legs(g, pose)
    for y in range(24, 28):
        for x in range(W):
            if g[y][x] == 'P': g[y][x] = 'C'
            elif g[y][x] in ('F', 'f'): g[y][x] = 'k'
    for x in range(5, 15):
        for y in (24, 25): put(g, x, y, 'c' if x in (7, 12) else 'C')
    for x in (4, 15): put(g, x, 25, 'c')

# ---- wigs: drawn on a bald head; the list is the left half from the outer edge to the centre -----------------------
def curls(g, y0, y1, width=4):
    for y in range(y0, y1 + 1):
        half(g, {y: ('HhHH' if (y - y0) % 2 == 0 else 'hHHh')[:width] + '.' * (10 - width)})

def wig_full(g):    # the full-bottomed wig: a high dome, a parting, curls that fall to the shoulder
    half(g, {0: 'HHHH', 1: 'HHHHHH', 2: 'HHwHHHHH', 3: 'HHHwHHHHH', 4: 'HHHHhHHHHH'[1:], 5: 'HHHHHHHHH', 6: 'HHHHHHHH.', 7: 'HhHHHHH..'})
    curls(g, 8, 17)
    half(g, {18: '.HHh......', 19: '..Hh......'})

def wig_barrister(g):   # a short barrister's wig: a neat dome and two rolled curls on each side
    half(g, {1: 'HHHH', 2: 'HHwHHH', 3: 'HHHwHHH'[0:], 4: 'HHHHHHHH', 5: 'HHHHHHHH', 6: 'HHHhHHH.', 7: '.HHHHHh.'})
    half(g, {8: '.HHH......', 9: '.HhH......', 11: '.HHH......', 12: '.HhH......'})

def wig_bob(g):     # a smooth bob wig with the ends turned in
    half(g, {1: 'HHHHH', 2: 'HHwHHHH', 3: 'HHHwHHHH', 4: 'HHHHHHHHH', 5: 'HHHHHHHHH', 6: 'HHHHHHHH.', 7: 'HHhHHHH..'})
    for y in range(8, 15): half(g, {y: '.HHH......'})
    half(g, {15: '.HhHH.....', 16: '..HHh.....'})

def wig_queue(g):   # a dome wig with a ponytail tied in a black bow, swung over the right shoulder
    half(g, {1: 'HHHH', 2: 'HHwHHH', 3: 'HHHwHHH', 4: 'HHHHHHHH', 5: 'HHHHHHHHH', 6: 'HHHHHHH.', 7: '.HHHHh..'})
    for y in range(8, 20): put(g, 18, y, 'H'); put(g, 19, y, 'h')
    for x, y in ((18, 12), (19, 12), (17, 12), (18, 13)): put(g, x, y, 'k')
    for x, y in ((18, 20), (19, 21), (18, 21)): put(g, x, y, 'h')

def wig_tall(g):    # a tall pompadour wig, two rolls high, short curls at the sides
    half(g, {0: 'HH', 1: 'HHHH', 2: 'HwHHHH', 3: 'HHwHHHHH', 4: 'HHHHHHHHH', 5: 'HHHhHHHHH', 6: 'HHHHHHH.', 7: '.HHHHh..'})
    half(g, {8: '.HHH......', 9: '.HhH......', 10: '..HH......', 11: '..Hh......'})

def wig_twin(g):    # a wig with a big round curl at each side
    half(g, {1: 'HHHH', 2: 'HHwHHH', 3: 'HHHwHHH', 4: 'HHHHHHHH', 5: 'HHHHHHHHH', 6: 'HHHHHHH.', 7: '.HHHhH..'})
    half(g, {9: '..HHH.....', 10: '.HHwHH....', 11: '.HHHHH....', 12: '.HhHHH....', 13: '..HHH.....'})

def wig_grand(g):   # the grandest: tall, wide, with a curled crown and side curls to the shoulder
    half(g, {0: 'HHhH', 1: 'HHHHHH', 2: 'HHwHHHHH', 3: 'HHHwHHHHH', 4: 'HHHHhHHHH', 5: 'HHHHHHHHH', 6: 'HHHHHHHH.', 7: 'HhHHHHH..'})
    curls(g, 8, 15, 3)
    half(g, {16: '.HHh......'})

def wig_rolls(g):   # three rolled curls a side, in horizontal rows: the classic judge's wig
    half(g, {1: 'HHHH', 2: 'HHwHHH', 3: 'HHHwHHH', 4: 'HHHHHHHH', 5: 'HHHHHHHHH', 6: 'HHHHHHH.', 7: '.HHHHh..'})
    half(g, {8: '.HHHH.....', 9: '.hhhh.....', 10: '.HHHH.....', 11: '.hhhh.....', 12: '.HHHH.....', 13: '.hhhh.....'})

WIGS = [wig_full, wig_barrister, wig_bob, wig_queue, wig_tall, wig_twin, wig_grand, wig_rolls]

def ring(g, ex, ch):
    for x, y in ((ex + 1, 10), (ex + 2, 10), (ex, 11), (ex, 12), (ex, 13), (ex, 14), (ex + 3, 11), (ex + 3, 12), (ex + 3, 13), (ex + 3, 14), (ex + 1, 15), (ex + 2, 15)): put(g, x, y, ch)

def extras(g, kind, mood):
    dx = 1 if mood == 'work' else 0
    if kind == 'spectacles':
        ring(g, 5 + dx, 'A'); ring(g, 11 + dx, 'A')
        for x in (9 + dx, 10 + dx): put(g, x, 12, 'A')
    if kind == 'monocle':
        ring(g, 11 + dx, 'A')
        for y in range(15, 20): put(g, 14 + dx if y < 17 else 15, y, 'A')
    if kind == 'pincenez':
        ring(g, 5 + dx, 'Z'); ring(g, 11 + dx, 'Z')
        for x in (9 + dx, 10 + dx): put(g, x, 12, 'Z')
    if kind == 'whiskers':
        for y in range(11, 17):
            for x in (3, 4, 15, 16): put(g, x, y, 'H' if (x + y) % 2 == 0 else 'h')
    if kind == 'brows':
        for x in (5, 6, 7, 8, 11, 12, 13, 14): put(g, x, 10, 'W')
        for x in (6, 7, 12, 13): put(g, x, 9, 'w')
    if kind == 'chain':
        for x, y in ((7, 19), (8, 20), (9, 21), (10, 21), (11, 20), (12, 19)): put(g, x, y, 'A')
    if kind == 'ermine':
        for y in range(18, 26):
            for x in (8, 9, 10, 11): put(g, x, y, 'W')
        for x, y in ((8, 19), (11, 21), (9, 23), (10, 25)): put(g, x, y, 'k')

HELD_J = {
    'gavel':  [(16, 17, 'K'), (17, 17, 'K'), (18, 17, 'k'), (16, 18, 'K'), (17, 18, 'y'), (18, 18, 'k')] + [(17, y, 'Y') for y in range(19, 25)],
    'scroll': [(16, 19, 'y'), (17, 19, 'y'), (18, 19, 'y')] + [(x, y, 'W') for y in range(20, 25) for x in (16, 17, 18)] + [(16, 25, 'y'), (17, 25, 'y'), (18, 25, 'y'), (17, 22, 'A')],
    'scales': [(15, 17, 'K'), (16, 17, 'K'), (17, 17, 'K'), (18, 17, 'K'), (19, 17, 'K'), (15, 18, 'k'), (19, 18, 'k'), (15, 19, 'K'), (16, 19, 'K'), (18, 19, 'K'), (19, 19, 'K')] + [(17, y, 'k') for y in range(18, 25)],
    'quill':  [(18, 15, 'W'), (18, 16, 'W'), (17, 16, 'W'), (17, 17, 'W'), (17, 18, 'w'), (16, 18, 'W'), (16, 19, 'Z'), (16, 20, 'Z'), (16, 21, 'k'), (15, 22, 'k')],
    'book':   [(x, y, 'A') for y in range(19, 25) for x in (16, 17)] + [(18, y, 'W') for y in range(19, 25)] + [(17, 21, 'y'), (17, 22, 'y')],
    'stamp':  [(16, 20, 'k'), (17, 20, 'k'), (18, 20, 'k'), (17, 21, 'Y'), (17, 22, 'Y'), (16, 23, 'K'), (17, 23, 'K'), (18, 23, 'K'), (16, 24, 'A'), (17, 24, 'A'), (18, 24, 'A')],
    'bell':   [(17, 18, 'K'), (17, 19, 'K'), (16, 20, 'K'), (17, 20, 'y'), (18, 20, 'K'), (16, 21, 'K'), (17, 21, 'K'), (18, 21, 'K'), (16, 22, 'k'), (17, 22, 'k'), (18, 22, 'k'), (17, 23, 'A')],
    'card':   [(x, y, 'W') for y in range(19, 25) for x in (16, 17, 18)] + [(16, 22, 'A'), (17, 23, 'A'), (18, 21, 'A'), (18, 20, 'A')],
}

def build_j(look, mood='normal', pose='stand'):
    g = [[None] * W for _ in range(H)]
    for y, (x0, x1) in SKIN_ROWS.items():
        for x in range(x0, x1 + 1): g[y][x] = 'S'
    for x in range(6, 14): g[17][x] = 's' if g[17][x] else g[17][x]
    hair(g, 'bob')
    clear_hair(g)
    chibi.eyes(g, mood)
    cs.face_quirks(g, look.get('quirks', []), mood)
    WIGS[look['wig']](g)
    for kind in look.get('extras', []): extras(g, kind, mood)
    rowset(g, ROBE)
    legs_j(g, pose)
    extras(g, 'ermine', mood) if 'ermine' in look.get('extras', []) else None
    if look.get('held'):
        for x, y, c in HELD_J[look['held']]: put(g, x, y, c)
    return g

JUDGES = [
    dict(wig=0, name='Gavel', hair='#f4f1ea', eye='#3b82f6', skin='#ffe6d5', outfit='#1f1d2b', accent='#d9a441', kit='#2a2630', pants='#1f1d2b', held='gavel', quirks=['smirk'], extras=[]),
    dict(wig=1, name='Writ', hair='#dcd9e6', eye='#a855f7', skin='#ecb891', outfit='#1f2f5a', accent='#c28a2b', kit='#2a2630', pants='#1f2f5a', held='scroll', quirks=['flat'], extras=['spectacles']),
    dict(wig=2, name='Scales', hair='#ece2d0', eye='#10b8d8', skin='#f9d2b6', outfit='#a8202a', accent='#d9a441', kit='#2a2630', pants='#a8202a', held='scales', quirks=['sparkle'], extras=['monocle', 'ermine']),
    dict(wig=3, name='Quill', hair='#e8e8f0', eye='#f59e0b', skin='#c98e63', outfit='#4a2f7a', accent='#d9a441', kit='#2a2630', pants='#4a2f7a', held='quill', quirks=['tired'], extras=[]),
    dict(wig=4, name='Statute', hair='#c9c4d6', eye='#10b981', skin='#8f5b3a', outfit='#1f5a3a', accent='#e3c27a', kit='#2a2630', pants='#1f5a3a', held='book', quirks=['halflid', 'smirk'], extras=[]),
    dict(wig=7, name='Seal', hair='#d8d8d8', eye='#ef4444', skin='#e9b98f', outfit='#6a1f3a', accent='#c28a2b', kit='#2a2630', pants='#6a1f3a', held='stamp', quirks=['flat'], extras=['whiskers', 'pincenez']),
    dict(wig=5, name='Bell', hair='#f2eee8', eye='#ec4899', skin='#ffe6d5', outfit='#1f3a3a', accent='#d9a441', kit='#2a2630', pants='#1f3a3a', held='bell', quirks=['open'], extras=[]),
    dict(wig=6, name='Docket', hair='#f7f7fa', eye='#06b6d4', skin='#d9a273', outfit='#2a2f45', accent='#e9c46a', kit='#2a2630', pants='#2a2f45', held='card', quirks=['sharp'], extras=['brows', 'chain', 'ermine']),
]

def pal_j(look, dim=False): return cs.pal(look, dim)

def board_j(name='17-judges.png', scale=8):
    from PIL import Image, ImageDraw
    cw, ch = W * scale + 14, H * scale + 52
    img = Image.new('RGB', (4 * cw + 20, 34 + 2 * ch + 4), (70, 62, 84)); d = ImageDraw.Draw(img)
    d.text((14, 8), 'gauntlet judges (original characters)', fill=(255, 240, 220), font=font(15))
    for k, look in enumerate(JUDGES):
        ox, oy = 10 + (k % 4) * cw, 34 + (k // 4) * ch
        d.rectangle([ox, oy, ox + cw - 6, oy + ch - 6], fill=(150, 142, 170))
        paint(build_j(look), pal_j(look), scale, ox + 7, oy + 6, img)
        chip(d, ox + 8, oy + H * scale + 8, f"Judge {k + 1}", font(12))
        d.text((ox + 8, oy + H * scale + 30), look['name'], fill=(30, 24, 44), font=font(11))
    img.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), name))

if __name__ == '__main__':
    board_j(); print('ok')
