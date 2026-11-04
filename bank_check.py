#!/usr/bin/env python3
"""Bank health gate — run after EVERY bank change, before pushing.

    python3 bank_check.py

Checks the whole bot bank (1,01,905 questions) and writes:
  - BANK-HEALTH.md  (summary, committed so the state is visible)
  - quarantine.json (poll-unaskable items, by chapter/position/id)

Hard problems (must be 0): answer letter not in options, empty option,
bot<->app drift on the main bank, bot<->source drift on Telegram sets.
Known structural limits are reported, not hidden: single-option broken
items (quarantined, the bot auto-skips them), duplicate-option items,
options/questions over Telegram's poll limits, and any remaining
conflicting-answer groups (same question+options, different keyed
answer in different copies).
"""
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(HERE)
BANK = os.path.join(HERE, "bank")
SRC = os.path.join(HERE, "bank-src")


def opts_list(o):
    if isinstance(o, dict):
        L = sorted(o.keys())
        return L, [str(o[l]) for l in L]
    if isinstance(o, list):
        return [chr(65 + i) for i in range(len(o))], [str(x) for x in o]
    return [], []


def nrm(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower()


def main():
    index = json.load(open(os.path.join(BANK, "index.json")))
    stats = Counter()
    quarantine = []
    groups = defaultdict(list)
    drift = []
    items_by_ci = {}
    def part_key(pf):
        m = re.match(r"p-(\d+)-(\d+)\.json", os.path.basename(pf))
        return (int(m.group(1)), int(m.group(2)))
    for pf in sorted(glob.glob(os.path.join(BANK, "p-*.json")), key=part_key):
        ci, pk = part_key(pf)
        part = json.load(open(pf))
        items_by_ci.setdefault(ci, []).extend(part)
        for off, item in enumerate(part):
            qi = pk * 100 + off
            stats["total"] += 1
            L, opts = opts_list(item.get("options"))
            ans = item.get("answer")
            q = str(item.get("q") or "")
            if item.get("i"):
                stats["with_id"] += 1
            if item.get("e"):
                stats["with_explanation"] += 1
            bad = None
            if ans not in L:
                stats["answer_not_in_options"] += 1
                bad = "answer-not-in-options"
            if any(not o.strip() for o in opts):
                stats["empty_option"] += 1
                bad = "empty-option"
            if len(opts) < 2:
                stats["opts_lt2"] += 1
                bad = bad or "too-few-options"
            if len(set(opts)) != len(opts):
                stats["dup_options"] += 1
                bad = bad or "duplicate-options"
            trunc = [(o.strip()[:99] + "…" if len(o.strip()) > 100
                      else o.strip()) for o in opts]
            if len(set(trunc)) != len(trunc) and len(set(opts)) == len(opts):
                stats["dup_after_truncation"] += 1
                bad = bad or "duplicate-after-truncation"
            if bad:
                quarantine.append({"ci": ci, "qi": qi,
                                   "id": item.get("i"), "why": bad,
                                   "q": q[:80]})
            if re.match(r"^[\s.,/\)]|^Q\d{1,4}\.\)|^\d{1,3}\)", q):
                stats["leading_junk"] += 1
            if len(q) > 300:
                stats["q_over_300"] += 1
            if any(len(o) > 100 for o in opts):
                stats["opt_over_100"] += 1
            if ans in L:
                key = (nrm(q), frozenset(nrm(o) for o in opts))
                groups[key].append((ci, qi, opts[L.index(ans)]))
    conflicts = {k: v for k, v in groups.items()
                 if len(set(nrm(x[2]) for x in v)) > 1}
    stats["conflict_groups"] = len(conflicts)
    stats["index_total"] = index.get("total", 0) + sum(
        index["chapter_counts"][ci] for ci in (599, 600, 601, 602)
        if len(index["chapter_counts"]) > ci)

    # drift: main bank vs app asset
    app = json.load(open(os.path.join(
        WS, "quiz-native/app/src/main/assets/questions.json")))
    for ci, ch in enumerate(app["chapters"]):
        qs = ch.get("questions", [])
        mine = items_by_ci.get(ci, [])
        if len(mine) != len(qs):
            drift.append(f"ch{ci}: count bot={len(mine)} app={len(qs)}")
            continue
        for qi, (b, a) in enumerate(zip(mine, qs)):
            if (b["q"] != a["q"] or b["answer"] != a["answer"]
                    or str(b["options"]) != str(a["options"])):
                drift.append(f"ch{ci}#{qi}")
    # drift: telegram chapters vs sources (answers; q may be strip-cleaned)
    for ci, g in ((599, 1), (600, 2), (601, 3), (602, 4)):
        data = json.load(open(os.path.join(SRC, f"telegram_g{g}.json")))
        mine = items_by_ci.get(ci, [])
        if len(mine) != len(data["questions"]):
            drift.append(f"ch{ci}: count bot={len(mine)} src="
                         f"{len(data['questions'])}")
            continue
        for qi, (b, s) in enumerate(zip(mine, data["questions"])):
            if b["answer"] != s["a"]:
                drift.append(f"ch{ci}#{qi} (TG answer)")
    stats["drift"] = len(drift)

    hard = (stats["answer_not_in_options"] + stats["empty_option"]
            + stats["drift"])
    lines = [
        "# Bank health — auto-generated by bank_check.py", "",
        f"- Total questions: **{stats['total']}** "
        f"(with ID: {stats['with_id']}, with explanation: "
        f"{stats['with_explanation']})",
        f"- HARD problems (must be 0): **{hard}** "
        f"[answer-not-in-options {stats['answer_not_in_options']}, "
        f"empty-option {stats['empty_option']}, drift {stats['drift']}]",
        f"- Conflicting-answer groups remaining: "
        f"**{stats['conflict_groups']}** (see AUDIT-2026-11-04.md)",
        f"- Quarantined (bot auto-skips): **{len(quarantine)}** "
        f"[too-few-options {stats['opts_lt2']}, duplicate-options "
        f"{stats['dup_options']}, dup-after-truncation "
        f"{stats['dup_after_truncation']}]",
        f"- Leading junk prefixes: {stats['leading_junk']}",
        f"- Telegram limits: {stats['q_over_300']} questions >300 chars "
        f"(bot sends full text as a pre-message), {stats['opt_over_100']} "
        f"questions with an option >100 chars (poll truncates with …)",
    ]
    if drift:
        lines += ["", "Drift details (first 20):"] + \
                 [f"- {d}" for d in drift[:20]]
    open(os.path.join(HERE, "BANK-HEALTH.md"), "w").write("\n".join(lines) + "\n")
    json.dump(quarantine, open(os.path.join(HERE, "quarantine.json"), "w"),
              ensure_ascii=False, indent=1)
    print("\n".join(lines))
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
