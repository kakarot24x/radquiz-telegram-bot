#!/usr/bin/env python3
"""Build bank/tgdays.json — the Day-wise index for Telegram Quizzes.

For Accounts Exam 1–3 the index is EXPORT-DRIVEN (user order 2026-11-05):
it replays the group's own Telegram Desktop export (result.json) day by
day — the day's polls in original order, repeats across days included —
instead of the app bank's unique-question view. This index is BOT-ONLY;
the app is untouched.

An export carries no answer key (Telegram Desktop never exports it), so
each export poll borrows its verified question/options/answer from the
existing bank. The first loose matcher (v26) produced wrong picks on
generic stems, so matching is DATE-LOCKED and evidence-tiered (v28):

  Tier 1  The group's own chapter holds a copy harvested from THIS date
          and it also passes strong option verification — near-certain.
  Tier 2  Same, but the copy cannot be option-verified (e.g. options
          reworded in harvest): accepted only when it is the day's ONLY
          copy of that stem, the day holds only one poll of that stem,
          and the stem is not one whose bank copies disagree on the
          correct option text (conflict group).
  Tier 3  No copy from this date, but strong option verification passes
          and every verified candidate agrees on the correct text.
  Tier 4  All bank copies of the stem share the identical option set AND
          the identical correct text — any copy asks the same question
          with the same key, so the transfer cannot be wrong.
  Anything else is SKIPPED and counted: a shorter day beats a wrong key.

  (Caution, learned the hard way in the v28 rebuild: main-bank parts
  store options as a dict {A:..}, Telegram parts as a list — see
  opts_list(). Reading a dict's keys as its options silently poisoned
  every cross-chapter match in v26.)

Strong verification — real polls: the candidate's correct option text is
among the poll's answers and >=3/4 of its options appear there. Letter
polls (answers just A/B/C/D, real options embedded in the question
text): >=3/4 of the candidate's option texts appear in the question.

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
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(HERE, "bank")
SRC = os.path.join(HERE, "bank-src")
PART = 100  # must match add_telegram.py
EXPORT_DIR = os.path.expanduser("~/workspace/user/files")

EXPORT_GROUPS = [
    (599, "result_0_b08e.json", "Accounts Exam 1", "LDCE", "telegram_g1.json"),
    (600, "result__1__0_qol3.json", "Accounts Exam 2", "Departmental", "telegram_g2.json"),
    (601, "result__2__0_8k7o.json", "Accounts Exam 3", "Quizee", "telegram_g3.json"),
]
BANK_GROUPS = [
    (602, "telegram_g4.json", "Accounts Exam 4"),
]
LETTER_SET = {"a", "b", "c", "d", "e"}


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


def opts_list(item):
    """Bank parts store options two ways: the main bank as a dict
    {A: .., B: ..} and the Telegram chapters as a list. (The worker's
    buildPollPayload accepts both; this generator must normalize or it
    reads a dict's KEYS as the options — the v26/v28 matching bug.)"""
    o = item.get("options")
    if isinstance(o, dict):
        return [o[k] for k in sorted(o)]
    return list(o or [])


def askable(item):
    opts = opts_list(item)
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
            opts = [norm_opt(trunc_opt(o)) for o in opts_list(it)]
            correct = opts[ord(it["answer"]) - 65]
            pool.setdefault(stem, []).append(
                (f"{part}#{i}", ci, set(opts), correct, len(opts)))
            n_items += 1
    print(f"candidate pool: {n_items} askable items, {len(pool)} stems")
    return pool


def strong_verified(cand, answers, qnorm):
    """answers is None for letter polls (then qnorm is used)."""
    key, ci, opts, correct, n = cand
    need = max(2, math.ceil(0.75 * n))
    if answers is not None:
        return correct in answers and len(opts & answers) >= need
    if all(len(o) <= 1 for o in opts):
        return False  # letter-option bank item: nothing findable in text
    found = sum(1 for o in opts if (" " + o + " ") in qnorm or o in qnorm)
    return found >= need


def build_export_group(pool, keymap, conflicts, ci, fname, name, expect, srcfile):
    path = os.path.join(EXPORT_DIR, fname)
    data = json.load(open(path))
    chat = data.get("name", "")
    if expect.lower() not in chat.lower():
        print(f"WARNING: {fname} chat name {chat!r} does not mention {expect!r}")
    # This group's own chapter, by harvest date: date -> stem -> [keys in
    # source order] — the date-locked candidate queues.
    src = json.load(open(os.path.join(SRC, srcfile)))
    by_date = {}
    for pos, it in enumerate(src["questions"]):
        key = f"p-{ci}-{pos // PART}.json#{pos % PART}"
        if key not in keymap or not it.get("d"):
            continue
        by_date.setdefault(it["d"], {}).setdefault(
            clean_stem(it["q"]), []).append(key)
    # Export polls grouped by day, file order preserved.
    days_in = OrderedDict()
    total_polls = 0
    for m in data["messages"]:
        if m.get("type") != "message" or "poll" not in m:
            continue
        poll = m["poll"]
        if len(poll.get("answers", [])) < 2:
            continue
        total_polls += 1
        days_in.setdefault(m["date"][:10], []).append(poll)
    months = OrderedDict()
    kept = 0
    tiers = Counter()
    for d, polls in days_in.items():
        queues = {s: list(ks) for s, ks in by_date.get(d, {}).items()}
        stem_count = Counter(clean_stem(p["question"]) for p in polls)
        day_keys = []
        for poll in polls:
            stem = clean_stem(poll["question"])
            cands = pool.get(stem)
            if not cands:
                continue
            raw_answers = {norm_opt(a["text"]) for a in poll["answers"]}
            is_letter = raw_answers <= LETTER_SET
            answers = None if is_letter else raw_answers
            qnorm = (" " + stem + " ") if is_letter else None
            verified = {c[0] for c in cands
                        if strong_verified(c, answers, qnorm)}
            pick, tier = None, 0
            queue = queues.get(stem, [])
            for qk in list(queue):
                if qk in verified:
                    pick, tier = qk, 1
                    queue.remove(qk)
                    break
            if pick is None and len(queue) == 1 and stem_count[stem] == 1:
                cand = keymap[queue[0]]
                if (stem, frozenset(cand[2])) not in conflicts:
                    pick, tier = queue[0], 2
                    queue.clear()
            if pick is None and verified:
                vc = [c for c in cands if c[0] in verified]
                if len({c[3] for c in vc}) == 1:
                    # Sabse zyada option-match wala copy us din ke asal
                    # poll ke sabse kareeb hai; chapter sirf tie-break.
                    def faith(c):
                        if answers is not None:
                            return (len(c[2] & answers), 1 if c[1] == ci else 0)
                        found = sum(1 for o in c[2]
                                    if (" " + o + " ") in qnorm or o in qnorm)
                        return (found, 1 if c[1] == ci else 0)
                    pick, tier = max(vc, key=faith)[0], 3
            if pick is None:
                optsets = {frozenset(c[2]) for c in cands}
                corrects = {c[3] for c in cands}
                if len(optsets) == 1 and len(corrects) == 1:
                    same = [c for c in cands if c[1] == ci]
                    pick, tier = (same or cands)[0][0], 4
            if pick is None:
                continue
            kept += 1
            tiers[tier] += 1
            day_keys.append(pick)
        if day_keys:
            months.setdefault(d[:7], OrderedDict())[d] = day_keys
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
          f"tiers 1/2/3/4 = {tiers[1]}/{tiers[2]}/{tiers[3]}/{tiers[4]}")
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
    keymap = {}
    for cands in pool.values():
        for c in cands:
            keymap[c[0]] = c
    # Conflict groups: same stem + same option set, but bank copies
    # disagree on the correct option TEXT.
    by_sc = {}
    for stem, cands in pool.items():
        for c in cands:
            by_sc.setdefault((stem, frozenset(c[2])), set()).add(c[3])
    conflicts = {k for k, v in by_sc.items() if len(v) > 1}
    print(f"conflict groups (stem+options, jawab alag): {len(conflicts)}")
    out = {"groups": []}
    total_days = 0
    spread = []
    for ci, fname, name, expect, srcfile in EXPORT_GROUPS:
        g, nd = build_export_group(pool, keymap, conflicts,
                                   ci, fname, name, expect, srcfile)
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
