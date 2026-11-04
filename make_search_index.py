#!/usr/bin/env python3
"""Build bank/search.json for the in-Telegram question editor (/edit).

One entry per bank item: [id, partFile, indexInPart, questionText].
Run AFTER add_ids.py / add_explanations.py, before bank_check.py:
    split_bank.py -> add_telegram.py -> add_ids.py -> add_explanations.py
    -> make_search_index.py -> bank_check.py
"""
import glob
import json
import os
import re

BANK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bank")


def part_key(name):
    m = re.match(r"p-(\d+)-(\d+)\.json", name)
    return (int(m.group(1)), int(m.group(2)))


def main():
    entries = []
    files = sorted(
        (f for f in os.listdir(BANK) if re.match(r"p-\d+-\d+\.json$", f)),
        key=part_key,
    )
    for name in files:
        items = json.load(open(os.path.join(BANK, name)))
        for idx, it in enumerate(items):
            if it.get("i"):
                entries.append([it["i"], name, idx, it.get("q", "")])
    out = os.path.join(BANK, "search.json")
    with open(out, "w") as f:
        json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(out) / 1e6
    print(f"search.json: {len(entries)} entries, {size:.1f} MB")


if __name__ == "__main__":
    main()
