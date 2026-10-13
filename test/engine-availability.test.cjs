'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const readSrc = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const {
  classifyEngineAvailability,
  engineBlocksOnboarding,
  engineAvailabilityBadge,
  engineAvailabilityMessage,
  pickDefaultEngine,
  sortProvidersByAvailability
} = loadTs('src/shared/engineAvailability.ts');
const { toolCatalog } = loadTs('src/shared/toolCatalog.ts');
const { AGENT_PROVIDER_PRESETS, canReceiveInbox } = loadTs('src/shared/agentProvider.ts');

// Build what `tools:status` returns for a machine where `found` lists the only
// binaries present. Mirrors the main-process handler's shape without electron.
function statusesFor(found) {
  return toolCatalog().map((spec) => ({
    ...spec,
    installCommand: spec.install.posix,
    found: !!spec.bin && found.includes(spec.bin),
    path: spec.bin && found.includes(spec.bin) ? `/usr/local/bin/${spec.bin}` : null
  }));
}

test('an installed engine is installed, whatever its installer story', () => {
  const s = statusesFor(['claude', 'grok']);
  assert.equal(classifyEngineAvailability(s, 'claude').state, 'installed');
  assert.equal(classifyEngineAvailability(s, 'grok').state, 'installed');
  assert.equal(classifyEngineAvailability(s, 'grok').path, '/usr/local/bin/grok');
});

test('a missing engine with an installer installs on first run and does not block', () => {
  const s = statusesFor([]);
  for (const id of ['claude', 'codex', 'opencode', 'crush', 'pi', 'copilot']) {
    const a = classifyEngineAvailability(s, id);
    assert.equal(a.state, 'installs-on-first-run', id);
    assert.ok(a.installCommand.length > 0, id);
    assert.equal(engineBlocksOnboarding(a), false, id);
  }
});

test('the repro: grok, antigravity and qwen are offered by the wizard but cannot install', () => {
  const s = statusesFor([]);
  const offered = AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => p.id);
  for (const id of ['grok', 'antigravity', 'qwen']) {
    assert.ok(offered.includes(id), `${id} is on the picker`);
    const a = classifyEngineAvailability(s, id);
    assert.equal(a.state, 'not-installable', id);
    assert.equal(engineBlocksOnboarding(a), true, id);
    assert.equal(engineAvailabilityBadge(a), '未安装');
    const msg = engineAvailabilityMessage(a, 'Grok');
    assert.match(msg, /尚未安装/);
    assert.match(msg, /重新检查/);
    assert.match(msg, /Claude Code/);
    assert.doesNotMatch(msg, /[–—-]/, 'no dashes in user facing prose');
  }
});

test('no probe result means unknown, and unknown never blocks', () => {
  const a = classifyEngineAvailability(undefined, 'grok');
  assert.equal(a.state, 'unknown');
  assert.equal(engineBlocksOnboarding(a), false);
  assert.equal(engineAvailabilityBadge(a), null);
  assert.equal(engineAvailabilityMessage(a, 'Grok'), null);
  // a probe that ran but lacks the row behaves the same
  assert.equal(classifyEngineAvailability([], 'grok').state, 'unknown');
});

test('pickDefaultEngine prefers the first installed 国产 engine, else the fallback', () => {
  // 国产优先：已装 qwen → qwen，压过同机已装的 opencode。
  assert.equal(pickDefaultEngine(statusesFor(['qwen', 'opencode'])), 'qwen');
  // qwen 未装 → doubao（opencode 壳，bin 同为 opencode）排在 opencode 前面。
  assert.equal(pickDefaultEngine(statusesFor(['opencode'])), 'doubao');
  // 没有国产引擎 → 回退历史默认 claude（代码默认常量不动）。
  assert.equal(pickDefaultEngine(statusesFor([])), 'claude');
  // 探测未跑 → 回退，不猜。
  assert.equal(pickDefaultEngine(undefined), 'claude');
  // kimi 已装也跳过：尚无收件箱排水桥（C-4 落地前不可当总控）。
  assert.equal(pickDefaultEngine(statusesFor(['kimi'])), 'claude');
});

test('only the dead end has a message', () => {
  const s = statusesFor(['claude']);
  assert.equal(engineAvailabilityMessage(classifyEngineAvailability(s, 'claude'), 'Claude Code'), null);
  assert.equal(engineAvailabilityMessage(classifyEngineAvailability(s, 'codex'), 'Codex'), null);
});

// --- 2026-10：引擎选择器接入本机可用性（排序 + 徽标）------------------------

test('sortProvidersByAvailability keeps installed first, unprobed order intact', () => {
  const s = statusesFor(['opencode', 'claude']);
  const rows = [{ id: 'grok' }, { id: 'claude' }, { id: 'codex' }, { id: 'opencode' }];
  // 已装（claude/opencode 同档保持原序）→ 首次自动装（codex）→ 未装（grok）。
  assert.deepEqual(
    sortProvidersByAvailability(s, rows).map((p) => p.id),
    ['claude', 'opencode', 'codex', 'grok']
  );
  // 探测未跑 → 原样，不猜。
  assert.deepEqual(
    sortProvidersByAvailability(undefined, rows).map((p) => p.id),
    ['grok', 'claude', 'codex', 'opencode']
  );
  // 不改动传入数组。
  const input = [{ id: 'grok' }, { id: 'claude' }];
  sortProvidersByAvailability(s, input);
  assert.deepEqual(input.map((p) => p.id), ['grok', 'claude']);
});

test('engine pickers order and badge by machine availability', () => {
  const add = readSrc('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(add, /sortProvidersByAvailability/, '添加对话框未按可用性排序');
  assert.match(add, /engineAvailabilityBadge/, '添加对话框未显示可用性徽标');
  const edit = readSrc('src/renderer/src/components/EditAgentModal.tsx');
  assert.match(edit, /sortProvidersByAvailability/, '编辑弹窗未按可用性排序');
  assert.match(edit, /engineAvailabilityBadge/, '编辑弹窗未显示可用性徽标');
  const modal = readSrc('src/renderer/src/components/SettingsModal.tsx');
  assert.match(modal, /engineAvailabilityBadge/, '设置页引擎行未显示可用性徽标');
});
