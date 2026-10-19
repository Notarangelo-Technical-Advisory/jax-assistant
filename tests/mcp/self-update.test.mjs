// The journal job keeps the copy of jax-assistant on Jack's Mac up to date
// (functions/src/mcp/self-update.ts). Run with `npm run test:mcp`. Each test
// builds a real GitHub stand-in (a bare repo) and a copy of it, as on the Mac.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// src/mcp is run with tsx and never compiled, so tsx loads it here too.
const functionsDir = new URL('../../functions/', import.meta.url).pathname;
const { require: tsxRequire } = createRequire(`${functionsDir}package.json`)('tsx/cjs/api');
const { selfUpdate } = tsxRequire(`${functionsDir}src/mcp/self-update.ts`, import.meta.url);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf-8' }).trim();

/** A bare "GitHub" repo with one commit on main, a copy of it as on the Mac, and a second working copy to push new commits from. */
function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'self-update-'));
  const origin = join(dir, 'origin.git');
  const author = join(dir, 'author');
  const mac = join(dir, 'mac');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(dir, 'clone', '--quiet', origin, author);
  mkdirSync(join(author, 'functions'));
  writeFileSync(join(author, 'functions', 'package-lock.json'), '{"v":1}\n');
  writeFileSync(join(author, 'README.md'), 'one\n');
  git(author, 'add', '.');
  git(author, 'commit', '--quiet', '-m', 'first');
  git(author, 'push', '--quiet', 'origin', 'HEAD:main');
  git(dir, 'clone', '--quiet', origin, mac);
  return { author, mac };
}

/** A new commit on GitHub's main, changing `file`. */
function publish(author, file, text) {
  writeFileSync(join(author, file), text);
  git(author, 'add', '.');
  git(author, 'commit', '--quiet', '-m', `change ${file}`);
  git(author, 'push', '--quiet', 'origin', 'HEAD:main');
}

const noInstall = () => assert.fail('npm install should not run');

describe('self-update', () => {
  it('brings main up to date with GitHub, so the next run uses the fix', () => {
    const { author, mac } = setUp();
    publish(author, 'README.md', 'two\n');

    const result = selfUpdate(mac, noInstall);

    assert.equal(result.updated, true);
    assert.match(result.note, /updated .* \(1 files\)/);
    assert.equal(git(mac, 'rev-parse', 'HEAD'), git(author, 'rev-parse', 'HEAD'));
  });

  it('runs npm install in functions only when the lock file changed', () => {
    const { author, mac } = setUp();
    publish(author, 'functions/package-lock.json', '{"v":2}\n');
    const installed = [];

    selfUpdate(mac, (dir) => installed.push(dir));

    assert.deepEqual(installed, [join(mac, 'functions')]);
  });

  it('says so and changes nothing when already up to date', () => {
    const { mac } = setUp();
    assert.deepEqual(selfUpdate(mac, noInstall), { updated: false, note: 'already up to date' });
  });

  it('leaves the copy alone when Jack is working on another branch', () => {
    const { author, mac } = setUp();
    git(mac, 'checkout', '--quiet', '-b', 'feat/something');
    publish(author, 'README.md', 'two\n');

    const result = selfUpdate(mac, noInstall);

    assert.equal(result.updated, false);
    assert.match(result.note, /on branch feat\/something, not main/);
  });

  it('leaves the copy alone when it has changes not yet committed', () => {
    const { author, mac } = setUp();
    writeFileSync(join(mac, 'README.md'), 'my edit\n');
    publish(author, 'README.md', 'two\n');
    const before = git(mac, 'rev-parse', 'HEAD');

    const result = selfUpdate(mac, noInstall);

    assert.match(result.note, /changes not yet committed/);
    assert.equal(git(mac, 'rev-parse', 'HEAD'), before);
  });

  it('leaves main alone when it has commits that are not on GitHub', () => {
    const { author, mac } = setUp();
    writeFileSync(join(mac, 'local.txt'), 'mine\n');
    git(mac, 'add', '.');
    git(mac, 'commit', '--quiet', '-m', 'local only');
    publish(author, 'README.md', 'two\n');
    const before = git(mac, 'rev-parse', 'HEAD');

    const result = selfUpdate(mac, noInstall);

    assert.match(result.note, /cannot fast-forward/);
    assert.equal(git(mac, 'rev-parse', 'HEAD'), before);
  });

  it('reports a failure instead of throwing, so the journal still runs', () => {
    const result = selfUpdate(join(tmpdir(), 'no-such-repo-here'), noInstall);
    assert.equal(result.updated, false);
    assert.match(result.note, /^could not update/);
  });
});
