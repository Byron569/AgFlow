'use strict';

/**
 * OpenCode 双发行线旗标自适应（真机实测引出，2026-10）：
 *   - v1（npm opencode-ai 1.x）：TUI 有 `-m, --model`，无 `--standalone`；
 *   - v2（桌面版内置 CLI 2.x）：TUI 无 `--model`（只有 run 子命令有），需要
 *     `--standalone` 才起私有服务（否则连共享后台服务，per-agent 配置/插件失效）。
 * 纯逻辑单测（--help 文本解析 + argv 改写），探测进程调用不在本文件范围。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseOpencodeHelp, adaptOpencodeArgs } = loadTs('src/main/opencodeCli.ts');

// 真实帮助文本节选（本机实测抓取）
const V1_HELP = [
  'Options:',
  '  -h, --help          show help   [boolean]',
  '  -m, --model         model to use in the format of provider/model   [string]',
  '      --prompt        prompt to use                                    [string]',
  ''
].join('\n');
const V2_HELP = [
  'FLAGS',
  '  --standalone            Run with a private server instead of the background service',
  '  --server string         Connect to a server URL instead of the background service',
  '  --prompt string         Prompt to use',
  ''
].join('\n');

test('帮助文本解析：v1 有 TUI --model、无 --standalone', () => {
  const p = parseOpencodeHelp(V1_HELP);
  assert.equal(p.tuiModelFlag, true);
  assert.equal(p.needsStandalone, false);
});

test('帮助文本解析：v2 无 TUI --model、要 --standalone', () => {
  const p = parseOpencodeHelp(V2_HELP);
  assert.equal(p.tuiModelFlag, false);
  assert.equal(p.needsStandalone, true);
});

test('v1 原样返回（不动 argv、不产生 config 模型）', () => {
  const args = ['--model', 'anthropic/claude-sonnet-4-5', '--prompt', 'hi'];
  const res = adaptOpencodeArgs(args, { tuiModelFlag: true, needsStandalone: false });
  assert.deepEqual(res.args, args);
  assert.equal(res.model, null);
});

test('v2：摘 --model 交回模型、补 --standalone（放最前）', () => {
  const res = adaptOpencodeArgs(['--model', 'deepseek/deepseek-flash', '--prompt', 'hi'],
    { tuiModelFlag: false, needsStandalone: true });
  assert.deepEqual(res.args, ['--standalone', '--prompt', 'hi']);
  assert.equal(res.model, 'deepseek/deepseek-flash');
});

test('v2：无模型也补 --standalone；已有则不重复（幂等）', () => {
  const r1 = adaptOpencodeArgs(['--prompt', 'hi'], { tuiModelFlag: false, needsStandalone: true });
  assert.deepEqual(r1.args, ['--standalone', '--prompt', 'hi']);
  const r2 = adaptOpencodeArgs(r1.args, { tuiModelFlag: false, needsStandalone: true });
  assert.deepEqual(r2.args, ['--standalone', '--prompt', 'hi']);
});

test('探测失败（null）不做任何改写', () => {
  const args = ['--model', 'x/y'];
  const res = adaptOpencodeArgs(args, null);
  assert.deepEqual(res.args, args);
  assert.equal(res.model, null);
});

test('v2 无 --standalone 能力时只摘 --model（保守：不引入未知旗标）', () => {
  const res = adaptOpencodeArgs(['--model', 'x/y', '--prompt', 'hi'], { tuiModelFlag: false, needsStandalone: false });
  assert.deepEqual(res.args, ['--prompt', 'hi']);
  assert.equal(res.model, 'x/y');
});