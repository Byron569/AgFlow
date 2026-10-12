'use strict';

// P1-4：总控人设（godPersona）——风格/策略注入文本 + 全链接线。
// 注入文本是纯函数（shared/godPersona.ts），直接装载断言；其余为静态接线检查。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const { GOD_STYLES, GOD_STRATEGIES, buildGodPersonaPrompt } = loadTs('src/shared/godPersona.ts');

test('默认（未设置）不注入任何行——提示词与旧版逐字相同', () => {
  assert.equal(buildGodPersonaPrompt(undefined), '');
  assert.equal(buildGodPersonaPrompt(null), '');
  assert.equal(buildGodPersonaPrompt({}), '');
});

test('合法风格/策略各自映射到注入行，两者并存时用空格连接', () => {
  for (const s of GOD_STYLES) assert.ok(buildGodPersonaPrompt({ style: s }).length > 20, `style ${s}`);
  for (const s of GOD_STRATEGIES) assert.ok(buildGodPersonaPrompt({ strategy: s }).length > 20, `strategy ${s}`);
  const both = buildGodPersonaPrompt({ style: 'concise', strategy: 'cautious' });
  assert.match(both, /沟通风格/);
  assert.match(both, /编排策略/);
  assert.ok(both.includes(' '), '两行以空格连接');
});

test('未知/垃圾值被忽略，绝不原样注入', () => {
  assert.equal(buildGodPersonaPrompt({ style: 'rm -rf', strategy: 'whatever' }), '');
  assert.equal(buildGodPersonaPrompt({ style: 'CONCISE' }), '', '机器值大小写敏感');
});

test('wiring: config 三处、hive 镜像与注入、spawn 形象、设置面板、文案', () => {
  const hive = readFileSync('src/main/hive.ts', 'utf8');
  assert.match(hive, /setGodPersona\(persona/);
  assert.match(hive, /meta\.isGod \? buildGodPersonaPrompt\(this\._godPersona\)/);
  assert.match(hive, /personaLine,/);

  const index = readFileSync('src/main/index.ts', 'utf8');
  assert.match(index, /hive\.setGodPersona\(next\.godPersona\)/);
  assert.match(index, /hive\.setGodPersona\(readConfig\(\)\.godPersona\)/);

  const useHive = readFileSync('src/renderer/src/hooks/useHive.ts', 'utf8');
  assert.match(useHive, /godPersona\?\.avatar/);
  assert.match(useHive, /character: godAvatar/);

  for (const f of ['src/main/config.ts', 'src/preload/index.ts', 'src/renderer/src/store/config.ts']) {
    assert.match(readFileSync(f, 'utf8'), /godPersona/, `${f} 必须携带该字段`);
  }

  const settings = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8');
  assert.match(settings, /<GodPersonaSection config=\{config\} \/>/);

  const zh = JSON.parse(readFileSync('src/renderer/src/i18n/locales/zh-CN.json', 'utf8'));
  assert.ok(zh.godPersona && zh.godPersona.title, 'zh-CN 必须有 godPersona 文案');
  assert.ok(zh.godPersona.style.concise && zh.godPersona.strategy.cautious, '选项文案齐备');
});