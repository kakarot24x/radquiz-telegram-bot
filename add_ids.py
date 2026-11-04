#!/usr/bin/env python3
"""Attach a stable question ID ("i") to every bot bank part item.

Run AFTER split_bank.py + add_telegram.py (and before/after
add_explanations.py — order between the two add_* scripts does not matter):
    python3 split_bank.py && python3 add_telegram.py && python3 add_ids.py \
        && python3 add_explanations.py

ID rules (the ID never changes for a given question version):
  - Main bank (chapters 0-598): the app's own qidOf content hash
    (QuestionRepository.qidOf with chapKey "ch<ci>") — the same ID the
    app and explanations.json use.
  - Telegram chapters (599-602): the source set's own id (TG_Q....)
    taken from bank-src/telegram_g*.json by position.
Parts are the ONLY files changed; sources are never touched.
"""
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_explanations import qid_of  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(HERE, "bank")
SRC = os.path.join(HERE, "bank-src")
TG = {599: "telegram_g1.json", 600: "telegram_g2.json",
      601: "telegram_g3.json", 602: "telegram_g4.json"}


def main():
    tg_ids = {}
    for ci, fname in TG.items():
        data = json.load(open(os.path.join(SRC, fname)))
        tg_ids[ci] = [it["i"] for it in data["questions"]]
    total = with_id = 0
    for pf in sorted(glob.glob(os.path.join(BANK, "p-*.json"))):
        m = re.match(r"p-(\d+)-(\d+)\.json", os.path.basename(pf))
        ci, pk = int(m.group(1)), int(m.group(2))
        part = json.load(open(pf))
        dirty = False
        for off, item in enumerate(part):
            total += 1
            qi = pk * 100 + off
            if ci in tg_ids:
                want = tg_ids[ci][qi]
            else:
                want = qid_of(item["q"], item["options"], item["answer"],
                              f"ch{ci}")
            if want:
                with_id += 1
                if item.get("i") != want:
                    item["i"] = want
                    dirty = True
        if dirty:
            json.dump(part, open(pf, "w"), ensure_ascii=False)
    print(f"ids attached: {with_id}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
