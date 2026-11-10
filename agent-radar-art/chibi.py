# Chibi crew sprite studio (design only; nothing here touches the mod).
# A figure is 20 wide by 28 tall: head 17 rows (about 65%), body 9 rows. Art sits in columns 1-18 and rows 1-26;
# the outline is added around it automatically, in a dark shade of whatever it touches.
import os, sys
from PIL import Image, ImageDraw, ImageFont

W, H = 20, 28
HERE = os.path.dirname(os.path.abspath(__file__))

def hexrgb(c): return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
def rgbhex(t): return '#%02x%02x%02x' % tuple(max(0, min(255, round(v))) for v in t)
def blend(a, b, t):
    A, B = hexrgb(a), hexrgb(b)
    return rgbhex([A[i] + (B[i] - A[i]) * t for i in range(3)])

def mirror(left, keep_shine=False):
    assert len(left) == 10, (left, len(left))
    right = left[::-1]
    if not keep_shine: right = right.replace('w', 'H')
    return left + right

def put(g, x, y, ch):
    if 0 <= x < W and 0 <= y < H and ch not in '. ': g[y][x] = ch

def stamp(g, x, y, rows):
    for dy, row in enumerate(rows):
        for dx, ch in enumerate(row): put(g, x + dx, y + dy, ch)

def rowset(g, rows, keep_shine=False):
    for y, left in rows.items():
        for x, ch in enumerate(mirror(left, keep_shine)): put(g, x, y, ch)

# ---- the head ------------------------------------------------------------------------------------------
SKIN_ROWS = {6: (2, 17), 7: (2, 17), 8: (2, 17), 9: (2, 17), 10: (3, 16), 11: (3, 16), 12: (3, 16), 13: (3, 16),
             14: (3, 16), 15: (3, 16), 16: (4, 15), 17: (6, 13)}

# Hair styles: rows 1-9 as left halves (mirrored), then side locks.
HAIR = {
    'bob': {1: '......hHHH', 2: '....hHHHHH', 3: '...hHHwwwH', 4: '..hHwwHHHH', 5: '..hHHHHHHH', 6: '.hHHHHHHHH',
            7: '.hHHHHHHHH', 8: '.hHHHHHHHH', 9: '.hHSSHSSSH'},
    'spiky': {0: '...h..h..h', 1: '..hHhhHHhH', 2: '..hHHHHHHH', 3: '..hHHHHwwH', 4: '.hHHHHwwHH', 5: '.hHHHHHHHH',
              6: '.hHHHHHHHH', 7: '.hHHHHHHHH', 8: '.hHHHHHHHH', 9: '.hHSSHSSSH'},
    'long': {1: '......hHHH', 2: '....hHHHHH', 3: '...hHHHHww', 4: '..hHHHwwHH', 5: '..hHHHHHHH', 6: '.hHHHHHHHH',
             7: '.hHHHHHHHH', 8: '.hHHHHHHHH', 9: '.hHSSHSSSH'},
    'buns': {3: '......hHHH', 4: '....hHHHHH', 5: '...hHHHwwH', 6: '.hHHHwwHHH', 7: '.hHHHHHHHH', 8: '.hHHHHHHHH', 9: '.hHSSHSSSH'},
    'messy': {0: '.......hHh', 1: '..h.hHHHHH', 2: '.hHHHHHHHH', 3: '.hHHHHHHww', 4: '.hHHHHwwHH', 5: '.hHHHHHHHH',
              6: '.hHHHHHHHH', 7: '.hHHHHHHHH', 8: '.hHHHHHHHH', 9: '.hHSSHSSSH'},
}
# Style details after the shared rows: locks beside the face, and extras (buns, ponytail, ahoge).
def hair(g, style):
    rowset(g, HAIR[style])
    locks = {'bob': 14, 'spiky': 12, 'long': 21, 'messy': 13, 'buns': 13}[style]
    for x, y in ((6, 7), (6, 8), (13, 7), (13, 8)): put(g, x, y, 'h')   # fringe strands
    for y in range(10, locks + 1):
        for x in (1, 18): put(g, x, y, 'h')
        for x in (2, 17): put(g, x, y, 'H')
    if style == 'long':           # long hair falls past the shoulders at the back
        for y in range(15, 22):
            for x in (1, 2, 17, 18): put(g, x, y, 'H' if x in (2, 17) else 'h')
    if style in ('bob',):
        for x in (2, 17): put(g, x, 15, 'h')
    if style == 'messy':          # an ahoge: a loose strand on top
        for x, y in ((9, 0), (10, 0), (10, 1)): put(g, x, y, 'H')

# Strands are 4-connected paths (stair steps), so they read as lines, not dots. Left half only; mirrored.
STRANDS = {
    'bob':   [[(9, 2), (8, 2), (8, 3), (7, 3), (7, 4), (7, 5), (6, 5), (6, 6), (6, 7), (5, 7), (5, 8)]],
    'spiky': [[(8, 3), (8, 4), (7, 4), (7, 5), (7, 6), (6, 6), (6, 7)]],
    'long':  [[(9, 2), (8, 2), (8, 3), (7, 3), (7, 4), (7, 5), (6, 5), (6, 6), (6, 7), (5, 7), (5, 8)]],
    'messy': [[(9, 3), (8, 3), (8, 4), (7, 4), (7, 5), (7, 6), (6, 6), (6, 7), (5, 7), (5, 8)]],
    'buns':  [[(9, 4), (8, 4), (8, 5), (7, 5), (7, 6), (6, 6), (6, 7), (5, 7), (5, 8)]],
}
SIDE_SHINE = {'bob': [], 'spiky': [], 'long': [(2, 16), (2, 17), (2, 18)], 'messy': [], 'buns': []}
def swoosh(g, style):
    for path in STRANDS[style]:
        for x, y in path:
            for px in (x, 19 - x):
                if g[y][px] == 'H': g[y][px] = 'h'
    for x, y in SIDE_SHINE[style]:                    # a glint on the left lock
        if g[y][x] == 'H': g[y][x] = 'w'

def eyes(g, mood):
    v = EYE_VARIANTS[EYE]
    L, R, w, y0 = v['L'], v['R'], v['w'], v['y']
    def at(x, y, rows):
        stamp(g, x, y, rows)
    mid = (w - 3) // 2
    if mood in ('normal', 'work'):       # 'work': both eyes look 1px toward the screen on the right
        dx = 1 if mood == 'work' else 0
        at(L + dx, y0, v['rows']); at(R + dx, y0, v['rows'])
        mouth(g, v.get('mouth', 'smile')); blush(g, 1)
    elif mood == 'happy':       # ^ ^
        at(L + mid, y0 + 1, ['.E.', 'E.E']); at(R + mid, y0 + 1, ['.E.', 'E.E'])
        mouth(g, 'open'); blush(g, 2)
    elif mood == 'sleepy':      # closed, resting
        at(L + mid, y0 + 1, ['E.E', '.E.']); at(R + mid, y0 + 1, ['E.E', '.E.'])
        mouth(g, 'tiny'); blush(g, 1)
    elif mood == 'stuck':       # > <
        at(L + mid, y0, ['E..', '.E.', 'E..']); at(R + mid, y0, ['..E', '.E.', '..E'])
        mouth(g, 'wavy'); blush(g, 1)
    elif mood == 'wow':         # startled: the usual eyes, raised brows, a round mouth
        at(L, y0, v['rows']); at(R, y0, v['rows'])
        for x in (6, 7, 12, 13): put(g, x, y0 - 2, 'E')
        mouth(g, 'o'); blush(g, 1)

EYE = 'S4'
EYE_VARIANTS = {
    # S1: small dark ovals, 2x3, wide apart, one shine: like the pattern you sent
    'S1': dict(L=6, R=12, w=2, y=12, rows=['WE', 'EE', 'EE'], mouth='tiny'),
    # S2: 3x4 glossy: dark with a colored lower edge and a shine
    'S2': dict(L=5, R=12, w=3, y=11, rows=['EEE', 'WEE', 'EEE', 'JJJ'], mouth='tiny'),
    # S3: 3x4 colored iris with a dark top, a shine, no ring
    'S3': dict(L=5, R=12, w=3, y=11, rows=['EEE', 'JWJ', 'JJJ', 'iii'], mouth='tiny'),
    # S4: 2x4 tall dark ovals with a shine and a colored glint at the bottom
    'S4': dict(L=6, R=12, w=2, y=11, rows=['WE', 'EE', 'EE', 'JJ'], mouth='tiny'),
}

def blush(g, strength):
    for x in (4, 5, 14, 15): put(g, x, 15, 'B')
    if strength > 1:
        for x in (3, 4, 15, 16): put(g, x, 15, 'B')
        for x in (4, 5, 14, 15): put(g, x, 14, 'B')

def mouth(g, kind):
    if kind == 'smile':  stamp(g, 9, 16, ['mm'])
    if kind == 'open':   stamp(g, 8, 15, ['MMMM', '.mm.'])
    if kind == 'tiny':   stamp(g, 9, 16, ['mm'])
    if kind == 'wavy':   stamp(g, 8, 16, ['M.M.']); put(g, 9, 15, 'M'); put(g, 11, 15, 'M')
    if kind == 'o':      stamp(g, 9, 15, ['MM', 'MM'])

# ---- the body --------------------------------------------------------------------------------------------
LEGS = {
    'stand': {24: '.......PP.', 25: '.......LL.', 26: '.....FFFF.'},
    'step-a': None, 'step-b': None,
}
def legs(g, pose):
    if pose == 'stand':
        rowset(g, LEGS['stand'])
    elif pose == 'step-a':     # left leg planted, right leg lifted
        stamp(g, 6, 24, ['PP', 'LL', 'FFF']); stamp(g, 5, 26, ['F'])
        stamp(g, 12, 24, ['PP']); stamp(g, 11, 25, ['FFF'])
    else:
        stamp(g, 12, 24, ['PP', 'LL', '.FFF']); stamp(g, 14, 26, ['F'])
        stamp(g, 6, 24, ['PP']); stamp(g, 5, 25, ['FFF'])

BODY = {18: '.......CCC', 19: '....ccdCCC', 20: '....ccdCCC', 21: '....ccCCCC', 22: '....SSCCCC', 23: '....SSAAAA'}

# ---- gear: rows that replace the head's or body's (left halves, mirrored) -------------------------------
GEAR = {
    'captain': {   # a straw hat with an orange band and a wide brim; gold epaulets
        'head': {1: '.......kKK', 2: '.....kKKkK', 3: '.....kKKKK', 4: '.....AAAAA', 5: '.kKKKKKKKK', 6: '.kkkkkkkkk'},
        'body': {19: '....KKdCCC'}},
    'beanie': {    # a striped knit cap with a bobble
        'head': {1: '.........A', 2: '....AAKKAA', 3: '...AAKKAAK', 4: '...AAKKAAK', 5: '..kKKKKKKK', 6: '..kkkkkkkk'},
        'body': {}},
    'bandana': {   # a bandana with a knot, a patch over one eye
        'head': {2: '....AAAAAA', 3: '...AAAAAAA', 4: '..aAAAAAAA', 5: '..aaaaaaaa'},
        'body': {}},
    'buns': {      # two hair buns, a brass compass
        'head': {}, 'body': {}},
    'tricorn': {   # a black tricorn with gold trim, a monocle
        'head': {1: '........KK', 2: '..K...KKKK', 3: '..KKKKKKKK', 4: '...AAAAAAA', 5: '....kkkkkk'},
        'body': {19: '....ccdCCC'}},
    'blade': {     # a hilt over the shoulder, a red plate
        'head': {}, 'body': {}},
    'goggles': {   # goggles pushed up on the forehead: a strap and two round lenses
        'head': {}, 'body': {23: '....SSKKKK'}},
    'sunhat': {    # a wide sun hat
        'head': {1: '......kKKK', 2: '....kKKKKK', 3: '....kAAAAA', 4: '..kKKKKKKK', 5: '.kKKKKKKKK', 6: '.kkKKKKKKK'},
        'body': {}},
    'deckhand': {  # cat ears (drawn in code), a striped shirt
        'head': {},
        'body': {18: '.......KCK', 19: '....KCKCKC', 20: '....KCKCKC', 21: '....KCKCKC'}},
    'none': {'head': {}, 'body': {}},
    'beret': {'head': {}, 'body': {}}, 'bucket': {'head': {1: '......kKKK', 2: '....kKKKKK', 3: '....kKKKKK', 4: '....AAAAAA', 5: '..kKKKKKKK', 6: '..kkkkkkkk'}, 'body': {}},
    'phones': {'head': {}, 'body': {}}, 'producer': {'head': {}, 'body': {}}, 'visor': {'head': {}, 'body': {}},
    'smock': {'head': {}, 'body': {}}, 'archivist': {'head': {}, 'body': {}}, 'assistant': {'head': {}, 'body': {}}, 'storyboard': {'head': {}, 'body': {}},
}

# ---- looks: palette per character ---------------------------------------------------------------------
LOOKS = {
    'captain Kaito':      dict(hair='#e9edf7', eye='#e5484d', skin='#ffe6d5', outfit='#3345a0', accent='#f47521', kit='#f0c85a', gear='captain', style='spiky', pants='#2b2a4a'),
    'lookout Pip':        dict(hair='#59b0ff', eye='#06b6d4', skin='#c98e63', outfit='#3b8fe0', accent='#e5484d', kit='#ffffff', gear='beanie', style='messy', pants='#2b3a67'),
    'spotter Rachael':       dict(hair='#f7c95e', eye='#a855f7', skin='#e9b98f', outfit='#8a3b5a', accent='#f47521', kit='#141018', gear='bandana', style='bob', pants='#2a2a38'),
    'navigator Mira':     dict(hair='#ff9248', eye='#10b8d8', skin='#ffe6d5', outfit='#20a3a0', accent='#ffd166', kit='#c9a227', gear='buns', style='buns', pants='#27403f'),
    'quartermaster Vance':dict(hair='#a99be0', eye='#f59e0b', skin='#f4cfb0', outfit='#9a3a5a', accent='#e9c46a', kit='#3f3570', gear='tricorn', style='bob', pants='#3a2230'),
    'swordsman Ren':      dict(hair='#3fb878', eye='#a855f7', skin='#f6d5b8', outfit='#6b45b0', accent='#d23c3c', kit='#7a4a2a', gear='blade', style='long', pants='#2f2548'),
    'shipwright Bolt':    dict(hair='#8a5a3c', eye='#ec4899', skin='#ecb891', outfit='#b57a3a', accent='#f2cc60', kit='#3a2a1e', gear='goggles', style='messy', pants='#4a3524'),
    'archaeologist Sora': dict(hair='#a8603a', eye='#f59e0b', skin='#d9a273', outfit='#7f9444', accent='#8a5a2b', kit='#f0dc9a', gear='sunhat', style='long', pants='#4a5030'),
    'deckhand':           dict(hair='#dcb98c', eye='#10b981', skin='#8f5b3a', outfit='#2b3a67', accent='#e5484d', kit='#f3f0ff', gear='deckhand', style='buns', pants='#2a3050'),
    'recruit':            dict(hair='#d86fa0', eye='#3b82f6', skin='#ffe6d5', outfit='#6a56a8', accent='#ffd166', kit='#c9d1d9', gear='none', style='messy', pants='#2f2a45'),
}

def palette(look, dim=False):
    skin, hairc, eye = look['skin'], look['hair'], look['eye']
    p = {
        'H': hairc, 'h': blend(hairc, '#1a1030', 0.32), 'w': blend(hairc, '#ffffff', 0.6),
        'S': skin, 's': blend(skin, '#c47f78', 0.5), 'B': blend(skin, '#ff5c8a', 0.6), 'L': skin,
        'E': '#2a1c3a', 'I': blend(eye, '#0c0a2a', 0.55), 'J': eye, 'i': blend(blend(eye, '#fff0a0', 0.5), '#ffffff', 0.15), 'W': '#ffffff',
        'M': '#b83a55', 'm': '#e3808f',
        'C': look['outfit'], 'c': blend(look['outfit'], '#10102a', 0.3), 'd': blend(look['outfit'], '#ffffff', 0.25),
        'A': look['accent'], 'a': blend(look['accent'], '#10102a', 0.35),
        'K': look['kit'], 'k': blend(look['kit'], '#3a2a1a', 0.3), 'G': '#7fd6ff', 'g': '#ffffff',
        'P': look['pants'], 'Z': '#2d2f3a', 'z': '#7fd6ff', 'F': '#8a5a36', 'f': '#c28a56', 'D': '#7cc8ff',
    }
    if dim: p = {k: blend(v, '#c9a27a', 0.22) for k, v in p.items()}
    return p

def build(look, mood='normal', pose='stand'):
    g = [[None] * W for _ in range(H)]
    for y, (x0, x1) in SKIN_ROWS.items():
        for x in range(x0, x1 + 1): g[y][x] = 'S'
    for x in range(6, 14): g[17][x] = 's' if g[17][x] else g[17][x]
    gear = GEAR[look['gear']]
    hair(g, look['style'])
    swoosh(g, look['style'])
    if gear['head']: rowset(g, gear['head'])
    eyes(g, mood)
    if look['gear'] == 'bandana':                         # the eye patch over the right eye, and its strap
        if mood in ('normal', 'work'):
            stamp(g, 11, 10, ['.EE.', 'EEEE', 'EEEE', 'EEEE', '.EE.'])
            for x, y in ((10, 9), (9, 8), (8, 7), (12, 9), (13, 9)): put(g, x, y, 'E')
        else:
            stamp(g, 12, 6, ['.EE.', 'EEEE', '.EE.'])
            for x in range(5, 12): put(g, x, 7, 'E')
    if look['gear'] == 'tricorn':                         # a gold monocle ring on the right eye, and its chain
        for x, y in ((12, 10), (13, 10), (11, 11), (11, 12), (11, 13), (11, 14), (14, 11), (14, 12), (14, 13), (14, 14), (12, 15), (13, 15)): put(g, x, y, 'A')
    if look['gear'] == 'goggles':                         # a strap across the hair and two round lenses
        for x in range(1, 19): put(g, x, 6, 'k')
        for ox in (4, 11):
            stamp(g, ox, 3, ['.KKK.', 'KGGgK', 'KGGGK', '.KKK.'])
    if look['gear'] in ('deckhand', 'assistant'):         # neko ears: hair-colored with a pink inside
        for side in (0, 1):
            m = (lambda x: 19 - x) if side else (lambda x: x)
            for x, y, c in ((3, 1, 'h'), (4, 1, 'H'), (2, 2, 'h'), (3, 2, 'H'), (4, 2, 'B'), (5, 2, 'H'), (2, 3, 'h'), (3, 3, 'H'), (4, 3, 'B'), (5, 3, 'B'), (6, 3, 'H'),
                            (3, 4, 'h'), (4, 4, 'H'), (5, 4, 'H'), (6, 4, 'H')):
                put(g, m(x), y, c)
    if look['gear'] in ('buns', 'storyboard'):            # two round buns tied with ribbon
        for side in (0, 1):
            m = (lambda x: 19 - x) if side else (lambda x: x)
            for x, y, c in ((2, 1, 'H'), (3, 1, 'H'), (4, 1, 'h'), (1, 2, 'h'), (2, 2, 'w'), (3, 2, 'H'), (4, 2, 'H'), (5, 2, 'h'), (1, 3, 'h'), (2, 3, 'H'), (3, 3, 'H'), (4, 3, 'H'),
                            (5, 3, 'h'), (1, 4, 'h'), (2, 4, 'H'), (3, 4, 'H'), (4, 4, 'H'), (5, 4, 'h'), (2, 5, 'h'), (3, 5, 'h'), (4, 5, 'A'), (5, 5, 'A'), (4, 6, 'A'), (5, 6, 'A')):
                put(g, m(x), y, c)
    gr = look['gear']
    dx = 1 if mood == 'work' else 0
    def ring(x0, ch):                                      # round glasses: a ring around each eye (shifts with the gaze)
        for ex in (x0 + dx, x0 + 6 + dx):
            for x, y in ((ex + 1, 10), (ex + 2, 10), (ex, 11), (ex, 12), (ex, 13), (ex, 14), (ex + 3, 11), (ex + 3, 12), (ex + 3, 13), (ex + 3, 14), (ex + 1, 15), (ex + 2, 15)): put(g, x, y, ch)
        for x in range(x0 + dx + 4, x0 + dx + 6): put(g, x, 12, ch)
    if gr == 'beret':                                      # a tilted orange beret with a stem
        for y, row in ((1, '..........aa........'), (2, '.....AAAAAAAAAA.....'), (3, '....AAAAAAAAAAAA....'), (4, '...AAAAAAAAAAAAAA...'), (5, '...aaaaaaaaaaaaaa...')):
            for x, ch in enumerate(row): put(g, x, y, ch)
        for x, y in ((6, 3), (7, 3), (5, 4)): put(g, x, y, 'K')
    if gr == 'phones':                                     # big headphones: a band over the head and two ear cups
        for x in range(5, 15): put(g, x, 2, 'k')
        for x, y in ((4, 3), (15, 3), (3, 4), (16, 4), (3, 5), (16, 5), (2, 6), (17, 6), (2, 7), (17, 7), (2, 8), (17, 8)): put(g, x, y, 'k')
        for side in (0, 1):
            m = (lambda x: 19 - x) if side else (lambda x: x)
            for y in range(9, 14):
                put(g, m(1), y, 'a'); put(g, m(2), y, 'A'); put(g, m(3), y, 'A')
            put(g, m(2), 11, 'K'); put(g, m(3), 11, 'K')
    if gr == 'producer': ring(5, 'K')
    if gr == 'archivist': ring(5, 'A')
    if gr == 'visor':                                      # an editor's green eyeshade and a red pen behind the ear
        for x in range(2, 18): put(g, x, 6, 'K'); put(g, x, 7, 'K')
        for x in range(3, 17): put(g, x, 8, 'k')
        for x, y in ((4, 6), (5, 6), (6, 6)): put(g, x, y, 'W')
        for x, y, c in ((17, 11, 'W'), (17, 12, 'A'), (17, 13, 'A'), (17, 14, 'A')): put(g, x, y, c)
    if gr == 'smock':                                      # a pencil behind the left ear
        for x, y, c in ((2, 11, 'B'), (2, 12, 'A'), (2, 13, 'A'), (2, 14, 'A'), (2, 15, 'F')): put(g, x, y, c)
    if gr == 'storyboard':                                 # a pencil stuck through the right bun
        for x, y, c in ((15, 3, 'K'), (16, 2, 'K'), (17, 1, 'K'), (18, 1, 'B')): put(g, x, y, c)
    # body
    rowset(g, BODY)
    if gear['body']: rowset(g, gear['body'])
    details = {
        'captain':  [(9, 20, 'K'), (10, 20, 'K'), (9, 22, 'K'), (10, 22, 'K')],                      # gold buttons
        'beanie':   [(9, 19, 'K'), (10, 19, 'K'), (9, 20, 'K'), (10, 20, 'K'), (9, 21, 'K'), (10, 21, 'K')],   # white shirt under the vest
        'bandana':  [(7, 19, 'A'), (8, 20, 'A'), (9, 21, 'A'), (10, 22, 'A'), (11, 22, 'A')],        # a sash
        'tricorn':  [(8, 19, 'A'), (8, 20, 'A'), (8, 21, 'A'), (8, 22, 'A'), (11, 19, 'A'), (11, 20, 'A'), (11, 21, 'A'), (11, 22, 'A')],   # gold lapels
        'goggles':  [(8, 19, 'K'), (8, 20, 'K'), (11, 19, 'K'), (11, 20, 'K'), (9, 21, 'k'), (10, 21, 'k'), (9, 22, 'k'), (10, 22, 'k')],   # overall straps and a pocket
        'sunhat':   [(7, 19, 'k'), (8, 19, 'k'), (8, 20, 'k'), (9, 20, 'k'), (9, 21, 'k'), (10, 21, 'k'), (10, 22, 'k'), (11, 22, 'k'), (11, 23, 'k'), (12, 23, 'k')],          # a satchel strap
        'blade':    [(7, 19, 'A'), (8, 20, 'A'), (9, 21, 'A'), (10, 22, 'A')],                       # a red sash
    }
    for x, y, c in details.get(look['gear'], []): put(g, x, y, c)
    if look['gear'] == 'blade':                           # sword hilt behind the right shoulder
        for x, y in ((17, 16), (18, 16), (18, 17), (18, 18), (18, 19), (17, 19)): put(g, x, y, 'K')
        put(g, 17, 17, 'A')
    if look['gear'] == 'buns':
        stamp(g, 9, 19, ['KK']); put(g, 9, 20, 'K')       # a compass on a chain
    if gr == 'beret':                                      # an orange scarf
        for x in range(8, 12): put(g, x, 18, 'A')
        for x, y in ((11, 19), (11, 20), (12, 20)): put(g, x, y, 'A')
    if gr == 'bucket':                                     # a camera on a strap
        stamp(g, 8, 20, ['ZZZZ', 'ZzzZ', 'ZZZZ'])
    if gr == 'producer':                                   # a tie
        for x, y, c in ((9, 18, 'a'), (10, 18, 'a'), (9, 19, 'A'), (10, 19, 'A'), (9, 20, 'A'), (10, 20, 'A'), (9, 21, 'A'), (10, 21, 'A'), (9, 22, 'a'), (10, 22, 'a')): put(g, x, y, c)
    if gr == 'archivist':                                  # a scarf
        for x in range(7, 13): put(g, x, 18, 'K')
        for x, y in ((11, 19), (11, 20), (11, 21)): put(g, x, y, 'K')
    if gr == 'smock':                                      # paint splashes on the smock
        for x, y, c in ((8, 20, 'B'), (9, 21, 'D'), (11, 19, 'A'), (7, 22, 'D'), (12, 21, 'B'), (10, 22, 'A')): put(g, x, y, c)
    if gr == 'assistant':                                  # a hoodie: drawstrings and a pocket
        for x, y in ((9, 19), (9, 20), (10, 19), (10, 20)): put(g, x, y, 'K')
        for x in range(8, 12): put(g, x, 22, 'c')
    if gr in ('beret', 'bucket', 'phones', 'smock', 'assistant', 'storyboard', 'visor', 'none'):    # a studio ID card
        for x, y, c in ((12, 20, 'W'), (13, 20, 'W'), (12, 21, 'W'), (13, 21, 'W'), (12, 22, 'A'), (13, 22, 'A')): put(g, x, y, c)
    if look['gear'] not in ('buns', 'tricorn', 'deckhand', 'beret', 'bucket', 'producer', 'archivist', 'assistant', 'storyboard'):                # a bow tie at the collar
        for x, y, c in ((8, 18, 'A'), (9, 18, 'a'), (10, 18, 'a'), (11, 18, 'A'), (9, 19, 'A'), (10, 19, 'A')): put(g, x, y, c)
    legs(g, pose)
    for x, y in ((5, 26), (6, 26), (13, 26), (14, 26)):          # a toe highlight on each boot
        if g[y][x] == 'F': g[y][x] = 'f'
    # light from the top left: lit left arm, shaded right arm and torso edge
    for y in range(19, 23):
        for x in (4, 5):
            if g[y][x] == 'c': g[y][x] = 'C'
        for x in (14, 15):
            if g[y][x] == 'C': g[y][x] = 'c'
        if g[y][13] == 'C': g[y][13] = 'c'
    for x, y in ((1, 14), (18, 14), (1, 10), (18, 10)):          # taper the lock tips
        if g[y][x] in ('h', 'H'): g[y][x] = None
    return g

def outline(g, pal):
    out = [row[:] for row in g]
    dark = '#140a24'
    cols = {}
    for y in range(H):
        for x in range(W):
            if g[y][x] is not None: continue
            for dx, dy in ((0, 1), (-1, 0), (1, 0), (0, -1)):      # below first: the soft side
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and g[ny][nx] is not None:
                    cols[(x, y)] = blend(pal[g[ny][nx]], dark, 0.9); break
    return out, cols

def paint(g, pal, scale, ox=0, oy=0, img=None, crop_rows=None):
    g2, ol = outline(g, pal)
    d = ImageDraw.Draw(img)
    rows = crop_rows or H
    for y in range(rows):
        for x in range(W):
            c = pal[g[y][x]] if g[y][x] is not None else ol.get((x, y))
            if c: d.rectangle([ox + x * scale, oy + y * scale, ox + (x + 1) * scale - 1, oy + (y + 1) * scale - 1], fill=c)

def font(n): return ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', n)

def sheet(name='1-crew.png', scale=11, light=False):
    names = list(LOOKS)
    pw, ph = W * scale + 36, H * scale + 70
    img = Image.new('RGB', (5 * pw + 20, 2 * ph + 20), (60, 44, 30) if light else (22, 20, 34))
    d = ImageDraw.Draw(img)
    for k, n in enumerate(names):
        ox, oy = 10 + (k % 5) * pw, 10 + (k // 5) * ph
        d.rectangle([ox, oy, ox + pw - 8, oy + ph - 8], fill=(168, 116, 67) if light else (52, 44, 84))
        paint(build(LOOKS[n]), palette(LOOKS[n]), scale, ox + 14, oy + 10, img)
        d.text((ox + 10, oy + H * scale + 20), n.replace(' ', '\n', 1), fill=(235, 230, 250), font=font(14))
    img.save(os.path.join(HERE, name))

def moods(name='2-moods.png', scale=11, who='captain Kaito'):
    ms = ['normal', 'happy', 'sleepy', 'stuck', 'wow']
    pw, ph = W * scale + 36, H * scale + 56
    img = Image.new('RGB', (5 * pw + 20, ph + 20), (22, 20, 34)); d = ImageDraw.Draw(img)
    for k, m in enumerate(ms):
        ox, oy = 10 + k * pw, 10
        d.rectangle([ox, oy, ox + pw - 8, oy + ph - 8], fill=(52, 44, 84))
        paint(build(LOOKS[who], m), palette(LOOKS[who]), scale, ox + 14, oy + 10, img)
        d.text((ox + 14, oy + H * scale + 20), {'normal': 'working', 'happy': 'done', 'sleepy': 'idle', 'stuck': 'stuck', 'wow': 'needs you'}[m], fill=(235, 230, 250), font=font(14))
    img.save(os.path.join(HERE, name))

def walk(name='3-walk.png', scale=9, who='navigator Mira'):
    ps = ['stand', 'step-a', 'step-b']
    pw, ph = W * scale + 24, H * scale + 24
    img = Image.new('RGB', (3 * pw + 20, ph + 20), (22, 20, 34)); d = ImageDraw.Draw(img)
    for k, p in enumerate(ps):
        ox, oy = 10 + k * pw, 10
        d.rectangle([ox, oy, ox + pw - 8, oy + ph - 8], fill=(52, 44, 84))
        paint(build(LOOKS[who], 'normal', p), palette(LOOKS[who]), scale, ox + 8, oy + 8, img)
    img.save(os.path.join(HERE, name))

if __name__ == '__main__':
    sheet(); moods(); walk(); print('done')


WHO = 'navigator Mira'
def eye_test(name='eyes.png', scale=14):
    import chibi as me
    pw, ph = W * scale + 20, 19 * scale + 50
    img = Image.new('RGB', (4 * pw + 20, ph + 20), (22, 20, 34)); d = ImageDraw.Draw(img)
    for k, v in enumerate('GHIK'):
        me.EYE = v
        ox, oy = 10 + k * pw, 10
        d.rectangle([ox, oy, ox + pw - 8, oy + ph - 8], fill=(52, 44, 84))
        paint(build(LOOKS[WHO]), palette(LOOKS[WHO]), scale, ox + 10, oy + 8, img, crop_rows=19)
        d.text((ox + 10, oy + 19 * scale + 18), 'eyes ' + v, fill=(235, 230, 250), font=font(14))
    img.save(os.path.join(HERE, name))

def scene(name='4-actual-size.png', unit=3):
    # The crew at their real size: one sprite pixel = `unit` screen pixels (a terminal cell is 1 pixel wide, 2 tall in half-blocks).
    names = list(LOOKS)[:6]
    seat_w = 36
    img = Image.new('RGB', (len(names) * seat_w * unit + 30, 24 * unit * 2 + 60), (122, 190, 236)); d = ImageDraw.Draw(img)
    d.rectangle([0, 18 * unit * 2, img.width, img.height], fill=(168, 116, 67))
    for k, n in enumerate(names):
        ox = 15 + k * seat_w * unit
        pal = palette(LOOKS[n]); g = build(LOOKS[n])
        paint(g, pal, unit, ox + 4 * unit, 6 * unit, img, crop_rows=20)
        d.rectangle([ox + 1 * unit, 6 * unit + 20 * unit - 4 * unit, ox + 34 * unit, 6 * unit + 28 * unit - 6 * unit], fill=(233, 228, 242))
        d.rectangle([ox + 1 * unit, 6 * unit + 24 * unit - 6 * unit, ox + 34 * unit, 6 * unit + 24 * unit - 4 * unit], fill=(189, 182, 207))
        d.rectangle([ox + 20 * unit, 6 * unit + 6 * unit, ox + 32 * unit, 6 * unit + 17 * unit], fill=(27, 31, 39))
        d.rectangle([ox + 22 * unit, 6 * unit + 8 * unit, ox + 30 * unit, 6 * unit + 15 * unit], fill=(13, 29, 58))
        d.text((ox + 4 * unit, 6 * unit + 29 * unit), n.split(' ')[-1], fill=(255, 255, 255), font=font(12))
    img.save(os.path.join(HERE, name))

def FIRST(): return list(LOOKS)[0]

def board(name='0-design-board.png', scale=8):
    """Everything on one page: the crew, the moods, a walk cycle."""
    names = list(LOOKS)
    cw, ch = W * scale + 14, H * scale + 44
    width = 5 * cw + 20
    rowh = H * scale + 12
    img = Image.new('RGB', (width, 34 + 2 * ch + 2 * (rowh + 34) + 10), (60, 44, 30)); d = ImageDraw.Draw(img)
    d.text((14, 8), 'agent-radar crew (design only; original characters)', fill=(255, 240, 220), font=font(15))
    for k, n in enumerate(names):
        ox, oy = 10 + (k % 5) * cw, 34 + (k // 5) * ch
        d.rectangle([ox, oy, ox + cw - 6, oy + ch - 6], fill=(168, 116, 67))
        paint(build(LOOKS[n]), palette(LOOKS[n]), scale, ox + 7, oy + 6, img)
        d.text((ox + 8, oy + H * scale + 12), n, fill=(255, 255, 255), font=font(12))
    def strip(y, title, items):
        d.text((14, y), title, fill=(255, 240, 220), font=font(13))
        for k, (who, m, p) in enumerate(items):
            ox = 10 + k * cw
            d.rectangle([ox, y + 22, ox + cw - 6, y + 22 + rowh - 6], fill=(168, 116, 67))
            paint(build(LOOKS[who], m, p), palette(LOOKS[who]), scale, ox + 7, y + 26, img)
    y = 34 + 2 * ch + 4
    strip(y, 'faces for each state: working, done, idle, stuck, needs you', [(FIRST(), m, 'stand') for m in ('normal', 'happy', 'sleepy', 'stuck', 'wow')])
    strip(y + rowh + 34, 'walking: stand, step, step (' + list(LOOKS)[3] + '), then ' + list(LOOKS)[6] + ' in both steps', [(list(LOOKS)[3], 'normal', p) for p in ('stand', 'step-a', 'step-b')] + [(list(LOOKS)[6], 'normal', p) for p in ('step-a', 'step-b')])
    img.save(os.path.join(HERE, name))

def scene(name='4-actual-size.png', unit=4):
    """The crew at real size: one sprite pixel is `unit` screen pixels; a seat is 36 sprite pixels wide (18 room pixels)."""
    names = list(LOOKS)[:6]
    seat_w = 36
    img = Image.new('RGB', (len(names) * seat_w * unit + 20, 30 * unit + 40), (122, 190, 236)); d = ImageDraw.Draw(img)
    d.rectangle([0, 11 * unit, img.width, img.height], fill=(168, 116, 67))
    for k, n in enumerate(names):
        ox = 10 + k * seat_w * unit
        paint(build(LOOKS[n]), palette(LOOKS[n]), unit, ox + 1 * unit, 4 * unit, img, crop_rows=20)
        d.rectangle([ox + 1 * unit, 4 * unit + 20 * unit - 1 * unit, ox + 35 * unit, 4 * unit + 23 * unit], fill=(233, 228, 242))
        d.rectangle([ox + 1 * unit, 4 * unit + 22 * unit, ox + 35 * unit, 4 * unit + 24 * unit], fill=(189, 182, 207))
        d.rectangle([ox + 24 * unit, 4 * unit + 8 * unit, ox + 34 * unit, 4 * unit + 19 * unit], fill=(27, 31, 39))
        d.rectangle([ox + 25 * unit, 4 * unit + 9 * unit, ox + 33 * unit, 4 * unit + 17 * unit], fill=(13, 29, 58))
        d.text((ox + 2 * unit, 4 * unit + 25 * unit), n.split(' ')[-1], fill=(255, 255, 255), font=font(12))
    img.save(os.path.join(HERE, name))

def eye_test(name='eyes.png', scale=11, variants=('S1', 'S2', 'S3', 'S4'), whos=('navigator Mira', 'swordsman Ren', 'shipwright Bolt')):
    import chibi as me
    pw, ph = W * scale + 14, 19 * scale + 14
    img = Image.new('RGB', (len(variants) * pw + 20, len(whos) * ph + 50), (60, 44, 30)); d = ImageDraw.Draw(img)
    for k, v in enumerate(variants):
        me.EYE = v
        d.text((10 + k * pw + 6, 8), 'eyes ' + v, fill=(255, 240, 220), font=font(14))
        for j, who in enumerate(whos):
            ox, oy = 10 + k * pw, 34 + j * ph
            d.rectangle([ox, oy, ox + pw - 6, oy + ph - 6], fill=(168, 116, 67))
            paint(build(LOOKS[who]), palette(LOOKS[who]), scale, ox + 6, oy + 4, img, crop_rows=19)
    img.save(os.path.join(HERE, name))

def office_mock(name='5-office-mock.png', u=4):
    """The new crew in a deck-and-galley mock: tables, screens, name tags, status bubbles, the galley with finished agents."""
    seat_w, seat_h = 36, 36                      # sprite pixels (18 room pixels at 2 each)
    cols = 5
    width = cols * seat_w * u + 20
    wall_h = 18 * u
    top = wall_h + 4 * u
    height = top + 2 * seat_h * u // 1 + 30 * u
    img = Image.new('RGB', (width, 120 * u + 60), (122, 190, 236)); d = ImageDraw.Draw(img)
    # sky, sea, rail, lanterns
    d.rectangle([0, 0, width, 8 * u], fill=(61, 143, 214)); d.rectangle([0, 8 * u, width, 12 * u], fill=(95, 179, 236))
    d.rectangle([0, 12 * u, width, 15 * u], fill=(47, 127, 196)); d.rectangle([0, 15 * u, width, 17 * u], fill=(31, 95, 158))
    d.rectangle([0, 17 * u, width, 18 * u], fill=(138, 90, 51))
    for x in range(8 * u, width, 54 * u): d.rectangle([x, 13 * u, x + 5 * u, 17 * u], fill=(244, 117, 33)); d.rectangle([x + 1 * u, 14 * u, x + 4 * u, 15 * u], fill=(255, 197, 143))
    # deck planks
    for y in range(18 * u, img.height, 6 * u):
        d.rectangle([0, y, width, y + 6 * u - 1], fill=(168, 116, 67) if ((y // (6 * u)) % 2) else (156, 106, 59)); d.line([0, y + 6 * u - 1, width, y + 6 * u - 1], fill=(110, 70, 39))
    roster = [('captain Kaito', 'thinking'), ('lookout Pip', 'reading'), ('navigator Mira', 'typing'), ('swordsman Ren', 'waiting'), ('shipwright Bolt', 'terminal')]
    screens = {'thinking': (11, 29, 58), 'reading': (242, 232, 213), 'typing': (13, 17, 23), 'waiting': (248, 81, 73), 'terminal': (1, 4, 9)}
    ty = 22 * u
    for k, (who, act) in enumerate(roster):
        ox = 10 + k * seat_w * u
        look = LOOKS[who]; pal = palette(look)
        mood = 'wow' if act == 'waiting' else 'normal'
        paint(build(look, mood), pal, u, ox + 2 * u, ty, img, crop_rows=20)
        # table, chair back, screen
        d.rectangle([ox + 2 * u, ty + 19 * u, ox + 34 * u, ty + 24 * u], fill=(201, 154, 98)); d.rectangle([ox + 2 * u, ty + 19 * u, ox + 34 * u, ty + 20 * u], fill=(221, 181, 127))
        d.rectangle([ox + 2 * u, ty + 24 * u, ox + 34 * u, ty + 30 * u], fill=(138, 90, 51))
        d.rectangle([ox + 24 * u, ty + 8 * u, ox + 34 * u, ty + 19 * u], fill=(27, 31, 39)); d.rectangle([ox + 25 * u, ty + 9 * u, ox + 33 * u, ty + 17 * u], fill=screens[act])
        if act == 'reading':
            for yy in (10, 12, 14): d.rectangle([ox + 26 * u, ty + yy * u, ox + 32 * u, ty + yy * u + u - 1], fill=(139, 148, 158))
        if act in ('typing', 'terminal'):
            for yy, ww in ((10, 6), (12, 4), (14, 5)): d.rectangle([ox + 26 * u, ty + yy * u, ox + (26 + ww) * u, ty + yy * u + u - 1], fill=(63, 185, 80) if act == 'terminal' else (121, 192, 255))
        # bubble
        if act in ('thinking', 'waiting'):
            bx, by = ox + 21 * u, ty - 1 * u
            d.rounded_rectangle([bx, by, bx + 8 * u, by + 5 * u], radius=u, fill=(200, 40, 34) if act == 'waiting' else (255, 255, 255))
            d.text((bx + 3 * u, by + 0 * u), '!' if act == 'waiting' else '…', fill=(255, 255, 255) if act == 'waiting' else (27, 31, 39), font=font(4 * u))
        # name tag
        label = who.split(' ')[-1]
        tw = len(label) * 7 + 10
        tx = ox + 18 * u - tw // 2
        d.rounded_rectangle([tx, ty + 31 * u, tx + tw, ty + 31 * u + 16], radius=4, fill=(244, 117, 33) if k == 0 else (255, 246, 232))
        d.text((tx + 5, ty + 31 * u + 1), label, fill=(42, 22, 8) if k == 0 else (42, 35, 64), font=font(12))
    # galley: two finished agents (dim) and one stuck
    gy = ty + 43 * u
    d.rectangle([0, gy - 2 * u, width, img.height], fill=(122, 82, 50))
    for y in range(gy, img.height, 3 * u): d.line([0, y, width, y], fill=(94, 62, 37))
    for k, (who, mood, sym) in enumerate([('quartermaster Vance', 'happy', 'sparkle'), ('archaeologist Sora', 'happy', 'sparkle'), ('spotter Rachael', 'stuck', 'sweat')]):
        ox = 10 + (k * 22 + 6) * u
        look = LOOKS[who]; pal = palette(look, dim=True)
        paint(build(look, mood), pal, u, ox, gy - 4 * u, img)
        sx = ox + 21 * u
        if sym == 'sparkle':
            for dx, dy in ((1, 0), (0, 1), (1, 1), (2, 1), (1, 2)): d.rectangle([sx + dx * u, gy + dy * u, sx + dx * u + u - 1, gy + dy * u + u - 1], fill=(255, 243, 163))
        else:
            for dx, dy in ((1, 0), (0, 1), (1, 1), (0, 2), (1, 2)): d.rectangle([sx + dx * u, gy + (dy + 2) * u, sx + dx * u + u - 1, gy + (dy + 2) * u + u - 1], fill=(124, 200, 255))
        label = who.split(' ')[-1]; tw = len(label) * 7 + 10
        d.rounded_rectangle([ox + 10 * u - tw // 2, gy + 25 * u, ox + 10 * u + tw // 2, gy + 25 * u + 16], radius=4, fill=(58, 53, 80))
        d.text((ox + 10 * u - tw // 2 + 5, gy + 25 * u + 1), label, fill=(216, 212, 234), font=font(12))
    img = img.crop((0, 0, width, gy + 25 * u + 26))
    img.save(os.path.join(HERE, name))

def chip(d, x, y, text, f, fill=(36, 26, 58), fg=(255, 255, 255)):
    w = d.textlength(text, font=f)
    d.rounded_rectangle([x - 4, y - 2, x + w + 4, y + f.size + 2], radius=4, fill=fill)
    d.text((x, y), text, fill=fg, font=f)

def office_mock(name='5-office-mock.png', u=4):
    """The crew in context: six at their tables (each state's mark in the same head-level slot), and the galley."""
    seat_w = 36
    width = 6 * seat_w * u + 20
    img = Image.new('RGB', (width, 118 * u + 40), (122, 190, 236)); d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width, 8 * u], fill=(61, 143, 214)); d.rectangle([0, 8 * u, width, 12 * u], fill=(95, 179, 236))
    d.rectangle([0, 12 * u, width, 15 * u], fill=(47, 127, 196)); d.rectangle([0, 15 * u, width, 17 * u], fill=(31, 95, 158))
    d.rectangle([0, 17 * u, width, 18 * u], fill=(138, 90, 51))
    for x in range(8 * u, width, 54 * u):
        d.rectangle([x, 13 * u, x + 5 * u, 17 * u], fill=(244, 117, 33)); d.rectangle([x + u, 14 * u, x + 4 * u, 15 * u], fill=(255, 197, 143))
    for y in range(18 * u, img.height, 6 * u):
        d.rectangle([0, y, width, y + 6 * u - 1], fill=(168, 116, 67) if ((y // (6 * u)) % 2) else (156, 106, 59)); d.line([0, y + 6 * u - 1, width, y + 6 * u - 1], fill=(110, 70, 39))
    def px(x, y, w, h, c): d.rectangle([x, y, x + w * u - 1, y + h * u - 1], fill=c)
    def bubble(x, y, kind):
        # one slot, up and to the right of the head: a rounded bubble with a dark rim and a glyph
        fills = {'think': (255, 255, 255), 'wait': (200, 30, 40), 'stuck': (200, 30, 40), 'idle': (225, 232, 255), 'done': (255, 243, 163)}
        glyph = {'think': '…', 'wait': '!', 'stuck': 'x', 'idle': 'z', 'done': '+'}[kind]
        ink = (27, 31, 39) if kind in ('think', 'idle', 'done') else (255, 255, 255)
        d.rounded_rectangle([x - 1, y - 1, x + 8 * u + 1, y + 5 * u + 1], radius=u + 1, fill=(27, 31, 39))
        d.rounded_rectangle([x, y, x + 8 * u, y + 5 * u], radius=u, fill=fills[kind])
        f = font(5 * u)
        d.text((x + 8 * u / 2 - d.textlength(glyph, font=f) / 2, y - u / 2), glyph, fill=ink, font=f)
    ty = 24 * u
    roster = [('captain Kaito', 'think', 'work'), ('lookout Pip', None, 'work'), ('navigator Mira', None, 'work'),
              ('swordsman Ren', 'wait', 'wow'), ('shipwright Bolt', None, 'work'), ('quartermaster Vance', 'idle', 'sleepy')]
    screen_kind = ['think', 'read', 'type', 'wait', 'term', 'off']
    for k, (who, mark, mood) in enumerate(roster):
        ox = 10 + k * seat_w * u
        look = LOOKS[who]; pal = palette(look)
        paint(build(look, mood), pal, u, ox + 2 * u, ty, img, crop_rows=20)
        px(ox + 2 * u - 0, ty + 19 * u, 32, 5, (201, 154, 98)); px(ox + 2 * u, ty + 19 * u, 32, 1, (221, 181, 127)); px(ox + 2 * u, ty + 24 * u, 32, 6, (138, 90, 51))
        px(ox + 24 * u, ty + 8 * u, 10, 11, (27, 31, 39))
        sx, sy = ox + 25 * u, ty + 9 * u
        kind = screen_kind[k]
        if kind == 'off': d.rectangle([sx, sy, sx + 8 * u - 1, sy + 8 * u - 1], fill=(22, 27, 34))
        if kind == 'think':
            d.rectangle([sx, sy, sx + 8 * u - 1, sy + 8 * u - 1], fill=(11, 29, 58))
            for i in range(3): d.rectangle([sx + (1 + i * 3) * u, sy + 4 * u, sx + (1 + i * 3) * u + u - 1, sy + 5 * u - 1], fill=(120, 170, 255))
        if kind == 'read':
            d.rectangle([sx, sy, sx + 8 * u - 1, sy + 8 * u - 1], fill=(242, 232, 213))
            for yy in (1, 3, 5): d.rectangle([sx + u, sy + yy * u, sx + 6 * u, sy + yy * u + u - 1], fill=(139, 148, 158))
        if kind == 'type':
            d.rectangle([sx, sy, sx + 8 * u - 1, sy + 8 * u - 1], fill=(13, 17, 23))
            for yy, ind, ww, col in ((1, 0, 4, (126, 231, 135)), (2, 2, 5, (121, 192, 255)), (3, 2, 3, (255, 166, 87)), (4, 0, 5, (210, 168, 255)), (5, 2, 4, (121, 192, 255))):
                d.rectangle([sx + (1 + ind) * u, sy + yy * u + u // 2, sx + (1 + ind + ww) * u - 1, sy + yy * u + u // 2 + u - 1], fill=col)
        if kind == 'term':
            d.rectangle([sx, sy, sx + 8 * u - 1, sy + 8 * u - 1], fill=(1, 4, 9))
            for dx, dy in ((1, 1), (2, 2), (1, 3)): d.rectangle([sx + dx * u, sy + dy * u, sx + dx * u + u - 1, sy + dy * u + u - 1], fill=(63, 185, 80))
            d.rectangle([sx + 4 * u, sy + 3 * u, sx + 6 * u - 1, sy + 4 * u - 1], fill=(63, 185, 80))
            d.rectangle([sx + 1 * u, sy + 5 * u, sx + 5 * u - 1, sy + 6 * u - 1], fill=(40, 120, 55))
        if kind == 'wait':
            d.rectangle([sx, sy, sx + 8 * u - 1, sy + 8 * u - 1], fill=(200, 30, 40))
            d.rectangle([sx + 3 * u, sy + 1 * u, sx + 5 * u - 1, sy + 4 * u - 1], fill=(255, 255, 255)); d.rectangle([sx + 3 * u, sy + 5 * u, sx + 5 * u - 1, sy + 6 * u - 1], fill=(255, 255, 255))
        if mark: bubble(ox + 22 * u, ty - 3 * u, mark)
        label = who.split(' ')[-1]
        chip(d, ox + 18 * u - d.textlength(label, font=font(max(8, 3 * u))) / 2, ty + 32 * u, label, font(max(8, 3 * u)), fill=(244, 117, 33) if k == 0 else (255, 246, 232), fg=(42, 22, 8) if k == 0 else (42, 35, 64))
    gy = ty + 46 * u
    d.rectangle([0, gy - 3 * u, width, img.height], fill=(122, 82, 50))
    for y in range(gy, img.height, 3 * u): d.line([0, y, width, y], fill=(94, 62, 37))
    galley = [('archaeologist Sora', 'happy', 'done', True), ('deckhand', 'happy', 'done', True), ('spotter Rachael', 'stuck', 'stuck', False)]
    for k, (who, mood, mark, dim) in enumerate(galley):
        ox = 10 + (k * 24 + 6) * u
        look = LOOKS[who]; pal = palette(look, dim=dim)
        paint(build(look, mood), pal, u, ox, gy - 6 * u, img)
        bubble(ox + 16 * u, gy - 9 * u, mark)
        label = who.split(' ')[-1]
        chip(d, ox + 10 * u - d.textlength(label, font=font(max(8, 3 * u))) / 2, gy + 24 * u, label, font(max(8, 3 * u)), fill=(58, 53, 80), fg=(216, 212, 234))
    img = img.crop((0, 0, width, min(img.height, gy + 24 * u + 30)))
    img.save(os.path.join(HERE, name))

def safer(name='6-safer-palette.png', scale=8):
    """Kaito, Mira and Ren as they are, and with hair colors that echo no existing crew."""
    import copy
    rows = [('as drawn', {}), ('safer hair colors', {'navigator Mira': dict(hair='#6b3a8a'), 'swordsman Ren': dict(hair='#b8324a', accent='#2fb59a'), 'captain Kaito': dict(hair='#e9edf7')})]
    who = ['captain Kaito', 'navigator Mira', 'swordsman Ren']
    cw = W * scale + 14
    img = Image.new('RGB', (3 * cw + 20, 2 * (H * scale + 40) + 20), (60, 44, 30)); d = ImageDraw.Draw(img)
    for r, (title, over) in enumerate(rows):
        for k, n in enumerate(who):
            look = dict(LOOKS[n]); look.update(over.get(n, {}))
            ox, oy = 10 + k * cw, 10 + r * (H * scale + 40)
            d.rectangle([ox, oy, ox + cw - 6, oy + H * scale + 34], fill=(168, 116, 67))
            paint(build(look), palette(look), scale, ox + 7, oy + 4, img)
        chip(d, 14, 10 + r * (H * scale + 40) + H * scale + 8, title, font(12))
    img.save(os.path.join(HERE, name))

# ---- the animation studio crew -------------------------------------------------------------------------------
LOOKS_STUDIO = {
    'director Kaito':        dict(hair='#e9edf7', eye='#e5484d', skin='#ffe6d5', outfit='#2b2d6b', accent='#f47521', kit='#ffb27a', gear='beret', style='spiky', pants='#2b2a4a'),
    'location scout Pip':    dict(hair='#59b0ff', eye='#06b6d4', skin='#c98e63', outfit='#4a8f6a', accent='#3b8fe0', kit='#e3c27a', gear='bucket', style='messy', pants='#3a4a5a'),
    'sound engineer Rachael':   dict(hair='#f7c95e', eye='#a855f7', skin='#e9b98f', outfit='#454a63', accent='#f47521', kit='#2d2f3a', gear='phones', style='bob', pants='#2a2a38'),
    'storyboard artist Mira':dict(hair='#ff9248', eye='#10b8d8', skin='#ffe6d5', outfit='#20a3a0', accent='#ffd166', kit='#c9a227', gear='storyboard', style='buns', pants='#27403f'),
    'producer Vance':        dict(hair='#a99be0', eye='#f59e0b', skin='#f4cfb0', outfit='#4d4577', accent='#e5484d', kit='#2d2f3a', gear='producer', style='bob', pants='#2f2748'),
    'QC editor Ren':         dict(hair='#3fb878', eye='#a855f7', skin='#f6d5b8', outfit='#6b45b0', accent='#d23c3c', kit='#8fe0d0', gear='visor', style='long', pants='#2f2548'),
    'animator Bolt':         dict(hair='#8a5a3c', eye='#ec4899', skin='#ecb891', outfit='#efe7d8', accent='#f2cc60', kit='#3a2a1e', gear='smock', style='messy', pants='#4a3524'),
    'archivist Sora':        dict(hair='#a8603a', eye='#f59e0b', skin='#d9a273', outfit='#7f9444', accent='#c28a2b', kit='#e3cd94', gear='archivist', style='long', pants='#4a5030'),
    'assistant':             dict(hair='#dcb98c', eye='#10b981', skin='#8f5b3a', outfit='#ff8fb0', accent='#e5484d', kit='#f3f0ff', gear='assistant', style='buns', pants='#2a3050'),
    'intern':                dict(hair='#d86fa0', eye='#3b82f6', skin='#ffe6d5', outfit='#6a56a8', accent='#ffd166', kit='#c9d1d9', gear='none', style='messy', pants='#2f2a45'),
}
LOOKS_PIRATE = dict(LOOKS)

def studio_mock(name='8-studio-mock.png', u=4):
    """An animation studio at night: window on the city, a STUDIO neon sign, a storyboard corkboard, six desks, and a break room with a ramen counter."""
    seat_w = 36
    width = 6 * seat_w * u + 20
    H_ = 124 * u + 40
    img = Image.new('RGB', (width, H_), (40, 34, 72)); d = ImageDraw.Draw(img)
    def box(x, y, w, h, c): d.rectangle([x, y, x + w - 1, y + h - 1], fill=c)
    # back wall
    box(0, 0, width, 22 * u, (43, 37, 71)); box(0, 0, width, u, (33, 28, 58)); box(0, 20 * u, width, 2 * u, (59, 51, 102))
    # night window with a city skyline and a moon
    wx, wy, ww, wh = 8 * u, 3 * u, 46 * u, 15 * u
    box(wx - u, wy - u, ww + 2 * u, wh + 2 * u, (58, 42, 30)); box(wx, wy, ww, wh, (20, 26, 61)); box(wx, wy + 8 * u, ww, 7 * u, (28, 36, 84))
    box(wx + 36 * u, wy + 2 * u, 3 * u, 3 * u, (255, 241, 184))
    import random
    rnd = random.Random(7)
    x = wx
    while x < wx + ww:
        bw = rnd.choice([4, 5, 6]) * u; bh = rnd.choice([5, 7, 9, 11]) * u
        box(x, wy + wh - bh, min(bw, wx + ww - x), bh, (22, 28, 72))
        for wy2 in range(wy + wh - bh + u, wy + wh - u, 3 * u):
            if rnd.random() < 0.55: box(x + u, wy2, u, u, (255, 214, 120))
        x += bw
    box(wx + ww // 2 - u // 2, wy, u, wh, (58, 42, 30))
    # neon sign
    sx, sy, sw, sh = 66 * u, 4 * u, 44 * u, 12 * u
    d.rounded_rectangle([sx - u, sy - u, sx + sw + u, sy + sh + u], radius=2 * u, fill=(244, 117, 33))
    d.rounded_rectangle([sx, sy, sx + sw, sy + sh], radius=2 * u, fill=(26, 19, 48))
    f = font(8 * u)
    tw = d.textlength('STUDIO', font=f)
    d.text((sx + sw / 2 - tw / 2, sy + sh / 2 - 5 * u), 'STUDIO', fill=(255, 190, 120), font=f)
    d.text((sx + sw / 2 - tw / 2 + 1, sy + sh / 2 - 5 * u + 1), 'STUDIO', fill=(244, 117, 33), font=f)
    # clapperboard
    cx, cy = 116 * u, 6 * u
    box(cx, cy + 3 * u, 12 * u, 9 * u, (36, 36, 44)); box(cx, cy, 12 * u, 3 * u, (245, 245, 245))
    for i in range(0, 12, 4): box(cx + i * u, cy, 2 * u, 3 * u, (36, 36, 44))
    box(cx + u, cy + 6 * u, 4 * u, u, (245, 245, 245)); box(cx + u, cy + 8 * u, 6 * u, u, (245, 245, 245))
    # storyboard corkboard
    kx, ky, kw, kh = 136 * u, 3 * u, 70 * u, 16 * u
    box(kx - u, ky - u, kw + 2 * u, kh + 2 * u, (110, 74, 40)); box(kx, ky, kw, kh, (184, 137, 90))
    panels = [(244, 244, 240), (255, 238, 200), (210, 232, 255), (255, 214, 224), (225, 240, 210), (255, 238, 200), (210, 232, 255)]
    for i, c in enumerate(panels):
        px_, py_ = kx + (2 + i * 9.5) * u, ky + (2 + (i % 2) * 6) * u
        box(int(px_), int(py_), 8 * u, 6 * u, c)
        box(int(px_) + u, int(py_) + 4 * u, 3 * u, u, (90, 130, 200)); box(int(px_) + 4 * u, int(py_) + u, 2 * u, 2 * u, (244, 117, 33))
        box(int(px_) + 3 * u, int(py_) - u, 2 * u, u, (229, 72, 77))
    # carpet floor
    box(0, 22 * u, width, H_, (141, 119, 154))
    for y in range(22 * u, H_, 8 * u):
        for x in range(0 if (y // (8 * u)) % 2 == 0 else 8 * u, width, 16 * u): box(x, y, 8 * u, 8 * u, (150, 128, 163))
    def bubble(x, y, kind):
        fills = {'think': (255, 255, 255), 'wait': (200, 30, 40), 'stuck': (200, 30, 40), 'idle': (225, 232, 255), 'done': (255, 243, 163)}
        glyph = {'think': '…', 'wait': '!', 'stuck': 'x', 'idle': 'z', 'done': '+'}[kind]
        ink = (27, 31, 39) if kind in ('think', 'idle', 'done') else (255, 255, 255)
        d.rounded_rectangle([x - 1, y - 1, x + 8 * u + 1, y + 5 * u + 1], radius=u + 1, fill=(27, 31, 39))
        d.rounded_rectangle([x, y, x + 8 * u, y + 5 * u], radius=u, fill=fills[kind])
        ff = font(5 * u)
        d.text((x + 8 * u / 2 - d.textlength(glyph, font=ff) / 2, y - u / 2), glyph, fill=ink, font=ff)
    roster = [('Lead', 'director Kaito', 'think', 'work', 'think'), ('Explore', 'location scout Pip', None, 'work', 'read'),
              ('Plan', 'storyboard artist Mira', None, 'work', 'draw'), ('Reviewer', 'QC editor Ren', 'wait', 'wow', 'wait'),
              ('Builder', 'animator Bolt', None, 'work', 'draw2'), ('Architect', 'producer Vance', 'idle', 'sleepy', 'off')]
    ty = 28 * u
    lf = font(max(8, 3 * u))
    for k, (label, who, mark, mood, screen) in enumerate(roster):
        ox = 10 + k * seat_w * u
        look = LOOKS_STUDIO[who]; pal = palette(look)
        paint(build(dict(look, held=None, quirks=[q for q in look.get('quirks', []) if q != 'tail']), mood), pal, u, ox + 2 * u, ty, img, crop_rows=20)
        box(ox + 2 * u, ty + 19 * u, 32 * u, 5 * u, (239, 233, 245)); box(ox + 2 * u, ty + 19 * u, 32 * u, u, (255, 255, 255)); box(ox + 2 * u, ty + 24 * u, 32 * u, 6 * u, (200, 191, 214))
        # mug with steam, a plush on the other end of the desk
        box(ox + 21 * u, ty + 16 * u, 3 * u, 3 * u, (255, 246, 232)); box(ox + 24 * u - 0, ty + 17 * u, 0, 0, (0, 0, 0)) if False else None
        # monitor
        box(ox + 24 * u, ty + 8 * u, 10 * u, 11 * u, (27, 31, 39))
        sx_, sy_ = ox + 25 * u, ty + 9 * u
        def scr(c): d.rectangle([sx_, sy_, sx_ + 8 * u - 1, sy_ + 8 * u - 1], fill=c)
        if screen == 'off': scr((22, 27, 34))
        if screen == 'think':
            scr((11, 29, 58))
            for i in range(3): box(sx_ + (1 + i * 3) * u, sy_ + 4 * u, u, u, (120, 170, 255))
        if screen == 'read':
            scr((242, 232, 213))
            for yy in (1, 3, 5): box(sx_ + u, sy_ + yy * u, 6 * u, u, (139, 148, 158))
        if screen == 'draw':       # a storyboard panel being drawn
            scr((250, 247, 238)); box(sx_ + u, sy_ + u, 6 * u, 4 * u, (200, 224, 255)); box(sx_ + 2 * u, sy_ + 3 * u, 2 * u, 2 * u, (244, 117, 33)); box(sx_ + u, sy_ + 6 * u, 4 * u, u, (90, 90, 110))
        if screen == 'draw2':      # animation frames on a timeline
            scr((30, 26, 52))
            for i in range(3): box(sx_ + (1 + i * 2) * u, sy_ + u, u * 2 - 1 if False else 2 * u - 2, 3 * u, (255, 255, 255) if i == 1 else (120, 110, 160))
            box(sx_ + u, sy_ + 5 * u, 6 * u, u, (63, 185, 80)); box(sx_ + 3 * u, sy_ + 5 * u, u, u, (255, 255, 255))
        if screen == 'wait':
            scr((200, 30, 40)); box(sx_ + 3 * u, sy_ + u, 2 * u, 3 * u, (255, 255, 255)); box(sx_ + 3 * u, sy_ + 5 * u, 2 * u, u, (255, 255, 255))
        # a prop on the table top, in front of the person (a 3/4 view: flat things, seen from above)
        py_ = ty + 20 * u
        def tbox(x, w, h, col, dy=0): box(ox + x * u, py_ + dy * u, w * u, h * u, col)
        if k == 0:    # a clapperboard
            tbox(4, 10, 3, (36, 36, 44), 1); tbox(4, 10, 1, (245, 245, 245), 0)
            for i in range(0, 10, 3): tbox(4 + i, 1, 1, (36, 36, 44), 0)
            tbox(5, 4, 1, (245, 245, 245), 2)
        if k == 1:    # a camera and a folded map
            tbox(4, 7, 3, (45, 47, 58), 1); tbox(6, 3, 2, (127, 214, 255), 1); tbox(13, 6, 3, (240, 220, 160), 1); tbox(15, 1, 3, (120, 90, 60), 1)
        if k == 2:    # a sketchbook with panels and a pencil
            tbox(4, 11, 4, (250, 247, 238), 0); tbox(5, 4, 2, (200, 224, 255), 1); tbox(10, 4, 2, (255, 214, 224), 1); tbox(16, 7, 1, (255, 209, 102), 2); tbox(23, 1, 1, (255, 143, 177), 2)
        if k == 3:    # a clipboard with a checklist and a red pen
            tbox(4, 8, 5, (138, 90, 51), 0); tbox(5, 6, 4, (250, 247, 238), 1); tbox(6, 4, 1, (200, 200, 210), 0)
            for i in (1, 2, 3): tbox(6, 4, 1, (139, 148, 158), i + 0) if False else None
            tbox(6, 1, 1, (63, 185, 80), 2); tbox(8, 2, 1, (139, 148, 158), 2); tbox(6, 1, 1, (229, 72, 77), 3); tbox(8, 2, 1, (139, 148, 158), 3); tbox(14, 6, 1, (210, 60, 60), 2)
        if k == 4:    # a drawing tablet and a stylus
            tbox(4, 12, 4, (45, 47, 58), 0); tbox(5, 10, 3, (70, 74, 96), 1); tbox(7, 2, 1, (255, 143, 177), 2); tbox(17, 5, 1, (230, 230, 240), 2)
        if k == 5:    # a phone, a coffee and a folder
            tbox(4, 3, 4, (45, 47, 58), 0); tbox(5, 1, 2, (120, 170, 255), 1); tbox(9, 4, 4, (255, 246, 232), 0); tbox(10, 2, 1, (122, 74, 42), 1); tbox(15, 8, 4, (240, 200, 110), 0)
        if mark: bubble(ox + 22 * u, ty - 3 * u, mark)
        tw_ = d.textlength(label, font=lf)
        chip(d, ox + 18 * u - tw_ / 2, ty + 32 * u, label, lf, fill=(244, 117, 33) if k == 0 else (255, 246, 232), fg=(42, 22, 8) if k == 0 else (42, 35, 64))
    # break room
    gy = ty + 53 * u
    box(0, gy - 3 * u, width, H_, (216, 200, 170))
    for y in range(gy - 3 * u, H_, 6 * u):
        for x in range(0 if ((y - gy) // (6 * u)) % 2 == 0 else 6 * u, width, 12 * u): box(x, y, 6 * u, 6 * u, (206, 188, 156))
    box(0, gy - 3 * u, width, u, (122, 74, 42))
    # ramen counter with bowls and stools
    cx0 = 100 * u
    box(cx0, gy + 2 * u, 70 * u, 6 * u, (122, 74, 42)); box(cx0, gy + 2 * u, 70 * u, u, (170, 108, 62)); box(cx0, gy + 8 * u, 70 * u, 8 * u, (94, 56, 32))
    for i in range(3):
        bx = cx0 + (10 + i * 22) * u
        box(bx, gy - u, 8 * u, 3 * u, (255, 255, 255)); box(bx + u, gy, 6 * u, u, (232, 160, 70)); box(bx + 2 * u, gy - 2 * u, 2 * u, u, (255, 220, 120))
        for sx_off, sy_off in ((3, -4), (4, -5), (3, -6), (4, -7)): box(bx + sx_off * u, gy + sy_off * u, u, u, (255, 255, 255))
        box(bx + u, gy + 17 * u, 6 * u, 2 * u, (229, 72, 77)); box(bx + 3 * u, gy + 19 * u, 2 * u, 5 * u, (60, 60, 70))
    # vending machine
    vx = width - 22 * u
    box(vx, gy - 6 * u, 14 * u, 26 * u, (229, 69, 83)); box(vx, gy + 16 * u, 14 * u, 4 * u, (168, 44, 56)); box(vx + 2 * u, gy - 4 * u, 10 * u, 12 * u, (191, 230, 255))
    for ry in (0, 5):
        for i, c in enumerate([(63, 185, 80), (242, 204, 96), (88, 166, 255), (255, 143, 191)]): box(vx + (3 + i * 2) * u, gy - 3 * u + ry * u, u + 1 if False else u, 3 * u, c)
    box(vx + 3 * u, gy + 11 * u, 8 * u, 3 * u, (60, 20, 28))
    box(vx - 6 * u, gy + 8 * u, 4 * u, 5 * u, (255, 255, 255)); box(vx - 6 * u, gy + 8 * u, 4 * u, u, (244, 117, 33))
    galley = [('archivist Sora', 'happy', 'done', True, 'Research'), ('assistant', 'happy', 'done', True, 'General'), ('sound engineer Rachael', 'stuck', 'stuck', False, 'Scout')]
    for k, (who, mood, mark, dim, label) in enumerate(galley):
        ox = 10 + (k * 24 + 4) * u
        look = LOOKS_STUDIO[who]; pal = palette(look, dim=dim)
        paint(build(look, mood), pal, u, ox, gy - 8 * u, img)
        bubble(ox + 16 * u, gy - 11 * u, mark)
        tw_ = d.textlength(label, font=lf)
        chip(d, ox + 10 * u - tw_ / 2, gy + 24 * u, label, lf, fill=(58, 53, 80), fg=(216, 212, 234))
    img = img.crop((0, 0, width, min(img.height, gy + 24 * u + 34)))
    img.save(os.path.join(HERE, name))
