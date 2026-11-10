# Gauntlet: TLDR

**What it is:** `/gauntlet:gauntlet [--agents 2|4|8] <task>`. Fresh sub-agents (the "gladiators") solve
the same task with different strategies. They attack each other's answers, defend and revise, and blind
judges score each match until 1 answer is left. You get the winning answer, the attacks it survived, and
an honest score against any answer you rejected earlier.

## 1. The run (one tournament)

| Step | What happens | Who |
|---|---|---|
| Task file | The orchestrator writes `.gauntlet/task.md`: your request, your standing rules, file paths. No opinion about the answer. | Main session |
| Spawn | Each gladiator writes a solution, guided by its strategy card. | Gladiators (fresh agents) |
| Attack | Each one attacks its opponent: up to 6 typed flaws (WRONG, UNIT, DATA, MISSING, SCOPE, BREAKS, VAGUE). | Same gladiators, resumed |
| Defend | Each one concedes or rebuts every attack, then revises. | Same gladiators, resumed |
| Judge | A blind judge checks every attack and scores both answers. It sees only its own view folder, with the pair as X and Y. The script adds the totals and picks the winner. | Fresh judge per match |
| Swap judge | 1 match is judged again with the 2 answers in swapped order, to test position bias. | Fresh judge |
| Harvest | The champion answers every attack still standing from all matches, then revises once (or writes NO CHANGE). | Champion, resumed |
| Harvest check | A blind judge compares the revision with the judged answer and checks each REJECT. The revision goes out only if it is not worse. | Fresh judge |
| Final check | Only if you rejected an earlier answer: champion against that answer, blind. | Fresh judge |

## 2. The parts

- **Strategy cards** (`skills/gauntlet/cards.json`): 10 lenses (Data skeptic, What else moved, Test
  first, The decision-maker, Cost and benefit, ...), 6 workflows and 6 priorities. No 2 gladiators get the
  same lens.
- **Rubric** (`skills/gauntlet/rubric.md`): correctness 30, fit 20, robustness 20, actionability 15,
  honesty 15. A fatal flaw always loses. Length earns nothing.
- **Script** (`skills/gauntlet/gauntlet.py`): keeps the state on disk, writes every brief, does all the
  arithmetic, and survives a context compaction. Commands: `plan`, `init`, `next`, `give-up`,
  `register`, `verdict`, `tokens`, `tokens-from-radar`, `audit`, `status`, `blind`, `winner`, `rate`,
  `history`.
- **Integrity** (0.4.0): judge view folders, sealed files (`next` stops when a finished file changes),
  a transcript audit (a judge that read outside its view is taken back), one verdict per job
  (`--rerun` with a reason), recorded give-ups and restarts, and briefs that treat other agents' files
  as data.
- **Templates** (`skills/gauntlet/templates.md`): the exact briefs for competitors, attackers, defenders,
  judges, the harvest and the final check. Every gladiator gets the task byte for byte the same.
- **Models** (`skills/gauntlet/models.json`): the model and effort for each role.

## 3. Models and size

| Role | Model |
|---|---|
| Gladiators | **Mixed by default**: half Opus 5.5 medium, half Sonnet 5.5 high. Round 1 is always Opus against Sonnet. `--models sonnet` puts them all on Sonnet high. A gladiator never runs above Opus medium. |
| Judges, swap judge, harvest check, final check | Opus 5.5, high |
| Never used | Haiku, Fable |

| Gladiators | Agents started | Calls (at most) | Waves |
|---|---|---|---|
| 2 (duel) | 5 | 10 | 1 |
| 4 (default) | 9 | 22 | 1 |
| 8 | 16 | 45 | 1 (waves of 8) |

It fits the delegate caps (8 running, 16 per turn, 25 per session). An 8-gladiator run is about 1 per
session, and it skips the extras to stay at 16: the swap judge always, the harvest check too with a
baseline.

## 4. The learning layer (Phase A, live now)

- **Ledger:** `rate` writes 1 metadata-only line per run to `~/.claude/gauntlet-log/ledger.jsonl`. It stays
  on your machine. It records cards, models and efforts, scores, the judge's pick and
  margin, eliminations, typed attacks still standing, the swap-judge result, the harvest and harvest
  check, the audit, re-runs, restarts, give-ups, your verdict and your "what was missing" note. It never holds
  answer text. `--sample` marks a test run, which `history` leaves out unless you pass `--all`.
- **Real cost:** `tokens-from-radar` reads each agent's real token use from agent-radar's local file
  (read only) and estimates the cost at list prices.
- **`history`** reports:
  - wins per lens, each with an 80% interval
  - the Opus-against-Sonnet head-to-head by effort, labelled a diagnostic only (confounded by who
    attacks whom, by same-family judges and by matches that share a task)
  - cost per role
  - length bias, swap agreement, the same-conclusion rate, the harvest check and the audit
  - your verdicts

**What it does NOT do yet:** change its own behavior. The cards are still dealt at random, and no
lessons feed back. That is by design until the data exists.

## 5. Status and what is next

- **Known gaps:** the integrity layer and Opus medium gladiators need more live runs. Open Phase B items: a control arm, a two-judge panel, model and effort arms, the statistics.
- **Roadmap** (one phase at a time; each phase has a gate):

| Phase | What | Gate before it starts |
|---|---|---|
| A.1 | Integrity: views, audit, sealed files, harvest check, failure paths (done in 0.4.0) | - |
| B | Frozen benchmark with known answers or planted flaws, graded by a script or by you, not by judges. It holds the control arm (one Opus answer plus one review), and the model and **effort** arms for gladiators (for example Sonnet high, Opus low, Opus medium), compared on champion quality per dollar with a switch rule written before the data | You choose the tasks |
| C | A local, read-only verifier that runs queries and code against files on disk | B exists; nothing leaves the machine |
| D | A traps file and task-file checklists that you approve, each trap dated. Traps go to the verifier and the judges, never to gladiators | About 10 real runs |
| E | Card evolution from the ratings; a card changes only when the benchmark score does not drop | About 30 real runs and a statistics review |

**Next:** run the first real gauntlet on a hard task you would defend to a reviewer, then pick
`rate accepted|edited|rejected` at the end. That gives the ledger its first real line.
