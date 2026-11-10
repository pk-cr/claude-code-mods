---
name: gauntlet
description: >-
  Make a few fresh Claude sub-agents compete on one hard task, then attack each other's answers,
  defend and revise, while a blind judge scores each match until one answer is left. Default 4
  competitors (9 agents started, about 22 sub-agent calls), for general hard tasks:
  code, analysis, design, writing, SQL and docs. Use
  when the user types /gauntlet, says "gauntlet" or "make them compete", or is not satisfied with
  an answer ("bad answer", "try again", "do better") on a task worth the extra tokens.
argument-hint: "[--agents 2|4|8] [--seed S] [--models mixed|sonnet] <task>"
---

# gauntlet

A small tournament for answers that matter. N sub-agents get the exact same task, each with a
different strategy card (lens + workflow + priority). They attack each other's solutions, defend
and revise, and a fresh blind judge scores each match on a written rubric. You are the
orchestrator. You never compete, attack or judge, and you never pick a winner.

What the user typed after `/gauntlet`: `$ARGUMENTS`

If that is blank, or still reads like a placeholder, take the task from the conversation.

## The tool

All bookkeeping goes through `gauntlet.py` in this skill's folder:

```bash
python3 "${CLAUDE_SKILL_DIR}/gauntlet.py" <command>
```

Below, `G` means exactly that command. If the path looks unexpanded, use the "Base directory for
this skill" printed at the top of this skill. Runs live in `.gauntlet/<run>/` in the current
directory, and every command after `init` finds the run through `.gauntlet/LATEST`. Run every `G`
command from the same directory.

## Models: Sonnet and Opus only

By default the competitors are mixed: half on Opus medium and half on Sonnet high, split at random
from the seed (not from the cards), with one Opus against one Sonnet in every round-1 match. The
rule: a gladiator never runs above Opus medium, so the judges stay stronger than every gladiator.
The match judges, the swap judge, the harvest check and the final check are Opus high in every mode
(`models.json`). `--models sonnet` (its old name `default` still works) puts every competitor on
Sonnet high. Which model and effort the gladiators should run on is a Phase B question, decided on
champion quality per dollar from paired runs. The Opus-vs-Sonnet line in `history` is a diagnostic
only: never use it to argue for a default. The gauntlet uses only `sonnet` and `opus`: `init` stops
on any other model (Haiku, Fable, or a full id outside those two families) and on a gladiator above
Opus medium. Never change a model yourself.

This skill explicitly asks you to set the model and effort of every agent it starts: each start job
that `next` prints has a `model:` and an `effort:` line. Pass them as the Agent tool's `model` and
`effort` parameters, exactly as printed. Without them, a plugin agent runs on its own definition
(delegate:builder is Sonnet medium, delegate:reviewer Sonnet high).

## Step 1: size it, and get a yes if nobody asked

| flag | meaning |
| --- | --- |
| `--agents N` | 2, 4 or 8 competitors. Default 4. 2 is a single duel. |
| `--seed S` | Fixes the cards, pairings and model split. Default: random, and recorded. |
| `--models M` | `mixed` (the default: half the competitors Opus medium, half Sonnet high, at random; round 1 is always Opus against Sonnet), `sonnet` (alias `default`: every competitor Sonnet high, as `models.json` says), or the path of a models file. Use `sonnet` only when the user asks for it or to keep the cost down. |

Run `G plan --agents N` (add `--baseline` if there is an answer to beat). It prints the agents
started, the resumed messages, the total and the models.

Cost: Opus costs twice as much per token as Sonnet. At medium effort it writes fewer tokens than at
high, but the real cost of the mixed default is not measured yet: `history` shows the real cost per
role and model once runs are rated. Say this when the user asks about cost.

- The user asked for it (`/gauntlet`, "gauntlet", "make them compete"): tell them the size in one
  line, for example "4 competitors, 2 rounds, up to 9 agents started, 22 calls", and start.
- The skill fired because the user is unhappy and never named it: ask once before spending
  anything. Offer: the gauntlet with 4 (about 22 calls), a duel with 2 (about 10 calls), or an
  ordinary retry. Wait for the answer.
- 8 competitors starts 16 agents (about 45 calls, 2.1x the cost of 4). That is the delegate mod's
  cap of 16 agents per turn and 16 of its 25 per session: one 8-run per session. The extras are
  skipped to stay at 16: the swap judge always, and with a baseline the harvest check too (the
  harvest's revision then goes out unjudged, and `winner` says so). A judge that has to run again
  cannot start in that turn: if that happens, tell the user and go on in their next message.

## Step 2: write the task file

This step decides the result. Sub-agents cannot see this conversation. Write
`.gauntlet/task.md` so a stranger could do the task from it alone:

- The request, in the user's own words where you can.
- Every requirement and constraint the user stated anywhere in the conversation: audience,
  length, format, deadline, what must not change, which phase the work is in.
- The standing rules the user has given (for example in CLAUDE.md) that apply to this kind of
  task, such as a required format, a naming convention or the scope of the current phase. These
  are the user's own requirements, so they belong in the task. Add only the ones that apply.
- The context a stranger needs: absolute paths of the files that matter (notebooks, `src/`,
  docs, CSV extracts already on disk), table and column names, definitions, the numbers already
  agreed.
- What "done" looks like, if the user said.
- If there is an answer to beat: what the user disliked about it, in their words.

Never put credentials, tokens, secret URLs or raw customer-level data into the task file.
Point at files instead of pasting data. Competitors cannot query a database or call outside
services: if the task needs fresh numbers, get them first, save them to a file, and point at it.

Do not add requirements the user never gave, and do not write your own view of the right answer
into the task. That pushes every competitor the same way, which defeats the point.

If there is an earlier answer the user rejected, write it word for word to
`.gauntlet/baseline.md`.

Before `init` on a real run (not a test): show the user the task file's requirements as a short
numbered list, and wait for an OK or a change. It takes about 30 seconds and it is the only check
that the task file says what they asked. Skip it for a test run. The ledger keeps a hash of the
task file, never its text.

## Step 3: init

```bash
G init --agents N --task-type T --task-file .gauntlet/task.md --baseline-file .gauntlet/baseline.md
```

`--task-type` is one of `code`, `analysis`, `design`, `writing`, `sql`, `docs`,
`other`: pick the closest. Leave out `--models` (mixed is the default); add `--models sonnet` or
`--seed S` only if the user asked. Leave out
`--baseline-file` when there is nothing to beat. If `init` stops on a models error, tell the user
the error: do not edit the models file to get past it. `init` writes `.gauntlet/.gitignore`
(`*`), so run folders stay out of git in any repo: they can hold numbers that must never be
committed. If `init` still warns that `.gauntlet/` is not git-ignored, add it to that repo's
`.gitignore` before you go on.

## Step 4: the loop

Drive everything with `G next`. It reads the state on disk, moves the run forward when a phase is
complete, writes the briefs, and prints every job still to run with the exact call to make.

For each `next`:

1. `next` groups the jobs into waves of at most 8 (the delegate mod's cap on agents running at
   once). Send each wave as parallel tool calls in ONE message, exactly as printed, and wait for
   every reply before you send the next wave. Only a phase with more than 8 jobs would need a
   second wave, and no phase has that many at the supported sizes (2, 4 or 8 competitors).
   - **start** jobs are Agent calls with the printed `subagent_type`, `description`, `model`,
     `effort` and `prompt`. Do not shorten the prompt: it carries the difficulty tag, scope,
     done-when line and return format that the delegate and agent-radar mods need. Keep the
     `description` too: agent-radar shows it on the card, so the person can tell competitor C from
     competitor D.
   - **resume** jobs are SendMessage calls to the competitor's registered agent id, with the
     printed message. Resuming keeps each competitor's own context and model, and does not count as
     a new agent. If SendMessage is not available or fails, start a fresh `delegate:builder` agent
     with the take-over call `next` prints under it (it names the competitor's card and latest
     solution; it costs one more start) and register its id. `register` records it as a restart.
2. After the spawn phase: `G register <letter> <agent id>` for each competitor, from the Agent
   results.
3. After each judge, swap judge or final reply: pipe the reply into `G verdict <job id>`,
   unchanged:

   ```bash
   G verdict r1m1 <<'EOF'
   <the judge's reply, exactly>
   EOF
   ```

   The script checks the scores, does the arithmetic and decides the winner. Never fix a score.
   If it rejects the JSON, give that judge a fresh run. A job has one verdict: `verdict` refuses a
   second one unless you pass `--rerun "<reason>"`, and the ledger counts every re-run. Re-run a
   judge only when its reply was broken or it was taken back, never to get another winner.
4. After every Agent or SendMessage result: `G tokens <job id> <n>`, with the token number the
   result reports. That number is the agent's context size at the end of the call, not the tokens
   it used: the ledger keeps it as `context_tokens`. If the result shows no number, skip it. Never
   estimate one.
5. After every wave, once all its replies are in (each wave in `next` ends with an `AFTER WAVE`
   line): `G tokens-from-radar`. It reads, never writes, agent-radar's live file
   (`~/.claude/agent-radar/live/<session id>.json`) and records each gauntlet agent's real
   cumulative tokens by kind (input, output, cache read, cache write). That file keeps the live
   agents and the newest 16 finished ones (agent-radar 1.6.0 or later), so one read after each
   wave of 8 finds every agent of it: no read is needed while a wave runs. It finds this session's file from the registered competitor ids. If it
   says it cannot find the file, or that more than one matches, get this session's id with the ccd
   `get_session` tool (session `"self"`) and pass `--session <id>`. If agent-radar is not on, it
   stops with an error: go on with the run, and say at the end that real usage was not recorded.
6. Run `G next` again. If an output is missing, it lists only the missing jobs: re-run those once.
   A competitor job (or the harvest) that fails twice: `G give-up <job id> --why "<what happened>"`.
   It writes `NO OUTPUT` into the job's missing outputs and records why. The swap judge and the
   harvest check may be given up the same way. A match judge or the final check that fails twice
   gets a third, fresh run: never decide a match yourself.
7. `next` also checks the run's integrity before it moves on:
   - It reads every sub-agent's transcript (read only) and lists what each job read or wrote
     outside its set: a judge outside its view folder, a gladiator in `state.json`, `verdicts/`,
     `views/`, another competitor's brief or another competitor's files. A judge whose verdict came
     from a transcript that read outside its view loses that verdict: `next` lists the judge again.
     Run it, and tell the user in one line.
   - It stops when a finished file changed after its phase ended (a sub-agent wrote into a file
     that was not its own). Tell the user which files. Go on with `G next --accept-changes` only if
     they say so: the ledger records it.

Phase order: **spawn** (every competitor writes a solution) → each round: **attack** (resume:
each attacks its opponent) → **defend** (resume: each answers the attacks and revises) →
**judge** (one fresh blind judge per match; it sees the pair as X and Y in its own view folder,
never as letters; in round 1 one match also gets a **swap judge**, job `r1mK-swap`, that sees the
pair in the other order: it measures position bias and only the first verdict counts) → next round
→ **harvest** (resume the champion once with every attack still standing from every match; it
concedes or rejects each one and writes one final revision, or NO CHANGE; skipped when nothing is
standing) → **check** (the harvest check: a blind judge compares the revision with the judged
solution and checks each REJECT; the revision goes out only if it is not worse; skipped when the
harvest changed nothing, or when no start is left under the cap) → **final** (only with a baseline:
a blind judge compares the champion's solution with the rejected answer) → DONE.

After each round, give the user one line, for example "Round 1 done: 2 of 4 left." Never paste
pairings, attacks, verdicts or solutions into the chat during the run.

## Step 5: the result

1. Optional blind pick, before the user sees the winner: offer it in one line ("Before the result:
   want to pick blind between the two finalists?"). If they want it, run `G blind`. It writes the
   two finalists, as the last judge saw them, to `X.md` and `Y.md` in seeded order. Give the user
   the two paths, and do not say or hint which one won. Note their pick (X or Y). If they decline,
   skip it.
2. Run `G winner`, then `G tokens-from-radar` once more (it catches the last wave), then read the champion's solution at the path it prints. That is the only
   solution file you read in the whole run. Give the user:
   1. The winning solution, in full.
   2. Why it won: the attacks it survived and any still standing, from `winner`, as a short list.
      Its card in one line, what the harvest changed, and the harvest check's result. If the
      revision went out unjudged (the cap), say so. If `winner` reports leaks, re-runs or accepted
      file changes, say so in one line. Never present "survived N attacks" or "N agents agreed" as
      independent confirmation: every agent is the same model family, and their mistakes overlap.
   3. Against the rejected answer, if there was one: the final scores, honestly. If the old answer
      scored higher, say so and show both.
   4. Where the full record lives: the run folder.

If the solution changes files in the user's project, do not apply it. Ask: apply it, or change it?
If it is a document for others, it still gets the usual no-ai-slop pass before it ships.

## Step 6: rate it

Ask the user once: did they accept the answer as it is, edit it, or reject it, and was anything
missing? Then record their answer, in their words:

```bash
G rate accepted|edited|rejected --missing "<what was missing>" --note "<anything else>" --pick X
```

Leave out the options they did not give (`--pick` only after `G blind`). Do not put numbers from
the task's data into the notes. `rate` appends one line to `~/.claude/gauntlet-log/ledger.jsonl`:
metadata only (cards, models, scores, word counts, attack counts by type, context sizes, real token
usage by agent and role with a cost estimate at list prices, file hashes, the user's verdict and
notes), never solution text. A test run, or one the user did not really use, gets `--sample`: it
goes to the ledger with `"sample": true`, and `history` leaves it out (`history --all` shows it). It refuses a run that is already rated. If it
fails with a permission error, the sandbox blocked the write: run the same `rate` command again
with the sandbox off.

`G history` reads the ledger: the runs, per-lens win rates, Opus against Sonnet in mixed runs,
real tokens and estimated cost per role and model, length bias, swap-judge agreement and the same-conclusion rate, each
labelled with the file versions it covers. Run it when the user asks how the gauntlet is doing.

## Rules for the orchestrator

- You run the tournament. You do not compete, attack or judge. `verdict` records what a judge
  decided, word for word.
- Every competitor gets the task byte for byte the same, from the one task file. Never add a hint
  to one agent's brief or message.
- Do not read solutions, attacks or verdicts during the run. `next` and `status` are all you need.
- If your context gets compacted mid-run, nothing is lost: `G status`, then `G next`. Agent ids
  are in the state file.
- Sub-agents write only inside the run folder. If one wrote anywhere else, tell the user.
- If the user says stop, stop. `G next` resumes the run later (resume jobs then need fresh agents
  if the old ids no longer answer).
- `G audit` prints what the transcripts show for the whole run: leaks, verdicts taken back, and
  whether each recorded verdict matches the judge's own last message. `rate` puts the same in the
  ledger.
