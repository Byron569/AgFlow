'use strict';

// PR #205 shipped en/zh-CN locales in which the orchestrator is always called
// "Michael". The user can rename it, and this codebase has already fixed that
// exact revert three times in the spawn path. It also replaced several
// per-agent runtime names with the literal "Michael", so the UI named the wrong
// agent — including a confirmation dialog for a destructive restart.
//
// These tests hold both fixes, plus the founder's rule that nothing changes for
// an existing user until they pick a language.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (l) => JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`));
// P0-B：语言包只保留 zh-CN（en/ar 已删），这里跟着收口。
const LOCALES = ['zh-CN'];

function flatten(obj, pre = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
const text = (v) => (Array.isArray(v) ? v.join(' ') : String(v));

test('no locale hardcodes the orchestrator name', () => {
  for (const l of LOCALES) {
    const bad = Object.entries(flatten(locale(l)))
      .filter(([, v]) => /Michael/i.test(text(v)))
      .map(([k]) => k);
    assert.deepEqual(bad, [], `${l}.json hardcodes Michael in: ${bad.join(', ')}`);
  }
});

test('the strings that talk about the orchestrator interpolate {{godName}}', () => {
  const f = flatten(locale('zh-CN'));
  // A representative spread: settings, command centre, onboarding, triggers.
  for (const k of ['settings.connections.slackDesc', 'commandCenter.michaelDecides',
                   'onboarding.orchestrator.modelNote', 'triggerHistory.approveTitle',
                   'workersTab.liveIntro', 'kanban.newWorkHint']) {
    assert.ok(k in f, `${k} vanished from zh-CN.json`);
    assert.match(text(f[k]), /\{\{godName\}\}/, `${k} does not interpolate godName`);
  }
});

test('strings about ONE agent interpolate {{name}}, not the orchestrator', () => {
  // These describe whichever agent is on screen. Naming god here is not a
  // translation nit: "This restarts Michael" on a dialog that restarts Kevin is
  // a destructive action describing the wrong target.
  const perAgent = ['commandCenter.runsTheFloor', 'commandCenter.noTerminal',
                    'commandCenter.confirmRestartEngine', 'commandCenter.restartContinueTitle'];
  for (const l of LOCALES) {
    const f = flatten(locale(l));
    for (const k of perAgent) {
      assert.match(text(f[k]), /\{\{name\}\}/, `${l}: ${k} must interpolate {{name}}`);
      assert.doesNotMatch(text(f[k]), /\{\{godName\}\}/, `${l}: ${k} is per-agent, not god`);
    }
  }
});

test('every per-agent string has a call site that actually passes a name', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  for (const k of ['commandCenter.runsTheFloor', 'commandCenter.noTerminal',
                   'commandCenter.confirmRestartEngine', 'commandCenter.restartContinueTitle']) {
    const call = new RegExp(`t\\('${k.replace('.', '\\.')}',\\s*\\{[^}]*name:`);
    assert.match(src, call, `${k} is used without passing a name`);
  }
});

test('the built-in default orchestrator name is 败龙 (P0-D-1)', () => {
  const { DEFAULT_GOD_NAME } = require('./load-ts.cjs')('src/shared/godIdentity.ts');
  assert.equal(DEFAULT_GOD_NAME, '败龙', '默认总控名必须是 败龙');
});

// --- the language default ---------------------------------------------------

test('the app starts in zh-CN, with no detectLanguage left behind', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  // Comments stripped: the module's header explains what it refuses to read,
  // and naming an API must not read as calling it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // P0-B：语言固定，不再读 localStorage、不再读 OS locale，detectLanguage 已删。
  assert.match(code, /lng: 'zh-CN'/, 'the app no longer starts in zh-CN');
  assert.ok(!code.includes('function detectLanguage'), 'detectLanguage should be gone');
  assert.ok(!code.includes('navigator'), 'the i18n init must not read the OS locale');
  assert.ok(!code.includes('cth.language'), 'the language persistence key should be gone');
});

test('godName reaches i18next as a default variable, so no call site must pass it', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /defaultVariables:\s*\{\s*godName:\s*DEFAULT_GOD_NAME\s*\}/);
  assert.match(src, /export function setGodName/);
  // Without an event react-i18next never re-renders, so a rename would not show.
  assert.match(src, /i18n\.emit\('languageChanged'/);
});

test('something actually calls setGodName, or the wiring is dead', () => {
  const hook = read('src/renderer/src/i18n/useGodNameSync.ts');
  assert.match(hook, /setGodName\(/);
  assert.match(hook, /isGod/);
  assert.match(read('src/renderer/src/App.tsx'), /useGodNameSync\(\)/);
});
