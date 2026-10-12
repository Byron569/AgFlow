// The office cast — roster metadata + sprite frames (15 neutral office roles).
//
// Both the static portraits (cards / picker) and the in-scene walking sprites are
// now fully custom-drawn from the same per-character recipes in portraitArt.ts:
// the scene sprite reuses the portrait's exact head/face/clothing and adds legs,
// so an agent on the office floor looks identical to its card. The LimeZu base
// sheets are no longer used for the cast. See assets/ATTRIBUTION.md.
//
// P0-D-2: keys are office roles with Chinese displayName/blurb; the TV-show
// character names are gone while portraitArt keeps each role's original look.

import { Texture } from 'pixi.js';
import { LEGACY_CHARACTER_KEYS as LEGACY_CHARACTER_KEYS_RAW } from '@shared/legacyNames';
import { paintPortrait, sceneFrameBufs, SCENE_W, SCENE_H } from './portraitArt';

export type OfficeCharacterName =
  | 'lead' | 'dev' | 'designer' | 'qa' | 'data'
  | 'finance' | 'architect' | 'sales' | 'support' | 'ops'
  | 'marketing' | 'intern' | 'hr' | 'security' | 'admin';

export interface CastMember {
  name: OfficeCharacterName;
  displayName: string;
  /** Signature accent color (hex) — used for the in-scene selection glow. */
  shirt: string;
  /** Blurb shown when this character is picked / has no description yet. */
  blurb: string;
}

/** Selectable roster, in display order. */
export const OFFICE_CAST: CastMember[] = [
  { name: 'lead',      displayName: '项目负责人', shirt: '#5a6b8c', blurb: '统筹与决策' },
  { name: 'dev',       displayName: '后端工程师', shirt: '#6fa8dc', blurb: '写代码、修缺陷' },
  { name: 'designer',  displayName: '设计师',     shirt: '#9caf88', blurb: '界面与体验' },
  { name: 'qa',        displayName: '测试工程师', shirt: '#b89b3e', blurb: '质量把关' },
  { name: 'data',      displayName: '数据分析师', shirt: '#4a7ab5', blurb: '报表与指标' },
  { name: 'finance',   displayName: '财务',       shirt: '#8a86a6', blurb: '预算与核对' },
  { name: 'architect', displayName: '架构师',     shirt: '#7a4b6b', blurb: '技术方案' },
  { name: 'sales',     displayName: '销售',       shirt: '#8c5a4b', blurb: '客户与签约' },
  { name: 'support',   displayName: '客户支持',   shirt: '#b08bbf', blurb: '答疑与安抚' },
  { name: 'ops',       displayName: '运维',       shirt: '#6fae6f', blurb: '部署与稳定性' },
  { name: 'marketing', displayName: '市场运营',   shirt: '#d16ba5', blurb: '推广与活动' },
  { name: 'intern',    displayName: '实习生',     shirt: '#3a3a44', blurb: '杂活与成长' },
  { name: 'hr',        displayName: '人力资源',   shirt: '#9a8c5a', blurb: '招聘与关系' },
  { name: 'security',  displayName: '安全',       shirt: '#6b7a4b', blurb: '审计与合规' },
  { name: 'admin',     displayName: '行政',       shirt: '#b5544a', blurb: '后勤与采购' },
];

export const CAST_BY_NAME: Record<OfficeCharacterName, CastMember> =
  Object.fromEntries(OFFICE_CAST.map((c) => [c.name, c])) as Record<OfficeCharacterName, CastMember>;

export const DEFAULT_CHARACTER: OfficeCharacterName = 'dev';

/** 旧美剧角色名 → 新岗位 key（P0-D-2 兼容）：存量智能体按名字推断形象时，
 *  旧名（如 "Meredith"/"Jim"）仍然命中同一造型（绘制配方未变），改名不丢外观。 */
export const LEGACY_CHARACTER_KEYS: Record<string, OfficeCharacterName> =
  LEGACY_CHARACTER_KEYS_RAW as Record<string, OfficeCharacterName>;

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── scene frames ────────────────────────────────────────────────────────────
const frameCache = new Map<OfficeCharacterName, Texture[][]>();

function bufToTexture(buf: Uint8ClampedArray): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_W; canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SCENE_W, SCENE_H);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * Frame grid CharacterSprite expects: 3 rows (down, up, right) × 7 frames
 * [walk1, walk2, walk3, type1, type2, read1, read2]. We provide a front view
 * (down — and reused for the side row, so left/right walkers still show a face)
 * and a back view (up — agents seated facing their desk show their back). The
 * three walk frames are stand / step-left / step-right.
 */
export async function getCastFrames(name: OfficeCharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const { front, back } = sceneFrameBufs(name);
  const toRow = (bufs: Uint8ClampedArray[]): Texture[] => {
    const [stand, stepL, stepR] = bufs.map(bufToTexture);
    return [stand, stepL, stepR, stand, stand, stand, stand];
  };
  const frontRow = toRow(front);
  const frames: Texture[][] = [frontRow, toRow(back), frontRow]; // down, up, right
  frameCache.set(name, frames);
  return frames;
}

/**
 * Paint a character's static portrait for cards / the picker (delegates to the
 * custom procedural composer in portraitArt.ts).
 */
export async function paintCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: OfficeCharacterName,
  scale = 2,
): Promise<void> {
  paintPortrait(ctx, name, scale);
}