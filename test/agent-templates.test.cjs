'use strict';

// P0-D-3 的 P1 续作：自定义角色模板（harnessHome/templates.json）。
// 存储层是纯 fs 模块（不 import electron），这里直接装载测试其消毒/落盘行为；
// 末尾再做一轮 IPC / preload / 模态的静态接线断言（同 hire-import 的风格）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { readAgentTemplates, saveAgentTemplate, deleteAgentTemplate, MAX_AGENT_TEMPLATES } =
  loadTs('src/main/agentTemplateStore.ts');

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'munder-templates-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

const base = (over = {}) => ({
  id: 'custom-test',
  name: '测试模板',
  provider: 'qwen',
  model: 'qwen3-coder-plus',
  description: '测试用模板',
  goal: '朝目标推进',
  skills: ['af-audit'],
  cwdRule: '选择仓库目录',
  ...over
});

test('save → list → delete roundtrip on templates.json', () => withHome((home) => {
  assert.deepEqual(readAgentTemplates(home), []);
  const saved = saveAgentTemplate(home, base());
  assert.equal(saved.ok, true);
  assert.equal(saved.templates.length, 1);
  assert.ok(existsSync(join(home, 'templates.json')), '模板必须落盘到 harnessHome');
  assert.deepEqual(readAgentTemplates(home).map((t) => t.name), ['测试模板']);
  const deleted = deleteAgentTemplate(home, 'custom-test');
  assert.deepEqual(deleted.templates, []);
}));

test('saving the same id replaces instead of duplicating', () => withHome((home) => {
  saveAgentTemplate(home, base());
  const again = saveAgentTemplate(home, base({ name: '改名模板' }));
  assert.equal(again.templates.length, 1, '同 id 必须覆盖，不能堆重复');
  assert.equal(again.templates[0].name, '改名模板');
}));

test('invalid entries are rejected on save and dropped on read', () => withHome((home) => {
  assert.equal(saveAgentTemplate(home, base({ name: '   ' })).ok, false, '空名必须拒绝');
  assert.equal(saveAgentTemplate(home, base({ provider: 'not-a-provider' })).ok, false, '未知引擎必须拒绝');
  assert.equal(saveAgentTemplate(home, base({ provider: 'custom' })).ok, true, 'custom 引擎是本地预设，应允许');
  writeFileSync(join(home, 'templates.json'), JSON.stringify([
    base(),
    { id: 'x', name: '' },
    { id: 'y', name: 'ok', provider: 'claude' },
    42,
    null
  ]));
  assert.deepEqual(readAgentTemplates(home).map((t) => t.id).sort(), ['custom-test', 'y']);
  writeFileSync(join(home, 'templates.json'), '{ 不是 JSON');
  assert.deepEqual(readAgentTemplates(home), [], '损坏文件必须安全收敛为空');
}));

test('unknown skills are dropped and long fields are capped', () => withHome((home) => {
  const res = saveAgentTemplate(home, base({
    skills: ['af-audit', 'rm -rf', 'af-hive-sync'],
    description: 'd'.repeat(300)
  }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.templates[0].skills, ['af-audit', 'af-hive-sync']);
  assert.ok(res.templates[0].description.length <= 200, 'descriptions must be capped');
}));

test('missing id gets a generated custom- id', () => withHome((home) => {
  const res = saveAgentTemplate(home, { name: '无 id 模板', provider: 'claude' });
  assert.equal(res.ok, true);
  assert.match(res.templates[0].id, /^custom-/);
}));

test('the count cap is enforced with an error, not a silent drop', () => withHome((home) => {
  for (let i = 0; i < MAX_AGENT_TEMPLATES; i++) {
    assert.equal(saveAgentTemplate(home, base({ id: `t-${i}` })).ok, true, `save #${i}`);
  }
  const over = saveAgentTemplate(home, base({ id: 't-overflow' }));
  assert.equal(over.ok, false);
  assert.equal(over.templates.length, MAX_AGENT_TEMPLATES);
  assert.match(over.error, /最多/);
}));

test('a missing harnessHome refuses the save instead of writing somewhere odd', () => {
  const res = saveAgentTemplate(null, base());
  assert.equal(res.ok, false);
  assert.deepEqual(res.templates, []);
  assert.deepEqual(readAgentTemplates(null), []);
});

test('wiring: IPC, preload, and the modal all speak templates:*', () => {
  const index = readFileSync('src/main/index.ts', 'utf8');
  assert.match(index, /ipcMain\.handle\('templates:list'/);
  assert.match(index, /ipcMain\.handle\('templates:save'/);
  assert.match(index, /ipcMain\.handle\('templates:delete'/);

  const preload = readFileSync('src/preload/index.ts', 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('templates:list'\)/);
  assert.match(preload, /ipcRenderer\.invoke\('templates:save'/);
  assert.match(preload, /ipcRenderer\.invoke\('templates:delete'/);

  const modal = readFileSync('src/renderer/src/components/AddAgentModal.tsx', 'utf8');
  assert.match(modal, /listAgentTemplates\(\)/);
  assert.match(modal, /saveAgentTemplate\(/);
  assert.match(modal, /deleteAgentTemplate\(/);
});