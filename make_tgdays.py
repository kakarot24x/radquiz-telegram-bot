#!/usr/bin/env python3
"""Build bank/tgdays.json — the Day-wise index for Telegram Quizzes.

For Accounts Exam 1–3 the index is EXPORT-DRIVEN (user order 2026-11-05):
it replays the group's own Telegram Desktop export (result.json) day by
day — EVERY poll of the day, in original order, repeats across days
included — instead of the app bank's unique-question view (the app bank
kept each question once, so later days there show only their few NEW
questions). This index is BOT-ONLY; the app is untouched.

An export carries no answer key (Telegram Desktop never exports it), so
each export poll borrows its verified question/options/answer from the
existing bank: the poll's cleaned stem is matched against the whole bot
bank, and a transfer is accepted only when the bank item's CORRECT option
text appears among the export poll's answers and the option sets overlap
strongly. Polls with no verified match are skipped and counted in the
build report (they cannot be quizzed without a known correct answer).

Exam 4 has no export in hand, so it keeps the bank-driven build from
bank-src/telegram_g4.json (field "d"), exactly as before.

Export inputs (NOT in git — ~100 MB; kept in the user's uploads folder):
    ~/workspace/user/files/result_0_b08e.json        -> Exam 1
    ~/workspace/user/files/result__1__0_qol3.json    -> Exam 2
    ~/workspace/user/files/result__2__0_8k7o.json    -> Exam 3

Run in the pipeline AFTER add_telegram.py / make_search_index.py:
    ... && python3 make_tgdays.py && python3 bank_check.py
"""
import glob
import json
import math
import os
import re
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(HERE, "bank")
SRC = os.path.join(HERE, "bank-src")
PART = 100  # must match add_telegram.py
EXPORT_DIR = os.path.expanduser("~/workspace/user/files")

EXPORT_GROUPS = [
    (599, "result_0_b08e.json", "Accounts Exam 1", "LDCE"),
    (600, "result__1__0_qol3.json", "Accounts Exam 2", "Departmental"),
    (601, "result__2__0_8k7o.json", "Accounts Exam 3", "Quizee"),
]
BANK_GROUPS = [
    (602, "telegram_g4.json", "Accounts Exam 4"),
]


def clean_stem(s):
    s = str(s).lower()
    for _ in range(8):
        prev = s
        s = re.sub(r"^\s*\[\d+\s*/\s*\d+\]\s*", "", s)   # [27/70] series marks
        s = re.sub(r"^\s*q\.?\s*\d{1,4}\s*[\.\)]\s*", "", s)  # Q136.)
        s = re.sub(r"^\s*\d{1,3}\s*[\.\)]\s*", "", s)    # 11. / 11)
        if s == prev:
            break
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_opt(s):
    s = re.sub(r"\s+", " ", str(s).strip().lower())
    s = re.sub(r"^[a-e][\.\)]\s+", "", s)  # "a. 10" -> "10" (export answers carry letter prefixes)
    return s.strip(" .,:;!?)(")


def trunc_opt(s):
    # Mirror the bot's poll build: options are cut to 100 chars at send time.
    o = str(s).strip()
    return o[:99] + "…" if len(o) > 100 else o


def askable(item):
    opts = item.get("options") or []
    if len(opts) < 2 or not all(str(o).strip() for o in opts):
        return False
    a = item.get("answer")
    if a not in [chr(65 + i) for i in range(len(opts))]:
        return False
    fixed = [trunc_opt(o) for o in opts]
    return len(set(fixed)) == len(fixed)


def load_candidate_pool():
    """cleaned stem -> [(key, ci, {norm options}, norm correct, n options)]"""
    pool = {}
    n_items = 0
    for path in sorted(glob.glob(os.path.join(BANK, "p-*.json"))):
        part = os.path.basename(path)
        ci = int(part.split("-")[1])
        items = json.load(open(path))
        for i, it in enumerate(items):
            if not askable(it):
                continue
            stem = clean_stem(it.get("q", ""))
            if not stem:
                continue
            opts = [norm_opt(trunc_opt(o)) for o in it["options"]]
            correct = opts[ord(it["answer"]) - 65]
            pool.setdefault(stem, []).append(
                (f"{part}#{i}", ci, set(opts), correct, len(opts)))
            n_items += 1
    print(f"candidate pool: {n_items} askable items, {len(pool)} stems")
    return pool


LETTER_SET = {"a", "b", "c", "d", "e"}


def match_poll(pool, poll, group_ci):
    """Return (key, tier) or (None, 0). Tier 1: the bank item's correct
    option text is among the poll's answers and the option sets overlap.
    Tier 2 (letter polls, whose real options sit inside the question
    text): most of the bank item's option texts appear in the question.
    Tier 3: the stem occurs exactly once in the group's own chapter —
    that chapter was harvested from this group's polls, so a unique
    same-chapter stem is the same question."""
    cands = pool.get(clean_stem(poll["question"]))
    if not cands:
        return None, 0
    answers = {norm_opt(a["text"]) for a in poll["answers"]}
    if not answers <= LETTER_SET:
        best, best_rank = None, None
        for key, ci, opts, correct, n in cands:
            if correct not in answers:
                continue
            overlap = len(opts & answers)
            if overlap >= 2 and overlap >= math.ceil(0.5 * n):
                rank = (1 if ci == group_ci else 0, overlap)
                if best_rank is None or rank > best_rank:
                    best, best_rank = key, rank
        if best:
            return best, 1
    else:
        qnorm = " " + clean_stem(poll["question"]) + " "
        best, best_found = None, -1
        for key, ci, opts, correct, n in cands:
            if all(len(o) <= 1 for o in opts):
                continue  # letter-option bank item: nothing to find in text
            found = sum(1 for o in opts
                        if (" " + o + " ") in qnorm or o in qnorm)
            if found >= 2 and found >= math.ceil(0.75 * n) and found > best_found:
                best, best_found = key, found
        if best:
            return best, 2
    same = [c for c in cands if c[1] == group_ci]
    if len(same) == 1:
        return same[0][0], 3
    return None, 0


def build_export_group(pool, ci, fname, name, expect):
    path = os.path.join(EXPORT_DIR, fname)
    data = json.load(open(path))
    chat = data.get("name", "")
    if expect.lower() not in chat.lower():
        print(f"WARNING: {fname} chat name {chat!r} does not mention {expect!r}")
    months = OrderedDict()
    total_polls = kept = 0
    tiers = {1: 0, 2: 0, 3: 0}
    for m in data["messages"]:
        if m.get("type") != "message" or "poll" not in m:
            continue
        poll = m["poll"]
        if len(poll.get("answers", [])) < 2:
            continue
        total_polls += 1
        key, tier = match_poll(pool, poll, ci)
        if key is None:
            continue
        kept += 1
        tiers[tier] += 1
        d = m["date"][:10]
        months.setdefault(d[:7], OrderedDict()).setdefault(d, []).append(key)
    mlist, ndays, slots = [], 0, 0
    for mo in sorted(months, reverse=True):
        days = [{"d": d, "n": len(months[mo][d]), "keys": months[mo][d]}
                for d in sorted(months[mo], reverse=True)]
        ndays += len(days)
        slots += sum(x["n"] for x in days)
        mlist.append({"m": mo, "n": sum(x["n"] for x in days), "days": days})
    pct = kept * 100 // max(total_polls, 1)
    print(f"ci {ci} {name}: export polls {total_polls} · kept {kept} ({pct}%) · "
          f"skipped {total_polls - kept} · {ndays} days · {slots} slots · "
          f"tiers 1/2/3 = {tiers[1]}/{tiers[2]}/{tiers[3]}")
    return {"ci": ci, "name": name, "total": slots, "ndays": ndays,
            "months": mlist}, ndays


def build_bank_group(ci, fname, name):
    data = json.load(open(os.path.join(SRC, fname)))
    questions = data["questions"]
    pos = 0
    part_no = 0
    while pos < len(questions):
        part = json.load(open(os.path.join(BANK, f"p-{ci}-{part_no}.json")))
        for item in part:
            src = questions[pos]
            if item.get("i") is not None and item["i"] != src["i"]:
                raise SystemExit(
                    f"ALIGNMENT FAIL {fname} pos {pos}: part id {item.get('i')} != source {src['i']}")
            pos += 1
        part_no += 1
    months = OrderedDict()
    for p, it in enumerate(questions):
        d = it.get("d")
        if not d:
            raise SystemExit(f"{fname} pos {p}: question without date")
        key = f"p-{ci}-{p // PART}.json#{p % PART}"
        months.setdefault(d[:7], OrderedDict()).setdefault(d, []).append(key)
    mlist = []
    ndays = 0
    for m in sorted(months, reverse=True):
        days = [{"d": d, "n": len(months[m][d]), "keys": months[m][d]}
                for d in sorted(months[m], reverse=True)]
        ndays += len(days)
        mlist.append({"m": m, "n": sum(x["n"] for x in days), "days": days})
    print(f"ci {ci} {name}: {len(questions)} Q · {ndays} days · {len(mlist)} months")
    return {"ci": ci, "name": name, "total": len(questions),
            "ndays": ndays, "months": mlist}, ndays


def main():
    pool = load_candidate_pool()
    out = {"groups": []}
    total_days = 0
    spread = []
    for ci, fname, name, expect in EXPORT_GROUPS:
        g, nd = build_export_group(pool, ci, fname, name, expect)
        out["groups"].append(g)
        total_days += nd
    for ci, fname, name in BANK_GROUPS:
        g, nd = build_bank_group(ci, fname, name)
        out["groups"].append(g)
        total_days += nd
    # A day whose questions are scattered over too many part files would
    # break the bot's per-start fetch budget (fetchByKeysOrdered caps at
    # 40 parts). Bake such days' full items into the index instead — the
    # worker reads them inline and fetches nothing for that day.
    part_cache = {}

    def load_item(key):
        part, idx = key.split("#")
        if part not in part_cache:
            part_cache[part] = json.load(open(os.path.join(BANK, part)))
        return part_cache[part][int(idx)]

    baked = 0
    for g in out["groups"]:
        for mo in g["months"]:
            for dy in mo["days"]:
                if "keys" not in dy:
                    continue
                parts = {k.split("#")[0] for k in dy["keys"]}
                spread.append((len(parts), g["name"], dy["d"], dy["n"]))
                if len(parts) > 36:
                    dy["items"] = [dict(load_item(k), _src=k) for k in dy["keys"]]
                    del dy["keys"]
                    baked += 1
    spread.sort(reverse=True)
    print(f"part spread: max {spread[0][0]} distinct parts in a day; "
          f"days baked inline (>36 parts): {baked}")
    with open(os.path.join(BANK, "tgdays.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(os.path.join(BANK, "tgdays.json"))
    print(f"tgdays.json written: {total_days} days total, {size} bytes")


if __name__ == "__main__":
    sys.exit(main())
