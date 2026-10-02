// Publishing invariants: catch broken links, identity changes and extra permissions.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const script = read('./mad-schedule-exporter.user.js');
const header = script.match(/^\/\/ ==UserScript==\n([\s\S]*?)\/\/ ==\/UserScript==/);
assert.ok(header, 'Userscript metadata must be at the start of the installable file');
const metadata = new Map();
for (const [, key, value] of header[1].matchAll(/^\/\/[ \t]+@(\S+)[ \t]*(.*?)[ \t]*$/gm)) {
  metadata.set(key, [...(metadata.get(key) || []), value]);
}
const value = key => {
  assert.equal(metadata.get(key)?.length, 1, `Expected exactly one @${key}`);
  return metadata.get(key)[0];
};

test('published metadata keeps installed identity and matches repository version/license', () => {
  const pkg = JSON.parse(read('./package.json'));
  assert.equal(value('name'), 'MadSchedule Exporter');
  assert.equal(value('namespace'), 'mad-schedule');
  assert.equal(value('version'), pkg.version);
  assert.equal(value('license'), pkg.license);
  assert.match(read('./LICENSE'), /^MIT License\n/);
  assert.match(read('./CHANGELOG.md'), new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')} —`, 'm'));
  assert.ok(value('description'));
  assert.ok(value('description:zh-CN'));
});

test('install/update/support links point to the standalone repository', () => {
  const repo = 'https://github.com/zzzhxxx/madschedule-exporter';
  const raw = 'https://raw.githubusercontent.com/zzzhxxx/madschedule-exporter/main/mad-schedule-exporter.user.js';
  assert.equal(value('homepageURL'), repo);
  assert.equal(value('supportURL'), `${repo}/issues`);
  assert.equal(value('updateURL'), raw);
  assert.equal(value('downloadURL'), raw);
  assert.ok(read('./README.md').includes(raw));
});

test('distribution needs no remote runtime code or privileged grants and targets only schedule paths', () => {
  assert.deepEqual(metadata.get('match'), [
    'https://mumaaenroll.services.wisc.edu/courses-schedule',
    'https://mumaaenroll.services.wisc.edu/courses-schedule/',
  ]);
  assert.equal(value('grant'), 'none');
  assert.equal(value('run-at'), 'document-idle');
  assert.ok(metadata.has('noframes'));
  for (const key of ['require', 'resource', 'connect', 'include']) {
    assert.equal(metadata.has(key), false, `Unexpected @${key}`);
  }
  assert.ok(Buffer.byteLength(script, 'utf8') < 2 * 1024 * 1024);
});
