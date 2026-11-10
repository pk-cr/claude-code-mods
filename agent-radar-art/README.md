# agent-radar art

Sources of the agent-radar studio crew. Not a mod: no `.claude-plugin`, so nothing here ships.

- `chibi.py`: shared pixel primitives (20 by 28 grid, hair styles, S4 eyes, moods, outline, paint helpers) and design-board drawing.
- `chibi_studio.py`: the ten studio characters (`CREW`): clothes, head gear, face quirks, held items, desk props' colors.
- `render_studio.py`: draws boards and a studio mock to PNG (design review only).
- `chibi_gladiators.py`, `chibi_judges.py`: the gauntlet's cast, eight gladiators (A to H) and eight judges in robes and wigs. `arena_export.py` turns them into grids.
- `export_crew.py`: writes `../agent-radar/hooks/crew.ts`, the grids the mod draws. Edit a character here, run it, then run the mod's tests.

```sh
python -I export_crew.py    # needs Pillow (chibi.py imports it)
```

Desk props and the studio room are drawn in code, in `agent-radar/hooks/office.ts` (`PROPS`, `paintWall`, `paintLounge`).
