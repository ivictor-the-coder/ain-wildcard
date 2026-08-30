#!/usr/bin/env node
/** Render docs/progress.json into a self-contained live progress page. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(readFileSync(join(root, 'docs/progress.json'), 'utf8'));
const stamp = state.updated || new Date().toISOString();

const STATUS = {
  queued:   { label: 'Queued',    cls: 'queued' },
  building: { label: 'Building',  cls: 'building' },
  critique: { label: 'In review', cls: 'critique' },
  rework:   { label: 'Rework',    cls: 'rework' },
  done:     { label: 'Passed',    cls: 'done' },
};

const all = state.waves.flatMap((w) => w.pieces);
const done = all.filter((p) => p.status === 'done').length;
const pct = all.length ? Math.round((done / all.length) * 100) : 0;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const piece = (p) => {
  const s = STATUS[p.status] || STATUS.queued;
  return `<li class="piece ${s.cls}">
      <span class="dot" aria-hidden="true"></span>
      <div class="piece__body">
        <div class="piece__head"><span class="piece__title">${esc(p.title)}</span>
          <span class="tag ${s.cls}">${s.label}</span>
          ${p.rounds ? `<span class="rounds" title="critic rounds">${p.rounds} round${p.rounds === 1 ? '' : 's'}</span>` : ''}
        </div>
        ${p.note ? `<p class="piece__note">${esc(p.note)}</p>` : ''}
        ${p.verdict ? `<p class="verdict"><b>Critic:</b> ${esc(p.verdict)}</p>` : ''}
      </div>
    </li>`;
};

const wave = (w) => `<section class="wave ${w.status}">
    <header class="wave__head">
      <h2>${esc(w.name)}</h2>
      <span class="tag ${w.status === 'done' ? 'done' : w.status === 'active' ? 'building' : 'queued'}">${w.status === 'done' ? 'Complete' : w.status === 'active' ? 'In flight' : 'Queued'}</span>
    </header>
    ${w.note ? `<p class="wave__note">${esc(w.note)}</p>` : ''}
    <ul class="pieces">${w.pieces.map(piece).join('')}</ul>
  </section>`;

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ain — build progress</title>
<style>
:root{--bg:#0c0f15;--panel:#14181f;--panel2:#1a1f28;--line:#242c37;--line2:#333d4c;--ink:#e8ecf3;--ink2:#a3adbf;--ink3:#7d8799;--brand:#8478ef;--green:#4dcb8f;--amber:#f0b64d;--blue:#6aa8f5;--pink:#f07ab5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.wrap{max-width:1000px;margin:0 auto;padding:48px 24px 96px}
header.top{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:8px}
.mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#6a5ce8,#12a0a0);display:grid;place-items:center;font-weight:700;color:#fff;flex:none}
h1{font-size:24px;margin:0;letter-spacing:-.02em}
.sub{color:var(--ink2);font-size:13px;margin-top:3px}
.stamp{margin-left:auto;color:var(--ink3);font-size:12px;text-align:right}
.headline{margin:22px 0 26px;padding:16px 18px;background:var(--panel);border:1px solid var(--line);border-radius:12px;font-size:15px;color:var(--ink)}
.bar{height:8px;border-radius:99px;background:var(--panel2);overflow:hidden;margin:18px 0 8px;border:1px solid var(--line)}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#6a5ce8,#34c4c4);width:${pct}%;transition:width .5s}
.barmeta{display:flex;justify-content:space-between;color:var(--ink2);font-size:12.5px;margin-bottom:30px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:34px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:22px;letter-spacing:-.02em}
.stat span{color:var(--ink3);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.wave{margin-bottom:28px;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.wave__head{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line)}
.wave__head h2{font-size:15px;margin:0;letter-spacing:-.01em}
.wave__note{margin:0;padding:12px 18px 0;color:var(--ink2);font-size:13px}
.pieces{list-style:none;margin:0;padding:10px 6px 12px}
.piece{display:flex;gap:12px;padding:10px 12px;border-radius:9px}
.piece+.piece{margin-top:1px}
.piece:hover{background:var(--panel2)}
.dot{width:8px;height:8px;border-radius:50%;margin-top:7px;flex:none;background:var(--line2)}
.piece.done .dot{background:var(--green)}
.piece.building .dot{background:var(--brand);box-shadow:0 0 0 4px rgba(132,120,239,.16);animation:p 1.6s ease-in-out infinite}
.piece.critique .dot{background:var(--blue);box-shadow:0 0 0 4px rgba(106,168,245,.14);animation:p 1.6s ease-in-out infinite}
.piece.rework .dot{background:var(--amber)}
@keyframes p{50%{opacity:.4}}
.piece__body{min-width:0;flex:1}
.piece__head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.piece__title{font-weight:520}
.piece__note{margin:2px 0 0;color:var(--ink2);font-size:12.5px}
.verdict{margin:5px 0 0;color:var(--ink2);font-size:12.5px;padding:7px 10px;background:var(--bg);border:1px solid var(--line);border-left:2px solid var(--pink);border-radius:6px}
.tag{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line2);color:var(--ink2)}
.tag.done{color:var(--green);border-color:rgba(77,203,143,.4);background:rgba(77,203,143,.1)}
.tag.building{color:var(--brand);border-color:rgba(132,120,239,.45);background:rgba(132,120,239,.12)}
.tag.critique{color:var(--blue);border-color:rgba(106,168,245,.4);background:rgba(106,168,245,.1)}
.tag.rework{color:var(--amber);border-color:rgba(240,182,77,.4);background:rgba(240,182,77,.1)}
.rounds{font-size:11.5px;color:var(--ink3)}
footer{color:var(--ink3);font-size:12px;margin-top:34px;text-align:center}
</style>
</head>
<body><div class="wrap">
<header class="top">
  <div class="mark">◈</div>
  <div><h1>Ain</h1><div class="sub">The AI services platform that runs a business end to end</div></div>
  <div class="stamp">Updated<br>${esc(stamp.replace('T', ' ').slice(0, 16))} UTC</div>
</header>
<div class="headline">${esc(state.headline)}</div>
<div class="bar"><i></i></div>
<div class="barmeta"><span>${done} of ${all.length} pieces passed their critic</span><span>${pct}%</span></div>
<div class="stats">
  ${Object.entries(state.stats).map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}
</div>
${state.waves.map(wave).join('')}
<footer>A piece is only "Passed" when a fresh critic ran the real thing, compared it blind against HubSpot and Stripe, and picked ours.</footer>
</div></body></html>`;

writeFileSync(join(root, 'docs/progress.html'), html);
console.log(`progress: ${done}/${all.length} pieces (${pct}%)`);
