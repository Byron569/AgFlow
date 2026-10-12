'use strict';
/**
 * Agent-provider registry tests. Self-contained, no test framework — run with
 * `node test/agent-provider.test.cjs` (mirrors test/kg-core.test.cjs). The
 * registry lives in TypeScript (src/shared/agentProvider.ts), so we transpile it
 * and its two dependency-free command-group siblings with the bundled `typescript`
 * compiler into a temp dir and require the result. Exercises the copilot preset
 * (GitHub Copilot CLI) end to end: registration, command inference, the print-mode
 * flag shape, and the model/resume passthrough — alongside the pre-existing codex
 * preset as a guard against regressions.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprov-'));
for (const name of ['claudeCommands', 'codexCommands', 'grokCommands', 'agentProvider']) {
  const src = fs.readFileSync(path.join(SHARED, `${name}.ts`), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const ap = require(path.join(out, 'agentProvider.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

console.log('agent-provider registry tests');

test('copilot is a recognized, selectable provider', () => {
  assert.ok(ap.isAgentProvider('copilot'), 'isAgentProvider("copilot")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'copilot'), 'preset registered');
});

test('inferAgentProvider maps the copilot binary (with path/flags) to copilot', () => {
  assert.strictEqual(ap.inferAgentProvider('copilot'), 'copilot');
  assert.strictEqual(ap.inferAgentProvider('/usr/local/bin/copilot --model gpt-5.4'), 'copilot');
});

test('copilot preset builds the documented non-interactive print-mode shape', () => {
  const p = ap.providerPreset('copilot');
  assert.strictEqual(p.defaultCommand, 'copilot', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, '-p', 'prompt rides in via -p');
  assert.strictEqual(ap.autoModeFlagForProvider('copilot'), '-s --allow-all-tools --no-ask-user');
  assert.strictEqual(p.autoFlag, '-s --allow-all-tools --no-ask-user', 'autoFlag mirrors autoModeFlag');
});

test('copilot passes model + resume through, non-hiveAware, never auto-receives inbox', () => {
  const p = ap.providerPreset('copilot');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.canReceiveInbox('copilot'), false, 'print mode exits, no drain → bounces');
  assert.strictEqual(ap.bridgeOf('copilot'), undefined, 'no hook/proxy bridge');
});

test('cursor is a recognized, selectable, god-eligible provider', () => {
  assert.ok(ap.isAgentProvider('cursor'), 'isAgentProvider("cursor")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'cursor'), 'preset registered');
  assert.strictEqual(ap.canReceiveInbox('cursor'), true, 'interactive TUI can receive inbox');
});

test('inferAgentProvider maps cursor-agent (canonical) and agent (alias) to cursor', () => {
  assert.strictEqual(ap.inferAgentProvider('cursor-agent'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('/Users/me/.local/bin/cursor-agent --model gpt-5.6-luna-high'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('agent'), 'cursor');
});

test('cursor preset is interactive (no -p), uses force+trust auto flags, types seed into TUI', () => {
  const p = ap.providerPreset('cursor');
  assert.strictEqual(p.defaultCommand, 'cursor-agent', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, undefined, 'no -p; stay interactive');
  assert.strictEqual(p.seedDelivery, 'type-into-tui', 'hive protocol typed after boot');
  assert.strictEqual(ap.autoModeFlagForProvider('cursor'), '--force --trust');
  assert.strictEqual(p.autoFlag, '--force --trust', 'autoFlag mirrors autoModeFlag');
  assert.strictEqual(p.recommendedOrchestratorModel, 'gpt-5.6-luna-high');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.bridgeOf('cursor'), undefined, 'no hook/proxy bridge yet');
});

test('codex preset still resolves (no regression)', () => {
  assert.strictEqual(ap.inferAgentProvider('codex'), 'codex');
  assert.strictEqual(ap.providerPreset('codex').defaultCommand, 'codex');
});

test('国产引擎 (P0-A6) register and carry the OpenCode plugin bridge', () => {
  for (const id of ['doubao', 'deepseek', 'glm', 'ollama']) {
    assert.ok(ap.isAgentProvider(id), `isAgentProvider("${id}")`);
    assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === id), `${id} preset registered`);
  }
  // doubao/deepseek/glm/ollama are the OpenCode shell with a different
  // endpoint/key, so they spawn `opencode` and reuse its plugin bridge verbatim.
  // (deepseek 曾在 2026-10 前默认走官方 dsh CLI；真机实测证明 dsh 0.2.0-rc.2 无
  //  交互 profile——裸 dsh 报 --profile 必填后退出——故按 C-7 结论改走该壳。)
  for (const id of ['doubao', 'deepseek', 'glm', 'ollama']) {
    assert.strictEqual(ap.providerPreset(id).defaultCommand, 'opencode', id);
    assert.deepStrictEqual(ap.bridgeOf(id), { kind: 'hooks', shim: 'opencode' }, id);
    assert.strictEqual(ap.canReceiveInbox(id), true, id);
  }
});

test('inferAgentProvider maps the dsh binary (with path/flags) to deepseek', () => {
  assert.strictEqual(ap.inferAgentProvider('dsh'), 'deepseek');
  assert.strictEqual(ap.inferAgentProvider('/usr/local/bin/dsh --profile tui'), 'deepseek');
  // The shared opencode shell is ambiguous by command alone — an explicit
  // provider field is what carries doubao/glm/ollama through the spawn path.
  assert.strictEqual(ap.inferAgentProvider('opencode', 'doubao'), 'doubao');
  assert.strictEqual(ap.inferAgentProvider('opencode'), 'opencode');
});

test('TraeCode CLI（traecli）注册为位置参数引导、无桥的国产引擎', () => {
  assert.ok(ap.isAgentProvider('traecli'), 'isAgentProvider("traecli")');
  assert.strictEqual(ap.inferAgentProvider('/usr/local/bin/traecli --model x'), 'traecli');
  const p = ap.providerPreset('traecli');
  assert.strictEqual(p.defaultCommand, 'traecli');
  assert.strictEqual(p.positionalInitialPrompt, true, 'hive 协议走位置参数首提示');
  assert.strictEqual(p.initialPromptFlag, undefined, '没有 flag 形式的引导');
  assert.strictEqual(ap.autoModeFlagForProvider('traecli'), '--permission-mode bypass_permissions');
  assert.strictEqual(p.autoFlag, '--permission-mode bypass_permissions', 'autoFlag mirrors autoModeFlag');
  assert.strictEqual(p.resumeFlag, '--resume');
  assert.strictEqual(p.hiveAware, false);
  assert.strictEqual(ap.canReceiveInbox('traecli'), false, '无桥 → 邮件退回总控');
  assert.strictEqual(ap.bridgeOf('traecli'), undefined);
  assert.ok(p.nativeInstallCommand.posix.includes('trae.cn/trae-cli'), '官方安装脚本（非 npm）');
});

test('CodeBuddy（codebuddy，腾讯 · WorkBuddy）注册为位置参数引导、npm 安装的国产引擎', () => {
  assert.ok(ap.isAgentProvider('codebuddy'), 'isAgentProvider("codebuddy")');
  assert.strictEqual(ap.inferAgentProvider('codebuddy --model sonnet'), 'codebuddy');
  const p = ap.providerPreset('codebuddy');
  assert.strictEqual(p.defaultCommand, 'codebuddy');
  assert.strictEqual(p.positionalInitialPrompt, true, '`codebuddy "query"` 以初始提示启动 REPL');
  assert.strictEqual(ap.autoModeFlagForProvider('codebuddy'), '--dangerously-skip-permissions');
  assert.strictEqual(p.resumeFlag, '--resume');
  assert.strictEqual(p.hiveAware, false);
  assert.strictEqual(ap.canReceiveInbox('codebuddy'), false, '无桥 → 邮件退回总控');
  assert.strictEqual(ap.bridgeOf('codebuddy'), undefined);
  assert.strictEqual(p.installCommand, 'npm install -g @tencent-ai/codebuddy-code');
});

test('ZCode（zcode，智谱 GLM 命令行版）注册为种子打字投递、无桥的国产引擎', () => {
  assert.ok(ap.isAgentProvider('zcode'), 'isAgentProvider("zcode")');
  assert.strictEqual(ap.inferAgentProvider('zcode'), 'zcode');
  assert.strictEqual(ap.inferAgentProvider('/usr/local/bin/zcode --help'), 'zcode');
  const p = ap.providerPreset('zcode');
  assert.strictEqual(p.defaultCommand, 'zcode', '无参数进入 TUI（官方 README）');
  assert.strictEqual(p.seedDelivery, 'type-into-tui', '协议文本开机后打字投递（错误 argv 不可能产生）');
  assert.strictEqual(p.initialPromptFlag, undefined, 'argv 面未核实，不用 flag');
  assert.strictEqual(p.supportsModel, false, '无已核实的 --model，不做注入');
  assert.strictEqual(p.hiveAware, false);
  assert.strictEqual(ap.canReceiveInbox('zcode'), false, '无桥 → 邮件退回总控');
  assert.strictEqual(ap.bridgeOf('zcode'), undefined);
  assert.strictEqual(p.installCommand, undefined, 'npm 无官方包，不猜安装命令');
  assert.ok(String(p.docsUrl).includes('zcode.z.ai'), '指向官方安装页');
});

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll agent-provider tests passed');
