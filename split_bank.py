#!/usr/bin/env python3
"""Split the RADEQuiz bank into Cloudflare-friendly parts.

Output (in ./bank/):
  index.json          - subjects/chapters map (from subjects.json) +
                        per-chapter part counts
  p-<chapter_i>-<k>.json - part k of chapter i, PART_SIZE questions each:
                        [{"q":..., "options": {...}, "answer": "A"}, ...]

The Worker fetches only the parts it needs for a quiz, so no single
fetch is ever large.
"""
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_BANK = os.path.expanduser(
    "~/workspace/quiz-native/app/src/main/assets/questions.json")
SRC_SUBJECTS = os.path.expanduser(
    "~/workspace/telegram-quiz-bot/subjects.json")
OUT = os.path.join(HERE, "bank")
PART_SIZE = 100


def main():
    with open(SRC_BANK) as f:
        data = json.load(f)
    with open(SRC_SUBJECTS) as f:
        meta = json.load(f)

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    chapters_out = []
    total = 0
    for ci, ch in enumerate(data["chapters"]):
        qs = [{"q": q.get("q", ""), "options": q.get("options", {}),
               "answer": q.get("answer", "")}
              for q in ch.get("questions", [])]
        total += len(qs)
        parts = 0
        for k in range(0, len(qs), PART_SIZE):
            chunk = qs[k:k + PART_SIZE]
            with open(os.path.join(OUT, f"p-{ci}-{parts}.json"), "w") as f:
                json.dump(chunk, f, ensure_ascii=False,
                          separators=(",", ":"))
            parts += 1
        chapters_out.append({"ci": ci, "parts": parts, "count": len(qs)})

    index = {
        "subjects": meta["subjects"],
        "chapter_titles": meta["chapter_titles"],
        "chapter_counts": meta["chapter_counts"],
        "chapters": chapters_out,
        "total": total,
        "part_size": PART_SIZE,
    }
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    n_files = len(os.listdir(OUT))
    print(f"bank split done: {total} questions, "
          f"{len(chapters_out)} chapters, {n_files} files in bank/")


if __name__ == "__main__":
    main()
