#!/usr/bin/env node
/**
 * Screenshot a running Ain preview so a reviewer can actually look at it.
 *
 *   node scripts/shoot.mjs --url http://127.0.0.1:8811 --out .artifacts/shots \
 *        --routes /,/design,/contacts --themes light,dark --width 1512 --height 950
 *
 * Signs in to the demo workspace first, waits for the app to settle, and writes
 * <out>/<theme>-<route>.png plus a <out>/report.txt of any console errors.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bool, int, parseArgs, text } from './lib/args.mjs';

// `--full` is the boolean here, and the same parser as preview.mjs reads it, so
// `--routes /billing --full` and `--full --routes /billing` are one command.
const { options } = parseArgs(process.argv.slice(2), { booleans: ['full'] });
const url = text(options, 'url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const out = text(options, 'out', '.artifacts/shots');
const routes = text(options, 'routes', '/').split(',').map((r) => r.trim()).filter(Boolean);
const themes = text(options, 'themes', 'light,dark').split(',').map((t) => t.trim());
const width = int(options, 'width', 1512);
const height = int(options, 'height', 950);
const full = bool(options, 'full');

mkdirSync(out, { recursive: true });
const problems = [];

const browser = await chromium.launch();
try {
  await fetch(`${url}/api/v1/health`).catch(() => { throw new Error(`Nothing is serving ${url}. Start it with scripts/preview.mjs first.`); });

  for (const theme of themes) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme === 'dark' ? 'dark' : 'light' });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${theme}] console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`[${theme}] pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) problems.push(`[${theme}] ${r.status()} ${r.url().replace(url, '')}`); });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { localStorage.setItem('ain.theme', JSON.stringify(t)); }, theme);
    await page.request.post(`${url}/api/v1/auth/demo`);

    for (const route of routes) {
      const name = `${theme}${route.replace(/\//g, '_') || '_root'}`.replace(/[^a-z0-9_-]/gi, '');
      await page.goto(url + route, { waitUntil: 'networkidle' }).catch(() => page.goto(url + route));
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
      const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
      if (/^\s*$/.test(text)) problems.push(`[${theme}] ${route} rendered an empty page`);
      console.log(`shot ${join(out, `${name}.png`)}  (${text.split('\n')[0].slice(0, 70)})`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

writeFileSync(join(out, 'report.txt'), problems.length ? problems.join('\n') : 'no console errors, no failed API calls, no blank pages');
console.log(problems.length ? `\n${problems.length} problem(s):\n` + problems.slice(0, 40).join('\n') : '\nclean: no console errors, no failed requests, no blank pages');
