# The gauntlet rubric

The judge scores both solutions in a match on this page. `gauntlet.py` does the arithmetic and
picks the winner from the scores. The judge never adds up the totals.

## The five criteria

Each criterion is scored 0 to 10. The weight is its share of the 100-point total.

| criterion | weight | the question |
| --- | --- | --- |
| Correctness | 30 | Is it right? Numbers, logic, SQL, statistics and causal claims hold up when you check them. Every percent says what it is a percent of. |
| Fit | 20 | Does it meet every requirement the task states, and stay inside the task's scope and phase? Judged against the task text only. |
| Robustness | 20 | Does it hold up against the attacks in this match: fixed, correctly rebutted, or still standing? |
| Actionability | 15 | Could the reader act on it now without guessing? Exact values, steps, names, queries, the decision it supports. |
| Honesty and clarity | 15 | Are assumptions and limits stated with their size, with no overclaiming? Is it easy to read at a length that fits, with no filler? |

Weighted total = (correctness x 30 + fit x 20 + robustness x 20 + actionability x 15 + honesty x 15) / 10,
a number from 0 to 100.

## Anchors

Use the whole scale. A 7 is not a polite default.

**Correctness**
- 10: nothing wrong that you can find after checking it yourself, including the arithmetic.
- 7: minor slips that do not change the conclusion.
- 4: at least one real error the reader would act on: a wrong number, a percent with the wrong base, a join that double counts, a causal claim the data cannot support.
- 0 to 2: wrong at the core.

**Fit**
- 10: every stated requirement met, nothing out of scope added.
- 7: every requirement touched, one thin.
- 4: a stated requirement missing, or a large part of the answer spent on a later phase or a different question.
- 0 to 2: answers a different question.

**Robustness**
- 10: every attack fixed or correctly rebutted, and nothing new broken.
- 7: one MINOR attack still standing.
- 4: a MAJOR attack still standing, or a fix that broke something else.
- 0 to 2: a FATAL attack still standing.

**Actionability**
- 10: the reader can act on every part immediately.
- 7: mostly concrete, one or two places need a guess.
- 4: a lot of "consider" and "it depends" without the actual answer.
- 0 to 2: generic advice that fits any task.

**Honesty and clarity**
- 10: every assumption labelled, every limit sized, no claim stronger than its evidence; tight and easy to use.
- 7: one unlabelled assumption or some padding.
- 4: confident claims with no numbers behind them, or the reader has to dig for the answer.
- 0 to 2: misleading about its own certainty, or hard to follow.

## The fatal rule

Set `fatal` only for a flaw you have verified that makes the solution wrong or unusable for the task:
a false central number or claim, a method that cannot work on the data described, a hard constraint
broken, a number presented as fact that has no source in the task, or the wrong question answered.
A fatal solution cannot beat one that is not fatal.

## Ties

`gauntlet.py` breaks an exact tie by fewer standing attacks, then by higher correctness, then by the
judge's `pick`. So `pick` must always name the one you would hand to the reader.

## What the judge does not reward

- Length. A tight answer that meets every requirement beats a long one that meets the same ones.
- A defense that says "fixed". Check the revised solution.
- The approach. Score the work, not the method behind it.
- Words about quality ("robust", "comprehensive", "rigorous") with nothing behind them.
- Your own taste where the task does not ask for it.
