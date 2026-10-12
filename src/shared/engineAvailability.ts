/**
 * Can the engine a user is about to pick actually boot on this machine?
 *
 * The onboarding wizard records Michael's engine and nothing checks it until the
 * first spawn. spawnAgentCore then runs the install ladder (cliInstall.ts), and
 * for a provider with no `installCommand` and no `nativeInstallCommand` that
 * ladder ends at the `manual` rung: a hint is printed in a terminal and the
 * orchestrator never starts. This module turns the setup catalog probe
 * (`tools:status`, which already resolves every engine binary on PATH) into one
 * answer per provider so the wizard can say so BEFORE the pick is committed.
 *
 * Pure and electron-free on purpose so it is testable from node --test.
 */
import { providerPreset, type AgentProvider } from './agentProvider';
import type { ToolStatus } from './toolCatalog';

export type EngineAvailabilityState =
  /** The binary resolves on this machine. */
  | 'installed'
  /** Not here yet, but the provider ships an installer the app runs on first spawn. */
  | 'installs-on-first-run'
  /** Not here and nothing we can run: the user has to install it by hand first. */
  | 'not-installable'
  /** The probe did not run or did not cover this provider. Never block on this. */
  | 'unknown';

export interface EngineAvailability {
  state: EngineAvailabilityState;
  /** Absolute path when installed. */
  path: string | null;
  /** The command the app would run (or the user could paste) to install it. */
  installCommand: string;
  docsUrl?: string;
}

/** Classify one provider from the catalog probe. `statuses` is what
 *  `window.cth.toolsStatus()` returned; undefined means it has not run (yet). */
export function classifyEngineAvailability(
  statuses: readonly ToolStatus[] | undefined,
  provider: AgentProvider
): EngineAvailability {
  const row = statuses?.find((s) => s.id === `engine:${provider}`);
  if (!row) return { state: 'unknown', path: null, installCommand: '' };
  const installCommand = row.installCommand ?? '';
  if (row.found) return { state: 'installed', path: row.path, installCommand, docsUrl: row.docsUrl };
  return {
    state: installCommand ? 'installs-on-first-run' : 'not-installable',
    path: null,
    installCommand,
    docsUrl: row.docsUrl
  };
}

/** Whether the wizard must refuse to move on with this engine selected. Only the
 *  proven dead end blocks; an unknown probe never locks a user out. */
export function engineBlocksOnboarding(a: EngineAvailability): boolean {
  return a.state === 'not-installable';
}

// ─── 智能默认引擎 (P0-A11) ────────────────────────────────────────────────────

/** 国产优先 pick order (方案 A-11)。Kimi is listed there but stays skipped until
 *  its hook bridge lands (C-4) and it becomes god-eligible — the engine picked
 *  here is preselected FOR THE GOD, and a god must drain hive mail, so an
 *  ineligible engine would preselect a disabled row. */
const DOMESTIC_PREFERENCE: readonly AgentProvider[] = ['qwen', 'kimi', 'doubao', 'opencode'];

/** The engine the onboarding wizard should preselect: the first INSTALLED 国产
 *  engine in preference order, else `fallback` (the historical default — the
 *  code default constant is deliberately untouched). Candidates must be
 *  god-eligible (model picker + inbox drain). `statuses` undefined = the probe
 *  has not run — never guess, fall back. */
export function pickDefaultEngine(
  statuses: readonly ToolStatus[] | undefined,
  fallback: AgentProvider = 'claude'
): AgentProvider {
  for (const provider of DOMESTIC_PREFERENCE) {
    const preset = providerPreset(provider);
    if (!preset.supportsModel || !preset.canReceiveInbox) continue;
    if (statuses?.find((s) => s.id === `engine:${provider}`)?.found) return provider;
  }
  return fallback;
}

/** One short line for the badge on each engine row. 中文（P0-B）。 */
export function engineAvailabilityBadge(a: EngineAvailability): string | null {
  switch (a.state) {
    case 'installed': return '已安装';
    case 'installs-on-first-run': return '首次运行自动安装';
    case 'not-installable': return '未安装';
    default: return null;
  }
}

/** The explanation shown under the picker when the selected engine cannot boot.
 *  Written for someone who does not know what a CLI engine is: what happened,
 *  then what to do next. 中文（P0-B）；刻意不提总控名，避免写死称呼。 */
export function engineAvailabilityMessage(a: EngineAvailability, label: string): string | null {
  if (a.state !== 'not-installable') return null;
  return `${label} 尚未安装到这台电脑，应用也没有它的安装程序，因此还无法启动。` +
    `请先手动安装，然后点击「重新检查」；或者改选 Claude Code，它会在首次运行时自动安装。`;
}
