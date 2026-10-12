/**
 * The setup catalog — every EXTERNAL tool the harness can use, what it buys the
 * user, and how to install it on this platform.
 *
 * Why this file exists: the app ships as one Electron bundle, but several of its
 * best features are thin wrappers over tools that live outside it — mempalace for
 * semantic memory, uv to install mempalace, git for worktrees, and one CLI per
 * agent engine. Every one of them degrades SILENTLY when absent (that is the
 * deliberate design — `memory.start()` is a documented no-op without mempalace),
 * which is friendly right up until the user cannot tell "off" from "broken" and
 * has no single place that says which is which. This catalog is that place.
 *
 * The engine rows are DERIVED from AGENT_PROVIDER_PRESETS rather than restated
 * here: those presets already carry `defaultCommand`, `installCommand`,
 * `nativeInstallCommand` and `docsUrl`, and a second hand-maintained copy would
 * drift the moment a provider is added.
 */

import { AGENT_PROVIDER_PRESETS } from './agentProvider';

export type ToolKind = 'prerequisite' | 'memory' | 'engine';

export interface ToolSpec {
  /** Stable row id. For a probed binary this is also the name we look up. */
  id: string;
  /** The executable to probe on PATH, or null when presence is derived some
   *  other way (mempalace comes from the memory subsystem's own status). */
  bin: string | null;
  label: string;
  kind: ToolKind;
  /** One line, benefit-framed: what the user LOSES without it. */
  why: string;
  /** Part of "set up everything". Everything else is opt-in. */
  essential: boolean;
  /** Install command per platform. Empty string = no scripted install. */
  install: { posix: string; win32: string };
  /** Shown when there is no scripted install, or as extra context. */
  note?: string;
  docsUrl?: string;
}

/** Base rows — the non-engine tools. Engines are appended by `toolCatalog()`. */
const BASE_TOOLS: ToolSpec[] = [
  {
    id: 'uv',
    bin: 'uv',
    label: 'uv',
    kind: 'prerequisite',
    why: '安装并运行 mempalace。一套自包含的 Python 工具链——不会碰你已有的任何 Python。',
    essential: true,
    install: {
      posix: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      // PowerShell, not cmd.exe: astral ships install.ps1 for Windows and there
      // is no .bat equivalent. Quoted so it survives being pasted into either.
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    },
    docsUrl: 'https://docs.astral.sh/uv/'
  },
  {
    id: 'mempalace',
    bin: null, // presence comes from MemoryStatus.available, not a PATH probe
    label: 'MemPalace — 语义记忆',
    kind: 'memory',
    why: '跨你的智能体所学的一切做按含义的回忆。没有它时，智能体仍会保留普通 markdown 笔记，但无法按含义检索。',
    essential: true,
    install: {
      posix: 'uv tool install mempalace',
      win32: 'uv tool install mempalace'
    },
    note: '需要先安装 uv。'
  },
  {
    id: 'git',
    bin: 'git',
    label: 'git',
    kind: 'prerequisite',
    why: '工作树让多个智能体并行工作而不争抢同一份检出；蜂巢也用它保存自己的历史。',
    essential: true,
    install: {
      posix: 'xcode-select --install   # macOS · or: sudo apt install git',
      win32: 'winget install --id Git.Git -e'
    },
    docsUrl: 'https://git-scm.com/downloads'
  },
  {
    id: 'node',
    bin: 'node',
    label: 'Node.js',
    kind: 'prerequisite',
    why: '运行通过 npm 安装的智能体引擎（OpenCode，以及没有原生构建时的 Claude Code）。',
    essential: false,
    // Deliberately no scripted command: the app already ships a checksum-verified
    // Node installer (nodeInstall.ts) that runs automatically when an engine needs
    // one. Printing a rival curl|sh here would compete with it.
    install: { posix: '', win32: '' },
    note: '引擎需要时应用会自动为你安装——无需手动操作。',
    docsUrl: 'https://nodejs.org'
  }
];

/**
 * The full catalog for a platform. `platform` is a `process.platform` value; only
 * win32 vs everything-else matters.
 */
export function toolCatalog(): ToolSpec[] {
  const engines: ToolSpec[] = AGENT_PROVIDER_PRESETS
    // `custom` is whatever the user typed — there is nothing to detect or install.
    .filter((p) => p.id !== 'custom' && !!p.defaultCommand)
    .map((p) => ({
      id: `engine:${p.id}`,
      bin: p.defaultCommand,
      label: p.label,
      kind: 'engine' as const,
      why: `智能体引擎：${p.defaultCommand}。`,
      // Claude Code is the recommended engine and the only one the floor assumes
      // by default, so it is the one engine "set up everything" will install.
      essential: p.id === 'claude',
      install: {
        posix: p.installCommand ?? p.nativeInstallCommand?.posix ?? '',
        win32: p.installCommand ?? p.nativeInstallCommand?.win32 ?? ''
      },
      docsUrl: p.docsUrl
    }));
  return [...BASE_TOOLS, ...engines];
}

/** A catalog row plus what we found on THIS machine. */
export interface ToolStatus extends ToolSpec {
  found: boolean;
  /** Absolute path when found, or null. */
  path: string | null;
  /** Extra live context — e.g. "palace initialised", a version string. */
  detail?: string;
  /** `install` already resolved for the running platform. */
  installCommand: string;
}

/**
 * The prompt handed to 败龙 by "ask 败龙 to set up everything".
 *
 * Written as an explicit contract rather than a wish: name the exact commands so
 * he does not have to guess or search, tell him to VERIFY rather than assume, and
 * make the ordering dependency (uv before mempalace) explicit — an orchestrator
 * that installs mempalace first just fails and reports failure.
 */
export function setupPrompt(missing: ToolStatus[]): string {
  if (missing.length === 0) return '';
  const lines = missing.map((t) => {
    const cmd = t.installCommand ? `\n  install: ${t.installCommand}` : '';
    const note = t.note ? `\n  note: ${t.note}` : '';
    return `- ${t.label} (${t.id})${cmd}${note}`;
  });
  return [
    '请帮我安装缺失的本地工具。下面这些是本应用使用、但这台机器上尚未安装的工具：',
    '',
    ...lines,
    '',
    '对每一个工具：在你自己的终端里执行安装命令，然后先验证它确实能解析到',
    '（`which <bin>`，Windows 用 `where <bin>`）再继续——不要假设没报错的安装器就成功了。',
    '先装 uv 再装 mempalace；mempalace 是由 uv 安装的，没有它会直接失败。',
    '',
    '如果某条命令需要我的密码，或需要只有我能做的决定，停下来问我，不要猜测或绕过。',
    '完成后，每个工具报告一行：已安装、本已存在，或失败及原因。'
  ].join('\n');
}
