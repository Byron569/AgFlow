'use strict';

/**
 * 便携增强（P2）纯逻辑：数据目录三档来源（AGFLOW_DATA_DIR / Windows portable
 * 的 PORTABLE_EXECUTABLE_DIR / agflow-portable.marker）+ 引擎随行目录
 *（PATH 置顶 + 探测候选）。文件系统副作用（setPath/mkdir）在 main 侧，不在
 * 本测试范围内。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  PORTABLE_DATA_DIR_NAME,
  resolvePortableDataDir,
  withEnginesPath,
  enginesBinCandidates
} = loadTs('src/shared/portable.ts');

test('数据目录：env 绝对路径最高优先（其余来源全在场也不动摇）', () => {
  const res = resolvePortableDataDir(
    {
      envDataDir: '/tmp/agflow-data',
      portableExeDir: 'D:\\U盘\\AgFlow',
      markerDirs: [{ dir: '/Volumes/USB/AgFlow', hasMarker: true }]
    },
    'darwin'
  );
  assert.deepEqual(res, { dataDir: '/tmp/agflow-data', source: 'env' });
});

test('数据目录：env 相对路径被拒绝（会随 CWD 漂移），回退下一档', () => {
  const res = resolvePortableDataDir(
    { envDataDir: 'relative/data', portableExeDir: 'D:\\U盘\\AgFlow' },
    'win32'
  );
  assert.equal(res.source, 'win-portable');
  assert.equal(res.dataDir, 'D:\\U盘\\AgFlow\\data');
  assert.equal(PORTABLE_DATA_DIR_NAME, 'data');
});

test('数据目录：Windows portable 注入的程序目录 → 程序目录/data', () => {
  const res = resolvePortableDataDir({ portableExeDir: 'E:\\' }, 'win32');
  assert.deepEqual(res, { dataDir: 'E:\\data', source: 'win-portable' });
});

test('数据目录：无 env/portable 时，带标记文件的程序目录 → 程序目录/data', () => {
  const res = resolvePortableDataDir(
    {
      markerDirs: [
        { dir: '/Applications', hasMarker: false },
        { dir: '/Volumes/U盘/AgFlow', hasMarker: true }
      ]
    },
    'darwin'
  );
  assert.deepEqual(res, { dataDir: '/Volumes/U盘/AgFlow/data', source: 'marker' });
});

test('数据目录：全无 → null（非便携，走 Electron 默认目录）', () => {
  assert.equal(resolvePortableDataDir({}, 'darwin'), null);
  assert.equal(resolvePortableDataDir({ markerDirs: [{ dir: '/x', hasMarker: false }] }, 'linux'), null);
  // env 为空白串同样视为未设置
  assert.equal(resolvePortableDataDir({ envDataDir: '   ' }, 'linux'), null);
});

test('引擎随行目录：置顶 + 去重（posix）', () => {
  const got = withEnginesPath('/usr/bin:/bin:/data/engines', '/data/engines', 'darwin');
  assert.equal(got, '/data/engines:/usr/bin:/bin');
});

test('引擎随行目录：已置顶则不重复（重复 spawn 的 PATH 不增长）', () => {
  const once = withEnginesPath('/usr/bin', '/data/engines', 'linux');
  const twice = withEnginesPath(once, '/data/engines', 'linux');
  assert.equal(twice, once);
});

test('引擎随行目录：Windows 分隔符 ; 且大小写不敏感去重', () => {
  const got = withEnginesPath('C:\\Windows;C:\\U盘\\AgFlow\\Data\\Engines', 'C:\\U盘\\AgFlow\\Data\\Engines', 'win32');
  assert.equal(got, 'C:\\U盘\\AgFlow\\Data\\Engines;C:\\Windows');
});

test('引擎随行目录：未设置（null）零变化；空 PATH → 仅随行目录', () => {
  assert.equal(withEnginesPath('/usr/bin', null, 'linux'), '/usr/bin');
  assert.equal(withEnginesPath('', '/data/engines', 'linux'), '/data/engines');
});

test('引擎探测候选：posix 单一路径；Windows 按 .exe/.cmd/.bat + 裸名', () => {
  assert.deepEqual(enginesBinCandidates('/data/engines', 'claude', 'linux'), ['/data/engines/claude']);
  assert.deepEqual(enginesBinCandidates('D:\\data\\engines', 'claude', 'win32'), [
    'D:\\data\\engines\\claude.exe',
    'D:\\data\\engines\\claude.cmd',
    'D:\\data\\engines\\claude.bat',
    'D:\\data\\engines\\claude'
  ]);
});

test('引擎探测候选：空名/带路径分隔符的输入不产生候选', () => {
  assert.deepEqual(enginesBinCandidates('/data/engines', '', 'linux'), []);
  assert.deepEqual(enginesBinCandidates('/data/engines', './bin/claude', 'linux'), []);
  assert.deepEqual(enginesBinCandidates('/data/engines', 'a\\b', 'win32'), []);
});