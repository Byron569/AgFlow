/**
 * 自定义角色模板存储（P0-D-3 续作，方案 §4-P1「自定义角色模板」）。
 *
 * 用户从 Add-Agent 表单把当前配置存成模板，落到 `<harnessHome>/templates.json`。
 * 该文件是「便利数据」：任何损坏/非法条目都容忍——读时逐条消毒、非法即丢；
 * 写时 tmp+rename 原子落盘（与 config.ts / hive.ts atomicWriteJson 同款纪律，
 * 崩溃只留下旧文件或新文件，绝不半截）。
 *
 * 依赖仅 fs + shared（不 import electron），便于 test/agent-templates.test.cjs
 * 直接装载。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_PROVIDER_PRESETS } from '../shared/agentProvider';
import { BUNDLED_SKILL_IDS } from '../shared/hire';
import type { AgentTemplate } from '../shared/agentTemplates';

export const AGENT_TEMPLATES_FILE = 'templates.json';
/** 模板数量上限——防止误点把文件撑爆；到上限后 save 明确报错，不静默丢弃。 */
export const MAX_AGENT_TEMPLATES = 40;
const NAME_MAX = 40;
const DESC_MAX = 200;
const GOAL_MAX = 4000;
const MODEL_MAX = 80;
const CWD_RULE_MAX = 200;
/** 保留的模板 id：小写字母/数字/连字符；缺失或非法时由保存方生成。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 引擎必须是本地预设之一——包括 'custom'（模板是本地自用数据，信任模型
 *  与可分享的 hire 清单不同，不需要那份保守 allowlist）。 */
const PROVIDER_IDS: ReadonlySet<string> = new Set<string>(AGENT_PROVIDER_PRESETS.map((p) => p.id as string));

function templatesPath(home: string): string {
  return join(home, AGENT_TEMPLATES_FILE);
}

function atomicWriteJson(p: string, data: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* tmp 是一次性文件 */ }
    throw e;
  }
}

function cap(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 消毒一条模板。null = 不可用（非对象 / 缺 name / 引擎非法）。 */
export function sanitizeAgentTemplate(raw: unknown): AgentTemplate | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = cap(o.name, NAME_MAX);
  if (!name) return null;
  const provider = typeof o.provider === 'string' && PROVIDER_IDS.has(o.provider) ? o.provider : null;
  if (!provider) return null;
  const idRaw = typeof o.id === 'string' ? o.id : '';
  const id = ID_RE.test(idRaw)
    ? idRaw
    : `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const skills = Array.isArray(o.skills)
    ? [...new Set(
        o.skills
          .filter((s): s is string => typeof s === 'string' && BUNDLED_SKILL_IDS.has(s.trim()))
          .map((s) => s.trim())
      )].slice(0, 8)
    : [];
  return {
    id,
    name,
    provider: provider as AgentTemplate['provider'],
    model: cap(o.model, MODEL_MAX),
    description: cap(o.description, DESC_MAX),
    goal: cap(o.goal, GOAL_MAX),
    skills,
    cwdRule: cap(o.cwdRule, CWD_RULE_MAX)
  };
}

/** 读全部模板；文件缺失/损坏/超限都安全收敛为空或前 N 条。 */
export function readAgentTemplates(home: string | null | undefined): AgentTemplate[] {
  if (!home) return [];
  const p = templatesPath(home);
  if (!existsSync(p)) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: AgentTemplate[] = [];
  for (const entry of parsed) {
    const t = sanitizeAgentTemplate(entry);
    if (t) out.push(t);
    if (out.length >= MAX_AGENT_TEMPLATES) break;
  }
  return out;
}

/** 保存/按 id 覆盖一条模板；返回刷新后的完整列表。 */
export function saveAgentTemplate(
  home: string | null | undefined,
  raw: unknown
): { ok: boolean; templates: AgentTemplate[]; error?: string } {
  if (!home) return { ok: false, templates: [], error: '尚未设置蜂巢工作区，无法保存模板' };
  const tpl = sanitizeAgentTemplate(raw);
  if (!tpl) return { ok: false, templates: readAgentTemplates(home), error: '模板不完整：需要名称与有效的引擎' };
  const list = readAgentTemplates(home);
  const idx = list.findIndex((t) => t.id === tpl.id);
  if (idx >= 0) {
    list[idx] = tpl;
  } else {
    if (list.length >= MAX_AGENT_TEMPLATES) {
      return { ok: false, templates: list, error: `最多保存 ${MAX_AGENT_TEMPLATES} 个自定义模板` };
    }
    list.push(tpl);
  }
  atomicWriteJson(templatesPath(home), list);
  return { ok: true, templates: list };
}

/** 删除一条模板；返回刷新后的完整列表。 */
export function deleteAgentTemplate(
  home: string | null | undefined,
  id: string
): { templates: AgentTemplate[] } {
  if (!home) return { templates: [] };
  const list = readAgentTemplates(home).filter((t) => t.id !== id);
  atomicWriteJson(templatesPath(home), list);
  return { templates: list };
}