'use strict';

/**
 * 技能投放目标（P1-3）：按引擎各自的技能目录约定投放 + 提示词兜底行。
 *
 * 契约：OpenCode 家族（含豆包/GLM/Ollama/DeepSeek 壳）多投一个 `.opencode/skills`
 * （= OPENCODE_CONFIG_DIR 下的全局技能目录）；其余引擎保守回退既有 `.claude/skills`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { skillDropDirs, bundledSkillsLine } = loadTs('src/shared/skillTargets.ts');

test('OpenCode 家族投放 .opencode/skills（配置目录）+ Claude 兼容路径', () => {
  for (const p of ['opencode', 'doubao', 'glm', 'ollama', 'deepseek']) {
    assert.deepEqual(skillDropDirs(p), ['.opencode/skills', '.claude/skills'], p);
  }
});

test('其余引擎与未设置值保守回退到既有 .claude/skills 投放', () => {
  for (const p of ['claude', 'codex', 'grok', 'kimi', 'gemini', 'antigravity', 'qwen',
    'crush', 'pi', 'copilot', 'cursor', 'traecli', 'codebuddy', 'zcode', 'custom', undefined]) {
    assert.deepEqual(skillDropDirs(p), ['.claude/skills'], String(p));
  }
});

test('提示词兜底行：空清单 → 空串（调用方丢弃该行）', () => {
  assert.equal(bundledSkillsLine('/tmp/skills', []), '');
});

test('提示词兜底行：含目录、全部 id、SKILL.md 读取方式与只读约束', () => {
  const line = bundledSkillsLine('/tmp/x/.opencode/skills', ['af-audit', 'af-hive-sync']);
  assert.ok(line.includes('/tmp/x/.opencode/skills'));
  assert.ok(line.includes('af-audit') && line.includes('af-hive-sync'));
  assert.ok(line.includes('SKILL.md'));
  assert.ok(line.includes('只读'));
});