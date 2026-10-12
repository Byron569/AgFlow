'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  isDurableRole,
  preferredAgentRole,
  roleForHiveSpawn
} = loadTs('src/shared/agentRole.ts');

test('status captions are not durable roles', () => {
  for (const text of [
    // English captions an older roster/registry may still carry on disk…
    'on standby', 'standby', 'idle', 'awaiting', 'a fresh harness', 'reconnecting…',
    // …and the Chinese ones this build writes.
    '空闲', '等待中', '已恢复', '思考中', '已归档', '正在启动', '正在重连…', '正在打理楼层', '一名新同事',
    ''
  ]) {
    assert.equal(isDurableRole(text), false, text);
  }
  assert.equal(isDurableRole('Head of Marketing — owns marketing-control-room'), true);
});

test('preferredAgentRole keeps a hire role over standby', () => {
  const hire = 'Head of Marketing — owns marketing-control-room and coordinates structured marketing work across the portfolio.';
  assert.equal(preferredAgentRole('on standby', hire), hire);
  assert.equal(preferredAgentRole(hire, 'on standby'), hire);
  assert.equal(preferredAgentRole('on standby', 'idle', true), 'on standby');
  // The Chinese placeholder is the same kind of caption, not a job.
  assert.equal(preferredAgentRole('一名新同事', hire), hire);
  assert.equal(preferredAgentRole(undefined, undefined, true), '总控（god）');
});

test('roleForHiveSpawn omits a transient roster caption', () => {
  assert.equal(roleForHiveSpawn({ description: 'on standby' }), undefined);
  assert.equal(
    roleForHiveSpawn({ description: 'SRT product steward — owns marketing execution' }),
    'SRT product steward — owns marketing execution'
  );
  assert.equal(
    roleForHiveSpawn({ description: 'on standby', isGod: true }),
    '总控（god）'
  );
});
