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
  return { QA_STOP, qaToks, qaNotesSearch };`)();
const { QA_STOP, qaToks, qaNotesSearch } = api;

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
      ['kaun', 'list', 'naam', 'name', 'names', 'sab', 'batao', 'bata']
        .includes(t)) || /\bhow many\b/i.test(raw0),
    prodIntent: rawToks.some((t) =>
      ['banata', 'banati', 'banta', 'produces', 'produce', 'manufactures']
        .includes(t)),
    locIntent: rawToks.some((t) =>
      ['kahan', 'where', 'sthit', 'located'].includes(t)),
  };
  const hit = qaNotesSearch(facts, byToken, ct, cues);
  return hit ? hit[2] : null;
}

const queries = process.argv.slice(2);
for (const q of queries) {
  const ans = probe(q);
  console.log(`${q}\n   -> ${ans ? 'NOTES: ' + ans.slice(0, 150) : '(no notes hit — bank/fallback decides)'}`);
}
