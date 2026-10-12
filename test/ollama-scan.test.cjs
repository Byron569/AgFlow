'use strict';

// P1「GLM / Ollama 完整化」：本机 Ollama 发现（/api/tags 扫描）。
// 纯函数直接装载测试；listOllamaModels 用本地 http 服务器走真实 fetch 路径
// （不打真 Ollama）；末尾做一轮 IPC / preload / UI 的静态接线断言。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const { parseOllamaTags, ollamaRootFromBaseUrl, listOllamaModels } =
  loadTs('src/shared/ollamaScan.ts');
const { hasOssQuickPicks, localSlugFor } = loadTs('src/shared/ossModels.ts');

test('parseOllamaTags reads name/size/details and drops malformed entries', () => {
  const models = parseOllamaTags({
    models: [
      { name: 'qwen3-coder:30b', size: 19_000_000_000, details: { parameter_size: '30.5B', family: 'qwen3' } },
      { name: 'gpt-oss:20b', size: 13_000_000_000, details: { family: 'gptoss' } },
      { model: 'legacy-name:7b' }, // 旧版 /api/tags 用 model 字段
      { name: 42 }, // 非字符串名 → 丢弃
      null,
      'nope',
      { size: 123 } // 无名 → 丢弃
    ]
  });
  assert.deepEqual(models.map((m) => m.name), ['qwen3-coder:30b', 'gpt-oss:20b', 'legacy-name:7b']);
  assert.equal(models[0].sizeBytes, 19_000_000_000);
  assert.equal(models[0].parameters, '30.5B');
  assert.equal(models[0].family, 'qwen3');
  assert.equal(models[1].sizeBytes, 13_000_000_000);
  assert.equal(models[1].parameters, undefined);
  assert.equal(models[2].sizeBytes, 0, '缺 size 落 0，绝不 NaN');
});

test('parseOllamaTags never throws on junk payloads', () => {
  assert.deepEqual(parseOllamaTags(null), []);
  assert.deepEqual(parseOllamaTags({ models: 'not-an-array' }), []);
  assert.deepEqual(parseOllamaTags({}), []);
  assert.deepEqual(parseOllamaTags('x'), []);
});

test('ollamaRootFromBaseUrl strips the /v1 suffix and trailing slashes', () => {
  assert.equal(ollamaRootFromBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(ollamaRootFromBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434');
  assert.equal(ollamaRootFromBaseUrl('  http://127.0.0.1:11434  '), 'http://127.0.0.1:11434');
  // 自定义 OpenAI 兼容端点（LM Studio 等）：去 /v1 后仍可作为根拼 /api/tags。
  assert.equal(ollamaRootFromBaseUrl('http://192.168.1.9:1234/v1'), 'http://192.168.1.9:1234');
});

test('the ollama engine joins the OSS quick-picks with ollama/<tag> slugs', () => {
  assert.equal(hasOssQuickPicks('ollama'), true);
  assert.equal(hasOssQuickPicks('opencode'), true);
  assert.equal(hasOssQuickPicks('doubao'), false, '云端 BYOK 引擎没有本机标签可列');
  assert.equal(localSlugFor('ollama', 'x:1'), 'ollama/x:1');
  assert.equal(localSlugFor('opencode', 'x:1'), 'local/x:1');
});

test('listOllamaModels parses a live /api/tags response', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        models: [{ name: 'qwen3-coder:30b', size: 19_000_000_000, details: { parameter_size: '30.5B' } }]
      }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const ok = await listOllamaModels(`http://127.0.0.1:${port}`);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.models.map((m) => m.name), ['qwen3-coder:30b']);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  const down = await listOllamaModels(`http://127.0.0.1:${port}`, 1000);
  assert.equal(down.ok, false, '服务器关闭后必须 ok:false 而不是抛异常');
  assert.equal(typeof down.error, 'string');
});

test('listOllamaModels reports non-200 responses without throwing', async () => {
  const srv = http.createServer((req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const res = await listOllamaModels(`http://127.0.0.1:${port}`);
    assert.equal(res.ok, false);
    assert.match(res.error, /HTTP 500/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('wiring: IPC, preload, modal and settings are connected end-to-end', () => {
  const index = readFileSync('src/main/index.ts', 'utf8');
  assert.match(index, /ipcMain\.handle\('ollama:listModels'/);
  // 双 provider 块（local/ + ollama/）是 slug 断链的修复本体；生成逻辑已抽到共享
  // 辅助函数（domesticOpencodeProviderBlocks），产品 spawn 与真机实测脚本共用。
  assert.match(index, /domesticOpencodeProviderBlocks\(eng, baseUrl, modelSlug\)/);
  const domestic = readFileSync('src/shared/domesticEngines.ts', 'utf8');
  assert.match(domestic, /const blockIds = eng\.id === 'ollama' \? \['local', 'ollama'\] : \[eng\.id\]/);

  const preload = readFileSync('src/preload/index.ts', 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('ollama:listModels'\)/);

  const modal = readFileSync('src/renderer/src/components/AddAgentModal.tsx', 'utf8');
  assert.match(modal, /listOllamaModels\(\)/);
  assert.match(modal, /localSlugFor\(provider, m\.name\)/);
  assert.match(modal, /addAgent\.ollamaScan/);

  const settings = readFileSync('src/renderer/src/components/AiEnginesSettings.tsx', 'utf8');
  assert.match(settings, /DOMESTIC_ENGINES/);
  assert.match(settings, /e\.keyRef/, '密钥表单必须从注册表取 keyRef（ark/glm/deepseek）');
});