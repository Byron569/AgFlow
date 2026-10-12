'use strict';

/**
 * 国内镜像源：npm registry 注入 + URL 校验。
 *
 * 关键安全面：镜像 URL 会被拼进 shell 安装脚本（含 Windows 的 cmd.exe 单行
 * 脚本，`&`/引号都是元字符），所以校验必须保守——非法值按“未配置”处理，
 * 绝不原样拼接。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { sanitizeMirrorUrl, withNpmRegistry } = loadTs('src/shared/mirrors.ts');
const { buildMissingCliScript } = loadTs('src/main/cliInstall.ts');

test('合法镜像源：https + 保守字符集，前后空白被裁剪', () => {
  assert.equal(sanitizeMirrorUrl('https://registry.npmmirror.com'), 'https://registry.npmmirror.com');
  assert.equal(sanitizeMirrorUrl('  https://mirror.example.com/agflow/  '), 'https://mirror.example.com/agflow/');
});

test('非法镜像源一律作废：非 https、空值、shell 元字符', () => {
  for (const bad of [
    undefined, null, 42, '',
    'http://registry.npmmirror.com',           // 非 https
    'registry.npmmirror.com',                  // 无 scheme
    'https://x.com && rm -rf /',               // cmd.exe 元字符
    'https://x.com"quote',                     // 引号
    'https://x.com/a b',                       // 空格
    'https://x.com/$HOME'                      // 变量展开
  ]) {
    assert.equal(sanitizeMirrorUrl(bad), undefined, String(bad));
  }
});

test('npm 命令追加 --registry；其他安装命令原样返回', () => {
  const reg = 'https://registry.npmmirror.com';
  assert.equal(
    withNpmRegistry('npm install -g @openai/codex', reg),
    'npm install -g @openai/codex --registry https://registry.npmmirror.com'
  );
  assert.equal(
    withNpmRegistry('npm install -g --ignore-scripts @earendil-works/pi-coding-agent', reg),
    'npm install -g --ignore-scripts @earendil-works/pi-coding-agent --registry https://registry.npmmirror.com'
  );
  for (const other of [
    'curl -LsSf https://astral.sh/uv/install.sh | sh',
    'uv tool install mempalace',
    'winget install --id Git.Git -e',
    'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
  ]) {
    assert.equal(withNpmRegistry(other, reg), other);
  }
});

test('未配置或非法镜像源时 npm 命令不变', () => {
  assert.equal(withNpmRegistry('npm install -g @openai/codex', undefined), 'npm install -g @openai/codex');
  assert.equal(withNpmRegistry('npm install -g @openai/codex', 'http://x.com'), 'npm install -g @openai/codex');
});

test('缺 CLI 安装脚本带上镜像源；Windows 单行脚本仍无引号', () => {
  const reg = 'https://registry.npmmirror.com';
  const posix = buildMissingCliScript('codex', 'codex', true, 'linux', null, reg);
  assert.ok(
    posix.split('\n').includes('npm install -g @openai/codex --registry https://registry.npmmirror.com'),
    'the executed line must carry the registry'
  );
  const win = buildMissingCliScript('codex', 'codex', true, 'win32', null, reg);
  assert.ok(win.includes('--registry https://registry.npmmirror.com'), 'win script must carry it too');
  assert.ok(!win.includes('"'), 'still quote-free for cmd.exe');
  assert.ok(!win.includes('\n'), 'still a single cmd.exe line');
});

test('不传镜像源时行为与旧版逐字一致', () => {
  const out = buildMissingCliScript('claude', 'claude', true, 'linux');
  assert.ok(out.split('\n').includes('npm install -g @anthropic-ai/claude-code'));
});