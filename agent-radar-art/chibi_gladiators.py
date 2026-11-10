# Gladiators for the agent-radar gauntlet: eight original arena fighters, one per competitor letter. Same 20x28 grid,
# soft S4 faces and automatic outline as the studio crew; sleeveless cuirass, pteruges skirt, sandals, and one
# classic gladiator kit each (murmillo, retiarius, thraex, secutor, hoplomachus, provocator, eques, dimachaerus).
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chibi, chibi_studio as cs
from chibi import W, H, put, stamp, rowset, hair, swoosh, SKIN_ROWS, blend, font, chip, paint

def R(s):
    assert len(s) == 20, (len(s), s)
    return s

def rows20(g, items):
    for y, row in items:
        for x, ch in enumerate(R(row)): put(g, x, y, ch)

def mir(g, pts):
    """Points given for the left half, drawn on both sides: (x, y, ch)."""
    for x, y, c in pts:
        put(g, x, y, c); put(g, 19 - x, y, c)

# torso rows 18-23, left halves: S bare arms, K bronze cuirass, k its shade, y its shine, C tunic
CUIRASS = {18: '.......kKK', 19: '....SSkKyK', 20: '....SSkKKK', 21: '....KKkKKK', 22: '....KKkkkk', 23: '....SSCCCC'}

def legs_g(g, pose, greave=False):
    cs.legs(g, pose)
    for y in range(24, 28):
        for x in range(W):
            if g[y][x] == 'P': g[y][x] = 'S'
            elif g[y][x] == 'F': g[y][x] = 'Y'
            elif g[y][x] == 'f': g[y][x] = 'y'
    if greave:
        for x, y in ((7, 25), (8, 25), (7, 24), (8, 24)): 
            if g[y][x] == 'S': g[y][x] = 'K'
    # the tunic's pteruges: leather strips that hang to the knee
    for x in range(5, 15): put(g, x, 23, 'C')
    for x in (5, 6, 13, 14): put(g, x, 24, 'c')
    for x in (6, 8, 11, 13): put(g, x, 24, 'c') if g[24][x] is None else None

# ---- head gear -------------------------------------------------------------------------------------------------
def half(g, rows):
    """Rows as the left half only, written from the outer edge to the centre (so the last character is column 9);
    shorter strings are padded on the outside. The right half mirrors it."""
    for y, content in rows.items():
        left = content.rjust(10, '.')
        assert len(left) == 10, (y, content)
        for x, ch in enumerate(left):
            put(g, x, y, ch); put(g, 19 - x, y, ch)

def clear_hair(g):
    """Bald base: the wig or helmet is drawn on a bare head."""
    for y in range(H):
        for x in range(W):
            if g[y][x] in ('h', 'H', 'w'):
                g[y][x] = 'S' if (y in SKIN_ROWS and SKIN_ROWS[y][0] <= x <= SKIN_ROWS[y][1]) else None

def clear_fringe(g):
    for y in (6, 7, 8, 9):
        for x in range(3, 17):
            if g[y][x] in ('h', 'H', 'w'): g[y][x] = 'S'

def murmillo(g):    # a bronze dome with a brim, cheek guards and a tall blue fin crest
    clear_fringe(g)
    half(g, {0: 'A', 1: 'A', 2: 'kkkkA', 3: 'kKKKKA', 4: 'kKKyyKA', 5: 'kKKKKKKA', 6: 'kkkkkkkk', 7: 'kK', 8: 'kK', 9: 'kK', 10: '.K', 11: '.k'})
    for y in (7, 8, 9, 10, 11):          # the cheek guards only: leave the face between them open
        for x in range(4, 10): 
            if g[y][x] in ('k', 'K') : g[y][x] = 'S' if y > 6 else g[y][x]

def retiarius(g):   # no helmet: a gold headband, a swinging ponytail and a big bronze shoulder guard on the left
    half(g, {5: 'AAAAAy', 6: 'aaaaaa'})
    for y in range(9, 19): put(g, 18, y, 'H'); put(g, 19, y, 'h')
    for y, row in ((15, '.kKKKk.'), (16, 'kKyKKKk'), (17, 'kKKKKKKk'), (18, 'kKyKKKk'), (19, '.kKKKk.')):
        for dx, ch in enumerate(row): put(g, dx, y, ch)

def thraex(g):      # a visored helmet topped by a swept plume, small wing tips at the sides
    clear_fringe(g)
    half(g, {0: 'AAAA', 1: 'aAAAAA', 2: 'kkkkkA', 3: 'kKKKKKA', 4: 'kKKyyKKA', 5: 'kKKKKKKK', 6: 'kkkkkkkk', 7: 'kK', 8: 'kK', 9: 'k'})
    for x, y in ((1, 3), (0, 2), (1, 2), (0, 3), (18, 3), (19, 2), (18, 2), (19, 3)): put(g, x, y, 'A')

def secutor(g):     # a smooth steel egg of a helmet, one red stripe, eye holes kept clear below
    clear_fringe(g)
    half(g, {1: 'kkkkk', 2: 'kZZZZZ', 3: 'kZZZZZZ', 4: 'kZZZZZZZ', 5: 'kZZZZZZZ', 6: 'kZZZZZZZ', 7: 'kZZ', 8: 'kZ', 9: 'k'})
    for y in range(1, 7): put(g, 9, y, 'A'); put(g, 10, y, 'A')
    for x, y in ((5, 3), (6, 3), (5, 4), (4, 5)): put(g, x, y, 'z')

def hoplomachus(g): # a tall red feather plume over a round bronze helm
    clear_fringe(g)
    half(g, {0: 'AAAA', 1: 'AAaAAA', 2: 'kKKAAAA'[1:], 3: 'kKKKKA', 4: 'kKKyyKKA', 5: 'kKKKKKKK', 6: 'kkkkkkkk', 7: 'kK', 8: 'kK', 9: 'k'})
    for x, y in ((8, 0), (11, 0), (7, 1), (12, 1)): put(g, x, y, 'W')

def provocator(g):  # a crested helm with side feathers and a raised visor ledge
    clear_fringe(g)
    half(g, {1: 'k', 2: 'AAAkkk', 3: 'AAKKkkk', 4: 'AaKKyyKK', 5: 'kKKKKKKK', 6: 'kkKKKKKK', 7: 'kK', 8: 'kK', 9: 'k'})
    for y in range(3, 7): put(g, 1, y, 'A'); put(g, 18, y, 'A')
    for x in range(5, 15): put(g, x, 7, 'k')

def eques(g):       # a feathered wide-brim helmet with two upright feathers, a flowing red cape behind
    clear_fringe(g)
    half(g, {0: 'A', 1: 'AA', 2: 'kkAAkkk', 3: 'kKKKKKKK', 4: 'kKKyyKKK', 5: 'kKKKKKKK', 6: 'kkkkkkkk', 7: 'kK', 8: 'k', 9: 'k'})
    for x in (6, 13): put(g, x, 0, 'A')
    for y in range(16, 26):
        for x in (1, 2, 17, 18): put(g, x, y, 'A' if x in (2, 17) else 'a')

def dimachaerus(g): # a red headband with wild hair, two short swords crossed on the back
    half(g, {4: 'AA.....', 5: 'AAAAAAAA'}) if False else None
    for x in range(3, 17): put(g, x, 5, 'A')
    for x, y in ((3, 4), (4, 4), (15, 4), (16, 4), (16, 6), (17, 7), (18, 8), (19, 9)): put(g, x, y, 'A')
    for x, y, c in ((4, 14, 'K'), (3, 13, 'z'), (2, 12, 'z'), (1, 11, 'z'), (15, 14, 'K'), (16, 13, 'z'), (17, 12, 'z'), (18, 11, 'z')): put(g, x, y, c)
    for x, y in ((3, 15), (4, 15), (15, 15), (16, 15)): put(g, x, y, 'k')

HEADS = [murmillo, retiarius, thraex, secutor, hoplomachus, provocator, eques, dimachaerus]

# what each carries in the right hand (cols 16-18) and, for shields, on the left (cols 0-3)
HELD_G = {
    'gladius': [(17, 14, 'z'), (17, 15, 'z'), (17, 16, 'z'), (17, 17, 'z'), (17, 18, 'z'), (17, 19, 'z'), (17, 20, 'z'), (17, 21, 'z'), (16, 22, 'K'), (17, 22, 'K'), (18, 22, 'K'), (17, 23, 'k')],
    'trident': [(17, 10, 'z'), (16, 10, 'z'), (18, 10, 'z'), (16, 11, 'z'), (18, 11, 'z'), (17, 11, 'z'), (17, 12, 'Y'), (17, 13, 'Y'), (17, 14, 'Y'), (17, 15, 'Y'), (17, 16, 'Y'), (17, 17, 'Y'), (17, 18, 'Y'), (17, 19, 'Y'), (17, 20, 'Y'), (17, 21, 'Y'), (17, 22, 'Y'), (17, 23, 'Y'), (17, 24, 'Y'), (17, 25, 'Y')],
    'sica': [(18, 15, 'z'), (18, 16, 'z'), (17, 17, 'z'), (17, 18, 'z'), (17, 19, 'z'), (16, 20, 'z'), (16, 21, 'K'), (17, 22, 'K'), (16, 22, 'k')],
    'spear': [(17, 6, 'z'), (17, 7, 'z'), (17, 8, 'Z')] + [(17, y, 'Y') for y in range(9, 26)],
    'twin': [(17, 15, 'z'), (17, 16, 'z'), (17, 17, 'z'), (17, 18, 'z'), (17, 19, 'z'), (17, 20, 'z'), (16, 21, 'K'), (17, 21, 'K'), (18, 21, 'K'),
             (2, 15, 'z'), (2, 16, 'z'), (2, 17, 'z'), (2, 18, 'z'), (2, 19, 'z'), (2, 20, 'z'), (1, 21, 'K'), (2, 21, 'K'), (3, 21, 'K')],
    'club': [(17, 17, 'Y'), (17, 18, 'Y'), (18, 18, 'k'), (17, 19, 'Y'), (17, 20, 'Y'), (17, 21, 'Y'), (17, 22, 'Y'), (16, 23, 'y'), (17, 23, 'y')],
}

def shield(g, kind, c='C', t='A'):
    if kind == 'rect':     # a big curved rectangular scutum on the left
        for y in range(17, 26):
            for x in range(0, 4): put(g, x, y, 'k' if x == 0 or y in (17, 25) else c)
        for x, y in ((1, 20), (2, 20), (1, 21), (2, 21)): put(g, x, y, t)
    if kind == 'round':    # a small round parmula
        for y, row in ((19, '.kkk.'), (20, 'kcccx'), (21, 'kcccx'), (22, 'kcccx'), (23, '.kkk.')):
            pass
        pts = {19: [(1, 'k'), (2, 'k'), (3, 'k')], 20: [(0, 'k'), (1, c), (2, c), (3, c), (4, 'k')], 21: [(0, 'k'), (1, c), (2, t), (3, c), (4, 'k')],
               22: [(0, 'k'), (1, c), (2, c), (3, c), (4, 'k')], 23: [(1, 'k'), (2, 'k'), (3, 'k')]}
        for y, items in pts.items():
            for x, ch in items:
                if x + 0 < 5: put(g, x, y, ch)

def build_g(look, mood='normal', pose='stand'):
    g = [[None] * W for _ in range(H)]
    for y, (x0, x1) in SKIN_ROWS.items():
        for x in range(x0, x1 + 1): g[y][x] = 'S'
    for x in range(6, 14): g[17][x] = 's' if g[17][x] else g[17][x]
    hair(g, look['style']); swoosh(g, look['style'])
    chibi.eyes(g, mood)
    cs.face_quirks(g, look.get('quirks', []), mood)
    HEADS[look['idx']](g)
    rowset(g, CUIRASS)
    for x, y, c in look.get('body', []): put(g, x, y, c)
    legs_g(g, pose, look.get('greave', False))
    for x, y in ((1, 14), (18, 14), (1, 10), (18, 10)):
        if g[y][x] in ('h', 'H') and look['idx'] not in (1, 6, 7): g[y][x] = None
    if look.get('shield'): shield(g, look['shield'], look.get('sc', 'C'), look.get('st', 'A'))
    if look.get('held'):
        for x, y, c in HELD_G[look['held']]: put(g, x, y, c)
    return g

def pal_g(look, dim=False):
    p = cs.pal(look, dim)
    return p

GLADIATORS = [
    dict(idx=0, letter='A', cls='murmillo', name='', style='bob', hair='#2a2340', eye='#3b82f6', skin='#c98e63', outfit='#2f5fb0', accent='#2f7fe0', kit='#d9a441', pants='#c98e63', shield='rect', sc='C', st='A', held='gladius', quirks=['smirk'], body=[]),
    dict(idx=1, letter='B', cls='retiarius', name='', style='long', hair='#c8483a', eye='#10b8d8', skin='#ffe6d5', outfit='#1f8a8a', accent='#ffd166', kit='#9aa3b5', pants='#ffe6d5', held='trident', quirks=['sparkle'], body=[(8, 19, 'A'), (9, 20, 'A'), (10, 21, 'A'), (11, 22, 'A')]),
    dict(idx=2, letter='C', cls='thraex', name='', style='bob', hair='#ff8fc7', eye='#a855f7', skin='#e9b98f', outfit='#a8402a', accent='#f47521', kit='#c28a2b', pants='#e9b98f', shield='round', sc='C', st='A', held='sica', quirks=['grin'], greave=True),
    dict(idx=3, letter='D', cls='secutor', name='', style='bob', hair='#dfe3ee', eye='#f59e0b', skin='#8f5b3a', outfit='#4a4f66', accent='#d23c3c', kit='#8a94ad', pants='#8f5b3a', shield='rect', sc='Z', st='A', held='gladius', quirks=['flat'], greave=True),
    dict(idx=4, letter='E', cls='hoplomachus', name='', style='messy', hair='#f7c95e', eye='#10b981', skin='#f9d2b6', outfit='#7a2e3a', accent='#e5484d', kit='#d8b04a', pants='#f9d2b6', shield='round', sc='C', st='A', held='spear', quirks=['open', 'freckles']),
    dict(idx=5, letter='F', cls='provocator', name='', style='long', hair='#9b6bff', eye='#ec4899', skin='#d9a273', outfit='#5a3a8a', accent='#e9c46a', kit='#c9d1d9', pants='#d9a273', held='gladius', quirks=['sharp'], body=[(7, 19, 'A'), (8, 19, 'A'), (11, 19, 'A'), (12, 19, 'A'), (9, 20, 'A'), (10, 20, 'A')]),
    dict(idx=6, letter='G', cls='eques', name='', style='bob', hair='#5b3527', eye='#06b6d4', skin='#ffe6d5', outfit='#2f6a4a', accent='#d23c3c', kit='#e3c27a', pants='#ffe6d5', shield='round', sc='C', st='A', held='spear', quirks=['halflid']),
    dict(idx=7, letter='H', cls='dimachaerus', name='', style='messy', hair='#3fb878', eye='#ef4444', skin='#ecb891', outfit='#2a2a38', accent='#e5484d', kit='#9aa3b5', pants='#ecb891', held='twin', quirks=['tongue']),
]

def board_g(name='15-gladiators.png', scale=8, who=None):
    from PIL import Image, ImageDraw
    items = who or GLADIATORS
    cw, ch = W * scale + 14, H * scale + 52
    img = Image.new('RGB', (4 * cw + 20, 34 + 2 * ch + 4), (96, 70, 44)); d = ImageDraw.Draw(img)
    d.text((14, 8), 'gauntlet gladiators (original characters)', fill=(255, 240, 220), font=font(15))
    for k, look in enumerate(items):
        ox, oy = 10 + (k % 4) * cw, 34 + (k // 4) * ch
        d.rectangle([ox, oy, ox + cw - 6, oy + ch - 6], fill=(196, 160, 104))
        paint(build_g(look), pal_g(look), scale, ox + 7, oy + 6, img)
        chip(d, ox + 8, oy + H * scale + 8, f"Gladiator {look['letter']}", font(12))
        d.text((ox + 8, oy + H * scale + 30), look['cls'], fill=(40, 24, 8), font=font(11))
    img.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), name))

def faces_g(name='16-gladiator-faces.png', scale=10):
    from PIL import Image, ImageDraw
    cw, ch = W * scale + 14, 20 * scale + 34
    img = Image.new('RGB', (4 * cw + 20, 34 + 2 * ch + 4), (96, 70, 44)); d = ImageDraw.Draw(img)
    d.text((14, 8), 'gladiator heads and shoulders (as seen at a desk)', fill=(255, 240, 220), font=font(15))
    for k, look in enumerate(GLADIATORS):
        ox, oy = 10 + (k % 4) * cw, 34 + (k // 4) * ch
        d.rectangle([ox, oy, ox + cw - 6, oy + ch - 6], fill=(196, 160, 104))
        paint(build_g(dict(look, held=None, shield=None)), pal_g(look), scale, ox + 7, oy + 4, img, crop_rows=20)
        chip(d, ox + 8, oy + 20 * scale + 6, f"{look['letter']} {look['cls']}", font(12))
    img.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), name))

if __name__ == '__main__':
    board_g(); faces_g(); print('ok')
