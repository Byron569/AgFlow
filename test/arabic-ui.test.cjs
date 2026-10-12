'use strict';

// P0-B：单一语言包（zh-CN）与方向机制惰性化。
//
// 阿拉伯语 UI（PR #213）上线时的唯一条件是：没有主动选择阿拉伯语的用户，
// 任何东西都不变——布局、方向、字体、间距都不。P0-B 把多语言整个收掉：
// en/ar 语言包删除、Settings 不再有语言选择器、只剩 zh-CN。这里把这些
// 状态钉住：
//   - 语言包里只有 zh-CN，i18n 也只注册 zh-CN，且没有任何切换入口；
//   - 留下来的 RTL 管道（useRtl/useDirection、[dir="rtl"] CSS、终端阿拉伯
//     渲染开关）仍然只读"用户选择的语言"这一个输入，而这个输入已不可能
//     是 rtl——机制惰性，而非被逐个拆掉；
//   - 阿拉伯语专属的渲染器链路（useArabicTerminalSync、markdown auto-dir）
//     是删除，不是停用。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
/** Source with comments removed, for assertions about what the CODE does. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const zh = JSON.parse(read('src/renderer/src/i18n/locales/zh-CN.json'));

/** Every leaf path in a locale tree, arrays included by index. */
function leaves(node, prefix = '') {
  if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${prefix}.${i}`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}

// --- one language pack, and no way to leave it ------------------------------

test('zh-CN is the only locale file that ships', () => {
  const dir = 'src/renderer/src/i18n/locales';
  const files = fs.readdirSync(path.join(root, dir)).sort();
  assert.deepEqual(files, ['zh-CN.json'],
    `the locale folder must hold zh-CN.json only, found: ${files.join(', ')}`);
  assert.ok(!exists(`${dir}/en.json`), 'en.json is back');
  assert.ok(!exists(`${dir}/ar.json`), 'ar.json is back');
});

test('i18n is pinned to zh-CN — no auto-detect, no persistence, no switch', () => {
  const code = strip(read('src/renderer/src/i18n/index.ts'));
  assert.match(code, /lng: 'zh-CN'/, 'the initial language must be zh-CN');
  assert.match(code, /fallbackLng: 'zh-CN'/, 'a missing key must fall back to zh-CN');
  assert.match(code, /supportedLngs: \['zh-CN'\]/, 'only zh-CN may be supported');
  assert.ok(!code.includes("locales/en.json"), 'en.json is still imported');
  assert.ok(!code.includes("locales/ar.json"), 'ar.json is still imported');
  assert.ok(!code.includes('navigator'), 'the init must not read the OS locale');
  // 切换与持久化入口都必须消失：没有 setLanguage，也就没人再写 cth.language。
  assert.ok(!code.includes('setLanguage'), 'setLanguage must be gone');
  assert.ok(!code.includes('cth.language'), 'the language persistence key must be gone');
  // 注册表只剩一条记录，且方向是 ltr —— 这是"机制惰性"的根因。
  assert.match(code, /export const LANGUAGES[\s\S]*?\{ code: 'zh-CN', label: '简体中文', dir: 'ltr' \}/,
    'LANGUAGES must hold the zh-CN ltr entry');
  const entries = (code.match(/code: '/g) ?? []).length;
  assert.equal(entries, 1, `expected exactly one registered language, found ${entries}`);
  assert.ok(!/dir: 'rtl'/.test(code), 'no RTL language may still be registered');
});

test('Settings no longer offers a language switcher', () => {
  const src = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(!src.includes('setLanguage'), 'the old picker handler is still wired');
  assert.ok(!src.includes('value={i18n.language}'), 'the language <select> is back');
  // 只读展示仍走 i18n 的单一来源（LANGUAGES[0].label），不是散落的字面量。
  assert.match(src, /LANGUAGES\[0\]\.label/, 'the read-only language label lost its source');
});

test('the direction gate still reads the selected language only — it just cannot be RTL now', () => {
  const src = read('src/renderer/src/i18n/useDirection.ts');
  // Comments stripped: these modules explain at length what they refuse to
  // read, and naming an API must not read as calling it.
  const code = strip(src);
  for (const sniff of ['navigator', 'matchMedia', 'textContent']) {
    assert.ok(!code.includes(sniff), `useDirection reads ${sniff} — that is not a user choice`);
  }
  assert.match(code, /isRtlLanguage\(i18n\.language\)/);
  // 精确集合匹配，且集合从 LANGUAGES 派生——空集也要是"派生出来的空集"。
  const init = read('src/renderer/src/i18n/index.ts');
  assert.match(init, /RTL_CODES\.has\(lng\)/,
    'isRtlLanguage must be exact-match on a registered code');
  assert.match(init, /LANGUAGES\.filter\(\(l\) => l\.dir === 'rtl'\)/,
    'the RTL set must be derived from LANGUAGES, not maintained separately');
});

// --- the Arabic-only renderer plumbing is deleted, not disabled -------------

test('the Arabic-only renderer helpers are gone', () => {
  assert.ok(!exists('src/renderer/src/terminal/useArabicTerminalSync.ts'),
    'useArabicTerminalSync.ts is back');
  assert.ok(!exists('src/renderer/src/markdown/rehypeAutoDir.ts'),
    'rehypeAutoDir.ts is back');
  assert.ok(!strip(read('src/renderer/src/App.tsx')).includes('useArabicTerminalSync'),
    'App still mounts the Arabic terminal sync');
  const md = read('src/renderer/src/markdown/MarkdownPreview.tsx');
  assert.ok(!md.includes('useRtl'), 'MarkdownPreview still gates on the language');
  assert.ok(!md.includes('rehypeAutoDir'), 'the auto-dir plugin is still wired');
  assert.ok(!md.includes('rehypePlugins'), 'the rehype pipeline is still configurable');
  // And the security invariant it sat next to is unchanged.
  assert.ok(!md.includes('rehypeRaw'), 'rehype-raw must never be added here');
  assert.ok(!read('src/renderer/src/components/AgentStrip.tsx').includes('useRtl'),
    'AgentStrip still imports the direction gate');
});

// --- the CSS guards that must survive P0-B ----------------------------------

test('every RTL CSS rule is scoped to [dir="rtl"], so LTR sees no change at all', () => {
  const css = read('src/renderer/src/design/global.css');
  const marker = css.indexOf('─── RTL app language');
  assert.ok(marker > 0, 'the RTL section vanished');
  // Start at the comment's OPENING delimiter, or strip() sees a dangling `*/`
  // and eats the wrong span.
  const start = css.lastIndexOf('/*', marker);
  const next = css.indexOf('/* ───', marker + 20);
  // Comments stripped first: this section explains WHY each rule exists, in
  // prose that otherwise reads like a selector list.
  const body = strip(next > 0 ? css.slice(start, next) : css.slice(start));
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const selectors = lines.filter((l) => /^[.[#a-z]/.test(l) && (l.includes('{') || l.endsWith(',')));
  assert.ok(selectors.length >= 5, `expected the RTL rules, found ${selectors.length}`);
  for (const sel of selectors) {
    assert.ok(sel.includes('[dir="rtl"]'),
      `an unscoped rule in the RTL section changes layout for everyone: ${sel.trim()}`);
  }
});

test('the terminal grid is pinned LTR under an RTL page', () => {
  // `direction` inherits. Without this the xterm viewport picks up rtl from
  // <html>, right-aligns the whole cell grid, and reverses every box-drawing
  // frame — while the pty still addresses columns from the left. Per-row
  // direction is a different layer (.cth-bidi) and is not affected.
  const css = strip(read('src/renderer/src/design/global.css'));
  // Every part of the grid, checked one at a time. A single regex over the whole
  // rule passes while three of the four selectors are missing — the root alone
  // does cover the rows by inheritance, but the viewport carries the scrollbar
  // and the measure container decides cell width, and a partial removal here
  // must not read as green.
  const rule = css.slice(css.indexOf('[dir="rtl"] .xterm'));
  const decl = rule.slice(0, rule.indexOf('}') + 1);
  assert.match(decl, /direction: ltr;/, 'the xterm pin lost its declaration');
  for (const sel of ['.xterm', '.xterm-viewport', '.xterm-screen', '.xterm-rows',
                     '.xterm-width-cache-measure-container']) {
    // Anchored on the selector's END. `.xterm` is a prefix of every other name
    // here, so a plain substring test reports the root as pinned when only
    // `.xterm-viewport` survives.
    const re = new RegExp(`\\[dir="rtl"\\] \\${sel}(?=\\s*[,{])`);
    assert.match(decl, re,
      `${sel} is not pinned to ltr, so an RTL app language mirrors part of the terminal`);
  }
});

test('no unbundled webfont rides in with the Arabic face stack', () => {
  // PR #213 added IBM Plex Sans Arabic to every token stack and re-added the
  // Google Fonts <link> that 41ea4c37 deliberately removed — a network fetch on
  // boot, blocked in mainland China, and an ungated font change for every user.
  // The bundled stacks already name system Arabic faces, so nothing is needed.
  const tokens = read('src/renderer/src/design/tokens.css');
  const html = read('src/renderer/index.html');
  assert.ok(!tokens.includes('IBM Plex Sans Arabic'),
    'an unbundled font in a token stack changes type for every user');
  assert.doesNotMatch(html, /<link[^>]*fonts\.googleapis\.com/,
    'the Google Fonts link is back — the app must render its own type offline');
  assert.match(html, /font-src 'self'/,
    'the CSP no longer pins fonts to the bundle');
  for (const face of ['Geeza Pro', 'Noto Naskh Arabic']) {
    assert.ok(tokens.includes(face), `${face} fallback is missing from the token stacks`);
  }
});

// --- the zh-CN tree itself --------------------------------------------------

test('the zh-CN tree is intact and internally well-formed', () => {
  const all = leaves(zh);
  assert.ok(all.length > 1000, `sanity: only ${all.length} keys found`);
  const bad = [];
  for (const [k, v] of all) {
    if (typeof v !== 'string') continue;
    // 未闭合或拼错的占位符会原样渲染到界面上；i18next 不会报错。
    const opened = (v.match(/\{\{/g) ?? []).length;
    const closed = (v.match(/\}\}/g) ?? []).length;
    if (opened !== closed) bad.push(`${k}: unbalanced braces`);
    for (const m of v.matchAll(/\{\{(.+?)\}\}/g)) {
      if (!/^\s*[\w.]+\s*$/.test(m[1])) bad.push(`${k}: malformed {{${m[1]}}}`);
    }
  }
  assert.deepEqual(bad, [], `placeholder problems:\n  ${bad.join('\n  ')}`);
});

test('the terminal setting still explains its performance cost', () => {
  // 该开关在 P0-B 后仍保留（终端里仍可能渲染阿拉伯语内容）；描述里的代价
  // 说明不能丢。
  const g = zh.settings.general;
  assert.ok(g.arabicTerminalDesc, 'lost arabicTerminalDesc');
  assert.ok(g.arabicTerminalDesc.length > 80,
    'the description is too short to still explain the tradeoff');
  assert.ok(g.arabicTerminalFollowsLanguage, 'the note about following the language is gone');
});