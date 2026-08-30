#!/usr/bin/env node
/**
 * Render docs/progress.json into the live build board (docs/progress.html).
 *
 * The board is written in Artifact shape — <title>, fonts, <style>, then body
 * content, with no <html>/<head>/<body> wrapper — so it can be published
 * straight to a hosted page and redeployed in place as the build advances.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(readFileSync(join(root, 'docs/progress.json'), 'utf8'));
const stamp = state.updated || new Date().toISOString();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS = {
  queued:   { label: 'Queued',   cls: 'queued' },
  building: { label: 'Building', cls: 'building' },
  critique: { label: 'In review',cls: 'critique' },
  rework:   { label: 'Sent back',cls: 'rework' },
  done:     { label: 'Cleared',  cls: 'done' },
};

const all = state.waves.flatMap((w) => w.pieces);
const tally = (s) => all.filter((p) => p.status === s).length;
const cleared = tally('done');
const inFlight = tally('building') + tally('critique') + tally('rework');
const rounds = all.reduce((n, p) => n + (p.rounds || 0), 0);
const sentBack = all.reduce((n, p) => n + Math.max(0, (p.rounds || 0) - (p.status === 'done' ? 1 : 0)), 0);

/* Round pips encode who won each blind comparison — the one fact that decides
   whether a piece ships, so it gets the structural device. */
const pips = (p) => {
  const history = p.history && p.history.length
    ? p.history
    : Array.from({ length: p.rounds || 0 }, (_, i) => (p.status === 'done' && i === (p.rounds || 0) - 1 ? 'ain' : 'reference'));
  if (!history.length) return '';
  return `<span class="pips" title="${history.length} critic round${history.length === 1 ? '' : 's'}">${
    history.map((h) => `<i class="pip ${h}" title="${h === 'ain' ? 'critic chose Ain' : h === 'tie' ? 'critic called it a tie' : 'critic chose the reference product'}"></i>`).join('')
  }</span>`;
};

const pieceRow = (p) => {
  const s = STATUS[p.status] || STATUS.queued;
  return `<li class="row ${s.cls}">
      <span class="row__dot" aria-hidden="true"></span>
      <div class="row__main">
        <div class="row__head">
          <h3 class="row__title">${esc(p.title)}</h3>
          <span class="chip ${s.cls}">${s.label}</span>
          ${pips(p)}
        </div>
        ${p.note ? `<p class="row__note">${esc(p.note)}</p>` : ''}
        ${p.verdict ? `<blockquote class="row__verdict"><span class="row__verdictlabel">Critic</span>${esc(p.verdict)}</blockquote>` : ''}
      </div>
    </li>`;
};

const waveBand = (w, i) => {
  const done = w.pieces.filter((p) => p.status === 'done').length;
  const stateCls = w.status === 'done' ? 'done' : w.status === 'active' ? 'active' : 'queued';
  return `<section class="wave ${stateCls}">
      <header class="wave__head">
        <span class="wave__rule" aria-hidden="true"></span>
        <h2 class="wave__title">${esc(w.name)}</h2>
        <span class="wave__count">${done}<span class="wave__of">/${w.pieces.length}</span></span>
      </header>
      ${w.note ? `<p class="wave__note">${esc(w.note)}</p>` : ''}
      <ul class="rows">${w.pieces.map(pieceRow).join('')}</ul>
    </section>`;
};

const segments = all.map((p) => `<i class="seg ${(STATUS[p.status] || STATUS.queued).cls}" title="${esc(p.title)} — ${(STATUS[p.status] || STATUS.queued).label}"></i>`).join('');

const html = `<title>Ain Build Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Source+Sans+3:wght@400;600&display=swap">
<style>
/* Light is the base palette; both dark paths redefine only tokens. */
:root {
  --ground:#f2f4f7; --panel:#ffffff; --panel-2:#f7f8fa; --sunk:#e9ecf1;
  --line:#dfe4ec; --line-2:#c6cedb;
  --ink:#141b2a; --ink-2:#4d576b; --ink-3:#78829a;
  --ours:#3d4fc4;          /* our side of the duel */
  --ours-soft:#e7e9fb;
  --theirs:#b8532f;        /* the reference product's side */
  --theirs-soft:#fbeae3;
  --good:#1f7a52; --good-soft:#e2f2ea;
  --warn:#9a6510; --warn-soft:#faefdc;
  --shadow:0 1px 2px rgba(20,27,42,.06), 0 8px 20px -14px rgba(20,27,42,.28);
  --font-display:"Archivo","Helvetica Neue",Arial,sans-serif;
  --font-body:"Source Sans 3",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground:#0d1220; --panel:#141a2a; --panel-2:#182031; --sunk:#0a0f1a;
    --line:#242e44; --line-2:#36425c;
    --ink:#e7ebf4; --ink-2:#a2adc2; --ink-3:#7684a0;
    --ours:#8a95f0; --ours-soft:rgba(138,149,240,.16);
    --theirs:#e08b64; --theirs-soft:rgba(224,139,100,.16);
    --good:#57c294; --good-soft:rgba(87,194,148,.15);
    --warn:#d9a94f; --warn-soft:rgba(217,169,79,.15);
    --shadow:0 1px 2px rgba(0,0,0,.5), 0 10px 28px -18px rgba(0,0,0,.8);
  }
}
:root[data-theme="dark"] {
  --ground:#0d1220; --panel:#141a2a; --panel-2:#182031; --sunk:#0a0f1a;
  --line:#242e44; --line-2:#36425c;
  --ink:#e7ebf4; --ink-2:#a2adc2; --ink-3:#7684a0;
  --ours:#8a95f0; --ours-soft:rgba(138,149,240,.16);
  --theirs:#e08b64; --theirs-soft:rgba(224,139,100,.16);
  --good:#57c294; --good-soft:rgba(87,194,148,.15);
  --warn:#d9a94f; --warn-soft:rgba(217,169,79,.15);
  --shadow:0 1px 2px rgba(0,0,0,.5), 0 10px 28px -18px rgba(0,0,0,.8);
}

* { box-sizing:border-box; }
body {
  margin:0; background:var(--ground); color:var(--ink);
  font-family:var(--font-body); font-size:15px; line-height:1.55;
  -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums;
}
h1,h2,h3 { font-family:var(--font-display); margin:0; text-wrap:balance; }

.board { max-width:1180px; margin:0 auto; padding:40px 24px 80px; display:grid; grid-template-columns:264px 1fr; gap:40px; align-items:start; }
@media (max-width:900px){ .board{ grid-template-columns:1fr; gap:28px; padding:28px 18px 60px; } .rail{ position:static !important; } }

/* ---------------------------------------------------------------- rail */
.rail { position:sticky; top:28px; display:flex; flex-direction:column; gap:22px; }
.brand { display:flex; align-items:center; gap:11px; }
.brand__mark { width:34px; height:34px; border-radius:9px; background:var(--ours); color:#fff; display:grid; place-items:center; font-family:var(--font-display); font-weight:700; font-size:17px; flex:none; }
.brand__name { font-family:var(--font-display); font-weight:700; font-size:20px; letter-spacing:-.015em; line-height:1.1; }
.brand__sub { font-size:12.5px; color:var(--ink-3); letter-spacing:.01em; }

.live { display:flex; align-items:center; gap:7px; font-family:var(--font-mono); font-size:11.5px; color:var(--ink-2); }
.live__dot { width:7px; height:7px; border-radius:50%; background:var(--ours); box-shadow:0 0 0 3px var(--ours-soft); animation:breathe 2.4s ease-in-out infinite; }
@keyframes breathe { 50% { opacity:.35; } }
@media (prefers-reduced-motion: reduce){ .live__dot{ animation:none; } }

.counts { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
.count { background:var(--panel); padding:12px 13px; }
.count b { display:block; font-family:var(--font-display); font-size:24px; font-weight:600; letter-spacing:-.02em; line-height:1.15; }
.count span { font-size:11px; color:var(--ink-3); text-transform:uppercase; letter-spacing:.07em; }
.count.wide { grid-column:1 / -1; }
.count.cleared b { color:var(--good); }
.count.flight b { color:var(--ours); }

.legend { border:1px solid var(--line); border-radius:11px; background:var(--panel); padding:14px; }
.legend h4 { font-family:var(--font-display); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-3); margin:0 0 9px; }
.legend ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:7px; }
.legend li { display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--ink-2); }
.rule { font-size:12.5px; color:var(--ink-2); line-height:1.5; border-left:2px solid var(--ours); padding-left:11px; }
.rule b { color:var(--ink); font-weight:600; }

/* ---------------------------------------------------------------- main */
.headline { font-family:var(--font-display); font-size:19px; font-weight:500; line-height:1.42; letter-spacing:-.01em; margin:0 0 22px; max-width:62ch; }
.headline em { font-style:normal; color:var(--ours); }

.strip { margin-bottom:8px; }
.strip__bar { display:flex; gap:2px; height:26px; }
.seg { flex:1 1 0; min-width:3px; border-radius:2px; background:var(--sunk); border:1px solid var(--line); }
.seg.done { background:var(--good); border-color:var(--good); }
.seg.building { background:var(--ours); border-color:var(--ours); }
.seg.critique { background:var(--ours-soft); border-color:var(--ours); }
.seg.rework { background:var(--warn); border-color:var(--warn); }
.strip__meta { display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:11.5px; color:var(--ink-3); margin-top:7px; }

.wave { margin-top:34px; }
.wave__head { display:flex; align-items:baseline; gap:12px; }
.wave__rule { width:10px; height:10px; border-radius:2px; background:var(--line-2); flex:none; align-self:center; }
.wave.active .wave__rule { background:var(--ours); }
.wave.done .wave__rule { background:var(--good); }
.wave__title { font-size:15px; font-weight:600; letter-spacing:-.005em; }
.wave__count { margin-left:auto; font-family:var(--font-mono); font-size:12.5px; color:var(--ink-2); }
.wave__of { color:var(--ink-3); }
.wave__note { margin:6px 0 0 22px; font-size:13.5px; color:var(--ink-2); max-width:70ch; }

.rows { list-style:none; margin:12px 0 0; padding:0; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:var(--shadow); overflow:hidden; }
.row { display:flex; gap:12px; padding:13px 16px; }
.row + .row { border-top:1px solid var(--line); }
.row__dot { width:8px; height:8px; border-radius:50%; margin-top:8px; flex:none; background:var(--line-2); }
.row.done .row__dot { background:var(--good); }
.row.building .row__dot { background:var(--ours); box-shadow:0 0 0 4px var(--ours-soft); }
.row.critique .row__dot { background:var(--ours); box-shadow:0 0 0 4px var(--ours-soft); }
.row.rework .row__dot { background:var(--warn); box-shadow:0 0 0 4px var(--warn-soft); }
.row__main { min-width:0; flex:1; }
.row__head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.row__title { font-size:14.5px; font-weight:600; letter-spacing:-.005em; }
.row__note { margin:3px 0 0; font-size:13px; color:var(--ink-2); max-width:78ch; }
.row__verdict { margin:9px 0 0; padding:9px 12px; background:var(--panel-2); border:1px solid var(--line); border-left:2px solid var(--theirs); border-radius:0 7px 7px 0; font-size:13px; color:var(--ink-2); max-width:78ch; }
.row__verdictlabel { display:block; font-family:var(--font-display); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.09em; color:var(--theirs); margin-bottom:2px; }

.chip { font-family:var(--font-mono); font-size:10.5px; padding:2px 7px; border-radius:5px; border:1px solid var(--line-2); color:var(--ink-3); background:var(--panel-2); white-space:nowrap; }
.chip.done { color:var(--good); border-color:var(--good); background:var(--good-soft); }
.chip.building, .chip.critique { color:var(--ours); border-color:var(--ours); background:var(--ours-soft); }
.chip.rework { color:var(--warn); border-color:var(--warn); background:var(--warn-soft); }

.pips { display:inline-flex; gap:3px; align-items:center; }
.pip { width:7px; height:7px; border-radius:2px; display:block; }
.pip.reference { background:var(--theirs); }
.pip.ain { background:var(--ours); }
.pip.tie { background:var(--line-2); }

footer { margin-top:44px; padding-top:18px; border-top:1px solid var(--line); font-size:12.5px; color:var(--ink-3); max-width:74ch; }
footer code { font-family:var(--font-mono); font-size:11.5px; color:var(--ink-2); }
</style>

<div class="board">
  <aside class="rail">
    <div class="brand">
      <div class="brand__mark">A</div>
      <div>
        <div class="brand__name">Ain</div>
        <div class="brand__sub">Build board</div>
      </div>
    </div>
    <div class="live"><span class="live__dot"></span>updated ${esc(stamp.replace('T', ' ').slice(0, 16))} UTC</div>

    <div class="counts">
      <div class="count cleared"><b>${cleared}</b><span>cleared</span></div>
      <div class="count flight"><b>${inFlight}</b><span>in flight</span></div>
      <div class="count"><b>${all.length - cleared - inFlight}</b><span>queued</span></div>
      <div class="count"><b>${rounds}</b><span>critic rounds</span></div>
      ${Object.entries(state.stats || {}).map(([k, val]) => `<div class="count wide"><b>${esc(val)}</b><span>${esc(k)}</span></div>`).join('')}
    </div>

    <div class="legend">
      <h4>Round pips</h4>
      <ul>
        <li><span class="pips"><i class="pip reference"></i></span> critic chose HubSpot / Stripe</li>
        <li><span class="pips"><i class="pip ain"></i></span> critic chose Ain</li>
      </ul>
    </div>

    <p class="rule">A piece clears only when a critic with <b>fresh context</b> ran the real software, compared it blind against the reference product, and picked ours with <b>zero blocking issues</b>. Builders never grade their own work.</p>
  </aside>

  <main>
    <h1 class="headline">${esc(state.headline)}</h1>

    <div class="strip">
      <div class="strip__bar" role="img" aria-label="${cleared} of ${all.length} pieces cleared">${segments}</div>
      <div class="strip__meta"><span>${cleared} of ${all.length} pieces cleared</span><span>${sentBack} rework${sentBack === 1 ? '' : 's'} demanded</span></div>
    </div>

    ${state.waves.map(waveBand).join('')}

    <footer>
      Regenerated from <code>docs/progress.json</code> by <code>scripts/progress.mjs</code> on every wave.
      Each piece is owned by one builder working a disjoint set of directories, then handed to a critic
      that runs <code>scripts/verify.ts</code>, exercises the API, screenshots the UI in both themes, and
      writes a verdict. Losing sends the builder back with the single biggest gap named.
    </footer>
  </main>
</div>
`;

writeFileSync(join(root, 'docs/progress.html'), html);
console.log(`build board: ${cleared} cleared / ${inFlight} in flight / ${all.length} total, ${rounds} critic rounds`);
