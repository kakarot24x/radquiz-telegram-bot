// RADEQuiz Telegram Quiz Bot — Cloudflare Worker version
// --------------------------------------------------------
// Narendra's rules (2026-11-03), same as the Python bot:
//   * EVERYTHING is managed from inside the Telegram group — no other app.
//     Topic -> number of questions -> time per question -> Start, via buttons.
//   * Everything is saved by the bot itself (per-group storage): selections,
//     scores, progress. A restart loses nothing.
//   * NO auto quiz: a quiz runs only when the admin starts one.
//   * /stop (admin) stops a running quiz. /score shows all-time ranking.
//     /ping checks the bot is alive.
// The bot runs on the owner's own Cloudflare account (free plan, no card).
// The question bank lives as small JSON parts in this GitHub repo; the
// Worker fetches only the few parts a quiz needs.

const BANK_BASE =
  "https://raw.githubusercontent.com/kakarot24x/radquiz-telegram-bot/main/bank";
const COUNT_CHOICES = [10, 20, 30, 50, 100];
const MIX_COUNT_CHOICES = [5, 10, 15, 20, 25, 30, 40, 50];
const SECOND_CHOICES = [10, 15, 20, 30, 45, 60];
const PAGE_SIZE = 8;
const Q_LIMIT = 300, OPT_LIMIT = 100, EXPL_LIMIT = 200;
const MAX_PARTS_PER_QUIZ = 12;
const DEFAULT_COUNT = 50, DEFAULT_SECONDS = 20;

// ------------------------------------------------------------------ helpers
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickSome(arr, n) {
  return shuffle([...arr]).slice(0, n);
}

async function tg(token, method, params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) clean[k] = v;
  }
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clean),
  });
  const out = await resp.json().catch(() => null);
  if (!resp.ok || !out || !out.ok) {
    const detail = out ? JSON.stringify(out) : `HTTP ${resp.status}`;
    if (detail.includes("message is not modified")) return true;
    throw new Error(`${method} failed: ${detail}`);
  }
  return out.result;
}

// Anonymous admins act through the GroupAnonymousBot account. A group
// message whose sender_chat is the group itself comes from an anonymous
// admin of that group — treat it as the admin, not as a stranger.
const ANON_ADMIN_ID = 1087968824;
function effectiveSenderId(msg) {
  if (msg?.sender_chat && msg.chat && msg.sender_chat.id === msg.chat.id) {
    return ANON_ADMIN_ID;
  }
  return msg?.from?.id;
}

// Appendix 3A marking: +1 correct, -1/3 wrong, 0 skipped.
// Session entry: [name, correct, wrong, timeSec]; totals: [name, correct, answered, wrong, timeSec].
function ptsOf(e, isTotals) {
  const wrong = isTotals ? (e[3] || 0) : (e[2] || 0);
  return (e[1] || 0) - wrong / 3;
}
function fmtPts(e, isTotals) {
  const v = Math.round(ptsOf(e, isTotals) * 100) / 100;
  return Object.is(v, -0) ? "0" : String(v);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ bank
let _indexCache = null;
let _indexCacheAt = 0;
const INDEX_TTL_MS = 5 * 60 * 1000; // bank updates show up within ~5 minutes
async function loadIndex() {
  if (_indexCache && Date.now() - _indexCacheAt < INDEX_TTL_MS) {
    return _indexCache;
  }
  const resp = await fetch(`${BANK_BASE}/index.json`);
  if (!resp.ok) {
    if (_indexCache) return _indexCache; // serve stale on a transient failure
    throw new Error("bank index fetch failed");
  }
  _indexCache = await resp.json();
  _indexCacheAt = Date.now();
  return _indexCache;
}

async function fetchPart(name) {
  const resp = await fetch(`${BANK_BASE}/${name}`);
  if (!resp.ok) return [];
  return resp.json();
}

// ------------------------------------------------- Telegram question editor
// Saved edits live in one KV value (edits_all): { qid: {q, options, answer,
// e, orig, by, at} }. They are applied over the bank item (matched by its
// stable ID) every time a quiz is built, so an edit is live from the next
// quiz without touching the bank files. /edits exports them so they can be
// merged back into the real bank later.
let _searchCache = null;
let _searchCacheAt = 0;
async function loadSearchIndex() {
  if (_searchCache && Date.now() - _searchCacheAt < 30 * 60 * 1000) {
    return _searchCache;
  }
  const resp = await fetch(`${BANK_BASE}/search.json`);
  if (!resp.ok) {
    if (_searchCache) return _searchCache;
    throw new Error("search index fetch failed");
  }
  _searchCache = await resp.json();
  _searchCacheAt = Date.now();
  return _searchCache;
}

// ------------------------------------------- Mahesh Q&A (Akaza only)
// Inverted token index over search.json, built once per index load, so
// a spoken question can be matched against the whole bank cheaply.
let _qaMap = null;
let _qaMapAt = 0;
const QA_STOP = new Set(("hai hain ka ki ke ko me mein par se aur ya to bhi nahi na hi tha thi " +
  "the a an is are of for in on to at by what how many much does do did can could will would " +
  "shall should tell me please bata batao bataiye kya kitna kitne kitni kaun kab kahan kaise " +
  "kise kis hota hoti hote milta milti milte milega milegi chahiye matlab given liye banti " +
  "banta total andar upar neeche wala wali wale hoga hogi sakta sakti aata aati jata rehta " +
  "saal sal rate din baar dafa naam banata banati karta karti deta deti").split(" "));
const QA_QWORDS = new Set(("kya kitna kitne kitni kaun kab kahan kaise kise kis what how " +
  "when where which who why").split(" "));
function qaToks(s) {
  // z -> s normalisation on every side alike, so "sterilization" and
  // "sterilisation" (and organisation/organization) meet in the middle.
  return (s || "").toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean)
    .map((t) => t.replace(/z/g, "s"));
}
// Abbreviation -> spelled-out phrases. A query token also matches a
// stem/fact that spells the term out in full (CL -> "casual leave"),
// which is how most of the bank and all of the book write it.
const QA_EXP = {
  cl: [["casual", "leave"]], lap: [["leave", "average", "pay"]],
  lhap: [["leave", "half", "average", "pay"]],
  scl: [["special", "casual", "leave"]], ccl: [["child", "care", "leave"]],
  da: [["dearness", "allowance"]], hra: [["house", "rent", "allowance"]],
  ta: [["travelling", "allowance"]],
  nps: [["national", "pension", "system"], ["new", "pension", "scheme"]],
  ups: [["unified", "pension", "scheme"]],
  pf: [["provident", "fund"]], srpf: [["state", "railway", "provident", "fund"]],
  gpf: [["general", "provident", "fund"]],
  dcrg: [["death", "retirement", "gratuity"], ["death", "cum", "retirement", "gratuity"]],
  macp: [["modified", "assured", "career", "progression"]],
  macps: [["modified", "assured", "career", "progression"]],
  eol: [["extra", "ordinary", "leave"], ["engine", "on", "load"]],
  pto: [["privilege", "ticket", "order"]],
  irfc: [["indian", "railway", "finance", "corporation"]],
  cris: [["centre", "railway", "information", "systems"],
         ["center", "railway", "information", "systems"]],
  rpf: [["railway", "protection", "force"]], grp: [["government", "railway", "police"]],
  cag: [["comptroller", "auditor", "general"]],
  uts: [["unreserved", "ticketing", "system"]],
  prs: [["passenger", "reservation", "system"]],
  fois: [["freight", "operations", "information", "system"]],
  tms: [["terminal", "management", "system"]], cms: [["crew", "management", "system"]],
  atvm: [["automatic", "ticket", "vending", "machine"]],
  wms: [["workshop", "manufacture", "suspense"], ["workshop", "manufacturing", "suspense"]],
  gm: [["general", "manager"]], drm: [["divisional", "railway", "manager"]],
  pfa: [["principal", "financial", "adviser"]], tte: [["travelling", "ticket", "examiner"]],
  hoer: [["hours", "employment"]],
  ldce: [["limited", "departmental", "competitive", "examination"]],
  gcc: [["general", "conditions", "contract"]],
};
// Does query token t hit this token set? Exact, prefix (len >= 4),
// percent-sign equivalence, or a spelled-out expansion phrase.
function qaTokenHit(t, tokSet) {
  if (tokSet.has(t)) return true;
  if (t === "percent" || t === "%") {
    for (const x of tokSet) if (x.includes("%")) return true;
  }
  if (t.length >= 4) {
    for (const x of tokSet) if (x.startsWith(t)) return true;
  }
  const phr = QA_EXP[t];
  if (phr) {
    for (const p of phr) if (p.every((x) => tokSet.has(x))) return true;
  }
  return false;
}
// How strongly does t hit a label? 3 = the label carries the term as
// its own bracketed short form ("Leave on Average Pay (LAP)") — the
// book's canonical row for that term; 2 = the word itself is in the
// label, 1 = only its spelled-out expansion is, 0 = no hit.
function qaLabelScore(t, labelToks, labelStr) {
  if (labelStr &&
      labelStr.toLowerCase().includes("(" + t + ")")) return 3;
  if (labelToks.has(t)) return 2;
  if (t === "percent" || t === "%") {
    for (const x of labelToks) if (x.includes("%")) return 2;
  }
  if (t.length >= 4) {
    for (const x of labelToks) if (x.startsWith(t)) return 2;
  }
  const phr = QA_EXP[t];
  if (phr) {
    for (const p of phr) if (p.every((x) => labelToks.has(x))) return 1;
  }
  return 0;
}
async function loadQaMap() {
  const sidx = await loadSearchIndex();
  if (_qaMap && _qaMapAt === _searchCacheAt) return { sidx, byToken: _qaMap };
  const byToken = new Map();
  sidx.forEach((e, n) => {
    for (const t of new Set(qaToks(e[3]))) {
      let arr = byToken.get(t);
      if (!arr) { arr = []; byToken.set(t, arr); }
      arr.push(n);
    }
  });
  _qaMap = byToken;
  _qaMapAt = _searchCacheAt;
  return { sidx, byToken: _qaMap };
}

// Detailed-notes fact index (bank/notes.json, built by
// make_notes_index.py from the user's detailed tables book: every
// table row is one fact per value column —
// [label, aspect, value, chapterTitle, tableTitle]).
let _notesCache = null;
let _notesCacheAt = 0;
let _notesMap = null;
async function loadNotesFacts() {
  if (_notesCache && Date.now() - _notesCacheAt < 30 * 60 * 1000) {
    return { facts: _notesCache, byToken: _notesMap };
  }
  const resp = await fetch(`${BANK_BASE}/notes.json`);
  if (!resp.ok) throw new Error("notes fetch " + resp.status);
  const facts = await resp.json();
  const byToken = new Map();
  facts.forEach((f, n) => {
    const text = `${f[0]} ${f[1]} ${f[2]} ${f[3]} ${f[4]} ${f[5] || ""}`;
    for (const t of new Set(qaToks(text))) {
      let arr = byToken.get(t);
      if (!arr) { arr = []; byToken.set(t, arr); }
      arr.push(n);
    }
  });
  _notesCache = facts;
  _notesCacheAt = Date.now();
  _notesMap = byToken;
  return { facts, byToken };
}

const QA_ASPECT_QTY =
  /(credit|days|limit|max|entitle|admissible|quantum|amount|rate|percent|charges|period|life|scale|slab|powers)/i;
// Search the notes facts for one precise answer. A fact wins only
// when every content token hits it AND at least one content token
// hits its label (the fact must be ABOUT the thing asked). An exact
// label word outranks a spelled-out expansion, so LAP beats LHAP for
// "lap". Tied facts with different values stay unanswered here —
// unless they are the same label (aspects of one row), where the
// book's own first fact speaks. Returns the fact or null.
function qaNotesSearch(facts, byToken, ct, cues) {
  const cand = new Set();
  for (const t of new Set(ct)) {
    if (byToken.has(t)) for (const n of byToken.get(t)) cand.add(n);
    if (t.length >= 4) {
      for (const [k, v] of byToken) {
        if (k.startsWith(t)) for (const n of v) cand.add(n);
      }
    }
    const phr = QA_EXP[t];
    if (phr) {
      for (const p of phr) {
        for (const x of p) {
          if (byToken.has(x)) for (const n of byToken.get(x)) cand.add(n);
        }
      }
    }
  }
  const ctSet = new Set(ct);
  let best = null;
  let bestList = null;
  let exactLabelRow = false;
  for (const n of cand) {
    const f = facts[n];
    const fToks = new Set(qaToks(`${f[0]} ${f[1]} ${f[2]} ${f[3]} ${f[4]} ${f[5] || ""}`));
    if (!ct.every((t) => qaTokenHit(t, fToks))) continue;
    const lToks = new Set(qaToks(f[0]));
    let labelScore = 0;
    let hitCount = 0;
    for (const t of ct) {
      const s = qaLabelScore(t, lToks, f[0]);
      labelScore = Math.max(labelScore, s);
      if (s > 0) hitCount += 1;
    }
    if (!labelScore) continue;
    // Exact-topic row: the label IS the asked topic, word for word
    // ("Limited Tender" for "limited tender?") — such a row outranks
    // supersets ("Special Limited Tender") and blocks the List pass.
    const labelContent = new Set([...lToks]
      .filter((x) => x.length >= 2 && !QA_STOP.has(x)));
    const exactLabel = f[1] !== "List" &&
      labelContent.size === ctSet.size &&
      [...ctSet].every((t) => qaTokenHit(t, labelContent));
    if (exactLabel) exactLabelRow = true;
    // A row whose own label/aspect names something the table title
    // does not ("copies" inside the Error Sheet table) is more
    // specific than the table's List fact — reward that.
    let distinctive = 0;
    if (f[1] !== "List") {
      const laToks = new Set(qaToks(f[0] + " " + f[1]));
      const ttToks = new Set(qaToks(f[4]));
      for (const t of ct) {
        if (qaTokenHit(t, laToks) && !qaTokenHit(t, ttToks)) distinctive += 1;
      }
    }
    let score = labelScore * 1000 + hitCount * 100 + distinctive * 150 +
      (exactLabel ? 50 : 0);
    if (f[1] === "List") score += cues.listIntent ? 70 : 20;
    if (QA_ASPECT_QTY.test(f[1])) score += cues.qtyIntent ? 10 : 5;
    if (cues.defIntent &&
        /period|fact|definition|meaning|position|detail|key|overview/i
          .test(f[1])) score += 15;
    if (cues.prodIntent && /produc|manufactur/i.test(f[1])) score += 30;
    if (cues.locIntent && /location|headquarter/i.test(f[1])) score += 30;
    if (cues.yearCue && /year|annum|annual/i.test(f[2] + " " + f[1])) score += 1;
    const entry = { score, list: [f], labelScore, hitCount };
    if (!best || score > best.score) best = entry;
    else if (score === best.score) best.list.push(f);
    if (f[1] === "List") {
      if (!bestList || score > bestList.score) bestList = entry;
      else if (score === bestList.score) bestList.list.push(f);
    }
  }
  // Short topic queries ("production unit kitne hai", "zones ke
  // naam") are answered by the table itself when a List fact's label
  // fully matches the topic — row facts about other tables that
  // merely mention the topic do not outrank it.
  const pick = (b) => {
    if (!b) return null;
    const labels = new Set(b.list.map((f) => f[0]));
    if (labels.size === 1) {
      // Aspects of one row tied — the longest value is the headline
      // fact (e.g. LAP's Credit over its Rule No. or Max columns).
      return b.list.reduce((a, c) => (c[2].length > a[2].length ? c : a));
    }
    const vals = new Set(b.list.map((f) => f[2]));
    return vals.size === 1 ? b.list[0] : null;
  };
  if (ct.length <= 2 && bestList && bestList.labelScore >= 2 &&
      bestList.hitCount === ct.length &&
      !cues.prodIntent && !cues.locIntent && !exactLabelRow) {
    const hit = pick(bestList);
    if (hit) return hit;
  }
  return pick(best);
}

// Day-wise index for Telegram Quizzes (bank/tgdays.json, built by
// make_tgdays.py): Group -> Month -> Day -> that day's question keys in
// original order, so a group's actual day quiz replays same-to-same.
let _tgDaysCache = null;
let _tgDaysCacheAt = 0;
async function loadTgDays() {
  if (_tgDaysCache && Date.now() - _tgDaysCacheAt < 30 * 60 * 1000) {
    return _tgDaysCache;
  }
  const resp = await fetch(`${BANK_BASE}/tgdays.json`);
  if (!resp.ok) {
    if (_tgDaysCache) return _tgDaysCache;
    throw new Error("tgdays fetch failed");
  }
  _tgDaysCache = await resp.json();
  _tgDaysCacheAt = Date.now();
  return _tgDaysCache;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtMonth(m) { // "2024-01" -> "Jan 2024"
  const [y, mo] = m.split("-");
  return `${MONTH_NAMES[parseInt(mo, 10) - 1]} ${y}`;
}
function fmtDay(d) { // "2024-01-16" -> "16 Jan 2024"
  const [y, mo, da] = d.split("-");
  return `${parseInt(da, 10)} ${MONTH_NAMES[parseInt(mo, 10) - 1]} ${y}`;
}

async function loadEdits(env) {
  try {
    return JSON.parse((await env.KV.get("edits_all")) || "{}");
  } catch (e) { return {}; }
}

function applyEdit(item, ed) {
  if (!ed) return item;
  item.q = ed.q;
  item.options = ed.options;
  item.answer = ed.answer;
  if (ed.e !== undefined) item.e = ed.e;
  return item;
}

// candidate parts for a selection, as [{name, size}]
function candidateParts(index, subjectI, chapterI, cis = null) {
  const parts = [];
  const addChapter = (ci) => {
    const ch = index.chapters[ci];
    if (!ch) return;
    for (let k = 0; k < ch.parts; k++) {
      const size = Math.min(index.part_size,
        ch.count - k * index.part_size);
      parts.push({ name: `p-${ci}-${k}.json`, size });
    }
  };
  if (cis) {
    cis.forEach(addChapter);
  } else if (subjectI === null || subjectI === undefined) {
    index.chapters.forEach((c) => addChapter(c.ci));
  } else if (chapterI === null || chapterI === undefined) {
    index.subjects[subjectI].chapters.forEach(addChapter);
  } else {
    addChapter(chapterI);
  }
  return parts;
}

// Fetch a bounded random subset of parts big enough for `count` questions.
// mode: "all" | "new" (never asked) | "done" (already asked, for revision).
// askedOf(partName) -> Promise<Set of asked indices within that part>.
// Every returned item is tagged with _k = "<part>#<index>" and _ci (chapter).
async function fetchPool(index, subjectI, chapterI, count, mode = "all", askedOf = null, cis = null, edits = null) {
  const cand = candidateParts(index, subjectI, chapterI, cis);
  const totalQ = cand.reduce((s, p) => s + p.size, 0);
  const want = Math.max(300, count * 3);
  let chosen = cand;
  if (mode === "done" && askedOf) {
    const withDone = [];
    for (const p of cand) {
      const set = await askedOf(p.name);
      if (set && set.size) withDone.push({ p, n: set.size });
    }
    withDone.sort((a, b) => b.n - a.n);
    chosen = [];
    let acc = 0;
    for (const { p, n } of withDone) {
      if (chosen.length >= 30 || acc >= want) break;
      chosen.push(p);
      acc += n;
    }
  } else if (totalQ > want) {
    chosen = [];
    let acc = 0;
    for (const p of shuffle([...cand])) {
      if (chosen.length >= MAX_PARTS_PER_QUIZ || acc >= want) break;
      chosen.push(p);
      acc += p.size;
    }
  }
  const items = [];
  for (const p of chosen) {
    const qs = await fetchPart(p.name);
    const asked = (mode !== "all" && askedOf) ? await askedOf(p.name) : null;
    qs.forEach((q, i) => {
      const isDone = asked ? asked.has(i) : false;
      if (mode === "new" && isDone) return;
      if (mode === "done" && !isDone) return;
      q._k = `${p.name}#${i}`;
      q._ci = parseInt(p.name.split("-")[1], 10);
      if (edits && q.i && edits[q.i]) applyEdit(q, edits[q.i]);
      items.push(q);
    });
  }
  return items;
}

// ------------------------------------------------------------- poll payload
// Faithful port of bot.py's build_poll_payload.
// Returns {pre, poll} or {skip: reason}.
function buildPollPayload(item, number, seconds) {
  const optsMap = item.options || {};
  let letters, options;
  if (Array.isArray(optsMap)) {
    letters = optsMap.map((_, i) => String.fromCharCode(65 + i));
    options = optsMap.map(String);
  } else {
    letters = Object.keys(optsMap).sort();
    options = letters.map((l) => String(optsMap[l]));
  }
  if (options.length < 2 || !letters.includes(item.answer)) {
    return { skip: "answer letter not in options / too few options" };
  }
  const correct = letters.indexOf(item.answer);
  let qtext = String(item.q || "").trim();
  let pre = null;
  if (qtext.length > Q_LIMIT) {
    pre = `📝 Question ${number}:\n${qtext}`;
    qtext = qtext.slice(0, Q_LIMIT - 1) + "…";
  }
  const fixed = options.map((o) => {
    o = o.trim();
    return o.length > OPT_LIMIT ? o.slice(0, OPT_LIMIT - 1) + "…" : o;
  });
  if (new Set(fixed).size !== fixed.length) {
    return { skip: "duplicate options" };
  }
  let explanation = `Correct answer: ${item.answer}. ${options[correct]}`;
  if (item.e) {
    // Bundled offline explanation (rides inside the same poll — Telegram
    // caps it at 200 chars, so it is trimmed at a word boundary).
    explanation = `Correct answer: ${item.answer}. ${String(item.e).trim()}`;
  }
  if (explanation.length > EXPL_LIMIT) {
    explanation = explanation.slice(0, EXPL_LIMIT - 1)
      .replace(/\s+\S*$/, "") + "…";
  }
  let question = `Q${number}. ${qtext}`;
  if (question.length > Q_LIMIT) question = question.slice(0, Q_LIMIT - 1) + "…";
  return {
    pre,
    poll: {
      question,
      options: fixed,
      type: "quiz",
      correct_option_id: correct,
      is_anonymous: false,
      open_period: seconds,
      explanation,
    },
  };
}

// ------------------------------------------------------- syllabus (App. 3A)
// The bank's Appendix-3 chapters are titled "PAPER-I: EST: Leave Rules" —
// paper + topic-group code + chapter name. The syllabus view is derived
// from those titles, so it can never drift away from the bank itself.
const SYL_GROUP_NAMES = {
  GRP: "GRP", EST: "Establishment", PPN: "PF, Pension & NPS",
  LLF: "Labour Laws & Associated Finance", EXP: "Expenditure",
  BB: "Books & Budget", BK: "Book-Keeping", IR: "Industrial Relations",
  CLP: "Codal Life & Records",
  STR: "Stores", WKS: "Workshop", COS: "COS Procedure",
  WCF: "Workshop Costing & Associated Finance", EX2: "Expenditure",
  WMS: "WMS", SAC: "Stores Accounts", AUD: "Audit",
  TAC: "Traffic Accounts", FIN: "Finance",
  TSC: "Traffic Statistics & Costing", STA: "Station Accounts",
  INS: "Inspection",
};
const SYL_PAPERS = ["PAPER-I", "PAPER-II", "PAPER-III"];

function syllabusMap(index) {
  const papers = SYL_PAPERS.map((p) => ({ paper: p, groups: [], cis: [], total: 0 }));
  const byPaper = Object.fromEntries(papers.map((p) => [p.paper, p]));
  index.chapter_titles.forEach((t, ci) => {
    const m = /^PAPER-(I|II|III):\s*([A-Z0-9]+):\s*(.+)$/.exec(t || "");
    if (!m) return;
    const count = index.chapter_counts[ci] || 0;
    if (!count) return;
    const P = byPaper[`PAPER-${m[1]}`];
    let g = P.groups.find((x) => x.code === m[2]);
    if (!g) {
      g = { code: m[2], name: SYL_GROUP_NAMES[m[2]] || m[2], cis: [], total: 0 };
      P.groups.push(g);
    }
    g.cis.push(ci); g.total += count;
    P.cis.push(ci); P.total += count;
  });
  return papers.filter((p) => p.total > 0);
}

// ------------------------------------------------------- 9 PM auto quiz
// Daily at 21:00 IST the Worker cron fires; every group whose admin has
// switched /autoquiz ON gets today's syllabus-rotation quiz (50 Q, 20 s,
// New-questions mode, falling back to All when a pool runs dry).
function istDayIndex() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return (ist.getUTCDay() + 6) % 7; // Monday = 0
}

function autoSelection(index) {
  const papers = syllabusMap(index);
  const byName = Object.fromEntries(papers.map((p) => [p.paper, p]));
  const groupEntry = (paper, code, count) => {
    const g = (byName[paper]?.groups || []).find((x) => x.code === code);
    return g ? { label: `${paper} › ${SYL_GROUP_NAMES[code] || code}`, cis: g.cis, count } : null;
  };
  const d = istDayIndex();
  let plan, tag;
  if (d === 3) { // Thursday = Mix day
    plan = [groupEntry("PAPER-I", "EST", 17), groupEntry("PAPER-II", "STR", 17),
            groupEntry("PAPER-III", "TAC", 16)].filter(Boolean);
    tag = "🧩 Mix Day (Establishment + Stores + Traffic Accounts)";
  } else {
    const name = ["PAPER-I", "PAPER-II", "PAPER-III", null,
                  "PAPER-I", "PAPER-II", "PAPER-III"][d];
    plan = [{ label: `${name} (All Topics)`, cis: byName[name].cis, count: 50 }];
    tag = `📖 ${name}`;
  }
  return {
    plan, label: `🌙 9 PM Auto Quiz — ${tag}`,
    count: 50, seconds: 20, mode: "new",
  };
}

async function roomCallFromWorker(env, chatId, path, payload) {
  const stub = env.QUIZ.get(env.QUIZ.idFromName(String(chatId)));
  const r = await stub.fetch(`https://do${path}`, {
    method: "POST", body: JSON.stringify(payload || {}),
  });
  return r.json().catch(() => ({}));
}

async function runAutoQuizzes(env) {
  let groups = {};
  try {
    groups = JSON.parse((await env.KV.get("groups")) || "{}");
  } catch (e) { /* no registry yet */ }
  const ids = Object.keys(groups);
  if (!ids.length) return;
  const index = await loadIndex();
  const sel = autoSelection(index);
  for (const id of ids) {
    const chatId = Number(id);
    try {
      const st = await roomCallFromWorker(env, chatId, "/auto");
      if (!st.on || st.running) continue;
      let res = await roomCallFromWorker(env, chatId, "/start", {
        chatId, label: sel.label, subject: null, chapter: null,
        count: sel.count, seconds: sel.seconds, mode: sel.mode,
        plan: sel.plan, saveLast: false,
      });
      if (!res.ok && res.reason === "empty") {
        res = await roomCallFromWorker(env, chatId, "/start", {
          chatId, label: sel.label, subject: null, chapter: null,
          count: sel.count, seconds: sel.seconds, mode: "all",
          plan: sel.plan, saveLast: false,
        });
      }
    } catch (e) { /* one bad group must not stop the others */ }
  }
}

function planLabel(kind, entries) {
  const body = (entries || []).map((e) => `${e.label} ×${e.count}`).join(" + ");
  return kind === "keyword" ? `🔑 Keywords: ${body}` : `🧩 Mix: ${body}`;
}

// Union of "part#index" keys across keyword entries (overlap-safe).
function kwUnion(entries) {
  const seen = new Set();
  const keys = [];
  for (const e of entries || []) {
    for (const k of e.keys || []) {
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  return keys;
}

function mixLabel(mix) {
  return "🧩 Mix: " + mix.map((e) => `${e.label} ×${e.count}`).join(" + ");
}

function mixTotals(index, mix, counts = {}) {
  const seen = new Set();
  let total = 0, done = 0;
  for (const e of mix) {
    for (const ci of e.cis) {
      if (seen.has(ci)) continue;
      seen.add(ci);
      total += index.chapter_counts[ci] || 0;
      done += counts[ci] || 0;
    }
  }
  return { total, done };
}

function labelFor(index, subjectI, chapterI) {
  if (subjectI === null || subjectI === undefined) {
    return "🎲 Full Bank (Random)";
  }
  const s = index.subjects[subjectI];
  if (chapterI === null || chapterI === undefined) {
    return `${s.icon || "📚"} ${s.name} — All Topics`;
  }
  return `${s.icon || "📚"} ${s.name} — ${index.chapter_titles[chapterI]}`;
}

// ================================================================== worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return htmlPage(await statusPage(env));
      }
      if (url.pathname === "/setup" && request.method === "POST") {
        return htmlPage(await handleSetup(request, env, url.origin));
      }
      if (url.pathname === "/activate" && request.method === "GET") {
        return htmlPage(await handleActivate(env, url.origin));
      }
      if (url.pathname === "/hook" && request.method === "POST") {
        return await handleHook(request, env, ctx);
      }
      if (url.pathname === "/hook") return new Response("ok");
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(`error: ${e.message}`, { status: 500 });
    }
  },

  // Cron: daily 15:30 UTC = 21:00 IST — 9 PM auto quiz in opted-in groups.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoQuizzes(env));
  },
};

function htmlPage(body) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RADEQuiz Bot Setup</title></head>
<body style="font-family: system-ui; max-width: 560px; margin: 24px auto; padding: 0 16px;">
${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// One codebase, two bots: the deployment whose bot username contains
// "akaza" runs as the Akaza bot (own commands, own branding); everything
// else is the main RADEQuiz bot. Flavor is fixed at setup time from the
// bot's own username, so a deployment can never take the wrong role.
function flavorOf(username) {
  return /akaza/i.test(username || "") ? "akaza" : "main";
}

async function getConfig(env) {
  const raw = await env.KV.get("config");
  return raw ? JSON.parse(raw) : null;
}

// The bot token can also arrive as a Worker secret named BOT_TOKEN
// (added from the Cloudflare dashboard). That path avoids the setup
// form entirely; the webhook secret is then derived from the token.
const _derivedSecrets = new Map();
async function deriveSecret(token) {
  if (_derivedSecrets.has(token)) return _derivedSecrets.get(token);
  const buf = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const secret = hex.slice(0, 40);
  _derivedSecrets.set(token, secret);
  return secret;
}

async function resolveConfig(env) {
  if (env.BOT_TOKEN) {
    const rawPaste = String(env.BOT_TOKEN);
    const found = rawPaste.match(/\d{6,}:[A-Za-z0-9_-]{30,}/);
    const token = found ? found[0] : rawPaste.trim();
    const kvCfg = await getConfig(env).catch(() => null);
    return {
      token, secret: await deriveSecret(token),
      username: kvCfg ? kvCfg.username : null, viaEnv: true,
    };
  }
  return getConfig(env);
}

async function handleActivate(env, origin) {
  const cfg = await resolveConfig(env);
  if (!cfg) {
    return `<h2>❌ No token found yet</h2>
<p>First add the bot token in the Cloudflare dashboard:
<b>Workers &amp; Pages → radquiz-bot → Settings → Variables and Secrets →
Add → Secret</b>, name it <b>BOT_TOKEN</b> and paste the BotFather token
as its value. Then open this page again.</p>`;
  }
  try {
    const me = await tg(cfg.token, "getMe");
    await tg(cfg.token, "setWebhook", {
      url: `${origin}/hook`,
      secret_token: cfg.secret,
      drop_pending_updates: true,
      allowed_updates: ["message", "callback_query", "poll_answer"],
    });
    await env.KV.put("config", JSON.stringify({
      token: cfg.token, secret: cfg.secret, username: me.username,
      flavor: flavorOf(me.username),
    }));
    const isAkaza = flavorOf(me.username) === "akaza";
    return `<h2>✅ Bot is Live!</h2>
<p>Bot <b>@${me.username}</b> is now connected to Telegram.</p>
<p>Open the <b>RADEQuiz</b> group and type <b>${isAkaza ? "/maheshping" : "/ping"}</b> — the bot will reply.
Then start a quiz with <b>${isAkaza ? "/maheshquiz" : "/quiz"}</b>.</p>`;
  } catch (e) {
    return `<h2>❌ Activation failed</h2>
<p>Telegram did not accept the token stored in BOT_TOKEN.</p>
<p>Check in BotFather (BotFather → /mybots → your bot → API Token) that the
token there matches the BOT_TOKEN value exactly, then open this page again.</p>
<small style="color:#555">Details: ${e.message}</small>`;
  }
}

async function statusPage(env) {
  const cfg = await resolveConfig(env);
  if (cfg && cfg.viaEnv && !cfg.username) {
    return `<h2>🚂 RADEQuiz Bot — One Last Tap</h2>
<p>Your bot token was found. ✅</p>
<p>Tap the button below to connect the bot to Telegram:</p>
<p><a href="/activate" style="display:block; text-align:center;
background:#2f7cf6; color:#fff; padding:14px; border-radius:8px;
font-size:17px; text-decoration:none;">▶ Activate the Bot</a></p>`;
  }
  if (!cfg) {
    return `<h2>🚂 RADEQuiz Bot — First-time Setup</h2>
<p>Paste your <b>bot token</b> from BotFather here, just once. The token
stays safe inside your own Cloudflare account.</p>
<form method="POST" action="/setup">
<input name="token" type="text" placeholder="Paste bot token here"
 autocomplete="off" autocapitalize="off" spellcheck="false"
 style="width:100%; padding:12px; font-size:16px;">
<p style="color:#555">After pasting, you should <b>see</b> the token in the box
above — it starts with about 10 numbers, then a <b>:</b>, then a long line of
letters and numbers. If the box looks empty, the paste did not happen —
long-press the box and tap <b>Paste</b> again.</p>
<button style="width:100%; padding:14px; margin-top:6px; font-size:17px;">
▶ Start the Bot</button></form>`;
  }
  return `<h2>✅ RADEQuiz Bot is Running</h2>
<p>Bot: <b>@${cfg.username || "RADEQuiz"}</b> · Build <b>2026-11-08 v42</b></p>
<p>Now open your Telegram group <b>RADEQuiz</b> and type <b>/quiz</b> —
choose a topic, the number of questions and the timer, and the quiz starts.
Everything is controlled from Telegram itself.</p>
<hr>
<p style="color:#555">To change the token: get a new token from BotFather,
enter the <b>last 6 characters of the current token</b> as the code below,
then paste the new token.</p>
<form method="POST" action="/setup">
<input name="code" placeholder="Last 6 characters of current token"
 style="width:100%; padding:10px; font-size:15px;">
<input name="token" type="password" placeholder="New bot token"
 style="width:100%; padding:10px; font-size:15px; margin-top:8px;">
<button style="width:100%; padding:11px; margin-top:10px; font-size:15px;">
Change Token</button></form>`;
}

async function handleSetup(request, env, origin) {
  const form = await request.formData();
  const rawPaste = String(form.get("token") || "");
  // If the whole BotFather message was pasted by mistake, pull the
  // token itself out of it automatically.
  const found = rawPaste.match(/\d{6,}:[A-Za-z0-9_-]{30,}/);
  const token = found ? found[0] : rawPaste.replace(/\s+/g, "");
  if (!token) {
    return `❌ The token box was empty. Please go back and paste the token.`;
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    return `❌ This does not look like a bot token. A bot token looks like
<code>123456789:AAE...</code> — a number, then a colon (:), then letters.
Please copy it again from BotFather (BotFather → /mybots → your bot →
API Token) and paste it carefully.`;
  }
  const existing = await getConfig(env);
  if (existing) {
    const code = String(form.get("code") || "").trim();
    if (code !== existing.token.slice(-6)) {
      return "❌ Wrong code — the last 6 characters of the current token are needed. The token was not changed.";
    }
  }
  let me;
  try {
    me = await tg(token, "getMe");
  } catch (e) {
    return `❌ Telegram did not accept this token.<br>
Please open BotFather → /mybots → your RADEQuiz bot → <b>API Token</b>,
copy the token shown there exactly, and try again.<br>
<small style="color:#555">Details: ${e.message}</small>`;
  }
  const secret = [...crypto.getRandomValues(new Uint8Array(18))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const cfg = { token, secret, username: me.username, flavor: flavorOf(me.username) };
  await env.KV.put("config", JSON.stringify(cfg));
  await tg(token, "setWebhook", {
    url: `${origin}/hook`,
    secret_token: secret,
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query", "poll_answer"],
  });
  try { await registerCommands(token, cfg.flavor); } catch (e) { /* menu retries later */ }
  return `<h2>✅ Done!</h2>
<p>Bot <b>@${me.username}</b> is now running and connected to Telegram.</p>
<p>Now type <b>/ping</b> in the <b>RADEQuiz</b> group — the bot will reply.
Then start your first quiz with <b>${cfg.flavor === "akaza" ? "/maheshquiz" : "/quiz"}</b>.</p>
<p style="color:#555">Do not share this page's address (URL) with anyone —
the bot is set up from here.</p>`;
}

// Telegram's own "/" command menu (shown by the Telegram app itself).
async function registerCommands(token, flavor = "main") {
  const base = [
    { command: "quiz", description: "🎯 Start a quiz" },
    { command: "score", description: "🏆 All-time ranking" },
    { command: "ping", description: "✅ Is the bot live?" },
    { command: "edit", description: "✏️ Edit a question (search & fix)" },
    { command: "edits", description: "📤 My saved edits (export)" },
  ];
  const group = flavor === "akaza" ? [
    { command: "maheshquiz", description: "🎯 Start a quiz (Akaza)" },
    { command: "maheshstop", description: "🛑 Stop the running quiz (admin only)" },
    { command: "maheshscore", description: "🏆 All-time ranking (Akaza)" },
    { command: "maheshping", description: "✅ Is the bot live?" },
    { command: "maheshauto", description: "🌙 9 PM auto quiz — on / off / test" },
    { command: "maheshedit", description: "✏️ Edit a question (opens in DM)" },
  ] : [
    base[0],
    { command: "stop", description: "🛑 Stop the running quiz (admin only)" },
    base[1], base[2],
    { command: "settings", description: "⚙️ Quiz info" },
    { command: "autoquiz", description: "🌙 9 PM auto quiz — on / off / test" },
    { command: "edit", description: "✏️ Edit a question (opens in DM)" },
  ];
  await tg(token, "setMyCommands", { commands: base });
  await tg(token, "setMyCommands",
    { commands: group, scope: { type: "all_group_chats" } });
}

async function handleHook(request, env, ctx) {
  const cfg = await resolveConfig(env);
  if (!cfg) return new Response("ok");
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== cfg.secret) return new Response("forbidden", { status: 403 });
  const update = await request.json();

  // One-time: publish the command menu to Telegram (v12+).
  if (!(await env.KV.get("cmds_v23"))) {
    ctx.waitUntil(registerCommands(cfg.token, cfg.flavor || flavorOf(cfg.username))
      .then(() => env.KV.put("cmds_v23", "1")).catch(() => {}));
  }

  if (update.poll_answer) {
    const chatId = await env.KV.get(`pollmap:${update.poll_answer.poll_id}`);
    if (chatId) {
      const stub = env.QUIZ.get(env.QUIZ.idFromName(String(chatId)));
      ctx.waitUntil(stub.fetch("https://do/poll_answer", {
        method: "POST", body: JSON.stringify(update.poll_answer),
      }));
    }
    return new Response("ok");
  }
  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat?.id;
    const cchat = update.callback_query.message?.chat;
    if (cchat && ["group", "supergroup"].includes(cchat.type)) {
      ctx.waitUntil(registerGroup(env, cchat));
    }
    if (chatId) {
      const stub = env.QUIZ.get(env.QUIZ.idFromName(String(chatId)));
      ctx.waitUntil(stub.fetch("https://do/callback", {
        method: "POST", body: JSON.stringify(update.callback_query),
      }));
    }
    return new Response("ok");
  }
  const msg = update.message;
  if (msg && msg.chat && ["group", "supergroup"].includes(msg.chat.type)) {
    ctx.waitUntil(registerGroup(env, msg.chat));
    const text = (msg.text || "").split("@")[0].trim();
    const flavor = cfg.flavor || flavorOf(cfg.username);
    if ((text === "/ping" && flavor !== "akaza") ||
        (text === "/maheshping" && flavor === "akaza")) {
      ctx.waitUntil(tg(cfg.token, "sendMessage", {
        chat_id: msg.chat.id,
        text: flavor === "akaza" ? "✅ Akaza bot is live!" : "✅ RADEQuiz bot is live!",
      }).catch(() => {}));
      return new Response("ok");
    }
    if (["/quiz", "/stop", "/score", "/settings", "/edit", "/edits",
         "/maheshquiz", "/maheshstop", "/maheshscore", "/maheshedit"].includes(text) ||
        text.split(" ")[0] === "/autoquiz" ||
        text.split(" ")[0] === "/maheshauto" || !text.startsWith("/")) {
      const stub = env.QUIZ.get(env.QUIZ.idFromName(String(msg.chat.id)));
      ctx.waitUntil(stub.fetch("https://do/message", {
        method: "POST", body: JSON.stringify(msg),
      }));
    }
  } else if (msg && msg.chat && msg.chat.type === "private") {
    // Private chat: the admin runs the quiz setup here, hidden from members.
    const text = (msg.text || "").split("@")[0].trim();
    if (text === "/ping" || text === "/maheshping") {
      ctx.waitUntil(tg(cfg.token, "sendMessage", {
        chat_id: msg.chat.id,
        text: (cfg.flavor || flavorOf(cfg.username)) === "akaza"
          ? "✅ Akaza bot is live!" : "✅ RADEQuiz bot is live!",
      }).catch(() => {}));
      return new Response("ok");
    }
    if (["/quiz", "/start", "/stop", "/score", "/edit", "/edits", "/maheshedit",
         "/maheshquiz", "/maheshstop", "/maheshscore"].includes(text) ||
        text.split(" ")[0] === "/autoquiz" ||
        text.split(" ")[0] === "/maheshauto" || !text.startsWith("/")) {
      const stub = env.QUIZ.get(env.QUIZ.idFromName(String(msg.chat.id)));
      ctx.waitUntil(stub.fetch("https://do/message", {
        method: "POST", body: JSON.stringify(msg),
      }));
    }
  }
  return new Response("ok");
}

// Remember groups the bot serves, so the private (DM) setup can offer them
// as targets. Throttled: writes only on first sight, title change, or daily.
async function registerGroup(env, chat) {
  try {
    const raw = await env.KV.get("groups");
    const groups = raw ? JSON.parse(raw) : {};
    const cur = groups[chat.id];
    const now = Date.now();
    if (!cur || cur.title !== (chat.title || "") ||
        now - (cur.at || 0) > 24 * 3600 * 1000) {
      groups[chat.id] = { title: chat.title || "", at: now };
      await env.KV.put("groups", JSON.stringify(groups));
    }
  } catch (e) { /* registry is best-effort */ }
}

// ============================================================ Durable Object
export class QuizRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._token = null;
  }

  async flavor() {
    if (!this._flavor) {
      const cfg = await getConfig(this.env).catch(() => null);
      this._flavor = (cfg && (cfg.flavor || flavorOf(cfg.username))) || "main";
    }
    return this._flavor;
  }

  async token() {
    if (!this._token) {
      const cfg = await resolveConfig(this.env);
      if (!cfg) throw new Error("bot is not configured yet");
      this._token = cfg.token;
    }
    return this._token;
  }

  async call(method, params) {
    return tg(await this.token(), method, params);
  }

  async send(chatId, text, keyboard) {
    return this.call("sendMessage", {
      chat_id: chatId, text,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  async edit(chatId, messageId, text, keyboard) {
    return this.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  async answerCb(id, text) {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: id, text,
      });
    } catch (e) { /* ignore */ }
  }

  async sendDocument(chatId, filename, content, caption) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    form.set("document",
      new Blob([content], { type: "application/json" }), filename);
    const resp = await fetch(
      `https://api.telegram.org/bot${await this.token()}/sendDocument`,
      { method: "POST", body: form });
    return resp.json().catch(() => ({}));
  }

  // ------------------------------------------------------ question editor
  editorNorm(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

  async startEditor(chatId, userId) {
    const groups = await this.knownGroupsFor(userId);
    if (!groups.length) {
      await this.send(chatId, "🔒 Question editing is only for a group admin.");
      return;
    }
    const ef = {
      owner: userId, step: "await_query", msgId: null, results: [],
      draft: null, orig: null, qid: null, ci: null, field: null, warn: "",
      lq: null, lqPage: 0,
    };
    const sent = await this.send(chatId,
      "✏️ Question Editor\nType some words from the question you want to fix (e.g. \"error sheet manual\") — I will search the whole bank.\nOr pick from a group's last quiz:",
      [[this.btn("🕘 Last Quiz Questions", "ed:lq")],
       [this.btn("❌ Close editor", "ed:close")]]);
    ef.msgId = sent.message_id;
    await this.state.storage.put("editflow", ef);
  }

  async editorSearch(chatId, ef, query) {
    const tokens = this.editorNorm(query).split(" ").filter(Boolean);
    if (!tokens.length) return;
    await this.edit(chatId, ef.msgId, "🔎 Searching the bank…");
    let sidx;
    try {
      sidx = await loadSearchIndex();
    } catch (e) {
      await this.edit(chatId, ef.msgId, "⚠️ Search is unavailable right now. Try again in a minute.",
        [[this.btn("❌ Close editor", "ed:close")]]);
      return;
    }
    const hits = [];
    for (const e of sidx) {
      const qn = this.editorNorm(e[3]);
      if (tokens.every((t) => qn.includes(t))) {
        hits.push(e);
        if (hits.length >= 40) break;
      }
    }
    if (!hits.length) {
      ef.step = "await_query";
      await this.state.storage.put("editflow", ef);
      await this.edit(chatId, ef.msgId,
        `🔎 No question matches "${query}".\nType different words to search again.`,
        [[this.btn("❌ Close editor", "ed:close")]]);
      return;
    }
    ef.results = hits.slice(0, 8).map((e) => ({ i: e[0], part: e[1], idx: e[2] }));
    ef.step = "results";
    await this.state.storage.put("editflow", ef);
    const index = await loadIndex();
    const rows = ef.results.map((r, n) => {
      const ci = parseInt(r.part.split("-")[1], 10);
      const chT = (index.chapter_titles[ci] || "").slice(0, 16);
      return [this.btn(`${hits[n][3].slice(0, 36)} · ${chT}`, `ed:pick:${n}`)];
    });
    rows.push([this.btn("🔍 Search again", "ed:new"),
               this.btn("❌ Close", "ed:close")]);
    await this.edit(chatId, ef.msgId,
      `🔎 ${hits.length >= 40 ? "40+" : hits.length} match(es) for "${query}" — tap the question to edit:`,
      rows);
  }

  // -------------------------------------------------- editor: last quiz
  // Pick a group -> the questions of its most recent quiz (recorded in
  // the group room by startSession, read back via the /lastquiz route)
  // -> tap one -> the same editor card the word-search path opens.
  async editorLqGroups(chatId, ef) {
    const groups = await this.knownGroupsFor(ef.owner);
    if (!groups.length) {
      await this.edit(chatId, ef.msgId,
        "🔒 Question editing is only for a group admin.",
        [[this.btn("❌ Close editor", "ed:close")]]);
      return;
    }
    ef.step = "lq_groups";
    await this.state.storage.put("editflow", ef);
    const rows = groups.map((g) =>
      [this.btn(`👥 ${g.title || g.id}`, `ed:lqg:${g.id}`)]);
    rows.push([this.btn("🔍 Search by words", "ed:new"),
               this.btn("❌ Close", "ed:close")]);
    await this.edit(chatId, ef.msgId,
      "🕘 Last Quiz Questions\nPick a group — I will show the questions from its most recent quiz:",
      rows);
  }

  async editorLqOpen(chatId, ef, groupId) {
    const groups = await this.knownGroupsFor(ef.owner);
    const g = groups.find((x) => x.id === groupId);
    if (!g) {
      await this.edit(chatId, ef.msgId,
        "🔒 You are not an admin of that group.",
        [[this.btn("🕘 Pick another group", "ed:lq"),
          this.btn("❌ Close", "ed:close")]]);
      return;
    }
    await this.edit(chatId, ef.msgId, "🕘 Loading the last quiz…");
    const res = await this.roomCall(groupId, "/lastquiz", {});
    if (!res.found || !(res.items || []).length) {
      ef.step = "lq_groups";
      await this.state.storage.put("editflow", ef);
      await this.edit(chatId, ef.msgId,
        `🕘 No quiz has been recorded in 👥 ${g.title || g.id} yet.\nRun a quiz in that group first — then its questions will appear here.`,
        [[this.btn("🕘 Pick another group", "ed:lq"),
          this.btn("❌ Close", "ed:close")]]);
      return;
    }
    ef.lq = {
      chatId: groupId, title: g.title || String(groupId),
      at: res.at || null, label: res.label || "", items: res.items,
    };
    ef.lqPage = 0;
    ef.step = "lq_list";
    await this.state.storage.put("editflow", ef);
    await this.renderLqList(chatId, ef);
  }

  async renderLqList(chatId, ef) {
    const lq = ef.lq;
    const items = lq?.items || [];
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    ef.lqPage = Math.min(ef.lqPage || 0, pages - 1);
    const when = lq?.at
      ? new Date(lq.at).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata", day: "numeric", month: "short",
          hour: "numeric", minute: "2-digit" })
      : "";
    const rows = items
      .slice(ef.lqPage * PAGE_SIZE, (ef.lqPage + 1) * PAGE_SIZE)
      .map((it, k) => {
        const n = ef.lqPage * PAGE_SIZE + k;
        return [this.btn(`${n + 1}. ${String(it.q || "").slice(0, 38)}`,
          `ed:lqq:${n}`)];
      });
    const nav = [];
    if (ef.lqPage > 0) nav.push(this.btn("⬅️ Prev", `ed:lqp:${ef.lqPage - 1}`));
    if (ef.lqPage < pages - 1) {
      nav.push(this.btn("Next ➡️", `ed:lqp:${ef.lqPage + 1}`));
    }
    if (nav.length) rows.push(nav);
    rows.push([this.btn("🕘 Groups", "ed:lq"),
               this.btn("❌ Close", "ed:close")]);
    await this.edit(chatId, ef.msgId,
      `🕘 Last quiz in 👥 ${lq.title}\n${lq.label}${when ? ` · ${when}` : ""} · ${items.length} question(s)\nTap a question to edit it:`,
      rows);
  }

  async editorOpen(chatId, ef, entry) {
    const items = await fetchPart(entry.part);
    const item = items[entry.idx];
    if (!item || item.i !== entry.i) {
      await this.edit(chatId, ef.msgId,
        "⚠️ That question could not be loaded. Please search again.",
        [[this.btn("🔍 Search again", "ed:new"),
          this.btn("❌ Close", "ed:close")]]);
      return;
    }
    const clone = (o) => JSON.parse(JSON.stringify(o));
    ef.qid = item.i;
    ef.orig = {
      q: item.q, options: clone(item.options),
      answer: item.answer, e: item.e || "",
    };
    ef.draft = clone(ef.orig);
    ef.step = "card";
    ef.warn = "";
    await this.state.storage.put("editflow", ef);
    await this.renderEditorCard(chatId, ef);
  }

  editorChanged(ef) {
    const a = ef.orig, b = ef.draft;
    if (!a || !b) return false;
    return a.q !== b.q || a.answer !== b.answer ||
      (a.e || "") !== (b.e || "") ||
      "ABCD".split("").some((L) => (a.options[L] || "") !== (b.options[L] || ""));
  }

  async renderEditorCard(chatId, ef) {
    const index = await loadIndex();
    const d = ef.draft;
    const changed = this.editorChanged(ef);
    const mark = (cond) => (cond ? " ●" : "");
    const lines = [`✏️ Editing [${ef.qid}]`];
    if (ef.ci !== null && ef.ci !== undefined) {
      lines.push(`📚 ${index.chapter_titles[ef.ci] || ""}`);
    }
    lines.push("", `Q${mark(d.q !== ef.orig.q)}: ${String(d.q).slice(0, 1200)}`, "");
    for (const L of ["A", "B", "C", "D"]) {
      lines.push(`${L}) ${d.options[L] || ""}${d.answer === L ? " ✅" : ""}${mark(d.options[L] !== ef.orig.options[L])}`);
    }
    if (d.answer !== ef.orig.answer) lines.push("🎯 Answer changed ●");
    lines.push("",
      `💡 ${(d.e || "(no explanation)").slice(0, 160)}${(d.e || "").length > 160 ? "…" : ""}${mark((d.e || "") !== (ef.orig.e || ""))}`);
    if (ef.warn) lines.push("", `⚠️ ${ef.warn}`);
    lines.push("", changed
      ? "● = changed — tap 💾 SAVE to make it live."
      : "No changes yet — tap a ✏️ button to edit, 🎯 to set the answer.");
    const rows = [
      [this.btn("✏️ Question", "ed:q"), this.btn("✏️ Explanation", "ed:e")],
      [this.btn("✏️ A", "ed:o:A"), this.btn("✏️ B", "ed:o:B"),
       this.btn("✏️ C", "ed:o:C"), this.btn("✏️ D", "ed:o:D")],
      ["A", "B", "C", "D"].map((L) =>
        this.btn(d.answer === L ? `✅ Ans ${L}` : `🎯 Ans ${L}`, `ed:a:${L}`)),
      [this.btn("💾 SAVE", "ed:save"), this.btn("↩️ Reset", "ed:reset")],
      ef.lq
        ? [this.btn("🕘 Last Quiz list", "ed:lql"),
           this.btn("🔍 New search", "ed:new"),
           this.btn("❌ Close", "ed:close")]
        : [this.btn("🔍 New search", "ed:new"),
           this.btn("❌ Close", "ed:close")],
    ];
    await this.edit(chatId, ef.msgId, lines.join("\n"), rows);
  }

  async editorPrompt(chatId, ef, field, label, current) {
    ef.step = "await_text";
    ef.field = field;
    await this.state.storage.put("editflow", ef);
    await this.edit(chatId, ef.msgId,
      `✏️ Send the new text for ${label}.\n\nCurrent:\n${String(current).slice(0, 900)}\n\n(Your next message will replace it.)`,
      [[this.btn("↩️ Back to question", "ed:card"),
        this.btn("❌ Close", "ed:close")]]);
  }

  async editorHandleText(chatId, ef, text) {
    if (ef.step === "await_query") {
      await this.editorSearch(chatId, ef, text);
      return;
    }
    if (ef.step === "await_text") {
      const v = text.trim();
      if (!v) return;
      ef.warn = "";
      if (ef.field === "q") ef.draft.q = v;
      else if (ef.field === "e") ef.draft.e = v;
      else if (ef.field && ef.field.startsWith("o:")) {
        const L = ef.field.slice(2);
        ef.draft.options[L] = v;
        if (v.length > 100) {
          ef.warn = "That option is longer than 100 characters — Telegram polls will show it cut with …";
        }
      }
      ef.step = "card";
      ef.field = null;
      await this.state.storage.put("editflow", ef);
      await this.renderEditorCard(chatId, ef);
    }
  }

  async showEdits(chatId, userId) {
    const groups = await this.knownGroupsFor(userId);
    if (!groups.length) {
      await this.send(chatId, "🔒 Only for a group admin.");
      return;
    }
    const edits = await loadEdits(this.env);
    const ids = Object.keys(edits);
    if (!ids.length) {
      await this.send(chatId, "📤 No saved edits yet. Use /edit to fix a question.");
      return;
    }
    const rows = [[this.btn(`📤 Export all ${ids.length} edit(s) as file`, "ed:exp")]];
    ids.slice(0, 8).forEach((id) =>
      rows.push([this.btn(`↩️ Revert ${id}`, `ed:rev:${id}`)]));
    rows.push([this.btn("🧹 Clear ALL saved edits", "ed:clr")]);
    const lines = [
      `📤 Saved edits: ${ids.length} (live in the bot)`,
      "Export the file and send it for merging into the app bank — then clear them here.",
    ];
    ids.slice(0, 10).forEach((id) =>
      lines.push(`• ${id} — ${String(edits[id].q).slice(0, 44)}…`));
    await this.send(chatId, lines.join("\n"), rows);
  }

  async editorCallback(chatId, cq) {
    const data = cq.data || "";
    const userId = cq.from?.id;
    if (data === "ed:keep") { await this.answerCb(cq.id, "Kept 👍"); return; }
    if (data === "ed:exp" || data.startsWith("ed:rev:") ||
        data === "ed:clr" || data === "ed:clrok") {
      const groups = userId ? await this.knownGroupsFor(userId) : [];
      if (!groups.length) {
        await this.answerCb(cq.id, "🔒 Only for a group admin.");
        return;
      }
      const edits = await loadEdits(this.env);
      if (data === "ed:exp") {
        const payload = JSON.stringify({
          exported_at: new Date().toISOString(),
          count: Object.keys(edits).length, edits,
        }, null, 1);
        await this.sendDocument(chatId, "radequiz-edits.json", payload,
          "📤 RADEQuiz saved question edits — send this file for merging into the app bank.");
        await this.answerCb(cq.id, "File sent 📤");
        return;
      }
      if (data.startsWith("ed:rev:")) {
        const id = data.slice(7);
        if (edits[id]) {
          delete edits[id];
          await this.env.KV.put("edits_all", JSON.stringify(edits));
        }
        await this.answerCb(cq.id, `↩️ Edit removed: ${id}`);
        await this.send(chatId,
          `↩️ Edit for ${id} removed — the bank version will be used again.`);
        return;
      }
      if (data === "ed:clr") {
        await this.edit(chatId, cq.message.message_id,
          `🧹 Delete ALL ${Object.keys(edits).length} saved edits?\nOnly do this after they have been merged into the app bank.`,
          [[this.btn("✅ Yes, clear all", "ed:clrok"),
            this.btn("❌ Keep them", "ed:keep")]]);
        return;
      }
      if (data === "ed:clrok") {
        await this.env.KV.put("edits_all", "{}");
        await this.edit(chatId, cq.message.message_id,
          "🧹 All saved edits cleared.");
        return;
      }
    }
    const ef = await this.state.storage.get("editflow");
    if (!ef) {
      await this.answerCb(cq.id, "Editor is closed. Send /edit to start.");
      return;
    }
    if (userId !== ef.owner) {
      await this.answerCb(cq.id, "🔒 This editor belongs to another admin.");
      return;
    }
    if (data === "ed:close") {
      await this.state.storage.delete("editflow");
      await this.edit(chatId, ef.msgId, "✏️ Editor closed.");
      await this.answerCb(cq.id);
      return;
    }
    if (data === "ed:new") {
      ef.step = "await_query"; ef.draft = null; ef.qid = null; ef.results = [];
      await this.state.storage.put("editflow", ef);
      await this.edit(chatId, ef.msgId,
        "✏️ Question Editor\nType some words from the question:",
        [[this.btn("🕘 Last Quiz Questions", "ed:lq")],
         [this.btn("❌ Close editor", "ed:close")]]);
      await this.answerCb(cq.id);
      return;
    }
    if (data === "ed:lq") {
      await this.editorLqGroups(chatId, ef);
      await this.answerCb(cq.id);
      return;
    }
    if (data.startsWith("ed:lqg:")) {
      await this.editorLqOpen(chatId, ef, parseInt(data.slice(7), 10));
      await this.answerCb(cq.id);
      return;
    }
    if (data.startsWith("ed:lqp:")) {
      if (!ef.lq) {
        await this.answerCb(cq.id, "Open a group's last quiz first.");
        return;
      }
      ef.lqPage = parseInt(data.slice(7), 10);
      ef.step = "lq_list";
      await this.state.storage.put("editflow", ef);
      await this.renderLqList(chatId, ef);
      await this.answerCb(cq.id);
      return;
    }
    if (data === "ed:lql") {
      if (!ef.lq) {
        await this.answerCb(cq.id, "Open a group's last quiz first.");
        return;
      }
      ef.step = "lq_list"; ef.draft = null; ef.qid = null;
      await this.state.storage.put("editflow", ef);
      await this.renderLqList(chatId, ef);
      await this.answerCb(cq.id);
      return;
    }
    if (data.startsWith("ed:lqq:")) {
      const entry = (ef.lq?.items || [])[parseInt(data.slice(7), 10)];
      if (!entry) {
        await this.answerCb(cq.id, "That question is gone — open the list again.");
        return;
      }
      ef.ci = entry.part ? parseInt(entry.part.split("-")[1], 10) : null;
      await this.state.storage.put("editflow", ef);
      await this.editorOpen(chatId, ef, entry);
      await this.answerCb(cq.id);
      return;
    }
    if (data.startsWith("ed:pick:")) {
      const entry = (ef.results || [])[parseInt(data.slice(8), 10)];
      if (!entry) {
        await this.answerCb(cq.id, "That result is gone — search again.");
        return;
      }
      ef.ci = parseInt(entry.part.split("-")[1], 10);
      await this.state.storage.put("editflow", ef);
      await this.editorOpen(chatId, ef, entry);
      await this.answerCb(cq.id);
      return;
    }
    if (!ef.draft) { await this.answerCb(cq.id, "Pick a question first."); return; }
    if (data === "ed:card") {
      ef.step = "card";
      await this.state.storage.put("editflow", ef);
      await this.renderEditorCard(chatId, ef);
      await this.answerCb(cq.id);
      return;
    }
    if (data === "ed:q") {
      await this.editorPrompt(chatId, ef, "q", "the QUESTION", ef.draft.q);
      await this.answerCb(cq.id);
      return;
    }
    if (data === "ed:e") {
      await this.editorPrompt(chatId, ef, "e", "the EXPLANATION", ef.draft.e || "(none)");
      await this.answerCb(cq.id);
      return;
    }
    if (data.startsWith("ed:o:")) {
      const L = data.slice(5);
      await this.editorPrompt(chatId, ef, `o:${L}`, `OPTION ${L}`, ef.draft.options[L] || "");
      await this.answerCb(cq.id);
      return;
    }
    if (data.startsWith("ed:a:")) {
      ef.draft.answer = data.slice(5);
      await this.state.storage.put("editflow", ef);
      await this.renderEditorCard(chatId, ef);
      await this.answerCb(cq.id, `🎯 Answer set to ${ef.draft.answer}`);
      return;
    }
    if (data === "ed:reset") {
      ef.draft = JSON.parse(JSON.stringify(ef.orig));
      ef.warn = "";
      await this.state.storage.put("editflow", ef);
      await this.renderEditorCard(chatId, ef);
      await this.answerCb(cq.id, "↩️ Changes reset");
      return;
    }
    if (data === "ed:save") {
      if (!this.editorChanged(ef)) {
        await this.answerCb(cq.id, "Nothing changed yet.");
        return;
      }
      const edits = await loadEdits(this.env);
      edits[ef.qid] = {
        q: ef.draft.q, options: ef.draft.options, answer: ef.draft.answer,
        e: ef.draft.e || "", orig: ef.orig, by: ef.owner, at: Date.now(),
      };
      await this.env.KV.put("edits_all", JSON.stringify(edits));
      const qid = ef.qid;
      await this.state.storage.delete("editflow");
      await this.edit(chatId, ef.msgId,
        `✅ Saved! [${qid}]\nThe corrected question is live in the bot from the next quiz.\n📤 Use /edits anytime to export all saved edits for merging into the app.`);
      await this.answerCb(cq.id, "✅ Saved");
      return;
    }
    await this.answerCb(cq.id);
  }

  async isAdmin(chatId, userId) {
    if (userId === ANON_ADMIN_ID) return true; // anonymous admin of this chat
    const key = `admin:${userId}`;
    const cached = await this.state.storage.get(key);
    if (cached && Date.now() - cached[1] < 10 * 60 * 1000) return cached[0];
    let ok = false;
    try {
      const m = await this.call("getChatMember", {
        chat_id: chatId, user_id: userId,
      });
      ok = ["creator", "administrator"].includes(m.status);
    } catch (e) { ok = false; }
    await this.state.storage.put(key, [ok, Date.now()]);
    return ok;
  }

  // ------------------------------------------------------------ routing
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      const body = await request.json();
      if (path === "/message") await this.onMessage(body);
      else if (path === "/callback") await this.onCallback(body);
      else if (path === "/poll_answer") await this.onPollAnswer(body);
      else if (path === "/state") {
        return Response.json({
          askedCounts: (await this.state.storage.get("askedCounts")) || {},
          lastSelection: ((await this.state.storage.get("meta")) || {})
            .lastSelection || null,
        });
      } else if (path === "/start") {
        return Response.json(await this.remoteStart(body));
      } else if (path === "/askedfor") {
        const out = {};
        for (const p of body.parts || []) {
          out[p] = (await this.state.storage.get(`asked:${p}`)) || [];
        }
        return Response.json(out);
      } else if (path === "/lastquiz") {
        // The DM question editor reads the group's most recent quiz
        // (recorded by startSession) through this route.
        const lq = await this.state.storage.get("lastQuiz");
        return Response.json(lq && (lq.items || []).length
          ? { found: true, at: lq.at, label: lq.label, items: lq.items }
          : { found: false });
      } else if (path === "/auto") {
        const cfg = (await this.state.storage.get("autoCfg")) || {};
        const session = await this.state.storage.get("session");
        return Response.json({ on: !!cfg.on, running: !!session });
      }
    } catch (e) {
      console.log("room error:", e.message);
    }
    return new Response("ok");
  }

  // Call another chat's room (used by the private DM setup to read a group's
  // state and to start a quiz inside that group).
  async roomCall(chatId, path, payload) {
    const stub = this.env.QUIZ.get(this.env.QUIZ.idFromName(String(chatId)));
    const r = await stub.fetch(`https://do${path}`, {
      method: "POST", body: JSON.stringify(payload || {}),
    });
    return r.json().catch(() => ({}));
  }

  // Start a quiz in THIS room's chat on behalf of the private DM setup.
  async remoteStart(p) {
    const session = await this.state.storage.get("session");
    if (session) return { ok: false, reason: "running" };
    if (p.saveLast) {
      const meta = (await this.state.storage.get("meta")) || {};
      meta.lastSelection = {
        subject: p.subject, chapter: p.chapter, count: p.count,
        seconds: p.seconds, label: p.label, mode: p.mode || "all",
        plan: p.plan || null,
      };
      await this.state.storage.put("meta", meta);
    }
    await this.startSession(p.chatId, p.label, p.subject, p.chapter,
      p.count, p.seconds, p.mode || "all", p.plan || null);
    const now = await this.state.storage.get("session");
    return { ok: !!now, reason: now ? "" : "empty" };
  }

  // DM setup: launch the chosen quiz inside the target group and report back.
  async dmLaunch(chatId, flow, sel) {
    const res = await this.roomCall(flow.targetChatId, "/start", {
      chatId: flow.targetChatId, label: sel.label, subject: sel.subject,
      chapter: sel.chapter, count: sel.count, seconds: sel.seconds,
      mode: sel.mode || "all", plan: sel.plan || null, saveLast: true,
    });
    await this.state.storage.delete("flow");
    if (res.ok) {
      await this.edit(chatId, flow.messageId,
        `✅ Quiz started in 👥 ${flow.targetTitle} — ${sel.label}\nThe questions are now running in the group.`);
    } else if (res.reason === "running") {
      await this.edit(chatId, flow.messageId,
        "⏳ A quiz is already running in that group. Wait for it to finish, or stop it with /stop inside the group.");
    } else {
      await this.edit(chatId, flow.messageId,
        "⚠️ No questions available for this selection.");
    }
    return res;
  }

  async knownGroupsFor(userId) {
    let groups = {};
    try {
      groups = JSON.parse((await this.env.KV.get("groups")) || "{}");
    } catch (e) { /* no registry yet */ }
    const out = [];
    for (const [id, g] of Object.entries(groups)) {
      if (await this.isAdmin(Number(id), userId)) {
        out.push({ id: Number(id), title: g.title || "" });
      }
    }
    return out;
  }

  async startDmFlow(chatId, userId) {
    await this.state.storage.delete("editflow");
    const groups = await this.knownGroupsFor(userId);
    if (!groups.length) {
      const akaza = (await this.flavor()) === "akaza";
      await this.send(chatId, akaza
        ? "No group found yet.\n1) Make @akazaquizbot an admin in your group.\n2) Send /maheshping once inside the group.\n3) Then send /quiz here again."
        : "No group found yet.\n1) Make @RADEQuizbot an admin in your group.\n2) Send /ping once inside the group.\n3) Then send /quiz here again.");
      return;
    }
    const flow = {
      owner: userId, step: "groups", messageId: null, dm: true,
      targetChatId: null, targetTitle: "", targetState: null,
      subject: null, chapter: null, page: 0, count: null, seconds: null,
      mode: null,
    };
    const rows = groups.map((g) => [this.btn(`👥 ${g.title || g.id}`, `grp:${g.id}`)]);
    rows.push([this.btn("❌ Cancel", "cancel")]);
    const sent = await this.send(chatId,
      "🔒 Private Quiz Setup\nFirst choose the group for this quiz:", rows);
    flow.messageId = sent.message_id;
    await this.state.storage.put("flow", flow);
  }

  // Mahesh Q&A (Akaza only, user orders 2026-11-07): when someone asks
  // Mahesh a question — in a group by saying "mahesh" or replying to
  // the bot, in DM by simply asking — he answers FIRST from the
  // detailed-notes facts (the user's own tables book, bank/notes.json)
  // when a fact precisely fits, else from the MCQ bank's keyed answers
  // when they agree confidently. If neither source is confident, he
  // deflects with the user's exact line instead of guessing. Returns
  // true when the message was handled here (the caller then skips the
  // roast); non-questions return false so the roast still fires.
  async maybeAnswer(msg) {
    if ((await this.flavor()) !== "akaza") return false;
    const raw0 = (msg.text || "").trim();
    if (!raw0 || raw0.startsWith("/")) return false;
    if (msg.from?.is_bot) return false;
    const chatType = msg.chat?.type || "";
    const isGroup = chatType === "group" || chatType === "supergroup";
    if (isGroup) {
      const rt = msg.reply_to_message?.from || null;
      let replyToBot = false;
      if (rt?.is_bot && rt.username) {
        const cfg = await getConfig(this.env).catch(() => null);
        replyToBot = !!cfg?.username &&
          rt.username.toLowerCase() === String(cfg.username).toLowerCase();
      }
      if (!/\bmahesh\b/i.test(raw0) && !replyToBot) return false;
    }
    const rawToks = qaToks(raw0.replace(/\bmahesh\b/gi, " "));
    const ct = rawToks.filter((t) => !QA_STOP.has(t) && t.length >= 2);
    if (!ct.length) return false;
    const questionLike = raw0.includes("?") || ct.length >= 2 ||
      rawToks.some((t) => QA_QWORDS.has(t));
    if (!questionLike) return false;
    const FALLBACK = "Pata nai bhai, Piyush se puch le ya Google me dekh le";
    const reply = async (text) => {
      try {
        await this.call("sendMessage", {
          chat_id: msg.chat.id, text,
          reply_parameters: { message_id: msg.message_id },
        });
      } catch (e) { /* best-effort */ }
      return true;
    };
    const yearCue = rawToks.some((t) =>
      ["total", "saal", "sal", "varsh", "annual", "salana"].includes(t) ||
      t.startsWith("year"));
    const monthCue = rawToks.some((t) =>
      ["mahina", "mahine"].includes(t) || t.startsWith("month"));
    const qtyIntent = rawToks.some((t) =>
      ["kitna", "kitne", "kitni"].includes(t)) ||
      /\bhow (many|much)\b/i.test(raw0);
    const formIntent = rawToks.some((t) =>
      ["matlab", "form", "stands"].includes(t)) || /full form/i.test(raw0);
    const listIntent = rawToks.some((t) =>
      ["kaun", "list", "naam", "name", "names", "sab", "batao", "bata"]
        .includes(t)) || /\bhow many\b/i.test(raw0);
    const prodIntent = rawToks.some((t) =>
      ["banata", "banati", "banta", "produces", "produce", "manufactures"]
        .includes(t));
    const locIntent = rawToks.some((t) =>
      ["kahan", "where", "sthit", "located"].includes(t));
    const defIntent =
      /what is|what's|kya hai|kya hota|kya hoti|matlab|meaning|define/i
        .test(raw0) ||
      (ct.length <= 3 && !qtyIntent && !listIntent && !prodIntent &&
        !locIntent);
    // ---- Layer 1: the detailed-notes facts (the user's own book).
    // A precise fact from the notes beats any MCQ-bank inference.
    try {
      const { facts, byToken: nBy } = await loadNotesFacts();
      const hit = qaNotesSearch(facts, nBy, ct,
        { qtyIntent, yearCue, listIntent, prodIntent, locIntent, defIntent });
      if (hit) {
        // Definition-style questions ("what is limited tender", a
        // bare "LAP?") get the fact's WHOLE row — definition, notice
        // period, key facts — quantity aspects first, Rule No. last.
        // Still no chapter/table framing (user order 2026-11-08).
        if (defIntent && hit[1] !== "List") {
          const sibs = facts.filter((f) =>
            f[0] === hit[0] && f[4] === hit[4] && f[1] !== "List");
          if (sibs.length >= 2) {
            const rank = (a) => (/^rule no/i.test(a) ? 2
              : QA_ASPECT_QTY.test(a) ? 0 : 1);
            const ordered = [...sibs]
              .sort((x, y) => rank(x[1]) - rank(y[1]));
            const lines = [];
            for (const s of ordered) {
              if (/^(N\/A|—|-)/.test(s[2])) continue;
              lines.push(s[1] ? `${s[1]}: ${s[2]}` : s[2]);
            }
            let text = lines.join("\n");
            if (text.length > 1400) text = text.slice(0, 1399) + "…";
            if (text) return reply(text);
          }
        }
        // The answer only (user order 2026-11-08): no chapter name,
        // no table or label framing — just the fact's own details.
        // List facts keep room for the full list.
        const cap = hit[1] === "List" ? 950 : 600;
        const val = hit[2].length > cap
          ? hit[2].slice(0, cap - 1) + "…" : hit[2];
        return reply(val);
      }
    } catch (e) { /* notes unavailable — the bank layer still answers */ }
    // ---- Layer 2: the MCQ question bank.
    let sidx, byToken;
    try {
      ({ sidx, byToken } = await loadQaMap());
    } catch (e) { return reply(FALLBACK); }
    // Candidates: postings union over the content tokens, their
    // prefix family, and their spelled-out expansion words.
    const cand = new Set();
    for (const t of new Set(ct)) {
      if (byToken.has(t)) for (const n of byToken.get(t)) cand.add(n);
      if (t.length >= 4) {
        for (const [k, v] of byToken) {
          if (k.startsWith(t)) for (const n of v) cand.add(n);
        }
      }
      const phr = QA_EXP[t];
      if (phr) {
        for (const p of phr) {
          for (const x of p) {
            if (byToken.has(x)) for (const n of byToken.get(x)) cand.add(n);
          }
        }
      }
    }
    // Nothing in the whole bank shares these words — it was never an
    // exam question, so this is not Q&A territory at all: let the
    // roast handle it. The deflection line is only for questions that
    // reached the library but found no confident answer.
    if (!cand.size) return false;
    let bestCov = 0;
    const scored = [];
    for (const n of cand) {
      const stemSet = new Set(qaToks(sidx[n][3]));
      const m = ct.filter((t) => qaTokenHit(t, stemSet)).length;
      const cov = m / ct.length;
      if (cov >= 0.6) {
        scored.push({ n, cov, stemSet });
        if (cov > bestCov) bestCov = cov;
      }
    }
    if (!scored.length || (ct.length === 1 && bestCov < 1)) {
      return reply(FALLBACK);
    }
    let tier = scored.filter((s) => s.cov === bestCov).map((s) => {
      let bonus = 0;
      const hasCue = (words) => [...s.stemSet].some((x) =>
        words.some((w) => x === w || x.startsWith(w)));
      if (yearCue && hasCue(["year", "annum", "annual"])) bonus += 1;
      if (monthCue && hasCue(["month"])) bonus += 1;
      if (formIntent && (s.stemSet.has("form") || s.stemSet.has("stands") ||
          s.stemSet.has("means"))) bonus += 1;
      return { n: s.n, bonus, stemLen: sidx[s.n][3].length };
    });
    const bestBonus = Math.max(...tier.map((s) => s.bonus));
    tier = tier.filter((s) => s.bonus === bestBonus);
    tier.sort((a, b) => a.stemLen - b.stemLen);
    tier = tier.slice(0, 60);
    // Fetch the keyed answers (editor edits overlay wins, as in quizzes).
    const edits = await loadEdits(this.env).catch(() => ({}));
    const partCache = new Map();
    const getItem = async (e) => {
      if (!partCache.has(e[1])) {
        if (partCache.size > 10) partCache.clear();
        partCache.set(e[1], await fetchPart(e[1]).catch(() => []));
      }
      const it = (partCache.get(e[1]) || [])[e[2]];
      if (!it) return null;
      const ed = edits[e[0]];
      const src = ed || it;
      const o = src.options || {};
      const opts = Array.isArray(o)
        ? o.map(String)
        : Object.keys(o).sort().map((k) => String(o[k]));
      const ai = "ABCD".indexOf(src.answer);
      if (ai < 0 || !opts[ai]) return null;
      return { stem: ed ? ed.q || it.q : it.q, answer: opts[ai] };
    };
    let items = [];
    for (const s of tier) {
      const it = await getItem(sidx[s.n]);
      if (it) items.push(it);
    }
    if (!items.length) return reply(FALLBACK);
    if (qtyIntent && !formIntent) {
      const digi = items.filter((it) => /\d/.test(it.answer));
      if (digi.length >= 3) items = digi;
    }
    // Answer variants of the same fact are grouped by a stripped core:
    // brackets, option-letter prefixes and unit words removed, so
    // "30", "30 days" and "c) 30 days" vote together.
    const coreOf = (a) => a.toLowerCase().replace(/\(.*?\)/g, " ")
      .replace(/^\s*\(?\s*[a-d]\s*[).]\s*/, "").trim().replace(/\.$/, "")
      .replace(/\b(days?|years?|months?|percent|percentage|rs\.?|rupees)\b/g, "")
      .replace(/%/g, "").replace(/\s+/g, " ").trim();
    const groups = new Map();
    for (const it of items) {
      const c = coreOf(it.answer);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(it);
    }
    const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
    const top = ranked[0];
    const runner = ranked[1] ? ranked[1].length : 0;
    const share = top.length / items.length;
    const confident = ranked.length === 1 ||
      (share >= 0.6 && top.length >= 2) ||
      (share >= 0.4 && top.length >= 5 && top.length >= 2 * runner) ||
      (share >= 0.3 && top.length >= 12 && top.length >= 2.5 * runner &&
        (yearCue || monthCue || formIntent));
    if (!confident) return reply(FALLBACK);
    // Display: the group's most frequent exact wording; a bare number
    // borrows the unit from a sibling variant when one is common.
    const freq = new Map();
    for (const it of top) freq.set(it.answer, (freq.get(it.answer) || 0) + 1);
    let disp = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    if (/^\d+(\.\d+)?$/.test(disp.trim())) {
      const withUnit = [...freq.entries()]
        .filter(([a]) => /^\d/.test(a) &&
          /[a-z%]/i.test(a.replace(/^\d+(\.\d+)?/, "")))
        .sort((a, b) => b[1] - a[1])[0];
      if (withUnit && withUnit[1] >= freq.get(disp) / 2) disp = withUnit[0];
    }
    if (/\d/.test(disp)) {
      disp = disp.replace(/^\s*\(?\s*[a-d]\s*[).]\s*/i, "");
    }
    const cueWord = yearCue ? /(year|annum|annual)/i
      : monthCue ? /(month|monthly)/i : null;
    const rep = (cueWord
      ? top.find((it) => cueWord.test(it.stem)) : null) ||
      top.reduce((a, b) => (b.stem.length < a.stem.length ? b : a));
    const stem = rep.stem.length > 140
      ? rep.stem.slice(0, 139) + "…" : rep.stem;
    return reply(`📝 ${stem}\n✅ Jawab: ${disp}`);
  }

  // Akaza-only study roast (user's exact words, 2026-11-05): a plain
  // spoken message — not a command, not input a flow is waiting for —
  // gets a reply. The first one per person in a room differs; every
  // later message gets the second line. Main bot never does this.
  // Group rule (user-approved 2026-11-06): in groups the roast fires
  // ONLY when the message contains the word "mahesh" (no @tag needed);
  // other group chatter is ignored and does not advance the count.
  // DM behaviour is unchanged: any plain text roasts.
  // Trigger widened (user order 2026-11-06 evening): in groups the
  // roast ALSO fires when the message is a reply to this bot's own
  // message, or a reply to a message sent by a person named Mahesh
  // (first/last name or username contains "mahesh"). The roast always
  // lands on the sender of the triggering message.
  async maybeRoast(msg) {
    if ((await this.flavor()) !== "akaza") return;
    const raw = (msg.text || "").trim();
    if (!raw || raw.startsWith("/")) return;
    if (msg.from?.is_bot) return;
    const chatType = msg.chat?.type || "";
    if (chatType === "group" || chatType === "supergroup") {
      const rt = msg.reply_to_message?.from || null;
      const rtName = rt
        ? [rt.first_name, rt.last_name, rt.username].filter(Boolean).join(" ")
        : "";
      let replyToBot = false;
      if (rt?.is_bot && rt.username) {
        const cfg = await getConfig(this.env).catch(() => null);
        replyToBot = !!cfg?.username &&
          rt.username.toLowerCase() === String(cfg.username).toLowerCase();
      }
      const triggered = /\bmahesh\b/i.test(raw) || /mahesh/i.test(rtName) ||
        replyToBot;
      if (!triggered) return;
    }
    const sender = effectiveSenderId(msg);
    if (!sender) return;
    const counts = (await this.state.storage.get("roast")) || {};
    const n = (counts[sender] || 0) + 1;
    counts[sender] = n;
    await this.state.storage.put("roast", counts);
    // Variety rule (user order 2026-11-06 evening, refined same night):
    // replies after the first come from a gaali pool picked PURELY at
    // random — a line may repeat, but only by chance, never in a fixed
    // cycle. Every line must carry a gaali.
    let text;
    if (n === 1) {
      text = "Bhag Madarchod Ja Padhai kar";
    } else {
      const POOL = [
        "Bhag Bhosdi ke",
        "Madarchod, kitab khol — bakchodi band kar",
        "Chutiye, ja padhai kar — yahan time barbaad mat kar",
        "Behenchod, phir aa gaya? Jaake notes padh",
        "Gaandu, selection padhai se hoga, bakaiti se nahi — chal padh",
        "Harami, syllabus pada hai poora — ja use khatam kar, bhosdi ke",
        "Kutte, phone ghumana band kar, kitab ghumaa bhosdi ke",
        "Bhosdi ke, rank chahiye to padh — warna nikal yahan se",
        "Madarchod, tera hi nuksaan hai — ja padhai kar",
        "Chutiya, bakchodi kam, padhai zyada — chal shuru ho ja",
        "Behenchod, aaj ka target poora kar pehle, phir aana",
        "Saale bhosdi ke, jaake revise kar — exam paas aa raha hai",
        "Koi fir se aa gaya madarchod",
        "Ye fir aa gaya bhosdi ke",
        "Dekho, madarchod fir haazir hai",
        "Fir se aa gaya chutiya",
        "Aa gaya behenchod dobara",
        "Madarchod ko chain nahi hai, fir aa gaya",
      ];
      text = POOL[Math.floor(Math.random() * POOL.length)];
    }
    // Name rule (user-ruled 2026-11-07): the name is taken ONLY on a
    // person's first-ever roast, placed at the very end of the line
    // with no comma — "Bhag Madarchod Ja Padhai kar Sunil". Every
    // later reply is the plain pool line, no name.
    if (n === 1) {
      const nm = (msg.from?.first_name || msg.sender_chat?.title ||
        msg.from?.username || "").replace(/\s+/g, " ").trim().slice(0, 30);
      if (nm) text = `${text} ${nm}`;
    }
    try {
      await this.call("sendMessage", {
        chat_id: msg.chat.id,
        text,
        reply_parameters: { message_id: msg.message_id },
      });
    } catch (e) { /* original message may be gone; roast is best-effort */ }
  }

  // Akaza-only new-member greeting (user's exact line, 2026-11-06):
  // when a new member joins the group, the bot announces them in
  // Mahesh style. One line per join event, only for human members,
  // and never for the bot itself being added.
  async maybeJoinRoast(msg) {
    if ((await this.flavor()) !== "akaza") return;
    const chatType = msg.chat?.type || "";
    if (chatType !== "group" && chatType !== "supergroup") return;
    const cfg = await getConfig(this.env).catch(() => null);
    const humans = (msg.new_chat_members || []).filter((u) =>
      !u.is_bot &&
      (!cfg?.username || (u.username || "").toLowerCase() !==
        String(cfg.username).toLowerCase()));
    if (!humans.length) return;
    // Name rule (user order 2026-11-07): the greeting names the new
    // member(s) — "Ek aur dalla aa gaya group me — Ravi".
    const names = humans
      .map((u) => (u.first_name || u.username || "")
        .replace(/\s+/g, " ").trim().slice(0, 30))
      .filter(Boolean);
    const text = "Ek aur dalla aa gaya group me" +
      (names.length ? ` — ${names.join(", ")}` : "");
    try {
      await this.call("sendMessage", {
        chat_id: msg.chat.id,
        text,
        reply_parameters: { message_id: msg.message_id },
      });
    } catch (e) { /* join message may be gone; greeting is best-effort */ }
  }

  async onMessage(msg) {
    const chatId = msg.chat.id;
    if (msg.new_chat_members?.length) {
      await this.maybeJoinRoast(msg);
      return;
    }
    const text = (msg.text || "").split("@")[0].trim();
    const sender = effectiveSenderId(msg);
    if (msg.chat.type === "private") {
      const ef0 = await this.state.storage.get("editflow");
      if (ef0 && sender && ef0.owner === sender && !text.startsWith("/") &&
          (ef0.step === "await_query" || ef0.step === "await_text")) {
        await this.editorHandleText(chatId, ef0, text);
        return;
      }
      const flow0 = await this.state.storage.get("flow");
      if (flow0 && flow0.step === "kwinput" && sender &&
          flow0.owner === sender && !text.startsWith("/")) {
        await this.keywordAccept(chatId, flow0, text);
        return;
      }
      if ((text === "/edit" || text === "/maheshedit") && sender) {
        await this.startEditor(chatId, sender);
        return;
      }
      if (text === "/edits" && sender) {
        await this.showEdits(chatId, sender);
        return;
      }
      if ((text === "/quiz" || text === "/start" || text === "/maheshquiz") && sender) {
        await this.startDmFlow(chatId, sender);
      } else if (text === "/stop" || text === "/score" ||
                 text === "/maheshstop" || text === "/maheshscore" ||
                 text.split(" ")[0] === "/autoquiz" ||
                 text.split(" ")[0] === "/maheshauto") {
        await this.send(chatId, "ℹ️ Please use this command inside the group.");
      } else {
        if (!(await this.maybeAnswer(msg))) await this.maybeRoast(msg);
      }
      return;
    }
    const gflow = await this.state.storage.get("flow");
    if (gflow && gflow.step === "kwinput" && sender && !text.startsWith("/") &&
        await this.isAdmin(chatId, sender)) {
      await this.keywordAccept(chatId, gflow, text);
      return;
    }
    const flavor = await this.flavor();
    const quizCmd = flavor === "akaza" ? "/maheshquiz" : "/quiz";
    const stopCmd = flavor === "akaza" ? "/maheshstop" : "/stop";
    const scoreCmd = flavor === "akaza" ? "/maheshscore" : "/score";
    const autoCmd = flavor === "akaza" ? "/maheshauto" : "/autoquiz";
    if (text === quizCmd) {
      const session = await this.state.storage.get("session");
      if (session) {
        await this.send(chatId, "⏳ Quiz is already running — please wait for it to finish.");
      } else if (sender && await this.isAdmin(chatId, sender)) {
        await this.startFlow(chatId, sender);
      } else {
        await this.send(chatId, "🔒 Only a group admin can start a quiz.");
      }
    } else if (text === stopCmd) {
      const session = await this.state.storage.get("session");
      if (session && sender && await this.isAdmin(chatId, sender)) {
        session.stop = true;
        await this.state.storage.put("session", session);
        await this.send(chatId, "🛑 Stopping the quiz after this question…");
      } else if (session) {
        await this.send(chatId, "🔒 Only a group admin can stop the quiz.");
      }
    } else if (text === scoreCmd) {
      const totals = (await this.state.storage.get("scores")) || {};
      const vals = Object.values(totals);
      if (vals.length) {
        const ranked = vals
          .sort((a, b) => (ptsOf(b, true) - ptsOf(a, true)) || ((a[4] || 0) - (b[4] || 0)))
          .slice(0, 10);
        const lines = ["🏆 All-time Ranking (saved by the bot):", ""];
        ranked.forEach((t, i) => lines.push(`${i + 1}. ${t[0]} — ${fmtPts(t, true)} pts · ✅${t[1] || 0}   ❌${t[3] || 0} · ⏱ ${fmtTime(t[4] || 0)}`));
        await this.send(chatId, lines.join("\n"));
      } else {
        await this.send(chatId, "📊 No scores saved yet.");
      }
    } else if (flavor === "main" && (text === "/edit" || text === "/edits")) {
      await this.send(chatId, "✏️ Question editing is done in private — open the @RADEQuizbot chat and send /edit there.");
    } else if (flavor === "akaza" && text === "/maheshedit") {
      await this.send(chatId, "✏️ Question editing is done in private — open the @akazaquizbot chat and send /maheshedit there.");
    } else if (flavor === "main" && text === "/settings") {
      const cfg = (await this.state.storage.get("autoCfg")) || {};
      await this.send(chatId, "⚙️ RADEQuiz settings\n" +
        `🌙 9 PM Auto Quiz (syllabus rotation, 50 Q · 20 s): ${cfg.on ? "🟢 ON" : "🔴 OFF"}\n` +
        "Admin commands: /autoquiz on · /autoquiz off · /autoquiz test");
    } else if (text.split(" ")[0] === autoCmd) {
      if (!(sender && await this.isAdmin(chatId, sender))) {
        await this.send(chatId, "🔒 Only a group admin can change the auto quiz setting.");
        return;
      }
      const arg = (text.split(" ")[1] || "").toLowerCase();
      const cfg = (await this.state.storage.get("autoCfg")) || {};
      if (arg === "on") {
        cfg.on = true;
        await this.state.storage.put("autoCfg", cfg);
        await this.send(chatId, "🌙 9 PM Auto Quiz is now 🟢 ON — every night at 9:00 PM a 50-question quiz (20 s each) will start automatically.\n📚 Rotation: Mon Paper-I · Tue Paper-II · Wed Paper-III · Thu 🧩 Mix · Fri Paper-I · Sat Paper-II · Sun Paper-III.");
      } else if (arg === "off") {
        cfg.on = false;
        await this.state.storage.put("autoCfg", cfg);
        await this.send(chatId, "🌙 9 PM Auto Quiz is now 🔴 OFF.");
      } else if (arg === "test") {
        const session = await this.state.storage.get("session");
        if (session) {
          await this.send(chatId, "⏳ A quiz is already running — test skipped.");
          return;
        }
        await this.send(chatId, "🌙 Starting today's auto quiz now (test)…");
        const index = await loadIndex();
        const sel = autoSelection(index);
        await this.startSession(chatId, sel.label, null, null, sel.count,
          sel.seconds, sel.mode, sel.plan);
        const now = await this.state.storage.get("session");
        if (!now) {
          await this.startSession(chatId, sel.label, null, null, sel.count,
            sel.seconds, "all", sel.plan);
        }
      } else {
        const probe = autoSelection(await loadIndex());
        await this.send(chatId,
          `🌙 9 PM Auto Quiz: ${cfg.on ? "🟢 ON" : "🔴 OFF"}\n` +
          `Today's quiz would be: ${probe.label} — 50 Q · 20 s\n` +
          `Use ${autoCmd} on, ${autoCmd} off, or ${autoCmd} test.`);
      }
    }
    if (!(await this.maybeAnswer(msg))) await this.maybeRoast(msg);
  }

  // ------------------------------------------------------------ flow UI
  btn(text, data) { return { text, callback_data: data }; }

  subjectsKeyboard(meta) {
    const rows = [];
    if (meta.lastSelection) {
      const l = meta.lastSelection;
      const lbl = l.label.length > 42 ? l.label.slice(0, 41) + "…" : l.label;
      rows.push([this.btn(`🔁 Repeat Last: ${lbl} • ${l.count}Q • ${l.seconds}s`, "repeat")]);
    }
    rows.push([this.btn(`⚡ Default Quiz — Full Bank Random • ${DEFAULT_COUNT}Q • ${DEFAULT_SECONDS}s`, "default")]);
    return rows;
  }

  async subjectsKeyboardFull(meta, index) {
    const rows = this.subjectsKeyboard(meta);
    rows.push([this.btn("🧩 Mix Quiz — Syllabus-wise (combine topics)", "mx:open")]);
    rows.push([this.btn("🔑 Keyword Quiz — build from your own keyword", "kw:open")]);
    index.subjects.forEach((s, i) => {
      rows.push([this.btn(`${s.icon || "📚"} ${s.name} (${s.questions} Q)`, `sub:${i}`)]);
    });
    rows.push([this.btn("❌ Cancel", "cancel")]);
    return rows;
  }

  chaptersKeyboard(index, flow, counts = {}) {
    const s = index.subjects[flow.subject];
    // Hide chapters with 0 questions (section/divider chapters in the bank,
    // mostly in Appendix 3 and Archive) — they can never start a quiz.
    const chapters = s.chapters.filter((ci) => (index.chapter_counts[ci] || 0) > 0);
    const pages = Math.max(1, Math.ceil(chapters.length / PAGE_SIZE));
    flow.page = Math.min(flow.page || 0, pages - 1);
    const rows = [[this.btn(`🎲 All Topics of ${s.name} (Random)`, "top:all")]];
    for (const ci of chapters.slice(flow.page * PAGE_SIZE, (flow.page + 1) * PAGE_SIZE)) {
      let t = index.chapter_titles[ci];
      if (t.length > 32) t = t.slice(0, 31) + "…";
      const done = counts[ci] || 0;
      rows.push([this.btn(`${t} (${index.chapter_counts[ci]} Q${done ? ` · ✅${done} done` : ""})`, `top:${ci}`)]);
    }
    const nav = [];
    if (flow.page > 0) nav.push(this.btn("⬅️ Prev", `page:${flow.page - 1}`));
    if (flow.page < pages - 1) nav.push(this.btn("Next ➡️", `page:${flow.page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([this.btn("⬅️ Back to Subjects", "back:subjects"),
               this.btn("❌ Cancel", "cancel")]);
    return rows;
  }

  // --------------------------------------- keyword quiz helpers
  // Asked sets for a flow: own storage for the group flow, the target
  // group's storage (one batched /askedfor call, cached on the flow) for DM.
  async flowAskedSets(flow, parts) {
    const out = new Map();
    if (!flow.dm) {
      for (const p of parts) out.set(p, await this.askedSet(p));
      return out;
    }
    flow._askedCache = flow._askedCache || {};
    const missing = parts.filter((p) => !(p in flow._askedCache));
    if (missing.length && flow.targetChatId) {
      const res = await this.roomCall(flow.targetChatId, "/askedfor",
        { parts: missing });
      for (const p of missing) flow._askedCache[p] = res[p] || [];
    }
    for (const p of parts) out.set(p, new Set(flow._askedCache[p] || []));
    return out;
  }

  async kwDone(flow, entries) {
    const keys = kwUnion(entries);
    const parts = [...new Set(keys.map((k) => k.split("#")[0]))];
    const sets = await this.flowAskedSets(flow, parts);
    let done = 0;
    for (const k of keys) {
      const [p, i] = k.split("#");
      if (sets.get(p)?.has(parseInt(i, 10))) done++;
    }
    return { total: keys.length, done };
  }

  // Day-wise days scattered over too many part files are baked into
  // tgdays.json as full items (each carries _src = its bank key, so
  // asked-tracking and saved edits keep working). Resolve the day from
  // the index and hand its items over in order.
  async fetchDayInline(ref, edits) {
    const tg = await loadTgDays();
    const g = tg.groups[ref.gi];
    const mo = g && g.months.find((x) => x.m === ref.m);
    const dy = mo && mo.days.find((x) => x.d === ref.d);
    if (!dy || !dy.items) return [];
    return dy.items.map((q) => {
      const c = { ...q };
      if (c._src) {
        c._k = c._src;
        c._ci = parseInt(c._src.split("-")[1], 10);
        delete c._src;
      }
      if (edits && c.i && edits[c.i]) applyEdit(c, edits[c.i]);
      return c;
    });
  }

  // Fetch items in the EXACT key order (Day-wise replay): no shuffle,
  // no mode filter, no small part cap — a day's questions sit in a few
  // neighbouring part files and must come back same-to-same.
  async fetchByKeysOrdered(keys, edits) {
    const items = [];
    const fetched = new Map();
    for (const k of keys) {
      const hash = k.lastIndexOf("#");
      const part = k.slice(0, hash);
      const i = parseInt(k.slice(hash + 1), 10);
      if (!fetched.has(part)) {
        if (fetched.size >= 40) break;
        fetched.set(part, await fetchPart(part));
      }
      const q = fetched.get(part)[i];
      if (!q) continue;
      q._k = `${part}#${i}`;
      q._ci = parseInt(part.split("-")[1], 10);
      if (edits && q.i && edits[q.i]) applyEdit(q, edits[q.i]);
      items.push(q);
    }
    return items;
  }

  // Fetch items a keyword matched (by "part#index" keys), honouring the
  // New/Completed/All mode and saved edits. A broad keyword can match
  // questions in HUNDREDS of part files — fetching them all in one go
  // kills the start (subrequest limits), so: shuffle the keys first and
  // open at most MAX_PARTS_PER_QUIZ files, like fetchPool does.
  async fetchByKeys(keys, count, mode, askedOf, edits) {
    const shuffled = shuffle([...keys]);
    const want = Math.max(count * 3, count + 30);
    const items = [];
    const fetched = new Map();
    const askedCache = new Map();
    let fetches = 0;
    for (const k of shuffled) {
      if (items.length >= want) break;
      const hash = k.lastIndexOf("#");
      const part = k.slice(0, hash);
      const i = parseInt(k.slice(hash + 1), 10);
      if (!fetched.has(part)) {
        if (fetches >= MAX_PARTS_PER_QUIZ) continue;
        fetched.set(part, await fetchPart(part));
        fetches++;
      }
      const q = fetched.get(part)[i];
      if (!q) continue;
      if (mode !== "all" && askedOf) {
        if (!askedCache.has(part)) askedCache.set(part, await askedOf(part));
        const asked = askedCache.get(part);
        const isDone = asked ? asked.has(i) : false;
        if (mode === "new" && isDone) continue;
        if (mode === "done" && !isDone) continue;
      }
      q._k = `${part}#${i}`;
      q._ci = parseInt(part.split("-")[1], 10);
      if (edits && q.i && edits[q.i]) applyEdit(q, edits[q.i]);
      items.push(q);
    }
    return items;
  }

  // The admin typed a keyword while the flow waited at step "kwinput".
  async keywordAccept(chatId, flow, rawText) {
    const query = rawText.trim();
    const tokens = query.toLowerCase().replace(/\s+/g, " ")
      .split(" ").filter(Boolean);
    if (!tokens.length) return;
    await this.edit(chatId, flow.messageId, `🔎 Searching for "${query}"…`);
    let sidx;
    try {
      sidx = await loadSearchIndex();
    } catch (e) {
      flow.step = "kwhome";
      await this.state.storage.put("flow", flow);
      await this.showStep(chatId, flow);
      return;
    }
    const keys = [];
    for (const e of sidx) {
      const qn = e[3].toLowerCase().replace(/\s+/g, " ");
      if (tokens.every((t) => qn.includes(t))) {
        keys.push(`${e[1]}#${e[2]}`);
        if (keys.length >= 2000) break;
      }
    }
    if (!keys.length) {
      flow.step = "kwinput";
      await this.state.storage.put("flow", flow);
      await this.edit(chatId, flow.messageId,
        `🔑 No questions match "${query}".\nType another keyword:`,
        [[this.btn("⬅️ Back to Keyword Quiz", "kw:home"),
          this.btn("❌ Cancel", "cancel")]]);
      return;
    }
    flow.pendingKw = { label: query, keys, total: keys.length, done: 0 };
    const parts = [...new Set(keys.map((k) => k.split("#")[0]))];
    const sets = await this.flowAskedSets(flow, parts);
    let done = 0;
    for (const k of keys) {
      const [p, i] = k.split("#");
      if (sets.get(p)?.has(parseInt(i, 10))) done++;
    }
    flow.pendingKw.done = done;
    flow.step = "kwcount";
    await this.state.storage.put("flow", flow);
    await this.showStep(chatId, flow);
  }

  // --------------------------------------- asked-question tracking (per group)
  async askedSet(partName) {
    const arr = await this.state.storage.get(`asked:${partName}`);
    return new Set(arr || []);
  }

  // Record questions a started quiz actually used. `pairs`: [{part, idx, ci}].
  async recordAsked(pairs) {
    const byPart = new Map();
    for (const { part, idx, ci } of pairs) {
      if (!byPart.has(part)) {
        byPart.set(part, { set: await this.askedSet(part), ci, added: 0 });
      }
      const e = byPart.get(part);
      if (!e.set.has(idx)) { e.set.add(idx); e.added += 1; }
    }
    const counts = (await this.state.storage.get("askedCounts")) || {};
    for (const [part, e] of byPart) {
      if (!e.added) continue;
      await this.state.storage.put(`asked:${part}`,
        [...e.set].sort((a, b) => a - b));
      counts[e.ci] = (counts[e.ci] || 0) + e.added;
    }
    await this.state.storage.put("askedCounts", counts);
  }

  async doneInScope(index, subjectI, chapterI, countsOverride = null) {
    const counts = countsOverride ||
      (await this.state.storage.get("askedCounts")) || {};
    if (chapterI !== null && chapterI !== undefined) return counts[chapterI] || 0;
    if (subjectI !== null && subjectI !== undefined) {
      return index.subjects[subjectI].chapters
        .reduce((s, ci) => s + (counts[ci] || 0), 0);
    }
    return Object.values(counts).reduce((s, n) => s + n, 0);
  }

  async startFlow(chatId, userId) {
    const index = await loadIndex();
    const meta = (await this.state.storage.get("meta")) || {};
    const flow = {
      owner: userId, step: "subjects", messageId: null,
      subject: null, chapter: null, page: 0, count: null, seconds: null,
      mode: null,
    };
    const sent = await this.send(chatId, "📚 Quiz Setup — first choose a Subject:",
      await this.subjectsKeyboardFull(meta, index));
    flow.messageId = sent.message_id;
    await this.state.storage.put("flow", flow);
  }

  async showStep(chatId) {
    const flow = await this.state.storage.get("flow");
    if (!flow) return;
    const index = await loadIndex();
    const meta = (await this.state.storage.get("meta")) || {};
    const mid = flow.messageId;
    if (flow.step === "groups") {
      const groups = await this.knownGroupsFor(flow.owner);
      const rows = groups.map((g) => [this.btn(`👥 ${g.title || g.id}`, `grp:${g.id}`)]);
      rows.push([this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid,
        "🔒 Private Quiz Setup\nFirst choose the group for this quiz:", rows);
    } else if (flow.step === "subjects") {
      const meta2 = flow.dm
        ? { lastSelection: flow.targetState?.lastSelection || null } : meta;
      const head = flow.dm
        ? `📚 Quiz Setup for 👥 ${flow.targetTitle}\nFirst choose a Subject:`
        : "📚 Quiz Setup — first choose a Subject:";
      await this.edit(chatId, mid, head,
        await this.subjectsKeyboardFull(meta2, index));
    } else if (flow.step === "chapters") {
      const s = index.subjects[flow.subject];
      const counts = flow.dm ? (flow.targetState?.askedCounts || {})
        : (await this.state.storage.get("askedCounts")) || {};
      const rows = this.chaptersKeyboard(index, flow, counts);
      if ((s.chapters || []).includes(599)) {
        rows.unshift([this.btn("📅 Day-wise — Month → Day (original day quizzes)", "dw:open")]);
      }
      await this.edit(chatId, mid, `${s.icon || "📚"} ${s.name} — now choose a Topic:`,
        rows);
      await this.state.storage.put("flow", flow); // page clamp saved
    } else if (flow.step === "dwgroups") {
      const tg = await loadTgDays();
      const rows = tg.groups.map((g, i) =>
        [this.btn(`🗓️ ${g.name} — ${g.ndays} days · ${g.total} Q`, `dw:grp:${i}`)]);
      rows.push([this.btn("⬅️ Back to Topics", "back:chapters"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid,
        "📅 Day-wise Quiz — the group's original day quizzes, with every question (repeats included).\nFirst choose a Group:", rows);
    } else if (flow.step === "dwmonths") {
      const tg = await loadTgDays();
      const g = tg.groups[flow.dwGroup || 0];
      const pages = Math.max(1, Math.ceil(g.months.length / PAGE_SIZE));
      flow.page = Math.min(flow.page || 0, pages - 1);
      const rows = g.months
        .slice(flow.page * PAGE_SIZE, (flow.page + 1) * PAGE_SIZE)
        .map((mo) => [this.btn(
          `🗓️ ${fmtMonth(mo.m)} — ${mo.days.length} days · ${mo.n} Q`, `dw:mon:${mo.m}`)]);
      const nav = [];
      if (flow.page > 0) nav.push(this.btn("⬅️ Prev", `dw:monp:${flow.page - 1}`));
      if (flow.page < pages - 1) nav.push(this.btn("Next ➡️", `dw:monp:${flow.page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push([this.btn("⬅️ Back to Groups", "dw:groups"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, `📅 ${g.name} — choose a Month:`, rows);
      await this.state.storage.put("flow", flow); // page clamp saved
    } else if (flow.step === "dwdays") {
      const tg = await loadTgDays();
      const g = tg.groups[flow.dwGroup || 0];
      const mo = g.months.find((x) => x.m === flow.dwMonth) || g.months[0];
      const keysOf = (dy) => dy.keys || (dy.items || []).map((q) => q._src);
      const parts = [...new Set(mo.days.flatMap((dy) =>
        keysOf(dy).map((k) => k.split("#")[0])))];
      const sets = await this.flowAskedSets(flow, parts);
      const doneOf = (dy) => keysOf(dy).reduce((s2, k) => {
        const [p, i] = k.split("#");
        return s2 + (sets.get(p)?.has(parseInt(i, 10)) ? 1 : 0);
      }, 0);
      const pages = Math.max(1, Math.ceil(mo.days.length / PAGE_SIZE));
      flow.page = Math.min(flow.page || 0, pages - 1);
      const rows = mo.days
        .slice(flow.page * PAGE_SIZE, (flow.page + 1) * PAGE_SIZE)
        .map((dy) => {
          const done = doneOf(dy);
          return [this.btn(
            `${fmtDay(dy.d)} · ${dy.n} Q${done ? ` · ✅${done} done` : ""}`, `dw:day:${dy.d}`)];
        });
      const nav = [];
      if (flow.page > 0) nav.push(this.btn("⬅️ Prev", `dw:dayp:${flow.page - 1}`));
      if (flow.page < pages - 1) nav.push(this.btn("Next ➡️", `dw:dayp:${flow.page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push([this.btn("⬅️ Back to Months", "dw:months"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid,
        `📅 ${g.name} › ${fmtMonth(mo.m)} — choose a Day (full day quiz, original order):`, rows);
      await this.state.storage.put("flow", flow); // page clamp saved
    } else if (flow.step === "kwhome") {
      const entries = flow.kwEntries || [];
      const total = entries.reduce((s, e) => s + e.count, 0);
      const lines = ["🔑 Keyword Quiz — add keywords and build a quiz from their questions:"];
      if (entries.length) {
        entries.forEach((e, i) =>
          lines.push(`${i + 1}. "${e.label}" — ${e.count} Q (pool ${e.total})`));
        lines.push(`📌 Total: ${total} questions`);
      } else {
        lines.push("Nothing added yet. Add your first keyword:");
      }
      const rows = [[this.btn("⌨️ Add keyword", "kw:add")]];
      if (entries.length) rows.push([this.btn(`✅ Done — choose Mode (${total} Q)`, "kw:go")]);
      if (entries.length) rows.push([this.btn("🗑️ Clear all", "kw:clear")]);
      rows.push([this.btn("⬅️ Back to Subjects", "back:subjects"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, lines.join("\n"), rows);
    } else if (flow.step === "kwinput") {
      await this.edit(chatId, mid,
        "⌨️ Type your keyword in your next message\n(e.g. pension · error sheet · wharfage · leave rules)",
        [[this.btn("⬅️ Back", "kw:home"), this.btn("❌ Cancel", "cancel")]]);
    } else if (flow.step === "kwcount") {
      const pk = flow.pendingKw || { label: "", total: 0, done: 0 };
      const rows = MIX_COUNT_CHOICES.map((n) =>
        [this.btn(`${n} Questions`, `kw:cnt:${n}`)]);
      rows.push([this.btn("⬅️ Back", "kw:home"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid,
        `🔑 "${pk.label}" — ${pk.total} questions found\n✅ Completed: ${pk.done} · 🆕 Pending: ${pk.total - pk.done}\nHow many questions from this keyword?`, rows);
    } else if (flow.step === "mixhome") {
      const mix = flow.mix || [];
      const total = mix.reduce((s, e) => s + e.count, 0);
      const lines = ["🧩 Mix Quiz — combine topics, choose how many from each:"];
      if (mix.length) {
        mix.forEach((e, i) => lines.push(`${i + 1}. ${e.label} — ${e.count} Q`));
        lines.push(`📌 Total: ${total} questions`);
      } else {
        lines.push("Nothing added yet. Add topics syllabus-wise (Appendix 3A):");
      }
      const rows = [[this.btn("📚 Add from Syllabus (Appendix 3A)", "mx:add")]];
      if (mix.length) rows.push([this.btn(`✅ Done — choose Mode (${total} Q)`, "mx:go")]);
      if (mix.length) rows.push([this.btn("🗑️ Clear all", "mx:clear")]);
      rows.push([this.btn("⬅️ Back to Subjects", "back:subjects"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, lines.join("\n"), rows);
    } else if (flow.step === "sylpapers") {
      const rows = syllabusMap(index).map((p, i) =>
        [this.btn(`📖 ${p.paper} (${p.total} Q)`, `mx:paper:${i}`)]);
      rows.push([this.btn("⬅️ Back to Mix", "mx:home"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, "📚 Appendix 3A Syllabus — choose a Paper:", rows);
    } else if (flow.step === "sylgroups") {
      const P = syllabusMap(index)[flow.sylPaper];
      const rows = [[this.btn(`🎲 Whole ${P.paper} — all topics (${P.total} Q)`, "mx:wholepaper")]];
      P.groups.forEach((g) =>
        rows.push([this.btn(`${g.name} (${g.total} Q)`, `mx:group:${g.code}`)]));
      rows.push([this.btn("⬅️ Back to Papers", "mx:add"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, `📖 ${P.paper} — choose a topic group:`, rows);
    } else if (flow.step === "sylchapters") {
      const P = syllabusMap(index)[flow.sylPaper];
      const g = P.groups.find((x) => x.code === flow.sylGroup);
      const counts = flow.dm ? (flow.targetState?.askedCounts || {})
        : (await this.state.storage.get("askedCounts")) || {};
      const pages = Math.max(1, Math.ceil(g.cis.length / PAGE_SIZE));
      flow.page = Math.min(flow.page || 0, pages - 1);
      const rows = [[this.btn(`➕ Whole topic: ${g.name} (${g.total} Q)`, "mx:wholegroup")]];
      for (const ci of g.cis.slice(flow.page * PAGE_SIZE, (flow.page + 1) * PAGE_SIZE)) {
        let t = index.chapter_titles[ci]
          .replace(/^PAPER-(I|II|III):\s*[A-Z0-9]+:\s*/, "");
        if (t.length > 32) t = t.slice(0, 31) + "…";
        const done = counts[ci] || 0;
        rows.push([this.btn(`${t} (${index.chapter_counts[ci]} Q${done ? ` · ✅${done} done` : ""})`, `mx:chap:${ci}`)]);
      }
      const nav = [];
      if (flow.page > 0) nav.push(this.btn("⬅️ Prev", `page:${flow.page - 1}`));
      if (flow.page < pages - 1) nav.push(this.btn("Next ➡️", `page:${flow.page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push([this.btn("⬅️ Back to Topic Groups", "mx:groups"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, `📖 ${P.paper} › ${g.name} — choose a chapter:`, rows);
      await this.state.storage.put("flow", flow); // page clamp saved
    } else if (flow.step === "mixcount") {
      const rows = MIX_COUNT_CHOICES.map((n) =>
        [this.btn(`${n} Questions`, `mx:cnt:${n}`)]);
      rows.push([this.btn("⬅️ Back", "mx:backcount"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid,
        `➕ Add: ${flow.pendingUnit.label}\nHow many questions from this?`, rows);
    } else if (flow.step === "mode") {
      if (flow.kind === "mix" || flow.kind === "keyword") {
        let total, done, label, backData;
        if (flow.kind === "mix") {
          const counts = flow.dm ? (flow.targetState?.askedCounts || {})
            : (await this.state.storage.get("askedCounts")) || {};
          ({ total, done } = mixTotals(index, flow.mix || [], counts));
          label = mixLabel(flow.mix || []);
          backData = "mx:home";
        } else {
          ({ total, done } = await this.kwDone(flow, flow.kwEntries || []));
          await this.state.storage.put("flow", flow); // asked-cache saved
          label = planLabel("keyword", flow.kwEntries || []);
          backData = "kw:home";
        }
        const rows = [
          [this.btn(`🆕 New Questions (${total - done} left)`, "mode:new")],
          [this.btn(`🔁 Completed Questions (${done} done)`, "mode:done")],
          [this.btn(`🎲 All Questions (${total})`, "mode:all")],
          [this.btn("⬅️ Back", backData), this.btn("❌ Cancel", "cancel")],
        ];
        await this.edit(chatId, mid,
          `✅ ${label}\nWhich questions should the quiz use?`, rows);
        return;
      }
      const label = labelFor(index, flow.subject, flow.chapter);
      const cand = candidateParts(index, flow.subject, flow.chapter);
      const total = cand.reduce((s2, p) => s2 + p.size, 0);
      const done = await this.doneInScope(index, flow.subject, flow.chapter,
        flow.dm ? (flow.targetState?.askedCounts || {}) : null);
      const rows = [
        [this.btn(`🆕 New Questions (${total - done} left)`, "mode:new")],
        [this.btn(`🔁 Completed Questions (${done} done)`, "mode:done")],
        [this.btn(`🎲 All Questions (${total})`, "mode:all")],
        [this.btn("⬅️ Back", "back:chapters"), this.btn("❌ Cancel", "cancel")],
      ];
      await this.edit(chatId, mid,
        `✅ Topic: ${label}\nWhich questions should the quiz use?`, rows);
    } else if (flow.step === "count") {
      const label = labelFor(index, flow.subject, flow.chapter);
      const rows = COUNT_CHOICES.map((n) => [this.btn(`${n} Questions`, `cnt:${n}`)]);
      rows.push([this.btn("⬅️ Back", "back:mode"), this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, `✅ Topic: ${label}\nHow many questions?`, rows);
    } else if (flow.step === "seconds") {
      const rows = SECOND_CHOICES.map((n) => [this.btn(`${n} seconds / question`, `sec:${n}`)]);
      rows.push([this.btn("⬅️ Back", flow.kind === "daywise" ? "dw:days"
        : (flow.kind === "mix" || flow.kind === "keyword") ? "back:mode" : "back:count"),
                 this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, "⏱️ How much time per question?", rows);
    } else if (flow.step === "confirm") {
      if (flow.kind === "mix" || flow.kind === "keyword" || flow.kind === "daywise") {
        const entries = flow.kind === "mix" ? (flow.mix || [])
          : flow.kind === "keyword" ? (flow.kwEntries || []) : (flow.dwEntries || []);
        let total, done;
        if (flow.kind === "mix") {
          const counts = flow.dm ? (flow.targetState?.askedCounts || {})
            : (await this.state.storage.get("askedCounts")) || {};
          ({ total, done } = mixTotals(index, entries, counts));
        } else {
          ({ total, done } = await this.kwDone(flow, entries));
          await this.state.storage.put("flow", flow);
        }
        let poolSize = total;
        if (flow.mode === "new") poolSize = total - done;
        if (flow.mode === "done") poolSize = done;
        const asked = entries.reduce((s, e) => s + e.count, 0);
        const count = Math.min(asked, poolSize);
        const modeName = { new: "🆕 New Questions", done: "🔁 Completed Questions", all: "🎲 All Questions" }[flow.mode || "all"];
        const lines = [flow.kind === "mix" ? "🚀 Mix Quiz is ready:"
          : flow.kind === "keyword" ? "🚀 Keyword Quiz is ready:" : "🚀 Day-wise Quiz is ready:"];
        entries.forEach((e, i) => lines.push(`${i + 1}. ${e.label} — ${e.count} Q`));
        lines.push(`🎯 ${modeName}`);
        lines.push(`📌 ${count} questions (pool: ${poolSize})`);
        lines.push(`⏱️ ${flow.seconds} seconds per question`);
        lines.push("\nStart the quiz?");
        await this.edit(chatId, mid, lines.join("\n"),
          [[this.btn("▶️ START QUIZ", "start"), this.btn("❌ Cancel", "cancel")]]);
        return;
      }
      const label = labelFor(index, flow.subject, flow.chapter);
      const cand = candidateParts(index, flow.subject, flow.chapter);
      const total = cand.reduce((s2, p) => s2 + p.size, 0);
      let poolSize = total;
      if (flow.mode === "new" || flow.mode === "done") {
        const done = await this.doneInScope(index, flow.subject, flow.chapter,
          flow.dm ? (flow.targetState?.askedCounts || {}) : null);
        poolSize = flow.mode === "new" ? total - done : done;
      }
      const count = Math.min(flow.count, poolSize);
      const modeName = { new: "🆕 New Questions", done: "🔁 Completed Questions", all: "🎲 All Questions" }[flow.mode || "all"];
      const text = `🚀 Quiz is ready:\n📚 ${label}\n🎯 ${modeName}\n📌 ${count} questions (pool: ${poolSize})\n⏱️ ${flow.seconds} seconds per question\n\nStart the quiz?`;
      await this.edit(chatId, mid, text,
        [[this.btn("▶️ START QUIZ", "start"), this.btn("❌ Cancel", "cancel")]]);
    }
  }

  async onCallback(cq) {
    const chatId = cq.message?.chat?.id;
    if (!chatId) return;
    const data = cq.data || "";
    const userId = cq.from?.id;
    if (data.startsWith("ed:")) {
      await this.editorCallback(chatId, cq);
      return;
    }
    let flow = await this.state.storage.get("flow");
    if (!flow) {
      await this.answerCb(cq.id, "No quiz setup is open. Type /quiz to start one.");
      return;
    }
    if (userId !== flow.owner) {
      // Telegram reports an anonymous admin under a different identity for
      // button taps than for messages, so the same person can mismatch their
      // own flow. A setup can only be created by an admin anyway — let any
      // admin operate it; members stay refused.
      const tapperAdmin = userId && (await this.isAdmin(chatId, userId));
      const ownerAdmin = flow.owner === ANON_ADMIN_ID ||
        (flow.owner && (await this.isAdmin(chatId, flow.owner)));
      if (!(tapperAdmin && ownerAdmin)) {
        await this.answerCb(cq.id, "This selection is only for the admin who started the setup.");
        return;
      }
    }
    const index = await loadIndex();

    if (data === "cancel") {
      await this.state.storage.delete("flow");
      await this.edit(chatId, flow.messageId, "❌ Quiz setup cancelled.");
      await this.answerCb(cq.id);
      return;
    }
    if (data.startsWith("grp:")) {
      const target = parseInt(data.slice(4), 10);
      if (!(await this.isAdmin(target, flow.owner))) {
        await this.answerCb(cq.id, "You are not an admin of that group.");
        return;
      }
      flow.targetChatId = target;
      let groups = {};
      try {
        groups = JSON.parse((await this.env.KV.get("groups")) || "{}");
      } catch (e) { /* title falls back below */ }
      flow.targetTitle = groups[target]?.title || "the group";
      flow.targetState = await this.roomCall(target, "/state");
      flow.step = "subjects";
      await this.state.storage.put("flow", flow);
      await this.answerCb(cq.id);
      await this.showStep(chatId);
      return;
    }
    if (data === "repeat" || data === "default") {
      if (flow.dm && flow.targetChatId) {
        const l = data === "repeat" ? flow.targetState?.lastSelection : {
          label: "🎲 Full Bank (Random)", subject: null, chapter: null,
          count: DEFAULT_COUNT, seconds: DEFAULT_SECONDS, mode: "all",
        };
        if (!l) {
          await this.answerCb(cq.id, "No previous quiz found for that group.");
          return;
        }
        await this.dmLaunch(chatId, flow, l);
        await this.answerCb(cq.id);
        return;
      }
      const meta = (await this.state.storage.get("meta")) || {};
      await this.state.storage.delete("flow");
      if (data === "repeat" && meta.lastSelection) {
        const l = meta.lastSelection;
        await this.edit(chatId, flow.messageId, "🔁 Starting the last quiz again…");
        await this.answerCb(cq.id);
        await this.startSession(chatId, l.label, l.subject, l.chapter, l.count, l.seconds, l.mode || "all", l.plan || null);
      } else if (data === "default") {
        await this.edit(chatId, flow.messageId, "⚡ Starting the default quiz…");
        await this.answerCb(cq.id);
        await this.startSession(chatId, "🎲 Full Bank (Random)", null, null, DEFAULT_COUNT, DEFAULT_SECONDS);
      } else {
        await this.answerCb(cq.id);
      }
      return;
    }
    if (data === "start" && (flow.kind === "mix" || flow.kind === "keyword" || flow.kind === "daywise")) {
      const plan = flow.kind === "mix" ? (flow.mix || [])
        : flow.kind === "keyword" ? (flow.kwEntries || []) : (flow.dwEntries || []);
      const label = flow.kind === "mix" ? mixLabel(plan)
        : flow.kind === "keyword" ? planLabel("keyword", plan)
        : (plan[0]?.label || "📅 Day-wise Quiz");
      const totalCount = plan.reduce((s, e) => s + e.count, 0);
      const sel = {
        label, subject: null, chapter: null, count: totalCount,
        seconds: flow.seconds, mode: flow.mode || "all", plan,
      };
      if (flow.dm && flow.targetChatId) {
        await this.dmLaunch(chatId, flow, sel);
        await this.answerCb(cq.id);
        return;
      }
      const meta = (await this.state.storage.get("meta")) || {};
      meta.lastSelection = sel;
      await this.state.storage.put("meta", meta);
      await this.state.storage.delete("flow");
      await this.edit(chatId, flow.messageId, `▶️ Starting the quiz — ${label}`);
      await this.answerCb(cq.id);
      try {
        await this.startSession(chatId, label, null, null, totalCount,
          flow.seconds, flow.mode || "all", plan);
        const now = await this.state.storage.get("session");
        if (!now) {
          await this.send(chatId, "⚠️ No questions could be built from this selection — try another Mode or keyword.");
        }
      } catch (e) {
        await this.send(chatId, "⚠️ The quiz could not be started — please try again with /quiz.");
      }
      return;
    }
    if (data === "start") {
      const label = labelFor(index, flow.subject, flow.chapter);
      if (flow.dm && flow.targetChatId) {
        await this.dmLaunch(chatId, flow, {
          label, subject: flow.subject, chapter: flow.chapter,
          count: flow.count, seconds: flow.seconds, mode: flow.mode || "all",
        });
        await this.answerCb(cq.id);
        return;
      }
      const meta = (await this.state.storage.get("meta")) || {};
      meta.lastSelection = {
        subject: flow.subject, chapter: flow.chapter,
        count: flow.count, seconds: flow.seconds, label,
        mode: flow.mode || "all",
      };
      await this.state.storage.put("meta", meta);
      await this.state.storage.delete("flow");
      await this.edit(chatId, flow.messageId, `▶️ Starting the quiz — ${label}`);
      await this.answerCb(cq.id);
      await this.startSession(chatId, label, flow.subject, flow.chapter, flow.count, flow.seconds, flow.mode || "all");
      return;
    }
    if (data === "dw:open") {
      flow.kind = "daywise"; flow.step = "dwgroups";
    } else if (data === "dw:groups") {
      flow.step = "dwgroups";
    } else if (data.startsWith("dw:grp:")) {
      flow.dwGroup = parseInt(data.slice(7), 10);
      flow.page = 0;
      flow.step = "dwmonths";
    } else if (data.startsWith("dw:monp:")) {
      flow.page = parseInt(data.slice(8), 10);
      flow.step = "dwmonths";
    } else if (data.startsWith("dw:mon:")) {
      flow.dwMonth = data.slice(7);
      flow.page = 0;
      flow.step = "dwdays";
    } else if (data === "dw:months") {
      flow.step = "dwmonths";
    } else if (data.startsWith("dw:dayp:")) {
      flow.page = parseInt(data.slice(8), 10);
      flow.step = "dwdays";
    } else if (data === "dw:days") {
      flow.step = "dwdays";
    } else if (data.startsWith("dw:day:")) {
      const tg = await loadTgDays();
      const g = tg.groups[flow.dwGroup || 0];
      const mo = g.months.find((x) => x.m === flow.dwMonth) || g.months[0];
      const dy = mo.days.find((x) => x.d === data.slice(7));
      if (!dy) {
        await this.answerCb(cq.id, "That day is no longer available.");
        return;
      }
      flow.dwEntries = [dy.items
        ? {
            label: `📅 ${g.name} · ${fmtDay(dy.d)}`,
            dwRef: { gi: flow.dwGroup || 0, m: mo.m, d: dy.d },
            count: dy.n, total: dy.n, ordered: true,
          }
        : {
            label: `📅 ${g.name} · ${fmtDay(dy.d)}`,
            keys: dy.keys, count: dy.n, total: dy.n, ordered: true,
          }];
      flow.mode = "all";
      flow.step = "seconds";
    } else if (data === "kw:open") {
      flow.kind = "keyword"; flow.kwEntries = flow.kwEntries || [];
      flow.step = "kwhome";
    } else if (data === "kw:home") {
      flow.step = "kwhome";
    } else if (data === "kw:add") {
      flow.step = "kwinput";
    } else if (data.startsWith("kw:cnt:")) {
      const n = parseInt(data.slice(7), 10);
      if (flow.pendingKw) {
        flow.kwEntries = flow.kwEntries || [];
        flow.kwEntries.push({ ...flow.pendingKw, count: n });
        flow.pendingKw = null;
      }
      flow.step = "kwhome";
    } else if (data === "kw:clear") {
      flow.kwEntries = []; flow.step = "kwhome";
    } else if (data === "kw:go") {
      flow.step = "mode";
    } else if (data === "mx:open") {
      flow.kind = "mix"; flow.mix = flow.mix || []; flow.step = "mixhome";
    } else if (data === "mx:home") {
      flow.step = "mixhome";
    } else if (data === "mx:add") {
      flow.step = "sylpapers";
    } else if (data.startsWith("mx:paper:")) {
      flow.sylPaper = parseInt(data.slice(9), 10); flow.step = "sylgroups";
    } else if (data === "mx:groups") {
      flow.step = "sylgroups";
    } else if (data.startsWith("mx:group:")) {
      flow.sylGroup = data.slice(9); flow.page = 0; flow.step = "sylchapters";
    } else if (data.startsWith("mx:chap:")) {
      const ci = parseInt(data.slice(8), 10);
      const short = index.chapter_titles[ci]
        .replace(/^PAPER-(I|II|III):\s*[A-Z0-9]+:\s*/, "");
      flow.pendingUnit = { label: short, cis: [ci] };
      flow.pendingFrom = "sylchapters"; flow.step = "mixcount";
    } else if (data === "mx:wholegroup") {
      const P = syllabusMap(index)[flow.sylPaper];
      const g = P.groups.find((x) => x.code === flow.sylGroup);
      flow.pendingUnit = { label: `${P.paper} › ${g.name}`, cis: g.cis };
      flow.pendingFrom = "sylchapters"; flow.step = "mixcount";
    } else if (data === "mx:wholepaper") {
      const P = syllabusMap(index)[flow.sylPaper];
      flow.pendingUnit = { label: `${P.paper} (All Topics)`, cis: P.cis };
      flow.pendingFrom = "sylgroups"; flow.step = "mixcount";
    } else if (data.startsWith("mx:cnt:")) {
      const n = parseInt(data.slice(7), 10);
      flow.mix = flow.mix || [];
      flow.mix.push({ ...flow.pendingUnit, count: n });
      flow.pendingUnit = null; flow.step = "mixhome";
    } else if (data === "mx:backcount") {
      flow.step = flow.pendingFrom || "sylchapters";
    } else if (data === "mx:clear") {
      flow.mix = []; flow.step = "mixhome";
    } else if (data === "mx:go") {
      flow.step = "mode";
    } else if (data.startsWith("sub:")) {
      flow.kind = null; flow.mix = null; flow.kwEntries = null;
      flow.subject = parseInt(data.slice(4), 10);
      flow.chapter = null; flow.page = 0; flow.step = "chapters";
    } else if (data.startsWith("page:")) {
      flow.page = parseInt(data.slice(5), 10);
    } else if (data.startsWith("top:")) {
      const v = data.slice(4);
      flow.chapter = v === "all" ? null : parseInt(v, 10);
      flow.step = "mode";
    } else if (data.startsWith("mode:")) {
      flow.mode = data.slice(5);
      flow.step = (flow.kind === "mix" || flow.kind === "keyword") ? "seconds" : "count";
    } else if (data.startsWith("cnt:")) {
      flow.count = parseInt(data.slice(4), 10);
      flow.step = "seconds";
    } else if (data.startsWith("sec:")) {
      flow.seconds = parseInt(data.slice(4), 10);
      flow.step = "confirm";
    } else if (data === "back:subjects") {
      flow.step = "subjects";
    } else if (data === "back:chapters") {
      flow.step = "chapters";
    } else if (data === "back:count") {
      flow.step = "count";
    } else if (data === "back:mode") {
      flow.step = "mode";
    } else {
      await this.answerCb(cq.id);
      return;
    }
    await this.state.storage.put("flow", flow);
    await this.answerCb(cq.id);
    await this.showStep(chatId);
  }

  // ------------------------------------------------------------ session
  async startSession(chatId, label, subjectI, chapterI, count, seconds, mode = "all", plan = null) {
    const index = await loadIndex();
    const askedOf = (name) => this.askedSet(name);
    const edits = await loadEdits(this.env);
    let items;
    if (plan && plan.length) {
      // Mix quiz: draw each entry's share from its own chapters, de-dupe
      // across entries, then shuffle everything together.
      items = [];
      const usedK = new Set();
      for (const e of plan) {
        const pool = e.ordered
          ? (e.dwRef
            ? await this.fetchDayInline(e.dwRef, edits)
            : await this.fetchByKeysOrdered(e.keys, edits))
          : shuffle(e.keys
            ? await this.fetchByKeys(e.keys, e.count, mode, askedOf, edits)
            : await fetchPool(
                index, null, null, e.count, mode, askedOf, e.cis, edits));
        let got = 0;
        for (const item of pool) {
          if (got >= e.count) break;
          // Ordered (day-wise) entries replay a day same-to-same: a
          // question the group posted twice that day stays twice, so
          // the cross-entry de-dupe does not apply to them.
          if (!e.ordered && item._k && usedK.has(item._k)) continue;
          if (buildPollPayload(item, 1, seconds).skip) continue;
          if (!e.ordered && item._k) usedK.add(item._k);
          items.push(item);
          got++;
        }
      }
      items = (plan.length === 1 && plan[0].ordered) ? items : shuffle(items);
    } else {
      items = shuffle(await fetchPool(index, subjectI, chapterI, count, mode, askedOf, null, edits));
    }
    const payloads = [];
    const usedKeys = [];
    const lqItems = [];
    for (const item of items) {
      if (payloads.length >= count) break;
      const built = buildPollPayload(item, payloads.length + 1, seconds);
      if (built.skip) continue;
      payloads.push(built);
      if (item._k) {
        const [part, idx] = item._k.split("#");
        usedKeys.push({ part, idx: parseInt(idx, 10), ci: item._ci });
        // Remember this quiz's questions in the group room so the DM
        // question editor can offer them via "Last Quiz Questions".
        if (item.i && lqItems.length < 100) {
          lqItems.push({
            i: item.i, part, idx: parseInt(idx, 10),
            q: String(item.q || "").slice(0, 120),
          });
        }
      }
    }
    if (!payloads.length) {
      const msg = mode === "new"
        ? "✅ No new questions left here — every question is already completed. Try Completed Questions or All Questions."
        : mode === "done"
          ? "No completed questions here yet — run a New Questions quiz first."
          : "⚠️ No quiz-worthy questions found in this topic.";
      await this.send(chatId, msg);
      return;
    }
    if (usedKeys.length) await this.recordAsked(usedKeys);
    if (lqItems.length) {
      await this.state.storage.put("lastQuiz",
        { at: Date.now(), label, items: lqItems });
    }
    const session = {
      chatId, label, seconds, items: payloads, idx: 0,
      scores: {}, pollMap: {}, pollSentAt: {}, answered: {},
      stop: false, asked: 0,
    };
    await this.state.storage.put("session", session);
    const modeLine = mode === "new" ? "\n🎯 Mode: 🆕 New questions only"
      : mode === "done" ? "\n🎯 Mode: 🔁 Completed questions (revision)" : "";
    await this.send(chatId,
      `${(await this.flavor()) === "akaza" ? "👹 Akaza" : "🚂 RADEQuiz"} — ${label}\n📌 ${payloads.length} questions • ⏱️ ${seconds} seconds each${modeLine}\n📝 Marking (Appendix 3A): +1 correct • −⅓ wrong • 0 skipped\n🏆 Ranking at the end. All the best!`);
    await this.sendCurrent(session);
  }

  async sendCurrent(session) {
    const built = session.items[session.idx];
    if (built.pre) {
      try { await this.send(session.chatId, built.pre); } catch (e) { /* skip */ }
    }
    const sent = await this.call("sendPoll", {
      chat_id: session.chatId, ...built.poll,
    });
    session.pollMap[sent.poll.id] = built.poll.correct_option_id;
    (session.pollSentAt ||= {})[sent.poll.id] = Date.now();
    session.asked += 1;
    session.idx += 1;
    await this.state.storage.put("session", session);
    await this.env.KV.put(`pollmap:${sent.poll.id}`, String(session.chatId));
    await this.state.storage.setAlarm(Date.now() + (session.seconds + 2) * 1000);
  }

  async alarm() {
    const session = await this.state.storage.get("session");
    if (!session) return;
    if (session.stop || session.idx >= session.items.length) {
      await this.finishSession(session);
      return;
    }
    try {
      await this.sendCurrent(session);
    } catch (e) {
      console.log("sendPoll failed, skipping:", e.message);
      session.idx += 1;
      await this.state.storage.put("session", session);
      await this.state.storage.setAlarm(Date.now() + 500);
    }
  }

  async finishSession(session) {
    await this.state.storage.delete("session");
    const meta = (await this.state.storage.get("meta")) || {};
    meta.sessionsDone = (meta.sessionsDone || 0) + 1;
    await this.state.storage.put("meta", meta);
    const entries = Object.values(session.scores);
    let resultText;
    if (entries.length) {
      const ranked = entries
        .sort((a, b) => (ptsOf(b) - ptsOf(a)) || ((a[3] || 0) - (b[3] || 0)))
        .slice(0, 10);
      const medals = ["🥇", "🥈", "🥉"];
      const lines = ["🏆 Ranking (score • time taken):", ""];
      ranked.forEach((e, i) => {
        lines.push(`${i < 3 ? medals[i] : `${i + 1}.`} ${e[0]} — ${fmtPts(e)} pts · ✅${e[1] || 0}   ❌${e[2] || 0} · ⏱ ${fmtTime(e[3] || 0)}`);
      });
      resultText = lines.join("\n");
    } else {
      resultText = "ℹ️ No answers were recorded in this quiz.";
    }
    const head = session.stop ? "🛑 Quiz stopped." : "🎉 Quiz finished!";
    await this.send(session.chatId, `${head} ${session.asked} questions done.\n\n${resultText}`);
  }

  async onPollAnswer(pa) {
    const session = await this.state.storage.get("session");
    if (!session) return;
    const correct = session.pollMap[pa.poll_id];
    if (correct === undefined) return;
    if (!pa.option_ids || !pa.option_ids.length) return; // vote retract: ignore
    const user = pa.user;
    session.answered ||= {};
    const akey = `${pa.poll_id}:${user.id}`;
    if (session.answered[akey]) return; // first answer only (exam rule)
    session.answered[akey] = 1;
    const sentAt = (session.pollSentAt || {})[pa.poll_id];
    let elapsed = sentAt ? Math.round((Date.now() - sentAt) / 1000) : 0;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > session.seconds) elapsed = session.seconds;
    // entry/totals format: [name, correct, wrong, timeSec] (totals: [name, correct, answered, wrong, timeSec])
    let entry = session.scores[user.id];
    if (!entry || entry.length < 4) {
      entry = session.scores[user.id] =
        [user.first_name || "Player", (entry && entry[1]) || 0, 0, 0];
    }
    entry[0] = user.first_name || entry[0];
    const totals = (await this.state.storage.get("scores")) || {};
    let tot = totals[user.id];
    if (!tot || tot.length < 5) {
      tot = totals[user.id] =
        [user.first_name || "Player", (tot && tot[1]) || 0, (tot && tot[2]) || 0, 0, 0];
    }
    tot[0] = user.first_name || tot[0];
    tot[2] += 1;
    if (JSON.stringify(pa.option_ids) === JSON.stringify([correct])) {
      entry[1] += 1; tot[1] += 1;
    } else {
      entry[2] += 1; tot[3] += 1;
    }
    entry[3] += elapsed; tot[4] += elapsed;
    await this.state.storage.put("session", session);
    await this.state.storage.put("scores", totals);
  }
}
