import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  PortableImportItem,
  PortableImportName,
  PortableImportResult,
  PortableScanResult
} from '../shared/portable';

/**
 * 迁移向导（P2）：把旧数据目录里的配置搬到当前数据目录。
 *
 * 纯 fs + shared 类型、不 import electron（沿用 nameMigration.ts 的测试模式），
 * 主进程负责定位目录（DEFAULT_USER_DATA_DIR / config.harnessHome）后调用这里。
 *
 * 两条铁律：
 *  1. 扫描只读——不动任何一边的磁盘。
 *  2. 导入绝不覆盖——目标文件已存在即跳过（用户想全量迁移就先备份并删除目标，
 *     再执行导入；这比一个「覆盖」勾选框安全得多）。
 */

/** 迁移范围：应用配置（数据目录根） + 蜂巢花名册与角色模板库（hive 根目录）。 */
export const PORTABLE_IMPORT_NAMES: readonly PortableImportName[] = [
  'config.json',
  'roster.json',
  'templates.json'
] as const;

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** 读旧目录 config.json 里记录的 harnessHome（roster/templates 的真实位置）。 */
function legacyHarnessHome(sourceDir: string): string | null {
  try {
    const raw = readFileSync(join(sourceDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { harnessHome?: unknown };
    const home = typeof parsed.harnessHome === 'string' ? parsed.harnessHome.trim() : '';
    if (!home || !isAbsolute(expandTilde(home))) return null;
    return expandTilde(home);
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** roster.json / templates.json 的源候选，按可信度排序：
 *  ① 源目录本身就是 hive 根（用户直接选了旧 harnessHome）
 *  ② 旧 config.json 记录的 harnessHome（常规旧安装）
 *  ③ <源目录>/hive（便携包的数据目录布局 —— 首启默认 hive 就在这） */
function hiveFileCandidates(sourceDir: string, name: PortableImportName): string[] {
  const out: string[] = [join(sourceDir, name)];
  const legacyHome = legacyHarnessHome(sourceDir);
  if (legacyHome && !samePath(legacyHome, sourceDir)) out.push(join(legacyHome, name));
  out.push(join(sourceDir, 'hive', name));
  return out;
}

export function scanPortableSource(
  sourceDir: string,
  opts: { dataDir: string; harnessHome: string | null }
): PortableScanResult {
  const items: PortableImportItem[] = [];
  const skipped: PortableScanResult['skipped'] = [];
  const src = resolve(sourceDir);
  const targetHome = opts.harnessHome ? expandTilde(opts.harnessHome) : null;

  for (const name of PORTABLE_IMPORT_NAMES) {
    const isConfig = name === 'config.json';
    let from: string | null = null;
    for (const candidate of isConfig ? [join(src, name)] : hiveFileCandidates(src, name)) {
      if (existsSync(candidate)) {
        from = candidate;
        break;
      }
    }
    if (!from) {
      skipped.push({ name, reason: 'missing' });
      continue;
    }
    const to = isConfig ? join(opts.dataDir, name) : targetHome ? join(targetHome, name) : null;
    if (!to) {
      // roster/templates 必须有 hive 根目录才能落位；config 永远落在数据目录。
      skipped.push({ name, reason: 'no-harness-home' });
      continue;
    }
    if (samePath(from, to)) {
      skipped.push({ name, reason: 'same-file' });
      continue;
    }
    items.push({ name, from, to, sizeBytes: sizeOf(from), targetExists: existsSync(to) });
  }
  return { sourceDir: src, items, skipped };
}

/** 执行导入：目标已存在一律跳过（在复制前一刻再判一次，防止扫描与导入之间
 *  有别的写入）；单文件走 tmp + rename，失败不留下半截目标文件。 */
export function importPortableItems(items: readonly PortableImportItem[]): PortableImportResult {
  const copied: string[] = [];
  const skippedExisting: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (const item of items) {
    if (existsSync(item.to)) {
      skippedExisting.push(item.name);
      continue;
    }
    const tmp = `${item.to}.agflow-import-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dirname(item.to), { recursive: true });
      copyFileSync(item.from, tmp);
      renameSync(tmp, item.to);
      copied.push(item.name);
    } catch (e) {
      errors.push({ name: item.name, error: e instanceof Error ? e.message : String(e) });
      try { unlinkSync(tmp); } catch { /* 清理失败不掩盖真实错误 */ }
    }
  }
  return { ok: errors.length === 0, copied, skippedExisting, errors };
}