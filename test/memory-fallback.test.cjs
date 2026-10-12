'use strict';

/**
 * 记忆检索的全文回退（中文优先）。
 *
 * 中文查询必须触发 hive:textSearch 的子串扫描——语义模型（默认多语言
 * embeddinggemma，可切回仅英文 minilm）是否命中中文、mempalace 是否可用，
 * 都不该让中文用户空手而归。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { wantsTextFallback, formatTextHits } = loadTs('src/shared/memoryFallback.ts');

test('中文查询总是追加全文回退，即使语义检索返回了内容', () => {
  assert.equal(wantsTextFallback('登录超时原因', { ok: true, output: 'some semantic hit' }), true);
  assert.equal(wantsTextFallback('認証失敗', { ok: true, output: 'hit' }), true);
});

test('英文查询且语义有结果时不回退', () => {
  assert.equal(wantsTextFallback('login timeout', { ok: true, output: 'hit' }), false);
  assert.equal(wantsTextFallback('login timeout', { ok: true, output: '\n  hit\n' }), false);
});

test('语义失败或空结果时回退（任何语言）', () => {
  assert.equal(wantsTextFallback('login', { ok: false, output: '' }), true);
  assert.equal(wantsTextFallback('login', { ok: true, output: '   \n ' }), true);
});

test('命中渲染为“来源 + 摘录”两行一条', () => {
  assert.equal(formatTextHits([]), '');
  assert.equal(
    formatTextHits([
      { source: 'dev/memory.md', excerpt: '修复了登录超时的竞态' },
      { source: 'qa/memory.md', excerpt: '复测通过' }
    ]),
    'dev/memory.md\n  修复了登录超时的竞态\nqa/memory.md\n  复测通过'
  );
});