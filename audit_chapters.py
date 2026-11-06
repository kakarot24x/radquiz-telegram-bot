#!/usr/bin/env python3
"""Chapter-wise answer-audit support.

Usage:
  python3 audit_chapters.py inventory           -> CHAPTER-AUDIT.md tracker (per-chapter
                                                   counts, explanation coverage, conflict
                                                   group membership)
  python3 audit_chapters.py show <ci>           -> full dump of one chapter for review
  python3 audit_chapters.py conflicts           -> all conflict groups (stem, copies, keys)
Grouping rule (same as bank audits): cleaned stem + identical option TEXT set;
a group conflicts when its copies disagree on the correct option TEXT.
Options normalized via opts_list (main bank stores dict, TG chapters list).
"""
import json, glob, sys, os
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_tgdays import clean_stem, opts_list

IDX = json.load(open('bank/index.json'))
TITLES = IDX['chapter_titles']

def load_all():
    items = []  # (ci, key, item)
    for path in sorted(glob.glob('bank/p-*.json')):
        base = os.path.basename(path)[:-5]
        ci = int(base.split('-')[1])
        for j, it in enumerate(json.load(open(path))):
            items.append((ci, f"{base}.json#{j}", it))
    return items

def groups(items):
    g = defaultdict(list)
    for ci, key, it in items:
        opts = opts_list(it)
        sig = (clean_stem(it['q']), tuple(sorted(o.strip().lower() for o in opts)))
        g[sig].append((ci, key, it))
    conf = {}
    for sig, lst in g.items():
        texts = set()
        for ci, key, it in lst:
            opts = opts_list(it)
            if it['answer'] in 'ABCDEFGH' and ord(it['answer']) - 65 < len(opts):
                texts.add(opts[ord(it['answer']) - 65].strip().lower())
        if len(lst) > 1 and len(texts) > 1:
            conf[sig] = lst
    return g, conf

if __name__ == '__main__':
    items = load_all()
    g, conf = groups(items)
    mode = sys.argv[1] if len(sys.argv) > 1 else 'inventory'
    if mode == 'inventory':
        per_ch = defaultdict(lambda: [0, 0])  # ci -> [total, with_exp]
        conf_ch = defaultdict(set)
        for sig, lst in conf.items():
            for ci, key, it in lst:
                conf_ch[ci].add(sig)
        for ci, key, it in items:
            per_ch[ci][0] += 1
            if it.get('e'):
                per_ch[ci][1] += 1
        lines = ['# Chapter-wise answer audit — tracker', '',
                 f'Total: {len(items)} questions · {len(per_ch)} chapters · conflict groups: {len(conf)}',
                 '', '| ch | title | Q | expl | conflict-groups | status |', '|---|---|---|---|---|---|']
        for ci in sorted(per_ch):
            t, e = per_ch[ci]
            title = TITLES[ci] if ci < len(TITLES) else '?'
            lines.append(f"| {ci} | {title} | {t} | {e} | {len(conf_ch.get(ci, ()))} | pending |")
        open('CHAPTER-AUDIT.md', 'w').write('\n'.join(lines) + '\n')
        print(f"tracker likha: {len(per_ch)} chapters, conflict groups {len(conf)}")
        print('sabse zyada conflict wale chapters:')
        for ci, s in sorted(conf_ch.items(), key=lambda kv: -len(kv[1]))[:10]:
            print(f"  ch {ci} ({TITLES[ci] if ci < len(TITLES) else '?'}): {len(s)} groups")
    elif mode == 'show':
        ci = int(sys.argv[2])
        mine = [(k, it) for c, k, it in items if c == ci]
        print(f"# ch {ci}: {TITLES[ci] if ci < len(TITLES) else '?'} — {len(mine)} Q")
        conf_keys = set()
        for sig, lst in conf.items():
            if any(c == ci for c, k, it in lst):
                for c, k, it in lst:
                    conf_keys.add(k)
        for k, it in mine:
            opts = opts_list(it)
            mark = ' ⚠CONFLICT' if k in conf_keys else ''
            print(f"\n[{k}] {it.get('i','')}{mark}\nQ: {it['q']}")
            for n, o in enumerate(opts):
                print(f"   {'*' if chr(65+n) == it['answer'] else ' '} {chr(65+n)}. {o}")
            print(f"E: {(it.get('e') or '(none)')[:220]}")
    elif mode == 'conflicts':
        for sig, lst in sorted(conf.items(), key=lambda kv: kv[1][0][0]):
            print(f"\n== {sig[0][:100]}")
            for ci, key, it in lst:
                opts = opts_list(it)
                a = opts[ord(it['answer']) - 65] if it['answer'] in 'ABCDEFGH' else '?'
                print(f"   ch{ci} {key} {it.get('i','')}: {it['answer']} = {a}")
