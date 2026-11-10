# The Lead as an emperor, for the gauntlet's colosseum: the same director Kaito (white asymmetric bob, red eyes, fang grin) in a laurel
# wreath, gold armor and a purple cape. Design only until it is built into the mod.
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import chibi, chibi_studio as cs, chibi_gladiators as cg
from chibi import W, H, put, rowset, font, chip, paint, blend

BASE = cs.CREW['director Kaito']
EMPEROR = dict(BASE, gear='none', garment='tee', held=None, quirks=['asym', 'grin'],
               outfit='#5a2a8a', accent='#f47521', kit='#e9c46a', pants=BASE['skin'])

def wreath(g):
    """A laurel wreath round the crown: leaf pairs in gold with a light edge, tips standing up, orange berries, a ribbon behind the ear."""
    for x in range(3, 17):
        put(g, x, 4, 'K' if x % 3 else 'k')
        put(g, x, 3, 'y' if x % 3 == 1 else 'K')
    for x in range(4, 16, 3):
        put(g, x, 2, 'K'); put(g, x + 1, 2, 'y')
    for x, y in ((2, 5), (2, 6), (2, 7), (3, 5), (3, 6), (16, 5), (16, 6), (16, 7), (17, 5), (17, 6)):
        put(g, x, y, 'K' if (x + y) % 3 else 'k')
    put(g, 2, 8, 'k'); put(g, 17, 8, 'k')
    for x, y in ((7, 5), (12, 5)): put(g, x, y, 'A')                 # berries
    for x, y in ((9, 4), (10, 4), (9, 3), (10, 3)): put(g, x, y, 'A')   # a jewel at the front
    put(g, 9, 3, 'W')
    for x, y in ((18, 8), (18, 9), (19, 10), (18, 11), (19, 12)): put(g, x, y, 'A')   # ribbon tails

def cape(g):
    for y in range(17, 26):
        for x in (1, 2, 3, 16, 17, 18):
            if y == 17 and x in (1, 18): continue
            put(g, x, y, 'c' if x in (1, 18) else 'C')
    for y in (24, 25):
        for x in (0, 19): put(g, x, y, 'c')

def build_e(look, mood='normal', pose='stand'):
    head = cs.build(dict(look, held=None), mood, 'stand')
    g = [[None] * W for _ in range(H)]
    for y in range(0, 18):
        for x in range(W): g[y][x] = head[y][x]
    wreath(g)
    cape(g)
    rowset(g, {**cg.CUIRASS, 18: '..ccCCCkKK'})
    for x, y in ((7, 19), (8, 19), (8, 20), (9, 20), (9, 21), (10, 21), (10, 22), (11, 22), (12, 22)): put(g, x, y, 'A')   # a sash across the plate
    for x in (6, 7, 8, 9, 10, 11, 12, 13): put(g, x, 22, 'k')                                  # belt
    for x in (9, 10): put(g, x, 22, 'y')
    cg.legs_g(g, pose, True)
    for x, y in ((1, 14), (18, 14)):
        if g[y][x] in ('h', 'H'): pass
    # the sceptre: a gold orb on a long staff, in the right hand
    for x, y, c in ((17, 11, 'y'), (18, 11, 'K'), (17, 12, 'K'), (18, 12, 'k')): put(g, x, y, c)
    for y in range(13, 26): put(g, 17, y, 'Y')
    put(g, 17, 14, 'K'); put(g, 17, 20, 'K')
    return g

def pal_e(look=EMPEROR, dim=False): return cs.pal(look, dim)

def board(name='21-emperor.png', scale=9):
    from PIL import Image, ImageDraw
    cw, ch = W * scale + 14, H * scale + 56
    img = Image.new('RGB', (4 * cw + 20, ch + 40), (96, 70, 44)); d = ImageDraw.Draw(img)
    d.text((14, 8), 'the Lead in the colosseum: same director Kaito, imperial dress (design only)', fill=(255, 240, 220), font=font(15))
    items = [('office: director Kaito', lambda: cs.build(dict(BASE, held=None), 'work'), cs.pal(BASE), None),
             ('colosseum: emperor Kaito', lambda: build_e(EMPEROR, 'work'), pal_e(), None),
             ('emperor, standing', lambda: build_e(EMPEROR, 'happy'), pal_e(), None),
             ('emperor, seated at the box', lambda: build_e(EMPEROR, 'work'), pal_e(), 20)]
    for k, (title, mk, pal, crop) in enumerate(items):
        ox, oy = 10 + k * cw, 34
        d.rectangle([ox, oy, ox + cw - 6, oy + ch - 6], fill=(196, 160, 104))
        paint(mk(), pal, scale, ox + 7, oy + 6, img, crop_rows=crop)
        chip(d, ox + 8, oy + (crop or H) * scale + 14, title, font(12))
    img.save(os.path.join(HERE, name))

if __name__ == '__main__':
    board(); print('ok')
