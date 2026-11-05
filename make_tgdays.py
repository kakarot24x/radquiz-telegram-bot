#!/usr/bin/env python3
"""Build bank/tgdays.json — the Day-wise index for Telegram Quizzes.

The harvested Telegram questions keep their original group date in the
source files (bank-src/telegram_g1..g4.json, field "d"). This index maps
Group -> Month -> Day -> the day's questions as "part#index" keys (the
same key form the Keyword Quiz uses), in ORIGINAL order, so the bot can
replay a group's actual day quiz same-to-same — repeats across days
included, nothing de-duplicated.

Run in the pipeline AFTER add_telegram.py (parts must exist):
    python3 split_bank.py && python3 add_telegram.py && ... && python3 make_tgdays.py
Alignment is verified against the part files (position + stable ID);
any drift aborts the build instead of writing a wrong index.
"""
import json
import os
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(HERE, "bank")
SRC = os.path.join(HERE, "bank-src")
PART = 100  # must match add_telegram.py

GROUPS = [
    (599, "telegram_g1.json", "Accounts Exam 1"),
    (600, "telegram_g2.json", "Accounts Exam 2"),
    (601, "telegram_g3.json", "Accounts Exam 3"),
    (602, "telegram_g4.json", "Accounts Exam 4"),
]


def main():
    out = {"groups": []}
    total_days = 0
    for ci, fname, name in GROUPS:
        data = json.load(open(os.path.join(SRC, fname)))
        questions = data["questions"]
        # Verify part alignment: walking the chapter's parts in order must
        # reproduce the source sequence exactly (count + stable IDs).
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
        out["groups"].append({
            "ci": ci, "name": name, "total": len(questions),
            "ndays": ndays, "months": mlist,
        })
        total_days += ndays
        print(f"ci {ci} {name}: {len(questions)} Q · {ndays} days · {len(mlist)} months")
    with open(os.path.join(BANK, "tgdays.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(os.path.join(BANK, "tgdays.json"))
    print(f"tgdays.json written: {total_days} days total, {size} bytes")


if __name__ == "__main__":
    main()
