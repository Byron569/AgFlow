'use strict';

/**
 * 便携数据迁移（P2 迁移向导）：扫描只读、导入绝不覆盖。
 * 纯 fs 模块（src/main/portableData.ts），临时目录实测。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { scanPortableSource, importPortableItems } = loadTs('src/main/portableData.ts');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agflow-portable-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('扫描：config + 旧 config 指向的 harnessHome 里的 roster/templates 全部命中', () => {
  const root = tmpdir();
  const oldHome = path.join(root, 'old-hive');
  const src = path.join(root, 'old-data');
  const target = path.join(root, 'new-data');
  const targetHome = path.join(root, 'new-hive');
  write(path.join(src, 'config.json'), JSON.stringify({ harnessHome: oldHome }));
  write(path.join(oldHome, 'roster.json'), '{"a":1}');
  write(path.join(oldHome, 'templates.json'), '[{"id":"t1"}]');

  const scan = scanPortableSource(src, { dataDir: target, harnessHome: targetHome });
  assert.equal(scan.items.length, 3);
  const byName = Object.fromEntries(scan.items.map((i) => [i.name, i]));
  assert.equal(byName['config.json'].from, path.join(src, 'config.json'));
  assert.equal(byName['config.json'].to, path.join(target, 'config.json'));
  assert.equal(byName['roster.json'].from, path.join(oldHome, 'roster.json'));
  assert.equal(byName['roster.json'].to, path.join(targetHome, 'roster.json'));
  assert.equal(byName['templates.json'].to, path.join(targetHome, 'templates.json'));
  assert.equal(byName['roster.json'].targetExists, false);
  assert.ok(byName['roster.json'].sizeBytes > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('扫描：便携布局 <源>/hive/roster.json 也能命中；未配置 hive 根时 roster 落位失败', () => {
  const root = tmpdir();
  const src = path.join(root, 'usb-data');
  write(path.join(src, 'hive', 'roster.json'), '{}');
  assert.equal(fs.existsSync(path.join(src, 'config.json')), false);

  const withHome = scanPortableSource(src, { dataDir: path.join(root, 'd'), harnessHome: path.join(root, 'h') });
  assert.equal(withHome.items.length, 1);
  assert.equal(withHome.items[0].name, 'roster.json');
  assert.equal(withHome.items[0].from, path.join(src, 'hive', 'roster.json'));

  const noHome = scanPortableSource(src, { dataDir: path.join(root, 'd'), harnessHome: null });
  assert.equal(noHome.items.length, 0);
  assert.deepEqual(
    noHome.skipped.map((s) => [s.name, s.reason]),
    [['config.json', 'missing'], ['roster.json', 'no-harness-home'], ['templates.json', 'missing']]
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('扫描：源 == 目标（同一数据目录）不产生迁移项', () => {
  const root = tmpdir();
  write(path.join(root, 'config.json'), '{}');
  const scan = scanPortableSource(root, { dataDir: root, harnessHome: null });
  assert.equal(scan.items.length, 0);
  assert.ok(scan.skipped.some((s) => s.name === 'config.json' && s.reason === 'same-file'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('导入：逐文件复制且目标已存在一律跳过（内容不被覆盖）', () => {
  const root = tmpdir();
  const src = path.join(root, 'src');
  const dst = path.join(root, 'dst');
  const home = path.join(root, 'home');
  write(path.join(src, 'config.json'), '{"v":"old"}');
  write(path.join(src, 'roster.json'), '{"v":"old-roster"}');
  write(path.join(dst, 'config.json'), '{"v":"new"}'); // 已存在 → 跳过

  const scan = scanPortableSource(src, { dataDir: dst, harnessHome: home });
  const res = importPortableItems(scan.items);
  assert.equal(res.ok, true);
  assert.deepEqual(res.copied, ['roster.json']);
  assert.deepEqual(res.skippedExisting, ['config.json']);
  assert.equal(fs.readFileSync(path.join(dst, 'config.json'), 'utf8'), '{"v":"new"}');
  assert.equal(fs.readFileSync(path.join(home, 'roster.json'), 'utf8'), '{"v":"old-roster"}');
  // 目标目录原本不存在 → 自动创建；不留 tmp 半成品
  assert.deepEqual(fs.readdirSync(home), ['roster.json']);
  assert.equal(fs.readdirSync(dst).filter((f) => f.includes('agflow-import')).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('导入：源文件在导入前消失 → 记为 errors，不产生目标文件', () => {
  const root = tmpdir();
  const src = path.join(root, 'src');
  const dst = path.join(root, 'dst');
  const configPath = path.join(src, 'config.json');
  write(configPath, '{}');
  const scan = scanPortableSource(src, { dataDir: dst, harnessHome: null });
  fs.rmSync(configPath); // 扫描后、导入前消失（竞态）
  const res = importPortableItems(scan.items);
  assert.equal(res.ok, false);
  assert.equal(res.copied.length, 0);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].name, 'config.json');
  assert.equal(fs.existsSync(path.join(dst, 'config.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});