/**
 * 便携增强（P2）：数据目录重定向 + 引擎随行目录的纯逻辑。
 *
 * 数据目录三档优先级（高 → 低）：
 *   1. 环境变量 AGFLOW_DATA_DIR（显式覆盖，须为绝对路径）
 *   2. Windows portable 包：electron-builder portable target 注入的
 *      PORTABLE_EXECUTABLE_DIR（程序所在目录）
 *   3. 程序目录中的标记文件 agflow-portable.marker（macOS/Linux 手工便携包：
 *      U 盘 / 免安装目录，把标记文件与程序放在一起即视为便携运行）
 *
 * 纯函数、不 import node:（平台差异走 platform 参数），主进程与测试共用；
 * 文件系统探测（existsSync / mkdirSync / setPath）全部留在 main 侧。
 */

export const PORTABLE_DATA_ENV = 'AGFLOW_DATA_DIR';
export const PORTABLE_MARKER = 'agflow-portable.marker';
export const PORTABLE_DATA_DIR_NAME = 'data';
export const PORTABLE_SESSION_DIR_NAME = 'session';
export const PORTABLE_HIVE_DIR_NAME = 'hive';
export const ENGINES_DIR_NAME = 'engines';

export type PortableDataSource = 'env' | 'win-portable' | 'marker';

export interface PortableDataDir {
  dataDir: string;
  source: PortableDataSource;
}

export interface PortableDataDirInput {
  /** AGFLOW_DATA_DIR 原值（main 侧已做 ~ 展开）。 */
  envDataDir?: string | null;
  /** Windows portable 注入的 PORTABLE_EXECUTABLE_DIR。 */
  portableExeDir?: string | null;
  /** 候选标记目录（main 侧已用 existsSync 判定 hasMarker）。 */
  markerDirs?: ReadonlyArray<{ dir: string; hasMarker: boolean }>;
}

/** 判定「绝对路径」，按目标平台解析（env 覆盖只接受绝对路径，相对路径
 *  会随 CWD 漂移，等于把数据目录钉在一个不确定的位置）。 */
export function isAbsoluteDataPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
  }
  return p.startsWith('/');
}

function joinChild(dir: string, name: string, platform: NodeJS.Platform): string {
  const sep = platform === 'win32' ? '\\' : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return trimmed ? `${trimmed}${sep}${name}` : `${sep}${name}`;
}

export function resolvePortableDataDir(
  input: PortableDataDirInput,
  platform: NodeJS.Platform = process.platform
): PortableDataDir | null {
  const env = input.envDataDir?.trim();
  if (env && isAbsoluteDataPath(env, platform)) {
    return { dataDir: env, source: 'env' };
  }
  const exeDir = input.portableExeDir?.trim();
  if (exeDir && isAbsoluteDataPath(exeDir, platform)) {
    return { dataDir: joinChild(exeDir, PORTABLE_DATA_DIR_NAME, platform), source: 'win-portable' };
  }
  for (const m of input.markerDirs ?? []) {
    if (m.hasMarker && isAbsoluteDataPath(m.dir, platform)) {
      return { dataDir: joinChild(m.dir, PORTABLE_DATA_DIR_NAME, platform), source: 'marker' };
    }
  }
  return null;
}

/**
 * 把 `<数据目录>/engines` 置顶到子进程 PATH：便携包里用户把引擎 CLI 直接放在
 * 数据目录的 engines/ 下，换机即可用（本机已装同名 CLI 时同样以随行版本优先，
 * 保证「换机完整」；需要系统版本时删掉该目录即可）。
 *
 * 置顶 + 去重（重复项会被剔除，重 spawn 的agent 不会把 PATH 越接越长）。
 */
export function withEnginesPath(
  path: string,
  enginesDir: string | null | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  if (!enginesDir) return path;
  const sep = platform === 'win32' ? ';' : ':';
  const entryKey = (s: string): string => {
    const trimmed = s.replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const target = entryKey(enginesDir);
  const rest = path.split(sep).filter(Boolean).filter((e) => entryKey(e) !== target);
  return [enginesDir, ...rest].join(sep);
}

/**
 * 工具探测优先路径：先查 engines/，未命中再回退 shellEnv.resolveCommand。
 * Windows 下按 PATHEXT 顺序补 .exe/.cmd/.bat（.cmd 不能直接 CreateProcess，
 * 但探测只回答「有没有」；真正 spawn 仍走 pty 的 shim 解码）。返回候选顺序，
 * 文件系统判定留给调用方（本模块保持纯净）。 */
export function enginesBinCandidates(
  enginesDir: string,
  bin: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (!bin || bin.includes('/') || bin.includes('\\')) return [];
  const base = joinChild(enginesDir, bin, platform);
  if (platform === 'win32') return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base];
  return [base];
}

// ─── 迁移向导（P2）数据形状 ─────────────────────────────────────────────────
// 扫描 = 只读；导入 = 绝不覆盖（目标已存在即跳过）。文件系统实现在
// src/main/portableData.ts（纯 fs、不 import electron，测试可直接装载）。

export interface PortableStatus {
  mode: 'portable' | 'default';
  source: PortableDataSource | null;
  /** 当前实际使用的数据目录（userData，已含便携重定向）。 */
  dataDir: string;
  enginesDir: string;
  /** 引擎随行目录里的条目数（0 = 尚未放置任何引擎）。 */
  enginesCount: number;
  /** 重定向前的 Electron 默认数据目录（迁移向导的自动探测来源）。 */
  defaultDataDir: string;
  /** 当前 hive 根目录（config.harnessHome），未设置 = null。 */
  hiveRoot: string | null;
  /** 便携运行时可自动扫描的旧数据目录；非便携 = null。 */
  legacyDir: string | null;
}

export type PortableImportName = 'config.json' | 'roster.json' | 'templates.json';

export interface PortableImportItem {
  name: PortableImportName;
  from: string;
  to: string;
  sizeBytes: number;
  /** 目标已存在 → 导入时会跳过（绝不覆盖）。 */
  targetExists: boolean;
}

export interface PortableScanResult {
  sourceDir: string;
  items: PortableImportItem[];
  skipped: Array<{ name: PortableImportName; reason: 'missing' | 'no-harness-home' | 'same-file' }>;
}

export interface PortableImportResult {
  ok: boolean;
  copied: string[];
  skippedExisting: string[];
  errors: Array<{ name: string; error: string }>;
  /** 整体失败（目录不可读等）；逐文件失败在 errors 里。 */
  error?: string;
}