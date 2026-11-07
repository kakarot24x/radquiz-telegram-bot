#!/usr/bin/env python3
"""Build bank/notes.json — a keyword-searchable fact index from the
user's detailed tables book (~/workspace/syllabus-detailed-build/gA..gF).

Every table row becomes one fact per value column:
  [label, aspect, value, chapterTitle, tableTitle]
The Akaza bot's Mahesh Q&A searches these facts by keyword before it
falls back to the MCQ bank, so answers come from the detailed notes
the user actually studies from.

Run after any book rebuild:  python3 make_notes_index.py
"""
import glob
import html
import json
import os
import re

BOOK_DIR = os.path.expanduser("~/workspace/syllabus-detailed-build")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bank", "notes.json")


def clean(cell):
    s = str(cell if cell is not None else "")
    s = re.sub(r"<br\s*/?>", "; ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.rstrip(";").strip()


def main():
    facts = []
    files = [os.path.join(BOOK_DIR, f"g{c}.json") for c in "ABCDEF"]
    for path in files:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for ch in data.get("chapters", []):
            ch_title = f"Ch {ch.get('chapter', '')} {clean(ch.get('title', ''))}"
            for tbl in ch.get("tables", []):
                tbl_title = clean(tbl.get("title", ""))
                cols = [clean(c) for c in tbl.get("columns", [])]
                for row in tbl.get("rows", []):
                    cells = [clean(c) for c in row]
                    if not cells or not cells[0]:
                        continue
                    label = cells[0]
                    for j in range(1, len(cells)):
                        value = cells[j]
                        if not value or value in ("—", "-", "N/A"):
                            continue
                        aspect = cols[j] if j < len(cols) else ""
                        facts.append([label, aspect, value, ch_title, tbl_title])
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(facts, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"notes.json: {len(facts)} facts, {size/1024:.0f} KB -> {OUT}")


if __name__ == "__main__":
    main()
