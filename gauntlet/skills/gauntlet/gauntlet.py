#!/usr/bin/env python3
"""gauntlet.py - bookkeeping for the /gauntlet skill.

A small single-elimination tournament: N competitors (2, 4 or 8) solve the same task, each with a
different strategy card, then attack each other, defend and revise, and a fresh judge scores each
match. Competitors are RESUMED for the attack and defend steps (SendMessage), so a 4-competitor run
starts only 8 agents: 4 competitors, 3 judges and 1 swap judge (and 1 final check with a baseline).

The measurement layer: every start job names its model and effort (models.json, Sonnet and Opus
only); one round-1 match gets a second judge with the pair in swapped order; the champion is resumed
once to concede or reject every attack still standing before the final check; `rate` appends one
metadata-only line per run to the ledger (~/.claude/gauntlet-log/ledger.jsonl) that `history` reads.

All state is in <run_dir>/state.json. Every command after init finds the run through .gauntlet/LATEST
in the current directory. Standard library only.

Token usage comes from agent-radar's live file (~/.claude/agent-radar/live/<session id>.json), read
only: `tokens-from-radar` copies each gauntlet agent's cumulative tokens by kind into the state, and
`rate` puts them in the ledger with a cost estimate. `tokens` keeps the number an Agent or SendMessage
result shows, which is the agent's context size at the end of that call, as `context_tokens`.

Commands: plan, init, next, give-up, register, verdict, tokens, tokens-from-radar, audit, status, blind,
winner, rate, history.
"""
import argparse
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
ROOT = Path(".gauntlet")
WEIGHTS = {"correctness": 30, "fit": 20, "robustness": 20, "actionability": 15, "honesty": 15}
SIZES = (2, 4, 8)
LETTERS = "ABCDEFGH"
NO_OUTPUT = "NO OUTPUT"   # a job given up on (or one that failed)
NO_CHANGE = "NO CHANGE"   # the harvest found nothing to change: the judged solution stands
# Judges see each pair as X and Y, never as the competitor letters, so no earlier verdict maps onto a match.
LABELS = ("X", "Y")
# Words in a solution or defense that may be text aimed at the judge. They are flagged to the judge, never
# removed: "judgment", "score" and "competitor" are ordinary words in analysis work and are not here.
META_TEXT = re.compile(r"\b(judges?|rubric|gauntlet|strategy card|score (?:this|it|me|us)|"
                       r"ignore (?:the|all|any|previous|above|your))\b", re.I)
# Caps of the delegate mod (defaults): agents started per turn and per session.
CAP_TURN, CAP_SESSION = 16, 25
# The delegate mod's cap on agents running at once (maxLive, 8 from delegate 0.1.4). next prints jobs in
# waves of this size. No phase at the supported sizes has more than 8 jobs, so every phase is one wave.
WAVE = 8
# Rule: the gauntlet runs on Sonnet and Opus only. No Haiku, no Fable. These are the Agent tool's names.
MODELS = ("sonnet", "opus")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Rule: gladiators max out at Opus medium, so the judges (Opus high) stay stronger than every gladiator.
GLADIATOR_OPUS_MAX = "medium"
ROLES = ("competitor", "judge", "swap_judge", "final", "harvest_check")
TASK_TYPES = ("code", "analysis", "design", "writing", "sql", "docs", "other")
USER_VERDICTS = ("accepted", "edited", "rejected")
ATTACK_TYPES = ("WRONG", "UNIT", "DATA", "MISSING", "SCOPE", "BREAKS", "VAGUE")
VERSION_KEYS = ("rubric", "cards", "templates", "models")
# Token kinds in agent-radar's live file (tokenCounts), and list prices per 1M tokens for the cost
# estimate. Cache writes cost 1.25x the input price. An estimate only: not a bill.
TOKEN_KINDS = ("input", "output", "cacheRead", "cacheWrite")
PRICES = {"sonnet": {"input": 2.0, "output": 10.0, "cacheRead": 0.20},
          "opus": {"input": 4.0, "output": 20.0, "cacheRead": 0.20}}
CACHE_WRITE = 1.25
PRICE_NOTE = ("estimate at list prices per 1M tokens: sonnet $2 in, $10 out, $0.20 cache read; opus $4 in, "
              "$20 out, $0.20 cache read; cache write 1.25x input")
SESSION_ID = r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}"
# One line of the harvest log: `ITEM H1: CONCEDE. ...`, also `H1: CONCEDE`, `ITEM 1 - REJECT` or `- H2: REJECT`.
HARVEST_LINE = r"^[\s*>-]*(?:ITEM\s*)?H?\d+\s*[:.)\-]?\s*\**\s*"


def die(msg):
    print(f"gauntlet: {msg}", file=sys.stderr)
    sys.exit(2)


def log_dir():
    """The ledger's folder: ~/.claude/gauntlet-log, or $GAUNTLET_LOG_DIR (the tests use one)."""
    return Path(os.environ.get("GAUNTLET_LOG_DIR") or Path.home() / ".claude" / "gauntlet-log")


def radar_dir():
    """agent-radar's live folder, read only: ~/.claude/agent-radar/live, or $GAUNTLET_RADAR_DIR (the tests use one)."""
    return Path(os.environ.get("GAUNTLET_RADAR_DIR") or Path.home() / ".claude" / "agent-radar" / "live")


def transcripts_root():
    """Claude Code's transcripts, read only: ~/.claude/projects, or $GAUNTLET_TRANSCRIPTS_DIR (the tests use one).
    Each session's sub-agents are in <project>/<session>/subagents/agent-<agent id>.jsonl."""
    return Path(os.environ.get("GAUNTLET_TRANSCRIPTS_DIR") or Path.home() / ".claude" / "projects")


def sha(path):
    p = Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16] if p.exists() else None


# ---------- state ----------

def latest_dir():
    p = ROOT / "LATEST"
    if not p.exists():
        die("no run here. Run init first, from the directory you want the run in.")
    return Path(p.read_text().strip())


def started_of(run_dir):
    """A run's start time from its folder name (20261014-173441), for runs made before init stored it."""
    m = re.search(r"(\d{8}-\d{6})", Path(run_dir).name)
    return time.mktime(time.strptime(m.group(1), "%Y%m%d-%H%M%S")) if m else None


def upgrade(st):
    """Fill the fields that a run made before the measurement layer does not have."""
    if "models" not in st:
        roles = read_models(SKILL_DIR / "models.json")
        st["models"] = {"mode": "default", "file": str(SKILL_DIR / "models.json"), "roles": roles,
                        "competitors": {x: dict(roles["competitor"]) for x in st["cards"]}}
    for k, v in (("task_type", "other"), ("swap", {"match": None, "why": "older run", "verdict": None}),
                 ("tokens", {}), ("jobmeta", {}), ("harvest", None), ("finalists", None),
                 ("blind_map", None), ("rated", False), ("versions", {}), ("radar", None), ("done_at", None),
                 ("check", {"planned": False, "why": "older run", "verdict": None}), ("hashes", {}),
                 ("audit", {"available": None, "folder": None, "leaks": [], "voided": []}), ("reruns", []),
                 ("restarts", []), ("no_output", {}), ("agent_ids_all", {}), ("task_sha", None), ("integrity", [])):
        st.setdefault(k, v)
    if "started" not in st:
        st["started"] = started_of(st["run_dir"])
    st["models"]["roles"].setdefault("harvest_check", dict(st["models"]["roles"]["judge"]))
    return st


def load():
    d = latest_dir()
    return upgrade(json.loads((d / "state.json").read_text())), d


def save(st, d):
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(st, indent=2))
    tmp.replace(d / "state.json")


def filled(path):
    """An output counts once it exists and is not blank. NO OUTPUT counts (a job given up on)."""
    p = Path(path)
    return p.exists() and p.read_text().strip() != ""


def is_no_output(path):
    p = Path(path)
    return p.exists() and p.read_text().strip() == NO_OUTPUT


def is_kept(path):
    """NO OUTPUT (failed) or NO CHANGE (nothing to change): either way the earlier solution stands."""
    p = Path(path)
    return p.exists() and p.read_text().strip() in (NO_OUTPUT, NO_CHANGE)


def words_of(path):
    p = Path(path)
    if not p.exists() or is_kept(p):
        return 0
    return len(p.read_text().split())


def seal(st, paths):
    """Record the hash of each finished output. `next` checks them all: a file that changes after its phase
    ended means a sub-agent wrote into a file that was not its own."""
    for p in paths:
        if Path(p).exists():
            st["hashes"][str(p)] = sha(p)


def tampered(st):
    return [p for p, h in st["hashes"].items() if sha(p) != h]


def rel(st, path):
    """A path as the ledger and the messages show it: inside the run folder, relative to it."""
    try:
        return str(Path(path).resolve().relative_to(Path(st["run_dir"])))
    except ValueError:
        return "outside the run folder"


def run_id(st):
    return f"{Path(st['run_dir']).name}-s{st['seed']}"


# ---------- templates and cards ----------

def template(name):
    text = (SKILL_DIR / "templates.md").read_text()
    m = re.search(rf"<!-- template:{name} -->\n(.*?)\n<!-- /template:{name} -->", text, re.S)
    if not m:
        die(f"template {name} missing from templates.md")
    return m.group(1)


def fill(text, **kw):
    """Fill {{placeholders}} in one pass, so text put in (a judge's note) is never read as a placeholder."""
    left = sorted(set(re.findall(r"\{\{(\w+)\}\}", text)) - set(kw))
    if left:
        die(f"unfilled placeholders: {left}")
    return re.sub(r"\{\{(\w+)\}\}", lambda m: str(kw[m.group(1)]), text)


def deal(n, seed):
    cards = json.loads((SKILL_DIR / "cards.json").read_text())
    rng = random.Random(f"{seed}-cards")
    picks = {}
    for kind in ("lenses", "workflows", "priorities"):
        pool = list(cards[kind])
        rng.shuffle(pool)
        # Distinct while the list lasts, then wrap. Lenses (10) never wrap for n <= 8.
        picks[kind] = [pool[i % len(pool)] for i in range(n)]
    return {
        LETTERS[i]: {"lens": picks["lenses"][i], "workflow": picks["workflows"][i], "priority": picks["priorities"][i]}
        for i in range(n)
    }


def pair(alive, seed, rnd, models=None):
    """Seeded pairs. With models (a mixed run), round 1 puts one opus against one sonnet in every match."""
    rng = random.Random(f"{seed}-round-{rnd}")
    if rnd == 1 and models:
        opus = [x for x in alive if models[x]["model"] == "opus"]
        sonnet = [x for x in alive if models[x]["model"] == "sonnet"]
        if len(opus) == len(sonnet):
            rng.shuffle(opus)
            rng.shuffle(sonnet)
            return [[o, s] if rng.random() < 0.5 else [s, o] for o, s in zip(opus, sonnet)]
    order = list(alive)
    rng.shuffle(order)
    return [order[i:i + 2] for i in range(0, len(order), 2)]


# ---------- models ----------

def model_alias(value, where):
    """sonnet or opus. A full id of those families (claude-opus-5-5) reads as its family. Anything else stops."""
    v = str(value).strip().lower()
    if v in MODELS:
        return v
    m = re.fullmatch(r"claude-(?:[a-z0-9.]+-)*?(sonnet|opus)(?:-[a-z0-9.]+)*", v)
    if m and not re.search(r"haiku|fable", v):
        return m.group(1)
    die(f"{where}: model {value!r} is not allowed. The gauntlet runs on {' and '.join(MODELS)} only "
        "(no Haiku, no Fable).")


def effort_of(value, where):
    v = str(value).strip().lower()
    if v not in EFFORTS:
        die(f"{where}: effort {value!r} is not one of {', '.join(EFFORTS)}")
    return v


def read_models(path):
    """Role -> {model, effort} from a models file, every role checked. swap_judge may name another role."""
    try:
        raw = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as err:
        die(f"cannot read the models file {path}: {err}")
    roles = raw.get("roles") if isinstance(raw, dict) else None
    if not isinstance(roles, dict):
        die(f"{path}: needs a \"roles\" object with {', '.join(ROLES)}")
    unknown = sorted(set(roles) - set(ROLES))
    if unknown:
        die(f"{path}: unknown role(s) {unknown}; the roles are {', '.join(ROLES)}")
    roles = dict(roles)
    roles.setdefault("swap_judge", "judge")
    roles.setdefault("harvest_check", "judge")
    out = {}
    for role in ROLES:
        spec = roles.get(role)
        if isinstance(spec, str):
            if spec == role or spec not in ROLES or not isinstance(roles.get(spec), dict):
                die(f"{path}: {role} = {spec!r} must name a role that has its own model and effort")
            spec = roles[spec]
        if not isinstance(spec, dict) or "model" not in spec or "effort" not in spec:
            die(f"{path}: {role} needs a model and an effort")
        out[role] = {"model": model_alias(spec["model"], f"{path} {role}"),
                     "effort": effort_of(spec["effort"], f"{path} {role}")}
    return out


# The --models modes. mixed is the default: half the competitors on opus medium, half on sonnet high. Which
# model and effort the gladiators should run on is a Phase B question (paired arms, champion quality per
# dollar), not one the head-to-head in `history` can settle. sonnet (alias: default, its old name) is
# models.json as it is: every competitor on sonnet.
MODEL_MODES = ("mixed", "sonnet", "default")
MIXED = {"opus": {"model": "opus", "effort": GLADIATOR_OPUS_MAX}, "sonnet": {"model": "sonnet", "effort": "high"}}


def check_gladiators(comp, where):
    """Rule: a gladiator on opus runs at medium effort or lower. Anything above stops init."""
    for x, m in comp.items():
        if m["model"] == "opus" and EFFORTS.index(m["effort"]) > EFFORTS.index(GLADIATOR_OPUS_MAX):
            die(f"{where}: competitor {x} on opus {m['effort']} is not allowed. Gladiators max out at opus "
                f"{GLADIATOR_OPUS_MAX}, so the judges stay stronger.")


def setup_models(choice, letters, seed):
    """(mode, models file, role models, competitor models). mixed: half opus medium, half sonnet high, from the
    seed only (its own random stream, so the split does not depend on the cards). Judges come from the models
    file in every mode."""
    path = SKILL_DIR / "models.json" if choice in MODEL_MODES else Path(choice)
    roles = read_models(path)
    if choice == "mixed":
        order = list(letters)
        random.Random(f"{seed}-models").shuffle(order)
        opus = set(order[:len(order) // 2])
        comp = {x: dict(MIXED["opus" if x in opus else "sonnet"]) for x in letters}
        return "mixed", path, roles, comp
    comp = {x: dict(roles["competitor"]) for x in letters}
    check_gladiators(comp, str(path))
    return ("sonnet" if choice in ("sonnet", "default") else "file"), path, roles, comp


def versions(models_path):
    def h(p):
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:10]
    try:
        plugin = json.loads((SKILL_DIR.parents[1] / ".claude-plugin" / "plugin.json").read_text())["version"]
    except (OSError, KeyError, ValueError):
        plugin = "?"
    return {"plugin": plugin, "rubric": h(SKILL_DIR / "rubric.md"), "cards": h(SKILL_DIR / "cards.json"),
            "templates": h(SKILL_DIR / "templates.md"), "models": h(models_path)}


# ---------- sizing ----------

def counts(n, baseline):
    """(rounds, starts, resumes, swap, check). Starts: competitors, one judge per match and the final check,
    then the extras while they fit under the delegate mod's per-turn cap: first the harvest check (it guards the
    answer the person gets), then the swap judge (a measurement). Resumes: attack and defend for each
    competitor in each round, plus the harvest (skipped when no attack is still standing)."""
    rounds = n.bit_length() - 1
    starts = n + (n - 1) + (1 if baseline else 0)
    check = starts + 1 <= CAP_TURN
    swap = starts + check + 1 <= CAP_TURN
    resumes = sum(2 * (n >> r) for r in range(rounds)) + 1
    return rounds, starts + check + swap, resumes, swap, check


def models_line(roles, comp_text):
    r = roles
    return (f"models: competitors {comp_text}; judges {r['judge']['model']} {r['judge']['effort']}; "
            f"swap judge {r['swap_judge']['model']} {r['swap_judge']['effort']}; "
            f"harvest check {r['harvest_check']['model']} {r['harvest_check']['effort']}; "
            f"final check {r['final']['model']} {r['final']['effort']}")


def cmd_plan(a):
    if a.agents not in SIZES:
        die(f"--agents must be one of {SIZES}")
    rounds, starts, resumes, swap, check = counts(a.agents, a.baseline)
    parts = [f"{a.agents} competitors", f"{a.agents - 1} judges"]
    parts += ["1 harvest check"] if check else []
    parts += ["1 swap judge"] if swap else []
    parts += ["1 final check"] if a.baseline else []
    print(f"{a.agents} competitors, {rounds} round(s): {starts} agents started at most ({', '.join(parts)}) "
          f"and up to {resumes} resumed messages (attack and defend, and 1 harvest). "
          f"{starts + resumes} sub-agent calls at most.")
    skipped = [x for x, on in (("harvest check", check), ("swap judge", swap)) if not on]
    if skipped:
        print(f"Skipped to stay at the delegate mod's {CAP_TURN} starts per turn: {', '.join(skipped)}. "
              "A judge that has to run again cannot start in this turn either.")
    if starts > CAP_TURN:
        print(f"WARNING: {starts} starts is more than the delegate mod's {CAP_TURN} per turn. "
              f"Raise maxTurn first, or the run stops partway.")
    print(f"The delegate mod allows {CAP_SESSION} starts per session: this run uses {starts}.")
    mode, _, roles, comp = setup_models(a.models, LETTERS[:a.agents], 0)
    c = roles["competitor"]
    print(models_line(roles, f"half opus {MIXED['opus']['effort']} and half sonnet {MIXED['sonnet']['effort']} "
                      "at random" if mode == "mixed" else f"{c['model']} {c['effort']}"))


# ---------- init ----------

def cmd_init(a):
    if a.agents not in SIZES:
        die(f"--agents must be one of {SIZES}")
    task = Path(a.task_file).read_text().strip()
    if not task:
        die("the task file is empty")
    seed = a.seed if a.seed is not None else random.randrange(10**6)
    agents = list(LETTERS[:a.agents])
    mode, mpath, roles, comp = setup_models(a.models, agents, seed)  # checked before anything is written
    base_text = Path(a.baseline_file).read_text().strip() if a.baseline_file else ""
    baseline = bool(base_text)
    stamp, k = time.strftime("%Y%m%d-%H%M%S"), 1
    run_dir = (ROOT / stamp).resolve()
    while run_dir.exists():  # two runs in one second must not share a folder
        k += 1
        run_dir = (ROOT / f"{stamp}-{k}").resolve()
    for sub in ("briefs", "solutions", "attacks", "defense", "verdicts", "views", "scratch"):
        (run_dir / sub).mkdir(parents=True, exist_ok=True)
    # Run folders can hold real numbers: ignored in any git repo, whatever its own .gitignore says.
    if not (ROOT / ".gitignore").exists():
        (ROOT / ".gitignore").write_text("*\n")
    (run_dir / "task.md").write_text(task + "\n")
    if baseline:
        (run_dir / "baseline.md").write_text(base_text + "\n")
    rounds, starts, resumes, swap, check = counts(a.agents, baseline)
    swap_match = f"r1m{random.Random(f'{seed}-swap').randrange(a.agents // 2) + 1}" if swap else None
    st = {
        "version": 3, "run_dir": str(run_dir), "n": a.agents, "seed": seed, "baseline": baseline,
        "task_type": a.task_type, "cards": deal(a.agents, seed), "agent_ids": {}, "alive": agents,
        "eliminated": {}, "round": 0, "phase": "spawn", "matches": [],
        "sol": {x: str(run_dir / "solutions" / f"{x}.r0.md") for x in agents},
        "verdicts": {}, "final": None, "final_map": None,
        "models": {"mode": mode, "file": str(mpath), "roles": roles, "competitors": comp},
        "swap": {"match": swap_match, "why": None if swap else "cap", "verdict": None},
        "check": {"planned": check, "why": None if check else "cap", "verdict": None},
        "tokens": {}, "jobmeta": {}, "harvest": None, "finalists": None, "blind_map": None, "rated": False,
        "versions": versions(mpath), "started": time.time(), "done_at": None, "radar": None,
        "task_sha": sha(run_dir / "task.md"), "hashes": {}, "reruns": [], "restarts": [], "no_output": {},
        "agent_ids_all": {}, "audit": {"available": None, "folder": None, "leaks": [], "voided": []},
        "integrity": [],
    }
    seal(st, [run_dir / "task.md"] + ([run_dir / "baseline.md"] if baseline else []))
    save(st, run_dir)
    (ROOT / "LATEST").write_text(str(run_dir) + "\n")
    print(f"run {run_dir}")
    print(f"seed {seed}. {a.agents} competitors, {rounds} round(s), up to {starts} starts and {resumes} resumes. "
          f"Task type {a.task_type}.")
    print(models_line(roles, ", ".join(f"{x} {m['model']} {m['effort']}" for x, m in comp.items())) + f" ({mode})")
    print(f"swap judge: {swap_match}" if swap else f"swap judge: skipped (over {CAP_TURN} starts per turn)")
    print("harvest check: planned" if check else f"harvest check: skipped (over {CAP_TURN} starts per turn)")
    try:
        ignored = subprocess.run(["git", "check-ignore", "-q", str(ROOT / "x")], capture_output=True).returncode == 0
        in_repo = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], capture_output=True).returncode == 0
        if in_repo and not ignored:
            print("WARNING: .gauntlet/ is not git-ignored here. Add it to .gitignore before anything commits it.")
    except FileNotFoundError:
        pass


# ---------- attacks and standing lists ----------

def attack_blocks(path):
    """{number: (severity, type, text)} from an attacks file in the attacker template's format."""
    p = Path(path)
    text = p.read_text() if p.exists() else ""
    heads = list(re.finditer(r"^[ \t]*ATTACK[ \t]+(\d+)\b(.*)$", text, re.M | re.I))
    out = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        head = m.group(2).upper()
        sev = re.search(r"\b(FATAL|MAJOR|MINOR)\b", head)
        typ = re.search(r"\b(" + "|".join(ATTACK_TYPES) + r")\b", head)
        out[int(m.group(1))] = (sev.group(1) if sev else "UNRATED", typ.group(1) if typ else "OTHER",
                                text[m.start():end].strip())
    return out


def by_letter(v, key, x):
    """A judge's survived or standing items for x, as a list, whatever shape the judge sent (a list, null, a string)."""
    d = v.get(key)
    items = d.get(x) if isinstance(d, dict) else None
    if items is None:
        return []
    return items if isinstance(items, list) else [items]


def is_filler(text):
    t = str(text).strip()
    return not t or t.startswith("<") or t.lower() in ("...", "none", "n/a") or t == NO_OUTPUT


def standing_number(item):
    """The attack number at the start of an old-format item: `2: base`, `ATTACK 2 - base`, `C 2: base`."""
    m = re.match(r"\s*(?:[A-HXY]\s+)?(?:attack\s*)?#?(\d{1,2})\s*[:.)\]-]", str(item), re.I)
    return int(m.group(1)) if m else None


def attack_ref(ref):
    """(attack number or None, True when it is the judge's own find) from a typed entry's attack field:
    `C 2`, `Y 2` (a judge's view label), `C ATTACK 2`, `ATTACK 2`, `2` or 2, and `judge` (or `new`) for a flaw no
    attack named."""
    if isinstance(ref, int) and not isinstance(ref, bool):
        return ref, False
    r = str(ref or "").strip()
    if re.fullmatch(r"(?i)judge|new|judge'?s? own|own", r):
        return None, True
    m = re.fullmatch(r"(?:[A-HXY]\s*)?(?:(?i:attack)\s*)?#?\s*(\d{1,2})", r)
    return (int(m.group(1)), False) if m else (None, False)


def standing_entry(item):
    """One standing item as {attack, judge, type, note}, or None for a blank or copied template filler.
    The typed format is an object: {"attack": "C 2" or "judge", "type": "UNIT", "note": "..."}. The old
    format is a string: "2: input size unclear" or "new: ..."; it has no type of its own."""
    if isinstance(item, dict):
        note = str(item.get("note") or item.get("text") or "").strip()
        ref = item.get("attack")
        if is_filler(note) or str(ref or "").strip().startswith("<"):
            return None
        n, own = attack_ref(ref)
        typ = str(item.get("type") or "").strip().upper()
        return {"attack": n, "judge": own, "type": typ if typ in ATTACK_TYPES else None, "note": note}
    text = str(item).strip()
    if is_filler(text):
        return None
    return {"attack": standing_number(text), "judge": bool(re.match(r"\s*(?:new|judge)\b", text, re.I)),
            "type": None, "note": text, "raw": True}


def standing_list(v, x):
    """The judge's still-standing items for x as entries, without blanks and copied template filler."""
    return [e for e in map(standing_entry, by_letter(v, "standing", x)) if e is not None]


def entry_text(e):
    """A standing entry as one line for the harvest brief and `winner`. An old-format string stays as it was."""
    if e.get("raw"):
        return e["note"]
    who = "judge's own find" if e["judge"] or e["attack"] is None else f"attack {e['attack']}"
    return f"{who}" + (f" [{e['type']}]" if e["type"] else "") + f": {e['note']}"


def standing_kind(item, blocks):
    """A standing item's type: the type the judge gave, else the type on the ATTACK line it names, else
    JUDGE for the judge's own untyped find (the old format), else OTHER."""
    e = item if isinstance(item, dict) and "judge" in item else standing_entry(item)
    if e is None:
        return "OTHER"
    if e["type"]:
        return e["type"]
    if e["attack"] is not None and e["attack"] in blocks:
        return blocks[e["attack"]][1]
    return "JUDGE" if e["judge"] else "OTHER"


def item_text(item):
    """A survived item (a string, or an object a judge sent anyway) as one line."""
    if isinstance(item, dict):
        return entry_text(standing_entry(item) or {"attack": None, "judge": True, "type": None, "note": str(item)})
    return str(item)


def tally(kinds):
    out = {}
    for k in kinds:
        out[k] = out.get(k, 0) + 1
    return out


def mkey(mid):
    return tuple(int(n) for n in re.findall(r"\d+", mid))


def judged(st):
    """Every match verdict in order: (match id, round, [first, second], verdict). Swap verdicts are not here."""
    for mid in sorted(st["verdicts"], key=mkey):
        v = st["verdicts"][mid]
        yield mid, mkey(mid)[0], v.get("pair") or [v["winner"], v["loser"]], v


def harvest_items(st, d):
    """Every attack a judge left standing, in every match, for the champion to concede or reject."""
    items = []
    for mid, rnd, (p, q), v in judged(st):
        if v.get("auto"):
            continue
        for x, opp in ((p, q), (q, p)):
            blocks = attack_blocks(attack_file(d, rnd, opp, x))
            for e in standing_list(v, x):
                n = e["attack"]
                items.append(dict(match=mid, round=rnd, target=x, note=entry_text(e),
                                  attack=blocks[n][2] if n in blocks else None))
    return items


def harvest_text(st, items):
    champ, last, lines = st["alive"][0], max(1, st["round"]), []
    for i, it in enumerate(items, 1):
        x = it["target"]
        if x != champ:
            whose = (f"competitor {x}'s solution ({st['sol'][x]}), which is out. It applies to yours only if "
                     "yours has the same flaw")
        elif it["round"] < last:
            whose = f"your solution as it was in round {it['round']}. Check whether your current one still has it"
        else:
            whose = "your solution"
        lines.append(f"H{i}. Match {it['match']} (round {it['round']}), against {whose}.")
        lines.append(f"  The judge's note: {it['note']}")
        if it["attack"]:
            lines.append("  The attack it refers to:")
            lines += [f"    {ln}" for ln in it["attack"].splitlines()]
        lines.append("")
    return "\n".join(lines).rstrip()


# ---------- jobs ----------

JUDGE_JOB = re.compile(r"r\d{1,2}m\d{1,2}(?:-swap)?|final|check")


def brief_path(d, job):
    """A competitor's brief is in briefs/. A judge's is in its own view folder, the only folder it needs."""
    if JUDGE_JOB.fullmatch(job):
        return d / "views" / job / "brief.md"
    return d / "briefs" / f"{job}.md"


def view_dir(d, job):
    return d / "views" / job


def meta_flags(paths):
    """Lines in competitor-written files with words that may be aimed at the judge, as `file line n ('word')`."""
    hits = []
    for name, p in paths.items():
        if not Path(p).exists():
            continue
        for n, line in enumerate(Path(p).read_text().splitlines(), 1):
            for m in META_TEXT.finditer(line):
                hits.append(f"{name} line {n} ('{m.group(1)}')")
    return "; ".join(hits) if hits else "none"


def make_view(d, job, files):
    """Copy what one judge needs into views/<job>/ under neutral names, so the judge never opens the run
    folder itself (letters, cards, models, earlier verdicts). files: {name: source path, or text}."""
    v = view_dir(d, job)
    v.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, src in files.items():
        if isinstance(src, Path):
            text = src.read_text() if src.exists() else NO_OUTPUT + "\n"
        else:
            text = src
        (v / name).write_text(text)
        out[name] = v / name
    return out


def view_common(d, job):
    return {"task.md": d / "task.md", "rubric.md": SKILL_DIR / "rubric.md"}


def attack_file(d, rnd, att, tgt):
    return d / "attacks" / f"r{rnd}-{att}-on-{tgt}.md"


def card_kw(st, x):
    c = st["cards"][x]
    return dict(lens_name=c["lens"]["name"], lens_how=c["lens"]["how"],
                workflow_name=c["workflow"]["name"], workflow_how=c["workflow"]["how"],
                priority_name=c["priority"]["name"], priority_how=c["priority"]["how"])


def opponent(st, x):
    for m in st["matches"]:
        if x in m:
            return m[1] if m[0] == x else m[0]
    die(f"{x} has no match this round")


def judge_text(st, d, job, mid, rnd, first, second):
    """The match judge's brief, over a view where `first` is X and `second` is Y."""
    files = view_common(d, job)
    for lab, x, opp in (("X", first, second), ("Y", second, first)):
        files[f"{lab}.solution.md"] = Path(st["sol"][x])
        files[f"{lab}.attacks.md"] = attack_file(d, rnd, opp, x)
        files[f"{lab}.defense.md"] = d / "defense" / f"r{rnd}-{x}.md"
    f = make_view(d, job, files)
    flags = meta_flags({k: f[k] for k in f if k.endswith((".solution.md", ".defense.md"))})
    return fill(template("judge"), match=mid, round=rnd, first="X", second="Y", view=view_dir(d, job),
                task_file=f["task.md"], rubric=f["rubric.md"], flags=flags,
                first_solution=f["X.solution.md"], first_attacks=f["X.attacks.md"], first_defense=f["X.defense.md"],
                second_solution=f["Y.solution.md"], second_attacks=f["Y.attacks.md"], second_defense=f["Y.defense.md"])


def label_map(st, job):
    """{X: letter, Y: letter} for a match judge or swap judge of the current round."""
    mid = job.removesuffix("-swap")
    i = mkey(mid)[1] - 1
    p, q = st["matches"][i]
    return {"X": q, "Y": p} if job.endswith("-swap") else {"X": p, "Y": q}


def check_items_text(items):
    lines = []
    for i, it in enumerate(items, 1):
        lines.append(f"H{i}. {it['note']}")
        if it["attack"]:
            lines += [f"    {ln}" for ln in it["attack"].splitlines()]
    return "\n".join(lines) + "\n"


def jobs(st, d):
    """Every job of the current phase: dict(id, how, role, agent, text, outs)."""
    rnd, phase, out = st["round"], st["phase"], []
    common = dict(task_file=d / "task.md", rubric=SKILL_DIR / "rubric.md", run_dir=d)
    if phase == "spawn":
        note = ""
        if st["baseline"]:
            note = ("The person who asked already rejected one answer to this task. Your solution will be "
                    "compared with it at the end. You do not see it: solve the task on its own terms.")
        task = (d / "task.md").read_text().strip()
        for x in st["alive"]:
            o = st["sol"][x]
            text = fill(template("competitor"), agent=x, n=st["n"], task=task, baseline_note=note,
                        out=o, **card_kw(st, x), **common)
            out.append(dict(id=f"spawn-{x}", how="start", role="competitor", agent=x, text=text, outs=[o]))
    elif phase == "attack":
        for x in st["alive"]:
            t = opponent(st, x)
            o = attack_file(d, rnd, x, t)
            text = fill(template("attacker"), round=rnd, match=match_id(st, x), agent=x, target=t,
                        target_solution=st["sol"][t], own_solution=st["sol"][x], out=o, **common)
            out.append(dict(id=f"r{rnd}-{x}-attacks-{t}", how="resume", role="attack", agent=x, text=text,
                            outs=[str(o)]))
    elif phase == "defend":
        for x in st["alive"]:
            t = opponent(st, x)
            so, do = d / "solutions" / f"{x}.r{rnd}.md", d / "defense" / f"r{rnd}-{x}.md"
            text = fill(template("defender"), round=rnd, match=match_id(st, x), agent=x, opponent=t,
                        own_solution=st["sol"][x], attacks=attack_file(d, rnd, t, x),
                        defense_out=do, solution_out=so, **common)
            out.append(dict(id=f"r{rnd}-defend-{x}", how="resume", role="defend", agent=x, text=text,
                            outs=[str(do), str(so)]))
    elif phase == "judge":
        swap = st["swap"]
        for i, (p, q) in enumerate(st["matches"], 1):
            mid = f"r{rnd}m{i}"
            if st["verdicts"].get(mid, {}).get("auto"):
                out.append(dict(id=mid, how="start", role="judge", match=mid, agent=None, text="",
                                outs=[str(d / "verdicts" / f"{mid}.json")]))
                continue
            out.append(dict(id=mid, how="start", role="judge", match=mid, agent=None,
                            text=judge_text(st, d, mid, mid, rnd, p, q),
                            outs=[str(d / "verdicts" / f"{mid}.json")]))
            # The swap judge: the same match with the pair in swapped order. Only the first verdict counts.
            if swap["match"] == mid:
                out.append(dict(id=f"{mid}-swap", how="start", role="swap_judge", match=mid, agent=None,
                                text=judge_text(st, d, f"{mid}-swap", mid, rnd, q, p),
                                outs=[str(d / "verdicts" / f"{mid}-swap.json")]))
    elif phase == "harvest":
        champ = st["alive"][0]
        items = harvest_items(st, d)
        so, ho = d / "solutions" / f"{champ}.harvest.md", d / "defense" / f"harvest-{champ}.md"
        text = fill(template("harvest"), agent=champ, n=st["n"], own_solution=st["sol"][champ], count=len(items),
                    standing=harvest_text(st, items), harvest_out=ho, solution_out=so, **common)
        out.append(dict(id="harvest", how="resume", role="harvest", agent=champ, text=text, outs=[str(ho), str(so)]))
    elif phase == "check":
        champ = st["alive"][0]
        items = harvest_items(st, d)
        x_before = random.Random(f"{st['seed']}-check").random() < 0.5
        st["check"]["map"] = {"X": "before" if x_before else "after", "Y": "after" if x_before else "before"}
        paths = {"before": Path(st["sol"][champ]), "after": Path(st["harvest"]["path"])}
        log = d / "defense" / f"harvest-{champ}.md"
        f = make_view(d, "check", {**view_common(d, "check"), "X.solution.md": paths[st["check"]["map"]["X"]],
                                   "Y.solution.md": paths[st["check"]["map"]["Y"]],
                                   "items.md": check_items_text(items),
                                   "log.md": log.read_text() if log.exists() else NO_OUTPUT + "\n"})
        text = fill(template("harvest_check"), view=view_dir(d, "check"), task_file=f["task.md"],
                    rubric=f["rubric.md"], x_solution=f["X.solution.md"], y_solution=f["Y.solution.md"],
                    items=f["items.md"], log=f["log.md"], count=len(items),
                    flags=meta_flags({k: f[k] for k in ("X.solution.md", "Y.solution.md", "log.md")}))
        out.append(dict(id="check", how="start", role="harvest_check", match="check", agent=None, text=text,
                        outs=[str(d / "verdicts" / "check.json")]))
    elif phase == "final":
        champ = st["alive"][0]
        x_is_champ = random.Random(f"{st['seed']}-final").random() < 0.5
        st["final_map"] = {"X": "champion" if x_is_champ else "baseline", "Y": "baseline" if x_is_champ else "champion"}
        paths = {"champion": Path(st["sol"][champ]), "baseline": d / "baseline.md"}
        f = make_view(d, "final", {**view_common(d, "final"), "X.solution.md": paths[st["final_map"]["X"]],
                                   "Y.solution.md": paths[st["final_map"]["Y"]]})
        text = fill(template("final"), n=st["n"], view=view_dir(d, "final"), task_file=f["task.md"],
                    rubric=f["rubric.md"], x_solution=f["X.solution.md"], y_solution=f["Y.solution.md"],
                    flags=meta_flags({k: f[k] for k in ("X.solution.md", "Y.solution.md")}))
        out.append(dict(id="final", how="start", role="final", match="final", agent=None, text=text,
                        outs=[str(d / "verdicts" / "final.json")]))
    return out


def match_id(st, x):
    for i, m in enumerate(st["matches"], 1):
        if x in m:
            return f"r{st['round']}m{i}"
    die(f"{x} has no match")


def job_model(st, j):
    """A competitor's job runs on that competitor's model; a judge's on its role's."""
    if j.get("agent"):
        return st["models"]["competitors"][j["agent"]]
    return st["models"]["roles"][j["role"]]


# agent-radar reads the Agent call's description to draw competitors as gladiators (A to H) and judges
# in robes: keep them exactly `Gauntlet competitor <A-H>`, `Gauntlet judge <rNmM|final>` and, for the swap
# judge, `Gauntlet judge <rNmM> swap` (agent-radar 1.6.0 or later draws that one as a judge too). The
# radar matches the whole string, and `radar_label` reads the same three back. A fourth, `Gauntlet judge
# check`, is the harvest check's. The radar also ends its colosseum when the Lead runs `gauntlet.py winner`
# (agent-radar 1.7.0 or later): `winner` stays the last step of SKILL.md, and the command keeps that name.
def call_text(st, d, j):
    brief = brief_path(d, j["id"])
    outs = " and ".join(j["outs"])
    m = job_model(st, j)
    model = f"    model: {m['model']}\n    effort: {m['effort']}\n"
    if j["how"] == "resume":
        msg = (f"Next gauntlet brief: read {brief} and follow it exactly. "
               f"Done when: {outs} written. Reply with only the one line the brief asks for.")
        aid = st["agent_ids"].get(j["agent"])
        x = j["agent"]
        fresh = (f"Agent, subagent_type delegate:builder\n    description: Gauntlet competitor {x}\n{model}"
                 f"    prompt: [difficulty: hard] Gauntlet competitor {x}. You take over as competitor {x}: the "
                 f"agent that had this role stopped. First read {brief_path(d, 'spawn-' + x)} for the task and "
                 f"your strategy card (do not redo it), then your own latest solution {st['sol'][x]}. Scope: do "
                 f"not edit, create or delete anything outside {d}. {msg}")
        if aid:
            return (f"SendMessage to {aid}\n    message: {msg}\n  if SendMessage fails, start this instead and "
                    f"register its id:\n  {fresh}")
        return f"NO AGENT ID REGISTERED: start a fresh agent instead, and register its id. {fresh}"
    if j["role"] == "competitor":
        return (f"Agent, subagent_type delegate:builder\n    description: Gauntlet competitor {j['agent']}\n{model}"
                "    prompt: [difficulty: hard] Gauntlet competitor "
                f"{j['agent']}. Goal: read the brief at {brief} and follow it exactly; it is your whole brief. "
                f"Scope: do not edit, create or delete anything outside {d}. Done when: {outs} is written. "
                "Return format: only the single DONE line the brief asks for.")
    swap = " swap" if j["role"] == "swap_judge" else ""
    return (f"Agent, subagent_type delegate:reviewer\n    description: Gauntlet judge {j['match']}{swap}\n{model}"
            "    prompt: [difficulty: careful] Gauntlet judge for "
            f"{j['match']}. Goal: read the brief at {brief} and follow it exactly; it is your whole brief. "
            "Scope: read only, do not edit or create any file. Done when: you have scored both solutions. "
            "Return format: only the JSON object the brief asks for.")


# ---------- transitions ----------

def done_phase(st, d):
    return all(all(filled(o) for o in j["outs"]) for j in jobs(st, d))


def phase_outputs(st, d):
    """The competitor-written files of the current phase, sealed when it ends. Verdicts are not sealed: the
    script writes them, and `verdict --rerun` and the audit move them on purpose."""
    if st["phase"] in ("judge", "check", "final"):
        return []
    return [o for j in jobs(st, d) for o in j["outs"]]


def auto_verdicts(st, d):
    """A match where a competitor has no solution at all is decided without a judge (and without a swap judge)."""
    for i, (p, q) in enumerate(st["matches"], 1):
        mid = f"r{st['round']}m{i}"
        vp = d / "verdicts" / f"{mid}.json"
        if vp.exists():
            continue
        dead = [x for x in (p, q) if is_no_output(st["sol"][x])]
        if dead and len(dead) < 2:
            w = q if dead[0] == p else p
            v = {"match": mid, "pair": [p, q], "winner": w, "loser": dead[0], "auto": True,
                 "reason": f"{dead[0]} produced no solution", "totals": {}, "survived": {}, "standing": {},
                 "words": {x: words_of(st["sol"][x]) for x in (p, q)}, "same_conclusion": None}
            vp.write_text(json.dumps(v, indent=2))
            st["verdicts"][mid] = v
            if st["swap"]["match"] == mid:
                st["swap"]["why"] = "auto"


def after_harvest(st):
    return "final" if st["baseline"] else "done"


def end_harvest(st, d):
    """After the harvest: a revision goes to the harvest check when one is planned. Without a check (the cap)
    it goes out unjudged, and the ledger says so. NO CHANGE and NO OUTPUT keep the judged solution."""
    champ = st["alive"][0]
    rev = d / "solutions" / f"{champ}.harvest.md"
    text = rev.read_text().strip() if rev.exists() else ""
    outcome = "failed" if text == NO_OUTPUT else "no_change" if text == NO_CHANGE else "revised"
    log = d / "defense" / f"harvest-{champ}.md"
    lt = log.read_text() if log.exists() else ""
    st["harvest"] = {"ran": True, "items": len(harvest_items(st, d)),
                     "conceded": len(re.findall(HARVEST_LINE + "CONCEDE", lt, re.M | re.I)),
                     "rejected": len(re.findall(HARVEST_LINE + "REJECT", lt, re.M | re.I)),
                     "outcome": outcome, "kept_previous": outcome != "revised", "path": str(rev)}
    if outcome == "revised" and st["check"]["planned"]:
        st["phase"] = "check"
        print("Harvest done: a revision. Next: the harvest check.")
        return
    if outcome == "revised":
        st["sol"][champ] = str(rev)
        st["check"].update(ran=False, kept=True, why="cap")
        print("Harvest done: a revision, sent out without a harvest check (no start left under the cap).")
    else:
        st["check"].update(ran=False, kept=False, why=outcome)
        print("Harvest done: " + ("NO CHANGE" if outcome == "no_change" else "NO OUTPUT")
              + ", the judged solution stands.")
    st["phase"] = after_harvest(st)


def advance(st, d):
    """Move phases forward while the current one is complete. Returns True when DONE."""
    while True:
        ph = st["phase"]
        if ph == "done":
            st["done_at"] = st.get("done_at") or time.time()
            return True
        if ph == "judge":
            auto_verdicts(st, d)
        if not done_phase(st, d):
            return False
        seal(st, phase_outputs(st, d))
        if ph == "spawn":
            st["round"], st["phase"] = 1, "attack"
            mixed = st["models"]["competitors"] if st["models"]["mode"] == "mixed" else None
            st["matches"] = pair(st["alive"], st["seed"], 1, mixed)
        elif ph == "attack":
            st["phase"] = "defend"
        elif ph == "defend":
            for x in st["alive"]:
                rev = d / "solutions" / f"{x}.r{st['round']}.md"
                if not is_no_output(rev):
                    st["sol"][x] = str(rev)
            st["phase"] = "judge"
        elif ph == "judge":
            rnd = st["round"]
            winners = []
            for i in range(1, len(st["matches"]) + 1):
                v = st["verdicts"].get(f"r{rnd}m{i}")
                if v is None:
                    die(f"r{rnd}m{i} has no verdict. A judge is never given up: give it a fresh run and pipe "
                        "its reply into verdict.")
                winners.append(v["winner"])
                st["eliminated"][v["loser"]] = rnd
            st["alive"] = winners
            if len(winners) == 1:
                # The two finalists, as the last judge saw them: the optional blind pick shows these.
                st["finalists"] = {x: st["sol"][x] for x in st["matches"][0]}
                st["matches"] = []
                if harvest_items(st, d):
                    st["phase"] = "harvest"
                else:
                    st["harvest"] = {"ran": False, "items": 0}
                    st["check"].update(ran=False, kept=False, why="nothing standing")
                    st["phase"] = after_harvest(st)
            else:
                st["round"] = rnd + 1
                st["matches"] = pair(winners, st["seed"], rnd + 1)
                st["phase"] = "attack"
            print(f"Round {rnd} done: {len(winners)} of {st['n']} left.")
        elif ph == "harvest":
            end_harvest(st, d)
        elif ph == "check":
            champ, v = st["alive"][0], st["check"].get("verdict")
            if v is None:   # given up: the judged solution stands
                st["check"].update(ran=False, kept=False, why="no output")
                print("Harvest check given up: the judged solution stands.")
            else:
                if v["kept"]:
                    st["sol"][champ] = st["harvest"]["path"]
                print("Harvest check: " + ("the revision is not worse, it goes out." if v["kept"] else
                                           "the revision is worse, the judged solution stands."))
            st["phase"] = after_harvest(st)
        elif ph == "final":
            st["phase"] = "done"


def in_waves(js):
    """Jobs in waves of at most WAVE, the delegate mod's cap on agents running at once."""
    return [js[i:i + WAVE] for i in range(0, len(js), WAVE)]


def cmd_next(a):
    st, d = load()
    bad = tampered(st)
    if bad and not a.accept_changes:
        die("these finished files changed after their phase ended: " + ", ".join(rel(st, p) for p in bad)
            + ". A sub-agent wrote into a file that was not its own: tell the user. To go on with the files "
            "as they are now: next --accept-changes (the ledger records it).")
    if bad:
        st["integrity"].append({"phase": st["phase"], "round": st["round"], "accepted": [rel(st, p) for p in bad]})
        seal(st, bad)
    note = run_audit(st, d)
    finished = advance(st, d)
    save(st, d)
    if note:
        print(note)
    if finished:
        print("DONE. Optional blind pick first: blind. Then: winner")
        return
    js = jobs(st, d)
    for j in js:
        st["jobmeta"][j["id"]] = {"role": j["role"], **job_model(st, j)}
    save(st, d)  # final_map and the check's map are set when their jobs are built
    missing = [j for j in js if not all(filled(o) for o in j["outs"])]
    label = st["phase"] if st["phase"] in ("spawn", "harvest", "check", "final") else f"round {st['round']} {st['phase']}"
    waves = in_waves(missing)
    print(f"PHASE {label}: {len(missing)} of {len(js)} job(s) to run, in {len(waves)} wave(s). "
          "Send each wave in ONE message and wait for every reply before the next wave.")
    for w, wave in enumerate(waves, 1):
        print(f"\nWAVE {w} of {len(waves)}")
        for j in wave:
            bp = brief_path(d, j["id"])
            bp.write_text(j["text"] + "\n")
            print(f"\nJOB {j['id']}\n  {call_text(st, d, j)}")
            if j["how"] == "start" and j["role"] != "competitor":
                print(f"  then pipe the reply into: verdict {j['id']}")
            if j["how"] == "start" and j["role"] == "competitor":
                print(f"  then: register {j['agent']} <the agent id from the result>")
            print(f"  then: tokens {j['id']} <the token number the result reports (its context size); skip if none>")
        print(f"\nAFTER WAVE {w}: once every reply of this wave is in, run tokens-from-radar")
    print("\nAfter every job has replied, run next again. A job that fails twice: give-up <job id> --why "
          "\"<what happened>\" (competitor jobs, the harvest, the swap judge and the harvest check only; a round "
          "judge or the final check never: give it a third, fresh run).")


# ---------- the audit: what each sub-agent read and wrote, from its transcript ----------

AGENT_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
# Run-folder names a gladiator must not read (relative, after a cd into the run folder, or absolute).
GLADIATOR_SECRET = re.compile(r"(?<![\w.-])(state\.json|verdicts/[\w.-]*|views/[\w./-]*)")
JUDGE_SECRET = re.compile(r"(?<![\w.-])(state\.json|verdicts/[\w.-]*|briefs/[\w.-]*|solutions/[\w.-]*|"
                          r"attacks/[\w.-]*|defense/[\w.-]*|views/[\w./-]*)")
REDIRECT = re.compile(r"(?:(?<![0-9&])>>?|\btee\s+(?:-a\s+)?)\s*['\"]?([^\s'\";|&)]+)")


def all_ids(st):
    ids = set(st["agent_ids"].values())
    for xs in st["agent_ids_all"].values():
        ids.update(xs)
    return sorted(i for i in ids if AGENT_ID.fullmatch(str(i)))


def find_transcripts(st):
    """The folder with this session's sub-agent transcripts, found from a registered competitor id."""
    known = st["audit"].get("folder")
    if known and Path(known).is_dir():
        return Path(known)
    root = transcripts_root()
    if not root.is_dir():
        return None
    for aid in all_ids(st):
        for hit in root.glob(f"*/*/subagents/agent-{aid}.jsonl"):
            st["audit"]["folder"] = str(hit.parent)
            return hit.parent
    return None


def segments(path, d):
    """[{job, uses, text}] for one transcript: every message to the agent that names a brief of this run starts
    a segment for that job (the last brief named, so a take-over prompt that names the spawn brief first counts
    for the job it was started for)."""
    brief = re.compile(re.escape(str(d)) + r"/(?:briefs/([\w.-]+)\.md|views/([\w-]+)/brief\.md)")
    segs, cur = [], None
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get("message") if isinstance(e, dict) else None
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if m.get("role") == "user":
            texts = [c] if isinstance(c, str) else [b.get("text", "") for b in c if isinstance(b, dict)
                                                    and b.get("type") == "text"] if isinstance(c, list) else []
            for t in texts:
                hits = brief.findall(t)
                if hits:
                    job = hits[-1][0] or hits[-1][1]
                    cur = {"job": job, "uses": [], "text": None}
                    segs.append(cur)
        elif m.get("role") == "assistant" and cur is not None and isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    cur["uses"].append((str(b.get("name")), b.get("input") if isinstance(b.get("input"), dict) else {}))
                elif b.get("type") == "text" and str(b.get("text", "")).strip():
                    cur["text"] = b["text"]
    return segs


def owner(st, job):
    """The competitor letter a job belongs to, or None for a judge's job."""
    m = re.fullmatch(r"spawn-([A-H])|r\d+-([A-H])-attacks-[A-H]|r\d+-defend-([A-H])", job)
    if m:
        return next(g for g in m.groups() if g)
    if job == "harvest":
        return st["alive"][0]
    return None


def own_output(x, r):
    """True when a path relative to the run folder is one competitor x may write."""
    return bool(re.fullmatch(rf"solutions/{x}\.[\w.-]+|attacks/r\d+-{x}-on-[A-H]\.md|defense/(?:r\d+|harvest)-{x}\.md|"
                             rf"scratch/{x}/.*", r))


def tool_paths(name, inp):
    """(read paths, write paths, bash command) from one tool use."""
    p = inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
    if name in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        return [], [p] if p else [], None
    if name == "Bash":
        return [], [], str(inp.get("command") or "")
    return [p] if p else [], [], None


def use_leaks(st, d, job, name, inp):
    """[(kind, what)] for one tool use. kind: read (a file the job must not see), list (the run folder itself),
    write (a file the job must not write). what: a path relative to the run folder, never file content."""
    root, x = d.parent.resolve(), owner(st, job)
    view = str(view_dir(d, job))
    reads, writes, cmd = tool_paths(name, inp)
    out = []

    def under(p, base):
        return p == base or p.startswith(base + "/")

    def check_read(p):
        p = str(p)
        if not under(p, str(root)):
            return
        if x is None:   # a judge: its view folder only
            if under(p, view):
                return
            out.append(("list" if p.rstrip("/") in (str(d), str(root)) else "read", rel(st, p)))
            return
        if not under(p, str(d)):
            out.append(("read", "another run"))
            return
        r = rel(st, p)
        mb = re.fullmatch(r"briefs/([\w.-]+)\.md", r)
        if GLADIATOR_SECRET.match(r) or (mb and owner(st, mb.group(1)) != x):
            out.append(("read", r))

    def check_write(p):
        p = str(p)
        if x is None:
            out.append(("write", rel(st, p) if p.startswith("/") else p))
            return
        if p.startswith("/"):
            if p.startswith("/dev/") or p.startswith(("/tmp/", "/private/tmp/", "/var/folders/")):
                return
            if not under(p, str(d)):
                out.append(("write", "outside the run folder"))
                return
            r = rel(st, p)
        else:
            r = p.lstrip("./")
            if not re.match(r"(solutions|attacks|defense|verdicts|views|state\.json)", r):
                return   # a relative path the audit cannot place
        if not own_output(x, r):
            out.append(("write", r))

    for p in reads:
        check_read(p)
    for p in writes:
        check_write(p)
    if cmd:
        for p in re.findall(re.escape(str(root)) + r"[^\s'\"`;|&)]*", cmd):
            check_read(p)
        secret = JUDGE_SECRET if x is None else GLADIATOR_SECRET
        for m in secret.finditer(cmd):
            start = m.start()
            if start and cmd[start - 1] == "/":
                continue     # part of an absolute path: checked above
            r = m.group(1)
            mb = re.fullmatch(r"briefs/([\w.-]+)\.md", r)
            if x is None and r.startswith("views/") and r.startswith(f"views/{job}/"):
                continue
            if x is not None and mb and owner(st, mb.group(1)) == x:
                continue
            out.append(("read", r))
        for t in REDIRECT.findall(cmd):
            check_write(t)
    return out


def reply_of(text):
    """The JSON object in a judge's last message, or None."""
    t = str(text or "")
    s, e = t.find("{"), t.rfind("}")
    if s < 0 or e <= s:
        return None
    try:
        v = json.loads(t[s:e + 1])
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def current_verdict(st, job):
    if job in st["verdicts"]:
        return st["verdicts"][job]
    if job.endswith("-swap"):
        return st["swap"].get("verdict")
    if job == "final":
        return st.get("final")
    if job == "check":
        return st["check"].get("verdict")
    return None


def void(st, d, job, why):
    """Take back a verdict: its file moves aside, the job runs again, and the ledger counts the re-run."""
    vp = d / "verdicts" / f"{job}.json"
    k = 1 + sum(1 for r in st["reruns"] if r["job"] == job)
    if vp.exists():
        vp.replace(d / "verdicts" / f"{job}.void{k}.json")
    if job in st["verdicts"]:
        del st["verdicts"][job]
    elif job.endswith("-swap"):
        st["swap"]["verdict"] = None
    elif job == "final":
        st["final"] = None
    elif job == "check":
        st["check"]["verdict"] = None
    st["reruns"].append({"job": job, "why": why})


def run_audit(st, d, act=True):
    """Read every transcript of this run and record what each job read or wrote outside its set. A judge whose
    recorded verdict came from a transcript that read outside its view loses that verdict and runs again (twice
    at most). Returns a note for the orchestrator, or None. Read only: transcripts are never changed."""
    folder = find_transcripts(st)
    a = st["audit"]
    if folder is None:
        a["available"] = False
        return ("audit: no sub-agent transcripts found yet, so leaks are unknown." if st["agent_ids"] else None)
    a["available"] = True
    seen = {(x["file"], x["job"], x["kind"], x["what"]) for x in a["leaks"]}
    voided_files = {v["file"] for v in a["voided"]}
    replies = {}
    new, voided = [], []
    for path in sorted(folder.glob("agent-*.jsonl")):
        for seg in segments(path, d):
            job = seg["job"]
            leaks = []
            for name, inp in seg["uses"]:
                leaks += use_leaks(st, d, job, name, inp)
            for kind, what in leaks:
                key = (path.name, job, kind, what)
                if key not in seen:
                    seen.add(key)
                    rec = {"file": path.name, "job": job, "who": owner(st, job) or "judge", "kind": kind, "what": what}
                    a["leaks"].append(rec)
                    new.append(rec)
            if JUDGE_JOB.fullmatch(job):
                r = reply_of(seg["text"])
                replies.setdefault(job, []).append((path.name, r, any(k == "read" for k, _ in leaks)))
    a["replies"] = {job: [[f, (r or {}).get("scores")] for f, r, _ in xs] for job, xs in replies.items()}
    if act:
        phase_jobs = {j["id"] for j in jobs(st, d)} if st["phase"] in ("judge", "check", "final") else set()
        for job, xs in replies.items():
            v = current_verdict(st, job)
            if v is None or job not in phase_jobs or not v.get("reply"):
                continue
            for f, r, leaked in xs:
                if leaked and f not in voided_files and r and r.get("scores") == v["reply"].get("scores"):
                    if sum(1 for x in a["voided"] if x["job"] == job) >= 2:
                        a.setdefault("kept_despite", []).append(job)
                        continue
                    void(st, d, job, "audit: read outside its view")
                    a["voided"].append({"job": job, "file": f})
                    voided.append(job)
    notes = []
    if new:
        notes.append("audit: " + "; ".join(f"{x['job']} ({x['who']}) {x['kind']} {x['what']}" for x in new))
    if voided:
        notes.append(f"audit: verdict(s) of {', '.join(voided)} taken back (the judge read outside its view). "
                     "Run that judge again: it is listed below. Tell the user in one line.")
    return "\n".join(notes) or None


def verdict_check(st):
    """For the ledger: does each recorded verdict match the judge's own last message in its transcript?"""
    a = st["audit"]
    if not a.get("available"):
        return None
    out = {"checked": 0, "same": 0, "differ": [], "not_found": []}
    vs = {**st["verdicts"], **({f"{st['swap']['match']}-swap": st["swap"]["verdict"]} if st["swap"].get("verdict") else {}),
          **({"final": st["final"]} if st.get("final") else {}),
          **({"check": st["check"]["verdict"]} if st["check"].get("verdict") else {})}
    for job, v in vs.items():
        if v.get("auto"):
            continue
        out["checked"] += 1
        got = [s for _, s in a.get("replies", {}).get(job, []) if s]
        if not got or not v.get("reply"):
            out["not_found"].append(job)
        elif any(s == v["reply"].get("scores") for s in got):
            out["same"] += 1
        else:
            out["differ"].append(job)
    return out


def cmd_audit(a):
    st, d = load()
    run_audit(st, d, act=False)
    save(st, d)
    au = st["audit"]
    if not au["available"]:
        print("audit: no transcripts found for this run (no registered competitor id matched a transcript).")
        return
    print(f"audit: transcripts in {au['folder']}")
    print(f"leaks: {len(au['leaks'])}")
    for x in au["leaks"]:
        print(f"  {x['job']} ({x['who']}): {x['kind']} {x['what']}")
    print(f"verdicts taken back: {', '.join(v['job'] for v in au['voided']) or 'none'}")
    vc = verdict_check(st)
    if vc:
        print(f"verdicts against transcripts: {vc['same']} of {vc['checked']} match"
              + (f"; differ: {', '.join(vc['differ'])}" if vc["differ"] else "")
              + (f"; not found: {', '.join(vc['not_found'])}" if vc["not_found"] else ""))


# ---------- verdicts ----------

def parse_json(text):
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e <= s:
        die("no JSON object in the input")
    try:
        return json.loads(text[s:e + 1])
    except json.JSONDecodeError as err:
        die(f"bad JSON: {err}")


def as_bool(v):
    """true/false from a judge's JSON: a bool, or the words true/false/yes/no. Anything else is None (unknown)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in ("true", "yes"):
        return True
    if isinstance(v, str) and v.strip().lower() in ("false", "no"):
        return False
    return None


def total(sc):
    return round(sum(float(sc[k]) * w for k, w in WEIGHTS.items()) / 10, 1)


def decide(scores, pick, standing):
    """The winner from the scores: fatal rule, total, fewer standing attacks, correctness, judge's pick."""
    ids = list(scores)
    def key(x):
        sc = scores[x]
        return (not sc.get("fatal", False), total(sc), -len(standing_list({"standing": standing}, x)),
                float(sc["correctness"]))
    a, b = ids
    ka, kb = key(a), key(b)
    if ka == kb:
        return pick if pick in ids else a
    return a if ka > kb else b


def check_scores(scores, ids):
    for x in ids:
        if x not in scores:
            die(f"scores for {x} missing")
        for k in WEIGHTS:
            v = scores[x].get(k)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= 10:
                die(f"{x}.{k} must be a number from 0 to 10, got {v!r}")
        scores[x]["fatal"] = as_bool(scores[x].get("fatal", False)) is True


def to_letters(v, labels):
    """A judge's reply in X/Y labels, turned into competitor letters. A reply already in letters stays."""
    sc = v.get("scores")
    if not isinstance(sc, dict) or not set(sc) <= set(LABELS):
        return v
    v = dict(v)
    v["scores"] = {labels[k]: s for k, s in sc.items()}
    for key in ("survived", "standing"):
        if isinstance(v.get(key), dict):
            v[key] = {labels.get(k, k): s for k, s in v[key].items()}
    if v.get("pick") in labels:
        v["pick"] = labels[v["pick"]]
    return v


def keep_old(st, d, job, why):
    """`verdict --rerun`: the old verdict moves aside and the ledger counts the re-run."""
    vp = d / "verdicts" / f"{job}.json"
    k = 1 + sum(1 for r in st["reruns"] if r["job"] == job)
    if vp.exists():
        vp.replace(d / "verdicts" / f"{job}.rerun{k}.json")
    st["reruns"].append({"job": job, "why": str(why)[:120]})


def refuse_twice(st, d, job, rerun):
    """A job has one verdict. A second needs --rerun with the reason, and the first is kept aside."""
    vp = d / "verdicts" / f"{job}.json"
    if vp.exists() and not is_no_output(vp):
        if not rerun:
            die(f"{job} already has a verdict. To replace it, say why: verdict {job} --rerun \"<reason>\". "
                "Never re-run a judge to get a different winner.")
        keep_old(st, d, job, rerun)


def cmd_verdict(a):
    st, d = load()
    v = parse_json(sys.stdin.read())
    reply = json.loads(json.dumps(v))     # the judge's reply as received, for the audit
    if a.match in ("final", "check"):
        if st["phase"] != a.match:
            die(f"not in the {a.match} phase (phase is {st['phase']})")
        refuse_twice(st, d, a.match, a.rerun)
        check_scores(v.get("scores", {}), ["X", "Y"])
        w = decide(v["scores"], v.get("pick"), {})
        v.update(winner=w, totals={x: total(v["scores"][x]) for x in ("X", "Y")}, reply=reply)
        lo = "Y" if w == "X" else "X"
        if a.match == "final":
            v["map"] = st["final_map"]
            st["final"] = v
            print(f"FINAL {st['final_map'][w]} wins {v['totals'][w]}-{v['totals'][lo]}")
        else:
            m = st["check"]["map"]
            rejects = [r for r in (v.get("rejects") or []) if isinstance(r, dict)]
            v.update(map=m, kept=m[w] == "after", rejects_checked=len(rejects),
                     rejects_wrong=sum(1 for r in rejects if as_bool(r.get("right")) is False))
            st["check"].update(verdict=v, ran=True, kept=v["kept"], why=None)
            print(f"CHECK {m[w]} wins {v['totals'][w]}-{v['totals'][lo]}: "
                  + ("the revision goes out." if v["kept"] else "the judged solution stands.")
                  + f" {v['rejects_wrong']} of {v['rejects_checked']} rejection(s) judged wrong.")
        (d / "verdicts" / f"{a.match}.json").write_text(json.dumps(v, indent=2))
        save(st, d)
        return
    if st["phase"] != "judge":
        die(f"not in a judge phase (phase is {st['phase']})")
    names = {f"r{st['round']}m{i}": m for i, m in enumerate(st["matches"], 1)}
    swap = st["swap"]["match"] if st["swap"]["match"] in names else None
    is_swap = swap is not None and a.match == f"{swap}-swap"
    mid = swap if is_swap else a.match
    if mid not in names:
        die(f"unknown match {a.match}; this round has {sorted(names) + ([f'{swap}-swap'] if swap else [])}")
    refuse_twice(st, d, a.match, a.rerun)
    p, q = names[mid][::-1] if is_swap else names[mid]
    labels = label_map(st, a.match)
    v = to_letters(v, labels)
    check_scores(v.get("scores", {}), [p, q])
    for key in ("survived", "standing"):
        v[key] = {x: by_letter(v, key, x) for x in (p, q)}
    w = decide({p: v["scores"][p], q: v["scores"][q]}, v.get("pick"), v["standing"])
    v.update(match=a.match, pair=[p, q], winner=w, loser=q if w == p else p,
             totals={p: total(v["scores"][p]), q: total(v["scores"][q])},
             same_conclusion=as_bool(v.get("same_conclusion")),
             words={x: words_of(st["sol"][x]) for x in (p, q)}, labels=labels, reply=reply)
    if v.get("pick") not in (None, w):
        v["note"] = f"judge picked {v['pick']}, scores decided {w}"
    (d / "verdicts" / f"{a.match}.json").write_text(json.dumps(v, indent=2))
    if is_swap:
        st["swap"]["verdict"] = v
        save(st, d)
        print(f"SWAP {mid} recorded: winner {w}. Only the first verdict counts.")
    else:
        st["verdicts"][a.match] = v
        save(st, d)
        print(f"WINNER {w} {v['totals'][w]}-{v['totals'][v['loser']]}" + (f" ({v['note']})" if "note" in v else ""))
    if v["same_conclusion"] is None:
        print("note: same_conclusion is missing or not true/false. Recorded as unknown.")


# ---------- other commands ----------

def cmd_register(a):
    st, d = load()
    if a.agent not in st["cards"]:
        die(f"unknown competitor {a.agent}")
    old = st["agent_ids"].get(a.agent)
    if old and old != a.agent_id:
        # A fresh agent took over a competitor whose agent stopped: the ledger counts it.
        st["restarts"].append({"agent": a.agent, "phase": st["phase"], "round": st["round"]})
    st["agent_ids_all"].setdefault(a.agent, [])
    for aid in (old, a.agent_id):
        if aid and aid not in st["agent_ids_all"][a.agent]:
            st["agent_ids_all"][a.agent].append(aid)
    st["agent_ids"][a.agent] = a.agent_id
    save(st, d)
    print(f"{a.agent} = {a.agent_id}" + (f" (takes over from {old}: recorded as a restart)" if old and old != a.agent_id else ""))


GIVE_UP_OK = ("competitor", "attack", "defend", "harvest", "swap_judge", "harvest_check")


def cmd_give_up(a):
    """Write NO OUTPUT into every missing output of a job that failed twice, and record why."""
    st, d = load()
    js = {j["id"]: j for j in jobs(st, d)}
    j = js.get(a.job)
    if j is None:
        die(f"{a.job} is not a job of this phase ({', '.join(js) or 'none'})")
    if j["role"] not in GIVE_UP_OK:
        die(f"{a.job} is a {j['role'].replace('_', ' ')}: never given up. Give it a third, fresh run.")
    wrote = []
    for o in j["outs"]:
        if not filled(o):
            Path(o).write_text(NO_OUTPUT + "\n")
            wrote.append(rel(st, o))
    st["no_output"][a.job] = str(a.why)[:120]
    save(st, d)
    print(f"{a.job}: NO OUTPUT written to {', '.join(wrote) or 'nothing (every output was there)'}. Run next.")


def cmd_tokens(a):
    st, d = load()
    if a.job not in st["jobmeta"]:
        die(f"unknown job {a.job}. The jobs so far: {', '.join(st['jobmeta']) or 'none'}")
    try:
        n = int(a.n.replace(",", "").replace("_", ""))
    except ValueError:
        die(f"tokens must be a whole number, got {a.n!r}")
    if n < 0:
        die("tokens cannot be negative")
    st["tokens"][a.job] = n
    save(st, d)
    print(f"{a.job}: {n} tokens")


# ---------- real token usage, from agent-radar's live file ----------

def radar_label(desc):
    """(role, key) from an Agent call's description, as the gauntlet writes it and agent-radar draws it:
    `Gauntlet competitor C` -> (competitor, C); `Gauntlet judge r1m2` -> (judge, r1m2); `Gauntlet judge
    r1m2 swap` -> (swap_judge, r1m2); `Gauntlet judge final` -> (final, final); `Gauntlet judge check` ->
    (harvest_check, check). Runs before 0.3.1 gave the
    swap judge its match's description: `assign_swap` tells those apart by start order."""
    d = str(desc or "")
    m = re.match(r"Gauntlet competitor ([A-H])\b", d)
    if m:
        return "competitor", m.group(1)
    m = re.fullmatch(r"Gauntlet judge (r\d{1,2}m\d{1,2}) swap", d)
    if m:
        return "swap_judge", m.group(1)
    m = re.fullmatch(r"Gauntlet judge (r\d{1,2}m\d{1,2}|final|check)", d)
    if m:
        return {"final": "final", "check": "harvest_check"}.get(m.group(1), "judge"), m.group(1)
    return None


def counts_of(tc):
    """The four token kinds from a tokenCounts object; None when it is not one."""
    if not isinstance(tc, dict):
        return None
    out = {}
    for k in TOKEN_KINDS:
        v = tc.get(k, 0)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
            return None
        out[k] = int(v)
    return out


def read_radar(path):
    """One agent-radar live file as a dict, or None when it is empty, broken or not a live file."""
    try:
        f = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None
    return f if isinstance(f, dict) and isinstance(f.get("agents"), list) else None


def family(model, fallback=None):
    """sonnet or opus from radar's model id (claude-sonnet-5-5), else the fallback."""
    m = re.search(r"(sonnet|opus)", str(model or "").lower())
    return m.group(1) if m else fallback


def cost_of(model, tok):
    """Estimated dollars for one agent's tokens at list prices; None for a model with no price."""
    p = PRICES.get(model)
    if p is None or tok is None:
        return None
    return (tok["input"] * p["input"] + tok["output"] * p["output"] + tok["cacheRead"] * p["cacheRead"]
            + tok["cacheWrite"] * p["input"] * CACHE_WRITE) / 1e6


def run_agents(st, f):
    """This run's agents in one live file: {agent id: snapshot}. A competitor is matched by its registered
    agent id, or by its description; a judge by its description. Either way it must have started inside
    the run (after init, and before DONE when the run is done), so an older run in the same session with
    the same descriptions does not count."""
    ids = {aid: x for x, aid in st["agent_ids"].items()}
    lo = (st.get("started") or 0) * 1000 - 2000
    hi = st["done_at"] * 1000 + 2000 if st.get("done_at") else None
    out = {}
    for ag in f.get("agents", []):
        if not isinstance(ag, dict) or not ag.get("id"):
            continue
        tok = counts_of(ag.get("tokenCounts"))
        lab = radar_label(ag.get("description"))
        t0 = ag.get("startedAt") if isinstance(ag.get("startedAt"), (int, float)) else None
        inside = t0 is not None and t0 >= lo and (hi is None or t0 <= hi)
        if ag["id"] in ids:
            role, key = "competitor", ids[ag["id"]]
        elif lab and inside and ((lab[0] == "competitor" and lab[1] in st["cards"])
                                 or (lab[0] == "swap_judge" and f"{lab[1]}-swap" in st["jobmeta"])
                                 or (lab[0] in ("judge", "final", "harvest_check") and lab[1] in st["jobmeta"])):
            role, key = lab
        else:
            continue
        if tok is None:
            continue
        fallback = (st["models"]["competitors"][key] if role == "competitor" else st["models"]["roles"][role])["model"]
        out[str(ag["id"])] = {"role": role, "key": key, "description": str(ag.get("description") or "")[:80],
                              "model": family(ag.get("model"), fallback), "startedAt": t0,
                              "status": str(ag.get("status") or "?"), "tokens": tok}
    return out


def assign_swap(st, agents):
    """True when the swap judge was told apart by start order. Since 0.3.1 its description says `swap`, so
    `run_agents` already knows it. A run before that gave it its match's description: the next job list puts
    it right after its match's judge in one message, so of the agents with that description the one started
    last is the swap judge. A re-run judge in that match would blur this; the ledger says `by start order`."""
    sw = st["swap"]
    if not sw.get("match") or f"{sw['match']}-swap" not in st["jobmeta"]:
        return False
    same = sorted((a for a in agents.values() if a["role"] in ("judge", "swap_judge") and a["key"] == sw["match"]),
                  key=lambda a: a["startedAt"] or 0)
    if any((radar_label(a.get("description")) or ("",))[0] == "swap_judge" for a in same):
        return False
    for a in same:
        a["role"] = "judge"
    if len(same) >= 2:
        same[-1]["role"] = "swap_judge"
        return True
    return False


def expected_agents(st):
    """The labels this run should have in the radar data so far: every competitor that started, every judge
    job listed (less auto-decided matches and a given-up swap judge)."""
    out = [f"competitor {x}" for x in st["cards"] if f"spawn-{x}" in st["jobmeta"]]
    for j, meta in st["jobmeta"].items():
        if meta["role"] == "judge" and not st["verdicts"].get(j, {}).get("auto"):
            out.append(f"judge {j}")
        elif meta["role"] == "swap_judge" and not st["swap"].get("why"):
            out.append(f"judge {j}")
        elif meta["role"] == "final":
            out.append("judge final")
        elif meta["role"] == "harvest_check" and st["check"].get("ran") is not False:
            out.append("judge check")
    return out


def agent_label(a):
    if a["role"] == "competitor":
        return f"competitor {a['key']}"
    return f"judge {a['key']}" + ("-swap" if a["role"] == "swap_judge" else "")


def usage_summary(st):
    """Real usage from the radar snapshots: per agent and per role, tokens by kind and the cost estimate."""
    r = st.get("radar") or {}
    agents = {k: dict(v) for k, v in (r.get("agents") or {}).items()}
    if not agents:
        return None
    by_order = assign_swap(st, agents)
    rows, by_role = [], {}
    for aid, a in sorted(agents.items(), key=lambda kv: (kv[1]["startedAt"] or 0)):
        c = cost_of(a["model"], a["tokens"])
        rows.append({"label": agent_label(a), "role": a["role"], "model": a["model"], "status": a["status"],
                     "tokens": a["tokens"], "total": sum(a["tokens"].values()),
                     "cost_usd": round(c, 4) if c is not None else None})
        b = by_role.setdefault(a["role"], {"agents": 0, "tokens": {k: 0 for k in TOKEN_KINDS}, "total": 0, "cost_usd": 0.0})
        b["agents"] += 1
        for k in TOKEN_KINDS:
            b["tokens"][k] += a["tokens"][k]
        b["total"] += sum(a["tokens"].values())
        b["cost_usd"] += c or 0.0
    for b in by_role.values():
        b["cost_usd"] = round(b["cost_usd"], 4)
    seen = {x["label"] for x in rows}
    total = {k: sum(b["tokens"][k] for b in by_role.values()) for k in TOKEN_KINDS}
    return {"source": "agent-radar", "session": r.get("session"), "agents": rows, "by_role": by_role,
            "tokens": total, "total": sum(total.values()),
            "cost_usd_estimate": round(sum(b["cost_usd"] for b in by_role.values()), 4),
            "missing": [x for x in expected_agents(st) if x not in seen],
            "swap_by_start_order": by_order,
            "prices": PRICE_NOTE}


def find_radar(st, folder, session):
    """(session id, live file) for this run. --session wins; then the session found before; then the one
    live file that holds this run's registered competitors (or, with none registered yet, its agents)."""
    if session:
        if not re.fullmatch(SESSION_ID, session):
            die(f"{session!r} is not a session id")
        f = read_radar(folder / f"{session}.json")
        if f is None:
            die(f"no agent-radar live file for session {session} in {folder}")
        return session, f
    known = (st.get("radar") or {}).get("session")
    if known:
        f = read_radar(folder / f"{known}.json")
        if f is not None:
            return known, f
    scored = []
    for path in sorted(folder.glob("*.json")) if folder.is_dir() else []:
        f = read_radar(path)
        if f is None:
            continue
        ids = {str(a.get("id")) for a in f["agents"] if isinstance(a, dict)}
        reg = len(ids & set(st["agent_ids"].values()))
        hits = reg * 1000 + len(run_agents(st, f))
        if hits:
            scored.append((hits, path.stem, f))
    if not scored:
        die(f"no agent-radar live file in {folder} holds this run's agents. Is agent-radar 1.5.0 or later on? "
            "If you know the session, pass --session <id> (the orchestrator gets its own id from the ccd "
            "get_session tool with \"self\").")
    scored.sort(key=lambda t: -t[0])
    if len(scored) > 1 and scored[0][0] == scored[1][0]:
        die("more than one session's live file matches this run: " + ", ".join(t[1] for t in scored[:4])
            + ". Pass --session <id> (the ccd get_session tool with \"self\" gives this session's id).")
    return scored[0][1], scored[0][2]


def fmt_tokens(tok):
    return ", ".join(f"{k} {tok[k]:,}" for k in TOKEN_KINDS)


def cmd_tokens_from_radar(a):
    """Read only: copies this run's agents from agent-radar's live file into the state. The file keeps
    only the live agents and the newest finished ones (16 since agent-radar 1.6.0, 6 before), so run this
    after every wave: each agent's tokens are cumulative, and the biggest snapshot of each agent is kept."""
    st, d = load()
    folder = Path(a.radar_dir) if a.radar_dir else radar_dir()
    session, f = find_radar(st, folder, a.session)
    found = run_agents(st, f)
    r = st.get("radar") or {"session": session, "agents": {}}
    if r.get("session") != session:
        r = {"session": session, "agents": {}}   # a different session: the old snapshots are another file's
    for aid, snap in found.items():
        old = r["agents"].get(aid)
        if old is None or sum(snap["tokens"].values()) >= sum(old["tokens"].values()):
            r["agents"][aid] = snap
    r["read_at"] = time.time()
    st["radar"] = r
    save(st, d)
    u = usage_summary(st)
    running = sorted(x["label"] for x in u["agents"] if x["status"] in ("pending", "running", "waiting"))
    print(f"agent-radar session {session}: {len(found)} agent(s) of this run in the file now, "
          f"{len(u['agents'])} recorded so far.")
    for role, b in sorted(u["by_role"].items()):
        print(f"  {role:<11} {b['agents']} agent(s)  {b['total']:>12,} tokens ({fmt_tokens(b['tokens'])})  "
              f"est. ${b['cost_usd']:.2f}")
    print(f"  total       {u['total']:>12,} tokens, est. ${u['cost_usd_estimate']:.2f} ({PRICE_NOTE})")
    if running:
        print(f"still running in the file: {', '.join(running)}. Run tokens-from-radar again after they finish.")
    if u["missing"]:
        print(f"not in the radar data: {', '.join(u['missing'])}. The file keeps only the newest 16 finished "
              "agents (6 before agent-radar 1.6.0): run tokens-from-radar after every wave.")


def cmd_status(a):
    st, d = load()
    print(f"run {d}\nphase {st['phase']}, round {st['round']}, seed {st['seed']}, task type {st['task_type']}")
    print(f"alive: {' '.join(st['alive'])}")
    if st["eliminated"]:
        print("out: " + ", ".join(f"{x} (round {r})" for x, r in st["eliminated"].items()))
    if st["matches"]:
        print("matches: " + ", ".join(" v ".join(m) for m in st["matches"]))
    mm = st["models"]
    print(models_line(mm["roles"], ", ".join(f"{x} {m['model']} {m['effort']}" for x, m in mm["competitors"].items()))
          + f" ({mm['mode']})")
    sw = st["swap"]
    print(f"swap judge: {sw['match']}" + (f" (skipped: {sw['why']})" if sw["why"] else "") if sw["match"]
          else f"swap judge: none ({sw['why']})")
    print(f"context tokens recorded for {len(st['tokens'])} of {len(st['jobmeta'])} job(s)")
    u = usage_summary(st)
    print(f"real usage (agent-radar): {len(u['agents'])} agent(s), {u['total']:,} tokens, est. "
          f"${u['cost_usd_estimate']:.2f}" + (f"; not yet seen: {', '.join(u['missing'])}" if u["missing"] else "")
          if u else "real usage (agent-radar): none read yet (tokens-from-radar)")
    missing = [x for x in st["cards"] if x not in st["agent_ids"]]
    if missing and st["phase"] != "spawn":
        print(f"no agent id for: {' '.join(missing)}")


def cmd_blind(a):
    st, d = load()
    if st["phase"] != "done":
        die(f"not done yet (phase {st['phase']}). Run next.")
    fin = st.get("finalists") or {}
    if len(fin) != 2 or any(is_no_output(p) for p in fin.values()):
        die("no blind pick for this run: the last match had no two judged solutions.")
    first, second = sorted(fin)
    x_first = random.Random(f"{st['seed']}-blind").random() < 0.5
    st["blind_map"] = {"X": first, "Y": second} if x_first else {"X": second, "Y": first}
    (d / "blind").mkdir(exist_ok=True)
    for label, x in st["blind_map"].items():
        (d / "blind" / f"{label}.md").write_text(Path(fin[x]).read_text())
    save(st, d)
    print(f"X {d / 'blind' / 'X.md'}\nY {d / 'blind' / 'Y.md'}")
    print("The two finalists as the last judge saw them, in seeded order. Show the person both BEFORE the "
          "winner, and do not say which one won. Record the answer with: rate <verdict> --pick X|Y")


def cmd_winner(a):
    st, d = load()
    if st["phase"] != "done":
        die(f"not done yet (phase {st['phase']}). Run next.")
    w = st["alive"][0]
    c = st["cards"][w]
    m = st["models"]["competitors"][w]
    print(f"champion {w}: {c['lens']['name']} + {c['workflow']['name']} + {c['priority']['name']} "
          f"({m['model']} {m['effort']})")
    print(f"solution {st['sol'][w]}")
    rounds = st["n"].bit_length() - 1
    print(f"{rounds} round(s), {st['n']} in, 1 left.")
    for mid in sorted(st["verdicts"], key=mkey):
        v = st["verdicts"][mid]
        if v["winner"] == w:
            t = v.get("totals", {})
            score = f" {t[w]}-{t[v['loser']]}" if t else ""
            print(f"{mid}: beat {v['loser']}{score}. {v.get('reason', '')}")
            for s in by_letter(v, "survived", w):
                print(f"  survived: {item_text(s)}")
            for e in standing_list(v, w):
                print(f"  still standing: {entry_text(e)}")
    h = st.get("harvest")
    if h and h.get("ran"):
        out = h.get("outcome") or ("failed" if h["kept_previous"] else "revised")
        print(f"harvest: {h['items']} attack(s) still standing across the run; conceded {h['conceded']}, "
              f"rejected {h['rejected']}" + {"revised": ".", "no_change": ". NO CHANGE: the judged solution stands.",
                                              "failed": ". NO OUTPUT: the judged solution stands."}[out])
        ck = st["check"]
        cv = ck.get("verdict")
        if cv:
            m = cv["map"]
            inv = {r: lab for lab, r in m.items()}
            print(f"harvest check: after {cv['totals'][inv['after']]}, before {cv['totals'][inv['before']]}: "
                  + ("the revision went out." if cv["kept"] else "the revision was worse, so the judged solution went out.")
                  + f" Rejections judged wrong: {cv['rejects_wrong']} of {cv['rejects_checked']}.")
        elif out == "revised":
            print("harvest check: " + ("not run (no start left under the cap): the revision went out unjudged. "
                                       "Tell the person." if ck.get("why") == "cap" else
                                       "given up: the judged solution went out."))
    if st["reruns"] or st["audit"]["leaks"] or st["integrity"]:
        print(f"integrity: {len(st['reruns'])} judge re-run(s), {len(st['audit']['leaks'])} audit leak(s), "
              f"{len(st['integrity'])} accepted file change(s). Details: audit.")
    f = st["final"]
    if f:
        fm = f["map"]
        champ = "X" if fm["X"] == "champion" else "Y"
        base = "Y" if champ == "X" else "X"
        print(f"against the rejected answer: champion {f['totals'][champ]}, rejected answer "
              f"{f['totals'][base]}. Winner: {fm[f['winner']]}. {f.get('reason', '')}")
    print(f"record {d}")
    print("After the person's verdict: rate accepted|edited|rejected [--missing TEXT] [--note TEXT] [--pick X|Y]")


# ---------- the ledger ----------

def swap_result(st):
    s = st["swap"]
    if not s["match"] or s["why"]:
        return {"ran": False, "match": s["match"], "why": s["why"]}
    sv, first = s.get("verdict"), st["verdicts"].get(s["match"])
    if not sv or not first:
        return {"ran": False, "match": s["match"], "why": "no output"}
    return {"ran": True, "match": s["match"], "agree": sv["winner"] == first["winner"],
            "same_conclusion": sv.get("same_conclusion")}


def ledger_record(st, d, a):
    """One metadata-only line: ids, models, scores, counts, hashes and the person's own words. Never a
    solution, attack, defense, judge reason or anything from the task's files."""
    champ, comp = st["alive"][0], st["models"]["competitors"]
    competitors = {x: {"lens": c["lens"]["id"], "workflow": c["workflow"]["id"], "priority": c["priority"]["id"],
                       "model": comp[x]["model"], "effort": comp[x]["effort"], "out_round": st["eliminated"].get(x)}
                   for x, c in st["cards"].items()}
    matches, standing_total = [], {}
    for mid, rnd, (p, q), v in judged(st):
        attacks, standing = {}, {}
        for x, opp in ((p, q), (q, p)):
            blocks = attack_blocks(attack_file(d, rnd, opp, x))
            attacks[x] = tally(b[1] for b in blocks.values())
            standing[x] = tally(standing_kind(s, blocks) for s in standing_list(v, x))
            for k, n in standing[x].items():
                standing_total[k] = standing_total.get(k, 0) + n
        sc, words, w, lo = v.get("scores", {}), v.get("words", {}), v["winner"], v["loser"]
        longer = None
        if not v.get("auto") and words.get(w) is not None and words.get(lo) is not None and words[w] != words[lo]:
            longer = words[w] > words[lo]
        tot = v.get("totals", {})
        matches.append({
            "id": mid, "round": rnd, "pair": [p, q], "winner": w, "auto": bool(v.get("auto")),
            "models": {x: comp[x]["model"] for x in (p, q)}, "efforts": {x: comp[x]["effort"] for x in (p, q)},
            "pick": v.get("pick"), "margin": round(abs(tot[p] - tot[q]), 1) if p in tot and q in tot else None,
            "scores": {x: {k: sc[x][k] for k in WEIGHTS} for x in (p, q) if x in sc},
            "fatal": {x: bool(sc[x].get("fatal")) for x in (p, q) if x in sc},
            "totals": v.get("totals", {}), "words": {x: words.get(x) for x in (p, q)}, "longer_won": longer,
            "attacks": attacks, "standing": standing, "same_conclusion": v.get("same_conclusion"),
        })
    final = None
    f = st.get("final")
    if f:
        inv = {role: lab for lab, role in f["map"].items()}
        final = {"winner": f["map"][f["winner"]],
                 "totals": {role: f["totals"][inv[role]] for role in ("champion", "baseline")},
                 "fatal": {role: bool(f["scores"][inv[role]].get("fatal")) for role in ("champion", "baseline")}}
    ck = st["check"]
    cv = ck.get("verdict")
    check = {"planned": bool(ck.get("planned")), "ran": bool(cv), "why": ck.get("why"), "kept": ck.get("kept")}
    if cv:
        inv = {r: lab for lab, r in cv["map"].items()}
        check.update(totals={r: cv["totals"][inv[r]] for r in ("before", "after")},
                     rejects_checked=cv["rejects_checked"], rejects_wrong=cv["rejects_wrong"])
    harvest = {k: v for k, v in (st.get("harvest") or {}).items() if k != "path"} if st.get("harvest") else None
    au = st["audit"]
    pick = None
    if a.pick:
        x = st["blind_map"][a.pick]
        pick = {"pick": a.pick, "letter": x, "is_champion": x == champ}
    return {
        "date": time.strftime("%Y-%m-%d"), "run": run_id(st), "seed": st["seed"], "n": st["n"],
        "task_type": st["task_type"], "baseline": st["baseline"],
        "models": {"mode": st["models"]["mode"],
                   **{r: st["models"]["roles"][r] for r in ("judge", "swap_judge", "harvest_check", "final")}},
        "champion": champ, "competitors": competitors, "matches": matches, "standing_by_type": standing_total,
        "swap": swap_result(st), "harvest": harvest, "check": check, "final": final,
        "audit": {"available": au.get("available"),
                  "leaks": [{k: x[k] for k in ("job", "who", "kind", "what")} for x in au["leaks"]],
                  "voided": [x["job"] for x in au["voided"]]},
        "verdict_check": verdict_check(st), "reruns": [r["job"] for r in st["reruns"]],
        "restarts": st["restarts"], "no_output": sorted(st["no_output"]), "integrity": st["integrity"],
        "task_sha": st.get("task_sha"),
        "user": {"verdict": a.verdict, "missing": a.missing, "note": a.note, "blind_offered": bool(st.get("blind_map")),
                 "blind_pick": pick},
        "jobs": [{"id": j, **meta, "context_tokens": st["tokens"].get(j)} for j, meta in st["jobmeta"].items()],
        "usage": usage_summary(st), "versions": st["versions"], "sample": bool(a.sample),
    }


def read_ledger():
    p = log_dir() / "ledger.jsonl"
    recs = []
    if p.exists():
        for i, line in enumerate(p.read_text().splitlines(), 1):
            if line.strip():
                try:
                    recs.append(json.loads(line))
                except json.JSONDecodeError:
                    print(f"gauntlet: ledger line {i} is not JSON, skipped", file=sys.stderr)
    return p, recs


def cmd_rate(a):
    st, d = load()
    if st["phase"] != "done":
        die(f"not done yet (phase {st['phase']}). Rate a run after DONE.")
    path, recs = read_ledger()
    if st.get("rated") or any(r.get("run") == run_id(st) for r in recs):
        die(f"run {run_id(st)} is already rated. A run is rated once.")
    if a.pick and not st.get("blind_map"):
        die("no blind pick was set up for this run: run blind first, or leave out --pick")
    run_audit(st, d, act=False)
    rec = ledger_record(st, d, a)
    if rec["usage"] is None:
        print("note: no real token usage for this run (tokens-from-radar was not run); the ledger says null.")
    elif rec["usage"]["missing"]:
        print(f"note: real usage is missing for {len(rec['usage']['missing'])} agent(s): "
              f"{', '.join(rec['usage']['missing'])}")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as fh:
            fh.write(json.dumps(rec) + "\n")
    except OSError as err:
        die(f"cannot write {path}: {err}. If the sandbox blocked it, run rate again with the sandbox off.")
    st["rated"] = True
    save(st, d)
    print(f"rated {run_id(st)}: {a.verdict}" + (" (sample: history leaves it out)" if a.sample else "")
          + f". One line added to {path}")


# ---------- history ----------

def _betacf(a, b, x):
    """Continued fraction of the incomplete beta function (modified Lentz)."""
    tiny = 1e-30
    c, dd = 1.0, 1.0 - (a + b) * x / (a + 1.0)
    dd = 1.0 / (dd if abs(dd) > tiny else tiny)
    h = dd
    for m in range(1, 300):
        for aa in (m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)),
                   -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))):
            dd = 1.0 + aa * dd
            dd = 1.0 / (dd if abs(dd) > tiny else tiny)
            c = 1.0 + aa / c
            c = c if abs(c) > tiny else tiny
            h *= dd * c
        if abs(dd * c - 1.0) < 1e-12:
            break
    return h


def betainc(a, b, x):
    """The regularized incomplete beta function I_x(a, b): the Beta(a, b) CDF at x."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1) / (a + b + 2):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1 - x) / b


def beta_ppf(q, a, b):
    lo, hi = 0.0, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if betainc(a, b, mid) < q:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def beta_summary(wins, losses):
    """Beta(1,1) prior: the posterior mean and 80% interval of the win rate."""
    a, b = 1 + wins, 1 + losses
    return a / (a + b), beta_ppf(0.1, a, b), beta_ppf(0.9, a, b)


def fmt_beta(wins, losses):
    mean, lo, hi = beta_summary(wins, losses)
    return f"{mean:.2f} [{lo:.2f}, {hi:.2f}]"


def print_table(rows):
    widths = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    for r in rows:
        print("  " + "  ".join(str(c).ljust(w) for c, w in zip(r, widths)).rstrip())


def rate_line(label, hits, n, what):
    if n == 0:
        print(f"{label}: no data yet")
    else:
        print(f"{label}: {hits} of {n} {what}, rate {hits / n:.2f}; Beta(1,1) {fmt_beta(hits, n - hits)}")


def context_of(j):
    """A job's context size: `context_tokens`, or `tokens` in a line written before 0.3.0."""
    return j.get("context_tokens", j.get("tokens"))


def cmd_history(a):
    path, recs = read_ledger()
    samples = sum(bool(r.get("sample")) for r in recs)
    if not a.all:
        recs = [r for r in recs if not r.get("sample")]
    if not recs:
        print(f"no rated runs in {path} yet. After a run: rate accepted|edited|rejected"
              + (f" ({samples} sample run(s) left out: history --all)" if samples else ""))
        return
    labels = {}
    for r in recs:
        key = tuple(r.get("versions", {}).get(k, "?") for k in VERSION_KEYS)
        r["_v"] = labels.setdefault(key, f"v{len(labels) + 1}")
    if a.version:
        keep = set(a.version.split(","))
        recs = [r for r in recs if r["_v"] in keep]
        if not recs:
            die(f"no runs with version label(s) {a.version}")
    shown = sorted({r["_v"] for r in recs}, key=lambda s: int(s[1:]))
    print(f"gauntlet history: {len(recs)} rated run(s), version set(s) {', '.join(shown)}. Ledger {path}")
    if samples:
        print(f"{samples} sample run(s) " + ("included (--all)." if a.all else "left out: history --all shows them."))
    print("versions (file hashes; a new label means the rubric, cards, templates or models changed):")
    for key, lab in labels.items():
        if lab in shown:
            plugins = sorted({r.get("versions", {}).get("plugin", "?") for r in recs if r["_v"] == lab})
            print(f"  {lab}: " + ", ".join(f"{k} {h}" for k, h in zip(VERSION_KEYS, key))
                  + f"; plugin {', '.join(plugins)}; {sum(r['_v'] == lab for r in recs)} run(s)")

    print(f"\nruns (last {min(a.last, len(recs))}):")
    rows = [("date", "run", "n", "type", "models", "champion", "lens", "model", "final", "verdict", "tokens",
             "est. $", "ver")]
    for r in recs[-a.last:]:
        ch = r["champion"]
        c = r["competitors"][ch]
        u = r.get("usage")
        tok = f"{u['total']:,}" + ("+" if u.get("missing") else "") if u else "-"
        rows.append((r["date"], r["run"], r["n"], r["task_type"], r["models"]["mode"], ch, c["lens"], c["model"],
                     r["final"]["winner"] if r.get("final") else "-",
                     r["user"]["verdict"] + (" (sample)" if r.get("sample") else ""), tok,
                     f"{u['cost_usd_estimate']:.2f}" if u else "-", r["_v"]))
    print_table(rows)

    judged_ms = [(r, m) for r in recs for m in r["matches"] if not m["auto"]]
    lens = {}
    for r, m in judged_ms:
        for x in m["pair"]:
            k = r["competitors"][x]["lens"]
            w, lo = lens.get(k, (0, 0))
            lens[k] = (w + (x == m["winner"]), lo + (x != m["winner"]))
    print("\nlens wins in judged matches (won-lost; Beta(1,1) mean [80% interval]):")
    for k, (w, lo) in sorted(lens.items(), key=lambda kv: -beta_summary(*kv[1])[0]):
        print(f"  {k:<22} {w}-{lo}  {fmt_beta(w, lo)}")

    h2h = {}
    for r, m in judged_ms:
        if r["models"]["mode"] == "mixed" and sorted(m["models"].values()) == ["opus", "sonnet"]:
            eff = {x: (m.get("efforts") or {}).get(x) or r["competitors"][x]["effort"] for x in m["pair"]}
            o = next(x for x in m["pair"] if m["models"][x] == "opus")
            s_ = next(x for x in m["pair"] if m["models"][x] == "sonnet")
            key = f"opus {eff[o]} vs sonnet {eff[s_]}"
            won, n, runs = h2h.get(key, (0, 0, set()))
            h2h[key] = (won + (m["winner"] == o), n + 1, runs | {r["run"]})
    if h2h:
        print("\nopus vs sonnet in mixed runs (a diagnostic only: confounded by who attacks whom, by same-family "
              "judges and by matches that share a task; not a basis for the model default):")
        for key, (won, n, runs) in sorted(h2h.items()):
            print(f"  {key}: opus won {won} of {n} head-to-head match(es) from {len(runs)} run(s); "
                  f"Beta(1,1) {fmt_beta(won, n - won)}")
    else:
        print("\nopus vs sonnet: no head-to-head matches yet (init --models mixed)")

    if any(r.get("usage") for r in recs):
        print("  tokens: real usage from agent-radar; + means some agents were not in the radar data")
    used = [r for r in recs if r.get("usage")]
    print(f"\nreal usage per agent, by role and model (agent-radar; {len(used)} of {len(recs)} run(s); "
          "cost at list prices, an estimate):")
    per = {}
    for r in used:
        for ag in r["usage"]["agents"]:
            per.setdefault((ag["role"], ag["model"]), []).append(ag)
    for (role, model), xs in sorted(per.items()):
        cost = [x["cost_usd"] for x in xs if x.get("cost_usd") is not None]
        print(f"  {role:<11} {model:<7} {sum(x['total'] for x in xs) / len(xs):>12,.0f} tokens"
              + (f"  ${sum(cost) / len(cost):.2f}" if cost else "") + f"  (n={len(xs)})")
    if not per:
        print("  none recorded yet (tokens-from-radar after every wave)")
    if used:
        tot = [r["usage"]["cost_usd_estimate"] for r in used]
        print(f"  per run: {sum(r['usage']['total'] for r in used) / len(used):,.0f} tokens, "
              f"est. ${sum(tot) / len(tot):.2f} on average")

    # The context size is not cost: shown only on request, so nobody reads it as usage.
    if a.context:
        tok, missing = {}, 0
        for r in recs:
            for j in r.get("jobs", []):
                if context_of(j) is None:
                    missing += 1
                else:
                    tok.setdefault((j["role"], j["model"]), []).append(context_of(j))
        print("\nmean context size per job at the end of its call (the Agent or SendMessage result's number; "
              "not usage):")
        for (role, model), xs in sorted(tok.items()):
            print(f"  {role:<11} {model:<7} {sum(xs) / len(xs):>10,.0f}  (n={len(xs)})")
        if not tok:
            print("  none recorded yet (tokens <job id> <n>)")
        if missing:
            print(f"  {missing} job(s) have no context number")

    print()
    lb = [m["longer_won"] for _, m in judged_ms if m.get("longer_won") is not None]
    rate_line("length bias", sum(lb), len(lb), "judged matches with unequal lengths went to the longer solution")
    sw = [r["swap"]["agree"] for r in recs if r.get("swap", {}).get("ran")]
    rate_line("swap agreement", sum(sw), len(sw), "swap judges picked the same winner as the first judge")
    sc = [m["same_conclusion"] for _, m in judged_ms if isinstance(m.get("same_conclusion"), bool)]
    rate_line("same conclusion", sum(sc), len(sc), "judged matches had two solutions with the same conclusion")
    bp = [r["user"]["blind_pick"]["is_champion"] for r in recs if r["user"].get("blind_pick")]
    rate_line("blind pick", sum(bp), len(bp), "blind picks named the champion")
    ck = [r["check"]["kept"] for r in recs if (r.get("check") or {}).get("ran")]
    rate_line("harvest check", sum(bool(x) for x in ck), len(ck), "harvest checks kept the revision")
    audited = [r for r in recs if (r.get("audit") or {}).get("available")]
    print(f"audit: {sum(len(r['audit']['leaks']) for r in audited)} leak(s) in {len(audited)} audited run(s) of "
          f"{len(recs)}; judge re-runs {sum(len(r.get('reruns') or []) for r in recs)}, verdicts taken back "
          f"{sum(len(r['audit']['voided']) for r in audited)}")
    verdicts = tally(r["user"]["verdict"] for r in recs)
    print("user verdicts: " + ", ".join(f"{k} {verdicts.get(k, 0)}" for k in USER_VERDICTS))
    st_types = {}
    for r in recs:
        for k, n in r.get("standing_by_type", {}).items():
            st_types[k] = st_types.get(k, 0) + n
    if st_types:
        print("attacks still standing, by type: "
              + ", ".join(f"{k} {n}" for k, n in sorted(st_types.items(), key=lambda kv: -kv[1])))


def main(argv=None):
    p = argparse.ArgumentParser(prog="gauntlet")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("plan")
    s.add_argument("--agents", type=int, default=4)
    s.add_argument("--baseline", action="store_true")
    s.add_argument("--models", default="mixed",
                   help="mixed (the default: half opus, half sonnet), sonnet (alias default: all sonnet) "
                        "or the path of a models file")
    s.set_defaults(fn=cmd_plan)
    s = sub.add_parser("init")
    s.add_argument("--agents", type=int, default=4)
    s.add_argument("--seed", type=int)
    s.add_argument("--task-file", required=True)
    s.add_argument("--baseline-file")
    s.add_argument("--task-type", choices=TASK_TYPES, default="other")
    s.add_argument("--models", default="mixed",
                   help="mixed (the default: half opus, half sonnet), sonnet (alias default: all sonnet) "
                        "or the path of a models file")
    s.set_defaults(fn=cmd_init)
    s = sub.add_parser("next")
    s.add_argument("--accept-changes", action="store_true",
                   help="go on although finished files changed (the ledger records which)")
    s.set_defaults(fn=cmd_next)
    s = sub.add_parser("give-up", help="write NO OUTPUT for a job that failed twice, and record why")
    s.add_argument("job")
    s.add_argument("--why", required=True)
    s.set_defaults(fn=cmd_give_up)
    sub.add_parser("audit", help="what each sub-agent read and wrote outside its set, from the transcripts").set_defaults(fn=cmd_audit)
    s = sub.add_parser("register")
    s.add_argument("agent")
    s.add_argument("agent_id")
    s.set_defaults(fn=cmd_register)
    s = sub.add_parser("verdict")
    s.add_argument("match")
    s.add_argument("--rerun", help="replace an existing verdict; the reason goes in the ledger count")
    s.set_defaults(fn=cmd_verdict)
    s = sub.add_parser("tokens")
    s.add_argument("job")
    s.add_argument("n")
    s.set_defaults(fn=cmd_tokens)
    s = sub.add_parser("tokens-from-radar", help="read this run's real token usage from agent-radar's live file")
    s.add_argument("--session", help="the orchestrator's session id; found from the registered agents if left out")
    s.add_argument("--radar-dir", help=argparse.SUPPRESS)
    s.set_defaults(fn=cmd_tokens_from_radar)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("blind").set_defaults(fn=cmd_blind)
    sub.add_parser("winner").set_defaults(fn=cmd_winner)
    s = sub.add_parser("rate")
    s.add_argument("verdict", choices=USER_VERDICTS)
    s.add_argument("--missing", help="what the person said was missing, in their words")
    s.add_argument("--note", help="any other note from the person")
    s.add_argument("--pick", choices=("X", "Y"), help="the person's blind pick, after blind")
    s.add_argument("--sample", action="store_true", help="a test run: in the ledger, but left out of history")
    s.set_defaults(fn=cmd_rate)
    s = sub.add_parser("history")
    s.add_argument("--last", type=int, default=20, help="rows in the runs table")
    s.add_argument("--version", help="only these version labels, for example v2 or v1,v2")
    s.add_argument("--all", action="store_true", help="include sample runs")
    s.add_argument("--context", action="store_true", help="also show the mean context size per job (not usage)")
    s.set_defaults(fn=cmd_history)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
