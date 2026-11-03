#!/usr/bin/env python3
"""Merge the app's Telegram-group question sets (21,208 Q) into the bot bank
as an 8th subject "Telegram Quizzes" (chapters 599-602).

Run AFTER split_bank.py whenever the bank is regenerated:
    python3 split_bank.py && python3 add_telegram.py
Sources: bank-src/telegram_g1..g4.json (copies of the app assets).
Idempotent: re-running replaces the Telegram chapters cleanly.
"""
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(HERE, "bank")
SRC = os.path.join(HERE, "bank-src")
PART = 100

GROUPS = [
    (599, "telegram_g1.json", "Accounts Exam 1", 6582),
    (600, "telegram_g2.json", "Accounts Exam 2", 9034),
    (601, "telegram_g3.json", "Accounts Exam 3", 5027),
    (602, "telegram_g4.json", "Accounts Exam 4", 565),
]


def askable(item):
    opts = item["options"]
    letters = [chr(65 + i) for i in range(len(opts))]
    if len(opts) < 2 or item["answer"] not in letters:
        return False
    fixed = [str(o).strip()[:99] + "…" if len(str(o).strip()) > 100
             else str(o).strip() for o in opts]
    return len(set(fixed)) == len(fixed)


def main():
    index = json.load(open(os.path.join(BANK, "index.json")))
    titles = index["chapter_titles"]
    counts = index["chapter_counts"]
    chapters = {c["ci"]: c for c in index["chapters"]}

    total_new = 0
    total_askable = 0
    for ci, fname, title, expected in GROUPS:
        data = json.load(open(os.path.join(SRC, fname)))
        items = [{"q": it["q"], "options": it["o"], "answer": it["a"]}
                 for it in data["questions"]]
        assert len(items) == expected, (fname, len(items), expected)
        for old in glob.glob(os.path.join(BANK, f"p-{ci}-*.json")):
            os.remove(old)
        nparts = (len(items) + PART - 1) // PART
        for k in range(nparts):
            with open(os.path.join(BANK, f"p-{ci}-{k}.json"), "w") as f:
                json.dump(items[k * PART:(k + 1) * PART], f, ensure_ascii=False)
        while len(titles) <= ci:
            titles.append("")
            counts.append(0)
        titles[ci] = title
        counts[ci] = len(items)
        chapters[ci] = {"ci": ci, "parts": nparts, "count": len(items)}
        a = sum(1 for it in items if askable(it))
        total_new += len(items)
        total_askable += a
        print(f"ci {ci}  {title}: {len(items)} Q in {nparts} parts, askable {a}")

    index["chapters"] = [chapters[ci] for ci in sorted(chapters)]
    index["subjects"] = [s for s in index["subjects"]
                         if s["name"] != "Telegram Quizzes"]
    index["subjects"].append({
        "name": "Telegram Quizzes", "icon": "✈️",
        "chapters": [ci for ci, *_ in GROUPS], "questions": total_new,
    })
    index["total"] = sum(counts)
    with open(os.path.join(BANK, "index.json"), "w") as f:
        json.dump(index, f, ensure_ascii=False)
    print(f"Telegram Quizzes: {total_new} Q (askable {total_askable}); "
          f"bank total now {index['total']}, subjects {len(index['subjects'])}")


if __name__ == "__main__":
    main()
