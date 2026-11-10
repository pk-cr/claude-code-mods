# Studio staff, drawn for the animation-studio theme: casual clothes (blazers, cardigans, hoodies, tees, smocks), white
# sneakers, ID lanyards, and big props that read at real size. Heads share the soft S4 faces with chibi.py.
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chibi
from chibi import W, H, put, stamp, rowset, hair, swoosh, eyes, palette, outline, paint, blend, SKIN_ROWS, font, chip, hexrgb

def R(s):
    assert len(s) == 20, (s, len(s))
    return s

def rows20(g, items):
    for y, row in items:
        for x, ch in enumerate(R(row)): put(g, x, y, ch)

# torso rows 18-23 as left halves (mirrored): C outfit, c shade, d light, W shirt/white, S hands
GARMENT = {
    'tee':     {18: '.......cCC', 19: '....ccdCCC', 20: '....ccdCCC', 21: '....ccCCCC', 22: '....SSCCCC', 23: '....SSCCCC'},
    'blazer':  {18: '.......cCW', 19: '....ccdCWW', 20: '....ccdCWW', 21: '....ccCCWW', 22: '....SSCCWW', 23: '....SSCCCC'},
    'cardi':   {18: '.......cCW', 19: '....ccdCCW', 20: '....ccdCCW', 21: '....ccCCCW', 22: '....SSCCCW', 23: '....SSCCCC'},
    'hoodie':  {18: '......ccCc', 19: '....ccdCCC', 20: '....ccdCCC', 21: '....ccCCCC', 22: '....SSCccc', 23: '....SSCccc'},
    'vest':    {18: '.......cWW', 19: '....WWdCWW', 20: '....WWdCWW', 21: '....WWCCWW', 22: '....SSCCWW', 23: '....SSCCCC'},
}

def legs(g, pose):
    if pose == 'stand':
        for y, row in ((24, '.......PP.'), (25, '.......PP.'), (26, '.....FFFF.')):
            for x, ch in enumerate(row + row[::-1]): put(g, x, y, ch)
    elif pose == 'step-a':
        stamp(g, 6, 24, ['PP', 'PP', 'FFF']); stamp(g, 5, 26, ['F']); stamp(g, 12, 24, ['PP']); stamp(g, 11, 25, ['FFF'])
    else:
        stamp(g, 12, 24, ['PP', 'PP', '.FFF']); stamp(g, 14, 26, ['F']); stamp(g, 6, 24, ['PP']); stamp(g, 5, 25, ['FFF'])

def clear_mouth(g):
    for x in range(8, 12):
        g[16][x] = 'S'
        if g[17][x] is not None: g[17][x] = 's'

def hair_quirks(g, q):
    if 'asym' in q:                                     # a lopsided bob: long on the left, short on the right
        for y in range(11, 15):
            for x in (17, 18): g[y][x] = None
        for x, y, c in ((1, 15, 'h'), (2, 15, 'H'), (2, 16, 'h'), (1, 14, 'h')): put(g, x, y, c)
    if 'tufts' in q:                                    # hair sticking out from under the hat
        for x, y, c in ((1, 6, 'H'), (1, 7, 'H'), (0 + 1, 8, 'h'), (18, 5, 'H'), (18, 6, 'H'), (18, 7, 'h')): put(g, x, y, c)

def face_quirks(g, q, mood):
    dx = 1 if mood == 'work' else 0
    live = mood in ('normal', 'work')
    if 'freckles' in q:
        for x, y in ((3, 13), (5, 13), (4, 14), (16, 13), (14, 13), (15, 14)): put(g, x, y, 's')
    if 'smudge' in q:                                   # an ink smudge on the cheek
        for x, y in ((15, 14), (15, 15), (14, 15)): put(g, x, y, 'Z')
    if live and 'halflid' in q:                         # droopy, relaxed eyes
        for ex in (6 + dx, 12 + dx):
            for x in range(ex - 1, ex + 3): put(g, x, 11, 'E')
            put(g, ex, 12, 'W')
    if live and 'sharp' in q:                           # a stern look: flat brows and sharp outer corners
        for x in (6 + dx, 7 + dx, 12 + dx, 13 + dx): put(g, x, 10, 'E')
        put(g, 5 + dx, 11, 'E'); put(g, 14 + dx, 11, 'E')
    if live and 'worry' in q:                           # worried brows
        for x, y in ((6 + dx, 10), (7 + dx, 9), (13 + dx, 10), (12 + dx, 9)): put(g, x, y, 'E')
    if live and 'sparkle' in q:                         # a second shine in each eye
        put(g, 7 + dx, 13, 'W'); put(g, 13 + dx, 13, 'W')
    if live and 'tired' in q:                           # a soft, tired look: lids and eye bags
        for ex in (6 + dx, 12 + dx):
            put(g, ex, 11, 'E'); put(g, ex + 1, 11, 'E')
            put(g, ex, 15, 's'); put(g, ex + 1, 15, 's')
    if live and 'grin' in q:                            # a wide cheeky grin with a fang
        clear_mouth(g)
        for x in range(8, 12): put(g, x, 16, 'M')
        put(g, 9, 17, 'W')
    if live and 'tongue' in q:                          # tongue out in concentration
        clear_mouth(g)
        put(g, 9, 16, 'M'); put(g, 10, 16, 'M'); put(g, 10, 17, 'B'); put(g, 11, 17, 'B')
    if live and 'smirk' in q:                           # a lopsided smirk
        clear_mouth(g)
        put(g, 9, 16, 'm'); put(g, 10, 16, 'm'); put(g, 11, 15, 'm')
    if live and 'flat' in q:                            # a serious straight mouth
        clear_mouth(g)
        for x in (9, 10, 11): put(g, x, 16, 'M')
    if live and 'nervous' in q:                         # a wobbly mouth and a sweat drop
        clear_mouth(g)
        for x, y in ((8, 16), (9, 17), (10, 16), (11, 17)): put(g, x, y, 'M')
        for x, y in ((16, 9), (16, 10), (16, 11)): put(g, x, y, 'D')
        put(g, 16, 12, 'W')
    if live and 'fangcat' in q:                         # a small smile with one fang
        put(g, 11, 17, 'W')
    if live and 'open' in q:                            # an excited little open mouth
        clear_mouth(g)
        for x in (9, 10): put(g, x, 16, 'M')
        for x in (9, 10): put(g, x, 17, 'B')

# little things held in the right hand when standing (cols 16-18, rows 20-25); palette keys as in the sprites
HELD = {
    'megaphone': [(18, 20, 'A'), (17, 21, 'A'), (18, 21, 'A'), (16, 22, 'a'), (17, 22, 'A'), (18, 22, 'A'), (16, 23, 'a'), (17, 23, 'a'), (18, 19, 'W'), (19 - 1, 18, 'W')],
    'camera': [(17, 21, 'Z'), (16, 22, 'Z'), (17, 22, 'Z'), (18, 22, 'Z'), (16, 23, 'Z'), (17, 23, 'z'), (18, 23, 'Z')],
    'mic': [(17, 20, 'y'), (18, 20, 'y'), (17, 21, 'W'), (18, 21, 'y'), (17, 22, 'k'), (17, 23, 'k'), (17, 24, 'A')],
    'sketchbook': [(16, 21, 'k'), (17, 21, 'W'), (18, 21, 'W'), (16, 22, 'k'), (17, 22, 'B'), (18, 22, 'W'), (16, 23, 'k'), (17, 23, 'W'), (18, 23, 'W'), (16, 24, 'k'), (17, 24, 'W'), (18, 24, 'W')],
    'coffee': [(17, 19, 'W'), (18, 20, 'W'), (16, 22, 'W'), (17, 22, 'W'), (18, 22, 'W'), (16, 23, 'W'), (17, 23, 'a'), (18, 23, 'W'), (17, 24, 'W')],
    'clipboard': [(17, 20, 'Y'), (16, 21, 'Y'), (17, 21, 'W'), (18, 21, 'W'), (16, 22, 'Y'), (17, 22, 'W'), (18, 22, 'W'), (16, 23, 'Y'), (17, 23, 'A'), (18, 23, 'W'), (16, 24, 'Y'), (17, 24, 'W'), (18, 24, 'W')],
    'tablet': [(15, 21, 'W'), (16, 22, 'Z'), (17, 22, 'Z'), (18, 22, 'Z'), (16, 23, 'Z'), (17, 23, 'z'), (18, 23, 'Z'), (16, 24, 'Z'), (17, 24, 'Z'), (18, 24, 'Z')],
    'book': [(16, 21, 'Y'), (17, 21, 'W'), (18, 21, 'Y'), (16, 22, 'Y'), (17, 22, 'W'), (18, 22, 'Y'), (16, 23, 'Y'), (17, 23, 'W'), (18, 23, 'Y'), (16, 24, 'Y'), (17, 24, 'A'), (18, 24, 'Y')],
    'tray': [(16, 22, 'W'), (18, 21, 'A'), (18, 22, 'A'), (16, 23, 'Z'), (17, 23, 'Z'), (18, 23, 'Z')],
    'papers': [(16, 21, 'W'), (17, 21, 'W'), (18, 21, 'A'), (16, 22, 'k'), (17, 22, 'k'), (18, 22, 'k'), (16, 23, 'W'), (17, 23, 'W'), (18, 23, 'W'), (16, 24, 'k'), (17, 24, 'k'), (18, 24, 'k')],
}

def build(look, mood='normal', pose='stand'):
    g = [[None] * W for _ in range(H)]
    for y, (x0, x1) in SKIN_ROWS.items():
        for x in range(x0, x1 + 1): g[y][x] = 'S'
    for x in range(6, 14): g[17][x] = 's' if g[17][x] else g[17][x]
    q = look.get('quirks', [])
    hair(g, look['style']); swoosh(g, look['style'])
    hair_quirks(g, q)
    chibi.eyes(g, mood)
    face_quirks(g, q, mood)
    gr = look['gear']
    dx = 1 if mood == 'work' else 0
    def ring(ch):                                           # round glasses, shifting with the gaze
        for ex in (5 + dx, 11 + dx):
            for x, y in ((ex + 1, 10), (ex + 2, 10), (ex, 11), (ex, 12), (ex, 13), (ex, 14), (ex + 3, 11), (ex + 3, 12), (ex + 3, 13), (ex + 3, 14), (ex + 1, 15), (ex + 2, 15)): put(g, x, y, ch)
        for x in range(9 + dx, 11 + dx): put(g, x, 12, ch)
    # ---- heads ----
    if gr == 'beret':        # an orange beret: a soft disc that overhangs the head, tilted, with a stem
        rows20(g, ((1, '..........aa........'), (2, '....AAAAAAAAAAA.....'), (3, '..AAAAAAAAAAAAAAA...'), (4, '.AAAAAAAAAAAAAAAAA..'), (5, '...aaaaaaaaaaaaaa...')))
        for x, y in ((5, 3), (6, 3), (7, 3), (3, 4), (4, 4)): put(g, x, y, 'K')
    if gr == 'bucket':       # a khaki bucket hat with a blue band
        rowset(g, {1: '......kKKK', 2: '....kKKKKK', 3: '....kKKKKK', 4: '....AAAAAA', 5: '..kKKKKKKK', 6: '..kkkkkkkk'})
    if gr == 'phones':       # big over-ear headphones: a thin band, large cups, a mic boom
        for x in range(6, 14): put(g, x, 2, 'k')
        for x, y in ((5, 2), (4, 2), (4, 3), (14, 2), (15, 2), (15, 3)): put(g, x, y, 'k')
        for y in range(3, 8):
            for x in (3, 16): put(g, x, y, 'k')
        for side in (0, 1):
            m = (lambda x: 19 - x) if side else (lambda x: x)
            for y in range(8, 15):
                put(g, m(1), y, 'a'); put(g, m(2), y, 'A'); put(g, m(3), y, 'A'); put(g, m(4), y, 'k')
            put(g, m(2), 11, 'W')
        for x, y in ((3, 15), (4, 16), (5, 16), (6, 16)): put(g, x, y, 'k')
        put(g, 7, 16, 'A')
    if gr == 'storyboard':   # twin buns and a big yellow pencil through the right one
        for side in (0, 1):
            m = (lambda x: 19 - x) if side else (lambda x: x)
            for x, y, c in ((2, 1, 'H'), (3, 1, 'H'), (4, 1, 'h'), (1, 2, 'h'), (2, 2, 'w'), (3, 2, 'H'), (4, 2, 'H'), (5, 2, 'h'), (1, 3, 'h'), (2, 3, 'H'), (3, 3, 'H'), (4, 3, 'H'),
                            (5, 3, 'h'), (1, 4, 'h'), (2, 4, 'H'), (3, 4, 'H'), (4, 4, 'H'), (5, 4, 'h'), (2, 5, 'h'), (3, 5, 'h'), (4, 5, 'A'), (5, 5, 'A'), (4, 6, 'A'), (5, 6, 'A')):
                put(g, m(x), y, c)
        for x, y, c in ((13, 4, 'F'), (14, 3, 'K'), (15, 3, 'K'), (15, 2, 'K'), (16, 2, 'K'), (16, 1, 'K'), (17, 1, 'K'), (17, 0 + 1, 'K'), (18, 1, 'B'), (18, 2, 'B')): put(g, x, y, c)
    if gr == 'producer':     # round glasses and a one-ear headset
        ring('K')
        for x, y, c in ((17, 10, 'K'), (17, 11, 'K'), (17, 12, 'K'), (16, 13, 'K'), (15, 14, 'K'), (14, 15, 'A')): put(g, x, y, c)
    if gr == 'archivist':    # round gold glasses and a hair clip
        ring('A')
        put(g, 14, 6, 'A'); put(g, 15, 6, 'A')
    if gr == 'visor':        # an editor's green eyeshade, a red pen behind the ear
        for y in (6, 7):
            for x in range(2, 18): put(g, x, y, 'K')
        for x in range(3, 17): put(g, x, 8, 'k')
        for x in (4, 5, 6): put(g, x, 6, 'W')
        for x, y, c in ((17, 11, 'W'), (17, 12, 'A'), (17, 13, 'A'), (17, 14, 'A')): put(g, x, y, c)
    if gr == 'smock':        # a pencil behind the left ear
        for x, y, c in ((2, 11, 'B'), (2, 12, 'A'), (2, 13, 'A'), (2, 14, 'A'), (2, 15, 'F')): put(g, x, y, c)
    if gr in ('assistant',): # neko ears
        for side in (0, 1):
            m = (lambda x: 19 - x) if side else (lambda x: x)
            for x, y, c in ((3, 1, 'h'), (4, 1, 'H'), (2, 2, 'h'), (3, 2, 'H'), (4, 2, 'B'), (5, 2, 'H'), (2, 3, 'h'), (3, 3, 'H'), (4, 3, 'B'), (5, 3, 'B'), (6, 3, 'H'), (3, 4, 'h'), (4, 4, 'H'), (5, 4, 'H'), (6, 4, 'H')):
                put(g, m(x), y, c)
    if gr == 'intern':       # a yellow sticky note stuck in the hair
        for y in (3, 4, 5):
            for x in (12, 13, 14): put(g, x, y, 'A')
        put(g, 12, 3, 'W'); put(g, 13, 4, 'k'); put(g, 14, 4, 'k')
    # ---- body ----
    rowset(g, GARMENT[look['garment']])
    if gr == 'beret':        # an orange scarf, tied
        for x in range(8, 12): put(g, x, 18, 'A')
        for x, y in ((11, 19), (11, 20), (12, 20), (12, 21)): put(g, x, y, 'A')
    if gr == 'bucket':       # a camera on a strap
        stamp(g, 8, 20, ['ZZZZZ', 'ZzzzZ', 'ZZZZZ'])
        for x, y in ((8, 19), (12, 19)): put(g, x, y, 'Z')
    if gr == 'producer':     # a tie
        for x, y, c in ((9, 18, 'a'), (10, 18, 'a'), (9, 19, 'A'), (10, 19, 'A'), (9, 20, 'A'), (10, 20, 'A'), (9, 21, 'A'), (10, 21, 'A'), (9, 22, 'a'), (10, 22, 'a')): put(g, x, y, c)
    if gr == 'phones':       # an orange stripe on the tee
        for x in range(7, 13): put(g, x, 21, 'A')
    if gr == 'smock':        # paint splashes
        for x, y, c in ((8, 20, 'B'), (9, 21, 'D'), (11, 19, 'A'), (7, 22, 'D'), (12, 21, 'B'), (10, 22, 'A')): put(g, x, y, c)
    if gr == 'assistant':    # drawstrings
        for x, y in ((9, 19), (9, 20), (10, 19), (10, 20)): put(g, x, y, 'W')
    if gr in ('visor', 'archivist'):   # a cardigan button pair
        put(g, 9, 21, 'K'); put(g, 10, 21, 'K')
    if gr != 'producer':     # ID lanyard card
        for x, y, c in ((12, 19, 'k'), (12, 20, 'W'), (13, 20, 'W'), (12, 21, 'W'), (13, 21, 'W'), (12, 22, 'A'), (13, 22, 'A')): put(g, x, y, c)
    if 'star' in q:                                        # a star pin on the beret and a pin on the lapel
        for x, y in ((13, 2), (12, 3), (13, 3), (14, 3), (13, 4)): put(g, x, y, 'W')
        put(g, 7, 20, 'K')
    if 'straps' in q:                                      # backpack straps
        for y in range(19, 23):
            for x in (7, 8, 11, 12): put(g, x, y, 'k')
        for x in (9, 10): put(g, x, 20, 'k')
    if 'wave' in q:                                        # a sound-wave print
        for x, y in ((7, 20), (8, 19), (9, 21), (10, 19), (11, 21), (12, 20)): put(g, x, y, 'A')
    if 'patch' in q:                                       # a storyboard-panel patch
        for x, y, c in ((7, 20, 'W'), (8, 20, 'W'), (7, 21, 'W'), (8, 21, 'A')): put(g, x, y, c)
    if 'pocket' in q:                                      # a pocket square, and a pen in the breast pocket
        put(g, 12, 19, 'A'); put(g, 7, 19, 'K')
    if 'check' in q:                                       # a check-mark pin
        for x, y in ((7, 21), (8, 22), (9, 21), (10, 20)): put(g, x, y, 'A')
    if 'pencils' in q:                                     # pencils in the smock's pocket
        for x, y, c in ((8, 19, 'A'), (9, 19, 'B'), (10, 19, 'D')): put(g, x, y, c)
    if 'braid' in q:                                       # a braid over the left shoulder, tied with a ribbon
        for i, (x, y) in enumerate(((6, 18), (5, 19), (6, 20), (5, 21), (6, 22), (5, 23))): put(g, x, y, 'H' if i % 2 == 0 else 'h')
        put(g, 5, 24, 'A'); put(g, 6, 24, 'A')
    if 'bell' in q:                                        # a red collar ribbon and a gold bell
        for x in range(8, 12): put(g, x, 18, 'A')
        put(g, 9, 19, 'K'); put(g, 10, 19, 'K'); put(g, 9, 20, 'K'); put(g, 10, 20, 'K')
    if 'bigcard' in q:                                     # a too-big ID card on a crooked lanyard
        for x, y, c in ((11, 19, 'k'), (11, 20, 'W'), (12, 20, 'W'), (13, 20, 'W'), (11, 21, 'W'), (12, 21, 'W'), (13, 21, 'W'), (11, 22, 'A'), (12, 22, 'A'), (13, 22, 'W'), (12, 23, 'W'), (13, 23, 'W')): put(g, x, y, c)
    legs(g, pose)
    if 'tail' in q and pose != 'none':                    # a cat tail
        for x, y, c in ((15, 25, 'H'), (16, 25, 'H'), (17, 24, 'H'), (18, 23, 'H'), (18, 22, 'H'), (18, 21, 'w'), (17, 25, 'h'), (18, 24, 'h')): put(g, x, y, c)
    for x, y in ((5, 26), (6, 26), (13, 26), (14, 26)):
        if g[y][x] == 'F': g[y][x] = 'f'
    for y in range(19, 23):
        for x in (4, 5):
            if g[y][x] == 'c': g[y][x] = 'C'
        for x in (14, 15):
            if g[y][x] in ('C', 'W'): g[y][x] = 'c' if g[y][x] == 'C' else g[y][x]
        if g[y][13] == 'C': g[y][13] = 'c'
    for x, y in ((1, 14), (18, 14), (1, 10), (18, 10)):
        if g[y][x] in ('h', 'H') and 'asym' not in q and 'tufts' not in q: g[y][x] = None
    held = look.get('held')
    if held:
        for x, y, c in HELD[held]: put(g, x, y, c)
    return g

def pal(look, dim=False):
    p = palette(look, dim)
    sneaker = '#f4f4fa'
    p['Y'] = '#a8702f'; p['y'] = '#e6c99a'; p['Z'] = '#6f7890'; p['z'] = '#bfe9ff'
    p['F'] = blend(sneaker, '#c9a27a', 0.22) if dim else sneaker
    p['f'] = blend(look['accent'], '#c9a27a', 0.22) if dim else look['accent']
    return p

CREW = {
    'director Kaito':        dict(hair='#e9edf7', eye='#e5484d', skin='#ffe6d5', outfit='#2b2d6b', accent='#f47521', kit='#ffb27a', gear='beret', style='bob', pants='#3b4a7a', garment='blazer', quirks=['asym', 'grin', 'star'], held='megaphone', trait='fang grin, star pin, horn'),
    'location scout Pip':    dict(hair='#59b0ff', eye='#06b6d4', skin='#c98e63', outfit='#4a8f6a', accent='#3b8fe0', kit='#e3c27a', gear='bucket', style='messy', pants='#6a5a4a', garment='vest', quirks=['tufts', 'freckles', 'open', 'straps', 'sparkle'], held='camera', trait='freckles, backpack, camera'),
    'sound engineer Rachael':   dict(hair='#f7c95e', eye='#a855f7', skin='#e9b98f', outfit='#454a63', accent='#f47521', kit='#2d2f3a', gear='phones', style='bob', pants='#2a2a38', garment='tee', quirks=['halflid', 'smirk', 'wave'], held='mic', trait='sleepy eyes, smirk, mic'),
    'storyboard artist Mira':dict(hair='#ff9248', eye='#10b8d8', skin='#ffe6d5', outfit='#20a3a0', accent='#ffd166', kit='#c9a227', gear='storyboard', style='buns', pants='#3b5a8a', garment='cardi', quirks=['smudge', 'sparkle', 'patch'], held='sketchbook', trait='ink smudge, pencil bun'),
    'producer Vance':        dict(hair='#a99be0', eye='#f59e0b', skin='#f4cfb0', outfit='#4d4577', accent='#e5484d', kit='#2d2f3a', gear='producer', style='bob', pants='#3a3550', garment='blazer', quirks=['tired', 'pocket'], held='coffee', trait='tired eyes, coffee'),
    'QC editor Ren':         dict(hair='#3fb878', eye='#a855f7', skin='#f6d5b8', outfit='#6b45b0', accent='#d23c3c', kit='#8fe0d0', gear='visor', style='long', pants='#3b5a8a', garment='cardi', quirks=['sharp', 'flat', 'check'], held='clipboard', trait='stern brows, check pin'),
    'animator Bolt':         dict(hair='#8a5a3c', eye='#ec4899', skin='#ecb891', outfit='#efe7d8', accent='#f2cc60', kit='#3a2a1e', gear='smock', style='messy', pants='#3b5a8a', garment='tee', quirks=['tongue', 'sparkle', 'pencils'], held='tablet', trait='tongue out, tablet'),
    'archivist Sora':        dict(hair='#a8603a', eye='#f59e0b', skin='#d9a273', outfit='#7f9444', accent='#c28a2b', kit='#e3cd94', gear='archivist', style='long', pants='#5a4a38', garment='cardi', quirks=['braid'], held='book', trait='braid, glasses, a book'),
    'assistant':             dict(hair='#dcb98c', eye='#10b981', skin='#8f5b3a', outfit='#ff8fb0', accent='#e5484d', kit='#f3f0ff', gear='assistant', style='buns', pants='#3a4468', garment='hoodie', quirks=['fangcat', 'bell', 'tail'], held='tray', trait='neko ears, bell, tail'),
    'intern':                dict(hair='#d86fa0', eye='#3b82f6', skin='#ffe6d5', outfit='#6a56a8', accent='#ffd166', kit='#c9d1d9', gear='intern', style='messy', pants='#3b5a8a', garment='tee', quirks=['nervous', 'worry', 'bigcard'], held='papers', trait='nervous, sticky note'),
}

def board(name='9-studio-board.png', scale=8):
    from PIL import Image, ImageDraw
    names = list(CREW)
    cw, ch = W * scale + 14, H * scale + 44
    img = Image.new('RGB', (5 * cw + 20, 34 + 2 * ch + 4), (60, 44, 30)); d = ImageDraw.Draw(img)
    d.text((14, 8), 'animation studio crew, redesigned (original characters)', fill=(255, 240, 220), font=font(15))
    for k, n in enumerate(names):
        ox, oy = 10 + (k % 5) * cw, 34 + (k // 5) * ch
        d.rectangle([ox, oy, ox + cw - 6, oy + ch - 6], fill=(168, 116, 67))
        paint(build(CREW[n]), pal(CREW[n]), scale, ox + 7, oy + 6, img)
        chip(d, ox + 8, oy + H * scale + 8, n, font(12))
        d.text((ox + 8, oy + H * scale + 28), CREW[n].get('trait', ''), fill=(255, 240, 220), font=font(10))
    img.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), name))

def faces(name='11-faces.png', scale=10):
    from PIL import Image, ImageDraw
    names = list(CREW)
    cw, ch = W * scale + 14, 20 * scale + 34
    img = Image.new('RGB', (5 * cw + 20, 34 + 2 * ch + 4), (60, 44, 30)); d = ImageDraw.Draw(img)
    d.text((14, 8), 'faces and head gear (close up)', fill=(255, 240, 220), font=font(15))
    for k, n in enumerate(names):
        ox, oy = 10 + (k % 5) * cw, 34 + (k // 5) * ch
        d.rectangle([ox, oy, ox + cw - 6, oy + ch - 6], fill=(168, 116, 67))
        paint(build(dict(CREW[n], held=None), 'normal'), pal(CREW[n]), scale, ox + 7, oy + 4, img, crop_rows=19)
        chip(d, ox + 8, oy + 19 * scale + 8, n, font(12))
    img.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), name))

if __name__ == '__main__':
    board(); print('ok')
