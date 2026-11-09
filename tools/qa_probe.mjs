// Mahesh Q&A probe — runs the REAL matching code extracted from
// worker.js against bank/notes.json, so a probe pass here means the
// deployed logic (not a copy) picks these facts. Bank-layer outcomes
// are not probed here; "no notes hit" means the bank layer decides.
//
//   node tools/qa_probe.mjs "mahesh LAP?" "mahesh CL kitne din"
import fs from 'fs';

const workerSrc = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const start = workerSrc.indexOf('// ------------------------------------------- Mahesh Q&A');
const end = workerSrc.indexOf('// Day-wise index');
if (start < 0 || end < 0) throw new Error('QA block not found in worker.js');
const block = workerSrc.slice(start, end)
  .replace(/async function loadQaMap[\s\S]*?\n}\n/, '')
  .replace(/async function loadNotesFacts[\s\S]*?\n}\n/, '');
const api = new Function(`${block};
  return { QA_STOP, qaToks, qaNotesSearch, QA_ASPECT_QTY };`)();
const { QA_STOP, qaToks, qaNotesSearch, QA_ASPECT_QTY } = api;

const facts = JSON.parse(fs.readFileSync(new URL('../bank/notes.json', import.meta.url), 'utf8'));
const byToken = new Map();
facts.forEach((f, n) => {
  const text = `${f[0]} ${f[1]} ${f[2]} ${f[3]} ${f[4]} ${f[5] || ''}`;
  for (const t of new Set(qaToks(text))) {
    if (!byToken.has(t)) byToken.set(t, []);
    byToken.get(t).push(n);
  }
});

function probe(raw0) {
  const rawToks = qaToks(raw0.replace(/\bmahesh\b/gi, ' '));
  const ct = rawToks.filter((t) => !QA_STOP.has(t) && t.length >= 2);
  const cues = {
    qtyIntent: rawToks.some((t) => ['kitna', 'kitne', 'kitni'].includes(t)) ||
      /\bhow (many|much)\b/i.test(raw0),
    yearCue: rawToks.some((t) =>
      ['total', 'saal', 'sal', 'varsh', 'annual', 'salana'].includes(t) ||
      t.startsWith('year')),
    listIntent: rawToks.some((t) =>
      ['kaun', 'list', 'naam', 'name', 'names', 'sab']
        .includes(t)) || /\bhow many\b/i.test(raw0),
    prodIntent: rawToks.some((t) =>
      ['banata', 'banati', 'banta', 'produces', 'produce', 'manufactures']
        .includes(t)),
    locIntent: rawToks.some((t) =>
      ['kahan', 'where', 'sthit', 'located'].includes(t)),
  };
  cues.defExplicit =
    /what is|what's|kya hai|kya hota|kya hoti|matlab|meaning|define/i
      .test(raw0);
  cues.defIntent = cues.defExplicit ||
    (ct.length <= 3 && !cues.qtyIntent && !cues.listIntent &&
      !cues.prodIntent && !cues.locIntent);
  const hit = qaNotesSearch(facts, byToken, ct, cues);
  if (!hit) return null;
  // Mirror the worker's reply shaping (v43): named aspect alone,
  // definition question -> characterisation alone, bare topic ->
  // whole row, otherwise the single hit value.
  const single = (s) => (s[2].length > 600 ? s[2].slice(0, 599) + '…' : s[2]);
  if (hit[1] !== 'List') {
    const sibs = facts.filter((f) =>
      f[0] === hit[0] && f[4] === hit[4] && f[1] !== 'List');
    if (sibs.length >= 2) {
      const rawSet = new Set(rawToks);
      const aspScore = (s) => qaToks(s[1])
        .filter((t) => t.length >= 3 &&
          !['the', 'and', 'for', 'with', 'without'].includes(t))
        .filter((t) => rawSet.has(t) || (t.length >= 4 &&
          [...rawSet].some((x) => x.startsWith(t) || t.startsWith(x))))
        .length;
      let named = null;
      let namedScore = 0;
      for (const s of sibs) {
        const sc = aspScore(s);
        if (sc > namedScore) { named = s; namedScore = sc; }
      }
      if (named && namedScore >= 1) {
        const tied = sibs.filter((s) => aspScore(s) === namedScore);
        if (tied.length === 1) return single(named);
      }
      if (cues.defExplicit) {
        const defSib =
          sibs.find((s) => /definition|meaning|what it is/i.test(s[1])) ||
          sibs.find((s) => /key facts/i.test(s[1])) ||
          sibs.find((s) => /position|overview|about/i.test(s[1])) ||
          sibs.filter((s) => !QA_ASPECT_QTY.test(s[1]) &&
              !/^rule no/i.test(s[1]))
            .sort((a, b) => b[2].length - a[2].length)[0];
        if (defSib) return single(defSib);
      }
    }
  }
  if (cues.defIntent && hit[1] !== 'List') {
    const sibs = facts.filter((f) =>
      f[0] === hit[0] && f[4] === hit[4] && f[1] !== 'List');
    if (sibs.length >= 2) {
      const rank = (a) => (/^rule no/i.test(a) ? 2
        : QA_ASPECT_QTY.test(a) ? 0 : 1);
      const ordered = [...sibs].sort((x, y) => rank(x[1]) - rank(y[1]));
      const lines = [];
      for (const s of ordered) {
        if (/^(N\/A|—|-)/.test(s[2])) continue;
        lines.push(s[1] ? `${s[1]}: ${s[2]}` : s[2]);
      }
      let text = lines.join('\n');
      if (text.length > 1400) text = text.slice(0, 1399) + '…';
      if (text) return text;
    }
  }
  const cap = hit[1] === 'List' ? 950 : 600;
  return hit[2].length > cap ? hit[2].slice(0, cap - 1) + '…' : hit[2];
}

const queries = process.argv.slice(2);
for (const q of queries) {
  const ans = probe(q);
  console.log(`${q}\n   -> ${ans ? 'NOTES: ' + ans.slice(0, 150) : '(no notes hit — bank/fallback decides)'}`);
}
