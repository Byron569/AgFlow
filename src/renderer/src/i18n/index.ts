/**
 * i18n bootstrap — react-i18next with inline JSON resources.
 *
 * P0-B 决策：界面语言固定为简体中文。产品只面向中文用户，英文与阿拉伯语
 * 语言包已删除（en.json / ar.json），Settings 不再提供语言切换。`lng` 恒为
 * 'zh-CN'，`fallbackLng` 也是 'zh-CN'；不读 navigator.language，也不再有
 * localStorage 持久化（cth.language 不再写入）。
 *
 * 方向机制（RTL）保留为惰性：`LANGUAGES` 里唯一的条目是 ltr，所以
 * `RTL_CODES` 为空集，`isRtlLanguage()` 恒 false——所有 `useRtl()` 分支与
 * 全局 CSS 的 `[dir="rtl"]` 规则自然不生效，无需逐个删组件。真正删掉的
 * 是阿拉伯语专属链路（useArabicTerminalSync、markdown auto-dir 等）。
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_GOD_NAME } from '@shared/godIdentity';
import zhCN from './locales/zh-CN.json';

/** 一条语言记录：code、显示名、书写方向。 */
export interface LanguageEntry {
  readonly code: string;
  readonly label: string;
  readonly dir: 'ltr' | 'rtl';
}

/**
 * 已注册的语言。当前只有简体中文；`dir` 字段保留，作为 RTL 判定的单一
 * 来源——未来若再引入 RTL 语言，只需往这里加条目。
 */
export const LANGUAGES: readonly LanguageEntry[] = [
  { code: 'zh-CN', label: '简体中文', dir: 'ltr' }
];

/** 从 LANGUAGES 派生的 RTL 语言集合（当前为空集）。 */
const RTL_CODES: ReadonlySet<string> = new Set(
  LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code)
);

/**
 * Does this language code read right-to-left?
 *
 * Deliberately EXACT-MATCH on a registered code rather than a prefix or a
 * script guess. An unknown code is left-to-right, which is the direction every
 * user had before this shipped — an unrecognised value must never be able to
 * mirror somebody's UI.
 */
export function isRtlLanguage(lng: string | undefined | null): boolean {
  return !!lng && RTL_CODES.has(lng);
}

/** `'rtl'` or `'ltr'` for a language code, for a `dir` attribute. */
export function directionFor(lng: string | undefined | null): 'rtl' | 'ltr' {
  return isRtlLanguage(lng) ? 'rtl' : 'ltr';
}

/**
 * The orchestrator's display name, for every string that talks about it.
 *
 * The user can rename the god, and roughly forty strings mention it. Baking
 * "败龙" into the locale files would silently undo that rename everywhere at
 * once — a bug this codebase has already fixed three times in the spawn path.
 * So the locales say `{{godName}}` and the live name is supplied here as an
 * i18next DEFAULT VARIABLE, which means no call site has to pass it. A call site
 * that needs a variant (an upper-cased title, say) still overrides it by passing
 * `godName` explicitly.
 */
export function setGodName(name: string | undefined | null): void {
  const next = name?.trim() || DEFAULT_GOD_NAME;
  const interpolation = i18n.options.interpolation ?? (i18n.options.interpolation = {});
  const vars = interpolation.defaultVariables ?? (interpolation.defaultVariables = {});
  if (vars.godName === next) return;
  vars.godName = next;
  // react-i18next re-renders on this event. Without it a rename would only
  // reach strings that happened to re-render for some other reason.
  i18n.emit('languageChanged', i18n.language);
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN }
    },
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN'],
    // Resources are bundled inline, so nothing ever suspends — the string is
    // there at init time. Keeping this false lets every component call
    // useTranslation() without wrapping the tree in <Suspense>.
    react: { useSuspense: false },
    // `defaultVariables` is what lets every {{godName}} string resolve without
    // its call site knowing god's name. setGodName() keeps it current.
    interpolation: { escapeValue: false, defaultVariables: { godName: DEFAULT_GOD_NAME } },
    returnNull: false
  });

export default i18n;