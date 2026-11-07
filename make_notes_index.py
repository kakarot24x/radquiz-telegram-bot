#!/usr/bin/env python3
"""Build bank/notes.json — a keyword-searchable fact index from the
user's detailed tables book:
  * the FRONT section (gFront.json — "Indian Railways at a Glance":
    zones, production units, committees, tatkal, concessions, ...)
  * all 36 chapters (gA..gF.json)

Linking, every level (user order 2026-11-07 — "ek ek cheez se link"):
  * every table row -> one fact per value column
      [label, aspect, value, chapterTitle, tableTitle, siblingLabels]
    (the sibling labels link each row to its whole table, so a row is
    findable by the words its table-mates use too)
  * every table      -> one "List" fact joining all row labels, so
    count / list / naam questions ("production unit kitne hai")
    answer from the table itself.

The Akaza bot's Mahesh Q&A searches these facts by keyword before it
falls back to the MCQ bank.

Run after any book rebuild:  python3 make_notes_index.py
"""
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


def add_table(facts, tbl, ch_title):
    tbl_title = clean(tbl.get("title", ""))
    cols = [clean(c) for c in (tbl.get("columns") or [])]
    rows = []
    for row in tbl.get("rows", []):
        cells = [clean(c) for c in row]
        if cells and cells[0]:
            rows.append(cells)
    context = " · ".join(r[0] for r in rows if r[0])
    for cells in rows:
        label = cells[0]
        for j in range(1, len(cells)):
            value = cells[j]
            if not value or value in ("—", "-", "N/A"):
                continue
            aspect = cols[j] if j < len(cols) else ""
            facts.append([label, aspect, value, ch_title, tbl_title, context])
    # The table itself as one linked fact: its items, countable.
    if len(rows) >= 2 and tbl_title:
        labels = [r[0] for r in rows if r[0]]
        if labels:
            value = f"Total {len(labels)}: " + " · ".join(labels)
            if len(value) > 950:
                value = value[:949] + "…"
            facts.append([tbl_title, "List", value, ch_title, tbl_title, ""])


def main():
    facts = []
    front = json.load(open(os.path.join(BOOK_DIR, "gFront.json"), encoding="utf-8"))
    front_title = clean(front.get("section_title", "Indian Railways at a Glance"))
    for tbl in front.get("tables", []):
        add_table(facts, tbl, front_title)
    for c in "ABCDEF":
        path = os.path.join(BOOK_DIR, f"g{c}.json")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for ch in data.get("chapters", []):
            ch_title = f"Ch {ch.get('chapter', '')} {clean(ch.get('title', ''))}"
            for tbl in ch.get("tables", []):
                add_table(facts, tbl, ch_title)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(facts, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"notes.json: {len(facts)} facts, {size/1024:.0f} KB -> {OUT}")


if __name__ == "__main__":
    main()
