# The arena cast (gladiators and judges) as grids for the mod: used by export_crew.py.
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chibi_gladiators as cg, chibi_judges as cj, chibi_emperor as ce

MOODS = ['normal', 'work', 'wow', 'sleepy', 'happy', 'stuck']
POSES = ['stand', 'step-a', 'step-b']

def rows(g, a, b):
    return [''.join(c if c else '.' for c in g[y]) for y in range(a, b)]

def cast(builder, looks, bare):
    sprites, outs, names = [], [], []
    for look in looks:
        nohold = dict(look, **bare)
        sprites.append(dict(
            head={m: rows(builder(nohold, m, 'stand'), 0, 18) for m in MOODS},
            seatBody=rows(builder(nohold, 'normal', 'stand'), 18, 20),
            body=rows(builder(look, 'normal', 'stand'), 18, 24),
            legs={p: rows(builder(look, 'normal', p), 24, 28) for p in POSES}))
        outs.append(dict(hair=look['hair'], eyes=look['eye'], skin=look['skin'], outfit=look['outfit'], accent=look['accent'], kit=look['kit'], pants=look['pants']))
    return sprites, outs

def arena():
    g_sprites, g_looks = cast(cg.build_g, cg.GLADIATORS, dict(held=None, shield=None))
    j_sprites, j_looks = cast(cj.build_j, cj.JUDGES, dict(held=None))
    names = dict(gladiator=[l['cls'] for l in cg.GLADIATORS], judge=[f"judge {l['name']}" for l in cj.JUDGES])
    return dict(gladiator=g_sprites, judge=j_sprites), dict(gladiator=g_looks, judge=j_looks), names


def emperor():
    """The Lead in the colosseum: the same director Kaito in imperial dress, one look."""
    look = ce.EMPEROR
    sprite = dict(
        head={m: rows(ce.build_e(dict(look, held=None), m, 'stand'), 0, 18) for m in MOODS},
        seatBody=rows(ce.build_e(look, 'normal', 'stand'), 18, 20),
        body=rows(ce.build_e(look, 'normal', 'stand'), 18, 24),
        legs={p: rows(ce.build_e(look, 'normal', p), 24, 28) for p in POSES})
    out = dict(hair=look['hair'], eyes=look['eye'], skin=look['skin'], outfit=look['outfit'], accent=look['accent'], kit=look['kit'], pants=look['pants'])
    return sprite, out
