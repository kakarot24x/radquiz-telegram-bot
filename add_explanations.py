#!/usr/bin/env python3
"""Attach bundled English explanations ("e") to bot bank parts.

Run AFTER split_bank.py and add_telegram.py when the bank is regenerated:
    python3 split_bank.py && python3 add_telegram.py && python3 add_explanations.py

Sources (workspace-relative):
  ../quiz-native/app/src/main/assets/explanations.json  (id -> explanation)
  ../quiz-native/app/src/main/assets/questions.json     (the app bank)
  ../quiz-bank/questions.json                           (master, carries ids)
  ../your_files/all-app-questions-backup.txt            (per-question [id] lines)

Matching routes, in priority order (union reached ~65% of the main bank;
the rest never had a bundled explanation written):
  1. qidOf content hash (exact app parity, chapKey "ch<ci>")
  2. master-bank exact question text -> id
  3. backup-txt exact question text -> id
  4. whitespace/punctuation-normalised text -> master/txt id
Telegram-group chapters (599+) have no bundled explanations and are skipped
by the matcher naturally (their texts are not in the sources).
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(HERE)
BANK = os.path.join(HERE, "bank")
M32 = 0xFFFFFFFF


def qid_of(question, options, answer, chap_key):
    if isinstance(options, dict):
        pairs = sorted(options.items())
    else:
        pairs = [(chr(65 + i), str(o)) for i, o in enumerate(options)]
    opts_str = "|".join(f"{k}:{v}" for k, v in pairs)
    s = f"{chap_key}|{question}|{opts_str}|{answer}"
    m1, m2, m3, m4 = 2654435761, 1597334677, 2246822507, 3266489909
    h1, h2 = 0xdeadbeef, 0x41C6CE57
    u = s.encode("utf-16-le")
    for i in range(0, len(u), 2):
        c = u[i] | (u[i + 1] << 8)
        h1 = ((h1 ^ c) * m1) & M32
        h2 = ((h2 ^ c) * m2) & M32
    h1 = (((h1 ^ (h1 >> 16)) * m3) & M32) ^ (((h2 ^ (h2 >> 13)) * m4) & M32)
    h1 &= M32
    h2 = (((h2 ^ (h2 >> 16)) * m3) & M32) ^ (((h1 ^ (h1 >> 13)) * m4) & M32)
    h2 &= M32
    comb = 4294967296 * (2097151 & h2) + h1
    dg = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while comb:
        out = dg[comb % 36] + out
        comb //= 36
    return "q" + (out or "0")


def norm(q):
    return re.sub(r"\s+", " ", q).strip().rstrip(".").strip()


def main():
    expl = json.load(open(os.path.join(
        WS, "quiz-native/app/src/main/assets/explanations.json")))
    app = json.load(open(os.path.join(
        WS, "quiz-native/app/src/main/assets/questions.json")))
    master = json.load(open(os.path.join(WS, "quiz-bank/questions.json")))
    txt = open(os.path.join(
        WS, "your_files/all-app-questions-backup.txt"), encoding="utf-8").read()

    t2id_master, t2id_txt = {}, {}
    for ch in master["chapters"]:
        for it in ch.get("questions", []):
            if it.get("id"):
                t2id_master[it["q"]] = it["id"]
    for qid, qtext in re.findall(r"\[((?:q|TG)[A-Za-z0-9]+)\]\s*(.+)", txt):
        t2id_txt[qtext.strip()] = qid
    n_master = {norm(k): v for k, v in t2id_master.items()}
    n_txt = {norm(k): v for k, v in t2id_txt.items()}

    def find_e(ci, it):
        qid = qid_of(it["q"], it["options"], it["answer"], f"ch{ci}")
        if expl.get(qid):
            return expl[qid]
        for src in (t2id_master, t2id_txt):
            if expl.get(src.get(it["q"], "")):
                return expl[src[it["q"]]]
        nq = norm(it["q"])
        for src in (n_master, n_txt):
            if expl.get(src.get(nq, "")):
                return expl[src[nq]]
        return None

    total = with_e = 0
    for ci, ch in enumerate(app["chapters"]):
        qs = ch.get("questions", [])
        for pk in range((len(qs) + 99) // 100):
            pf = os.path.join(BANK, f"p-{ci}-{pk}.json")
            if not os.path.exists(pf):
                continue
            part = json.load(open(pf))
            dirty = False
            for off, it in enumerate(part):
                total += 1
                e = find_e(ci, qs[pk * 100 + off])
                if e:
                    with_e += 1
                    if it.get("e") != e:
                        it["e"] = e
                        dirty = True
                elif "e" in it:
                    del it["e"]
                    dirty = True
            if dirty:
                json.dump(part, open(pf, "w"), ensure_ascii=False)
    print(f"explanations attached: {with_e}/{total} "
          f"({with_e * 100 // max(total, 1)}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
