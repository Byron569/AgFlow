/**
 * 历史名称迁移（P1-3，方案 §4-P1「历史名称替换工具」）。
 *
 * 改名（D-1 败龙 / D-2 岗位角色）之后，把存量数据里的旧名残留清干净：
 *   - 扫描面：`board.md`、`tasks.json`、`agents/<id>/memory.md`、`agents/<id>/inbox/**`
 *     （含 .done）、`agents/<id>/outbox/**`（含 .sent）——方案四项 + outbox 成对
 *     语料，避免「收到/发出」两份消息被改成不一致的状态；
 *   - 替换对象：只有「旧内置总控默认名 → 迁移目标名」这一条映射
 *     （LEGACY_GOD_NAME → target）。其他旧名（Jim/Pam…）是用户自己的智能体名
 *     或数据内容，没有对应新名，不属于「替换」；
 *   - registry 上的总控改名不在这里做：IPC 层复用 hive.renameAgent
 *     （registry/fleet/log/commit 一并保持同步）。
 *
 * 写盘纪律：命中文件先按相对路径整份备份到 `backups/name-migration-<ts>/`
 * （附 manifest.json），再 tmp+rename 原子替换。
 *
 * 纯 fs + shared 依赖（不 import electron），test/name-migration.test.cjs 直接装载。
 */
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DEFAULT_GOD_NAME, resolveGodName } from '../shared/godIdentity';
import { LEGACY_GOD_NAME, type LegacyNameApplyResult, type LegacyNameScan } from '../shared/legacyNames';

/** 单文件读上限——病态大文件跳过（正式数据都在 KB 级）。 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** 旧名的词边界匹配源串。大小写敏感：旧默认名的正式写法就是 '败龙'，
 *  而 'michael-voice' 这类小写机器名不受影响。 */
const LEGACY_NAME_RE = `\\b${LEGACY_GOD_NAME}\\b`;

function countHits(text: string): number {
  return (text.match(new RegExp(LEGACY_NAME_RE, 'g')) ?? []).length;
}

function walkJsonFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonFiles(p, out);
    else if (entry.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/** 相对 hive 根的扫描清单：board.md + tasks.json + 每个智能体的 memory/inbox/outbox。 */
function collectTextFiles(home: string): string[] {
  const out: string[] = [];
  const push = (abs: string) => {
    try {
      if (existsSync(abs) && statSync(abs).isFile()) out.push(relative(home, abs));
    } catch { /* 读不了的文件跳过：迁移是尽力而为的清理，不是数据校验 */ }
  };
  push(join(home, 'board.md'));
  push(join(home, 'tasks.json'));
  const agentsDir = join(home, 'agents');
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      push(join(agentsDir, entry.name, 'memory.md'));
      for (const sub of ['inbox', 'outbox']) {
        for (const abs of walkJsonFiles(join(agentsDir, entry.name, sub))) out.push(relative(home, abs));
      }
    }
  }
  return out;
}

function readGodName(home: string): string {
  try {
    const reg = JSON.parse(readFileSync(join(home, 'registry.json'), 'utf8')) as {
      godId?: string | null;
      agents?: Record<string, { name?: string }>;
    };
    const id = typeof reg.godId === 'string' ? reg.godId : undefined;
    return resolveGodName(id ? reg.agents?.[id]?.name : undefined);
  } catch {
    return DEFAULT_GOD_NAME;
  }
}

function writeAtomic(p: string, content: string): void {
  const tmp = `${p}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* tmp 是一次性文件 */ }
    throw e;
  }
}

/**
 * 收口编排：总控仍是旧默认名时先改名（`renameGod` 由调用方注入——IPC 层传
 * `hive.renameAgent`），再替换文本。
 *
 * 手动入口（设置页「扫描 → 确认」）与启动自动收口共用这一份：存量安装的
 * registry 里总控名会一直是旧默认名（改名通道只认显式改名，不会跟随新默认
 * 值），不自动收口的话设置面板 / 楼层卡片会一直显示旧名。
 */
export function cleanupLegacyNames(
  home: string | null | undefined,
  renameGod: () => { ok: boolean; error?: string }
): LegacyNameApplyResult {
  if (!home) return { ok: false, error: '尚未设置蜂巢工作区' };
  const scan = scanLegacyNames(home);
  let godRenamed = false;
  if (scan.godOnLegacyDefault) {
    const res = renameGod();
    if (!res.ok) return { ok: false, error: res.error ?? '改总控名失败，未做任何替换' };
    godRenamed = true;
  }
  // replacementTarget 在 godOnLegacyDefault 时就是改名目标（新默认名），
  // 与手动入口此前逐字一致。
  return { ...applyLegacyNameMigration(home, scan.replacementTarget), godRenamed };
}

/** 只读扫描：返回命中清单，不写盘。 */
export function scanLegacyNames(home: string | null | undefined): LegacyNameScan {
  const base = (godName: string, godOnLegacyDefault: boolean): LegacyNameScan => ({
    godName,
    godOnLegacyDefault,
    replacementTarget: godOnLegacyDefault ? DEFAULT_GOD_NAME : godName,
    files: [],
    totalHits: 0
  });
  if (!home) return base(DEFAULT_GOD_NAME, false);
  const godName = readGodName(home);
  const godOnLegacyDefault = godName === LEGACY_GOD_NAME;
  const scan = base(godName, godOnLegacyDefault);
  if (scan.replacementTarget === LEGACY_GOD_NAME) return scan; // 理论不可达（改名后目标即新默认名）
  for (const rel of collectTextFiles(home)) {
    const abs = join(home, rel);
    try {
      if (statSync(abs).size > MAX_SCAN_BYTES) continue;
      const hits = countHits(readFileSync(abs, 'utf8'));
      if (hits > 0) { scan.files.push({ rel, hits }); scan.totalHits += hits; }
    } catch { /* 单个文件读失败不影响其余扫描 */ }
  }
  return scan;
}

/**
 * 执行文本迁移：备份 + 旧总控名 → `target` 替换。
 * registry 上的改名由调用方（IPC 层，复用 hive.renameAgent）先行完成。
 */
export function applyLegacyNameMigration(
  home: string | null | undefined,
  target: string
): LegacyNameApplyResult {
  if (!home) return { ok: false, error: '尚未设置蜂巢工作区' };
  const to = target.trim();
  if (!to || to === LEGACY_GOD_NAME) {
    return { ok: true, godRenamed: false, filesChanged: 0, totalReplaced: 0, backupDir: null };
  }
  const hits = scanLegacyNames(home).files;
  if (hits.length === 0) {
    return { ok: true, godRenamed: false, filesChanged: 0, totalReplaced: 0, backupDir: null };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRel = join('backups', `name-migration-${stamp}`);
  const backupAbs = join(home, backupRel);
  const re = new RegExp(LEGACY_NAME_RE, 'g');
  const written: Array<{ rel: string; hits: number }> = [];
  let totalReplaced = 0;

  for (const { rel, hits: fileHits } of hits) {
    const abs = join(home, rel);
    const content = readFileSync(abs, 'utf8');
    // 函数式替换：目标名里即便出现 `$&` 之类的替换模式字符也不会被特殊解释。
    const replaced = content.replace(re, () => to);
    if (replaced === content) continue;
    const dest = join(backupAbs, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    writeAtomic(abs, replaced);
    written.push({ rel, hits: fileHits });
    totalReplaced += fileHits;
  }

  mkdirSync(backupAbs, { recursive: true });
  writeFileSync(
    join(backupAbs, 'manifest.json'),
    JSON.stringify({ ts: new Date().toISOString(), from: LEGACY_GOD_NAME, to, files: written }, null, 2),
    'utf8'
  );
  return { ok: true, godRenamed: false, filesChanged: written.length, totalReplaced, backupDir: backupRel };
}