/**
 * The command line the build scripts read.
 *
 * `node scripts/preview.mjs --port 8975 --name rev --fresh` came up on the
 * database it was told to delete: the old parser decided what a flag meant by
 * looking at the token after it, so a boolean written last on the line — with
 * no token after it — parsed as `undefined`, and `if (args.fresh !== undefined)`
 * skipped the delete without a word. These pin the rule that prevents it: a
 * boolean flag never consumes the next token, and a flag that was passed is
 * never indistinguishable from a flag that was not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bool, int, parseArgs, text } from '../scripts/lib/args.mjs';

const preview = (argv: string[]) => parseArgs(argv, { booleans: ['fresh', 'skipBuild', 'verbose'] }).options;

describe('script flags', () => {
  test('a boolean flag written last on the line is still the flag', () => {
    const options = preview(['--port', '8975', '--name', 'rev', '--fresh']);
    assert.equal(options.fresh, true);
    assert.equal(bool(options, 'fresh'), true);
    assert.equal(text(options, 'name', 'preview'), 'rev');
    assert.equal(int(options, 'port', 8800), 8975);
  });

  test('and means the same thing written first', () => {
    const first = preview(['--fresh', '--port', '8975', '--name', 'rev']);
    const last = preview(['--port', '8975', '--name', 'rev', '--fresh']);
    assert.deepEqual({ ...first }, { ...last });
  });

  test('a boolean flag never eats the value of the flag after it', () => {
    const options = preview(['--fresh', '8975']);
    assert.equal(options.fresh, true);
    assert.deepEqual(parseArgs(['--fresh', '8975'], { booleans: ['fresh'] }).positional, ['8975']);
  });

  test('every flag that was passed reads as passed, whatever followed it', () => {
    for (const argv of [['--fresh'], ['--fresh', '--verbose'], ['--verbose', '--fresh'], ['--fresh=true']]) {
      assert.equal(bool(preview(argv), 'fresh'), true, argv.join(' '));
    }
    assert.equal(bool(preview([]), 'fresh'), false);
    assert.equal(bool(preview(['--fresh=false']), 'fresh'), false, 'and one written off explicitly is off');
  });

  test('a value flag takes the next token, and only the next token', () => {
    const options = preview(['--name', 'rev-pay', '--db', 'memory', '--port', '8975']);
    assert.equal(text(options, 'name', 'preview'), 'rev-pay');
    assert.equal(text(options, 'db', ''), 'memory');
    assert.equal(int(options, 'port', 8800), 8975);
    assert.equal(text(options, 'missing', 'fallback'), 'fallback');
    assert.equal(int(options, 'missing', 8800), 8800);
  });

  test('--flag=value is the same as --flag value', () => {
    assert.equal(text(preview(['--name=rev']), 'name', 'preview'), 'rev');
    assert.equal(int(preview(['--port=8975']), 'port', 8800), 8975);
  });

  test('a value flag left without a value says so rather than inventing one', () => {
    const options = preview(['--port']);
    assert.throws(() => text(options, 'port', 'x'), /--port needs a value/);
    assert.throws(() => int(preview(['--port', 'eight']), 'port', 8800), /whole number/);
  });

  test('everything after -- is a positional argument, flag-shaped or not', () => {
    const { options, positional } = parseArgs(['--name', 'rev', '--', '--fresh', 'x'], { booleans: ['fresh'] });
    assert.equal(text(options, 'name', 'preview'), 'rev');
    assert.equal(bool(options, 'fresh'), false);
    assert.deepEqual(positional, ['--fresh', 'x']);
  });

  test('shoot.mjs reads --full the same way', () => {
    const shoot = (argv: string[]) => parseArgs(argv, { booleans: ['full'] }).options;
    assert.equal(bool(shoot(['--routes', '/billing', '--full']), 'full'), true);
    assert.equal(bool(shoot(['--full', '--routes', '/billing']), 'full'), true);
    assert.equal(text(shoot(['--full', '--routes', '/billing']), 'routes', '/'), '/billing');
    assert.equal(bool(shoot(['--routes', '/billing']), 'full'), false);
  });

  test('both scripts parse through it, with no lookahead of their own', () => {
    for (const file of ['scripts/preview.mjs', 'scripts/shoot.mjs']) {
      const source = readFileSync(file, 'utf8');
      assert.match(source, /from '\.\/lib\/args\.mjs'/, `${file} parses its flags through the shared parser`);
      assert.doesNotMatch(
        source,
        /argv\[i \+ 1\]|all\[i \+ 1\]|indexOf\(`--/,
        `${file} decides a flag by looking at the token after it, which is the bug`,
      );
    }
  });
});
