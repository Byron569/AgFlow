'use strict';

// P1-3：历史名称迁移（nameMigration.ts）——扫描 / 备份 / 替换 + 旧名形象兼容。
// 迁移模块是纯 fs（不 import electron），直接装载；末尾做一轮静态接线断言。

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { scanLegacyNames, applyLegacyNameMigration } = loadTs('src/main/nameMigration.ts');
const { LEGACY_GOD_NAME, LEGACY_CHARACTER_KEYS } = loadTs('src/shared/legacyNames.ts');

function seedHive({ godName = 'Michael' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'munder-migrate-'));
  mkdirSync(join(home, 'agents', 'jim-1', 'inbox', '.done'), { recursive: true });
  mkdirSync(join(home, 'agents', 'jim-1', 'outbox', '.sent'), { recursive: true });
  writeFileSync(join(home, 'board.md'), '# Board\nMichael assigned the sprint.\n');
  writeFileSync(join(home, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', notes: 'ping Michael' }] }));
  writeFileSync(join(home, 'agents', 'jim-1', 'memory.md'), 'Michael prefers short reports.\n');
  writeFileSync(join(home, 'agents', 'jim-1', 'inbox', 'm1.json'), JSON.stringify({ from: 'michael-voice', text: 'Michael asked for the numbers' }));
  writeFileSync(join(home, 'agents', 'jim-1', 'inbox', '.done', 'm0.json'), JSON.stringify({ text: 'an old Michael note' }));
  writeFileSync(join(home, 'agents', 'jim-1', 'outbox', '.sent', 'o1.json'), JSON.stringify({ text: 'Michael: done' }));
  // 不在扫描面里：cursor 与 registry 都不被文本替换触碰。
  writeFileSync(join(home, 'agents', 'jim-1', 'cursor.json'), JSON.stringify({ note: 'Michael' }));
  writeFileSync(join(home, 'registry.json'), JSON.stringify({
    godId: 'god-1',
    agents: { 'god-1': { name: godName }, 'jim-1': { name: 'Jim' } }
  }));
  return home;
}

const cleanup = (home) => rmSync(home, { recursive: true, force: true });

test('scan reports the legacy god default and every text hit (outbox included, machines excluded)', () => {
  const home = seedHive();
  try {
    const scan = scanLegacyNames(home);
    assert.equal(scan.godName, LEGACY_GOD_NAME);
    assert.equal(scan.godOnLegacyDefault, true);
    assert.equal(scan.replacementTarget, '败龙');
    assert.deepEqual(scan.files.map((f) => f.rel).sort(), [
      'agents/jim-1/inbox/.done/m0.json',
      'agents/jim-1/inbox/m1.json',
      'agents/jim-1/memory.md',
      'agents/jim-1/outbox/.sent/o1.json',
      'board.md',
      'tasks.json'
    ]);
    // board 1 + tasks 1 + memory 1 + m1 1 + m0 1 + o1 1；'michael-voice' 小写不命中。
    assert.equal(scan.totalHits, 6);
  } finally { cleanup(home); }
});

test('apply backs up first, replaces every hit, and leaves non-target files alone', () => {
  const home = seedHive();
  try {
    const res = applyLegacyNameMigration(home, '败龙');
    assert.equal(res.ok, true);
    assert.equal(res.filesChanged, 6);
    assert.equal(res.totalReplaced, 6);
    assert.ok(res.backupDir && res.backupDir.startsWith('backups/name-migration-'), '备份目录必须落在 backups/ 下');
    // 备份里是改动前的原文 + manifest。
    const man = JSON.parse(readFileSync(join(home, res.backupDir, 'manifest.json'), 'utf8'));
    assert.equal(man.from, LEGACY_GOD_NAME);
    assert.equal(man.to, '败龙');
    assert.equal(man.files.length, 6);
    assert.match(readFileSync(join(home, res.backupDir, 'board.md'), 'utf8'), /Michael/);
    // 正式文件已替换；机器 actor id 原样保留。
    assert.match(readFileSync(join(home, 'board.md'), 'utf8'), /败龙 assigned/);
    assert.match(readFileSync(join(home, 'agents/jim-1/inbox/m1.json'), 'utf8'), /"from":"michael-voice"/);
    assert.match(readFileSync(join(home, 'agents/jim-1/inbox/m1.json'), 'utf8'), /败龙 asked/);
    // 不在扫描面的文件原样保留。
    assert.match(readFileSync(join(home, 'agents/jim-1/cursor.json'), 'utf8'), /Michael/);
    assert.match(readFileSync(join(home, 'registry.json'), 'utf8'), /"name":"Michael"/);
    // 再扫一遍：清零。
    assert.equal(scanLegacyNames(home).totalHits, 0);
  } finally { cleanup(home); }
});

test('a renamed god syncs text to the custom name instead of the new default', () => {
  const home = seedHive({ godName: '老王' });
  try {
    const scan = scanLegacyNames(home);
    assert.equal(scan.godOnLegacyDefault, false);
    assert.equal(scan.replacementTarget, '老王');
    applyLegacyNameMigration(home, '老王');
    assert.match(readFileSync(join(home, 'agents/jim-1/memory.md'), 'utf8'), /老王 prefers/);
  } finally { cleanup(home); }
});

test('with nothing to migrate, apply is a no-op and creates no backup', () => {
  const home = seedHive({ godName: '败龙' });
  try {
    for (const f of ['board.md', 'tasks.json', 'agents/jim-1/memory.md',
                     'agents/jim-1/inbox/m1.json', 'agents/jim-1/inbox/.done/m0.json',
                     'agents/jim-1/outbox/.sent/o1.json']) {
      writeFileSync(join(home, f), 'clean\n');
    }
    const res = applyLegacyNameMigration(home, '败龙');
    assert.equal(res.ok, true);
    assert.equal(res.filesChanged, 0);
    assert.equal(res.backupDir, null);
    assert.ok(!existsSync(join(home, 'backups')), '零改动不应产生备份目录');
  } finally { cleanup(home); }
});

test('legacy cast names still resolve to the same sprite look (P0-D-2 compat map)', () => {
  assert.equal(Object.keys(LEGACY_CHARACTER_KEYS).length, 15);
  assert.equal(LEGACY_CHARACTER_KEYS.michael, 'lead');
  assert.equal(LEGACY_CHARACTER_KEYS.meredith, 'admin');
  const cast = readFileSync('src/renderer/src/scene/office/cast.ts', 'utf8');
  assert.match(cast, /export const LEGACY_CHARACTER_KEYS/);
  const useHive = readFileSync('src/renderer/src/hooks/useHive.ts', 'utf8');
  assert.match(useHive, /LEGACY_CHARACTER_KEYS\[q\]/);
});

test('wiring: IPC, preload, and Settings all expose the migration', () => {
  const index = readFileSync('src/main/index.ts', 'utf8');
  assert.match(index, /ipcMain\.handle\('legacyNames:scan'/);
  assert.match(index, /ipcMain\.handle\('legacyNames:apply'/);
  assert.match(index, /hive\.renameAgent\(godId, DEFAULT_GOD_NAME\)/, '旧默认名必须经 hive.renameAgent 改名');

  const preload = readFileSync('src/preload/index.ts', 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('legacyNames:scan'\)/);
  assert.match(preload, /ipcRenderer\.invoke\('legacyNames:apply'\)/);

  const settings = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8');
  assert.match(settings, /<NameMigrationSection \/>/);
});