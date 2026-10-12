/**
 * 历史名称（P0-D 改名前）的常量与迁移类型（P1-3）。
 *
 * - `LEGACY_GOD_NAME`：D-1 之前的内置总控默认名。它是唯一有「新名」可迁移的
 *   遗留名称（旧名 → 迁移目标名）。
 * - `LEGACY_CHARACTER_KEYS`：旧美剧角色 key → 新岗位 key。渲染端按名推断形象时
 *   仍认旧名，存量智能体（例如叫 "Meredith" 的）改名后不丢外观。
 * - 扫描/应用的数据形状（IPC 传输用，dumb data）。
 *
 * 依赖为零：main（迁移工具）与 renderer（形象兼容）都从这里取。
 */

/** D-1 之前的旧内置总控默认名。 */
export const LEGACY_GOD_NAME = 'Michael';

/** 旧美剧角色 key（D-2 前）→ 新岗位 key（见 cast.ts 的 15 角色映射）。 */
export const LEGACY_CHARACTER_KEYS: Record<string, string> = {
  michael: 'lead', jim: 'dev', pam: 'designer', dwight: 'qa', kevin: 'data',
  angela: 'finance', oscar: 'architect', stanley: 'sales', phyllis: 'support',
  andy: 'ops', kelly: 'marketing', ryan: 'intern', toby: 'hr', creed: 'security',
  meredith: 'admin'
};

/** 一次历史名称扫描的结果。 */
export interface LegacyNameScan {
  /** 总控的当前名（registry 解析 + 默认回落）。 */
  godName: string;
  /** 总控仍是旧默认名——迁移会先把它改名为新默认名，再替换文本。 */
  godOnLegacyDefault: boolean;
  /** 文本替换的目标名（godOnLegacyDefault ? 新默认名 : godName）。 */
  replacementTarget: string;
  /** 命中文件（相对 hive 根），仅含有命中的。 */
  files: Array<{ rel: string; hits: number }>;
  totalHits: number;
}

/** 迁移应用结果。 */
export interface LegacyNameApplyResult {
  ok: boolean;
  /** 是否顺带把总控从旧默认名改名（由 IPC 层经 hive.renameAgent 完成）。 */
  godRenamed?: boolean;
  filesChanged?: number;
  totalReplaced?: number;
  /** 备份目录（相对 hive 根）；无改动时为 null。 */
  backupDir?: string | null;
  error?: string;
}