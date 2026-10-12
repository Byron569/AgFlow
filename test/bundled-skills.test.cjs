'use strict';

/**
 * 技能包扩充（P1-5）：BUNDLED_SKILL_IDS 与 resources/skills 落盘一一对应，
 * 每个内置技能都有合法 frontmatter 的 SKILL.md（name 与目录名一致）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { BUNDLED_SKILL_IDS, validateHireManifest } = loadTs('src/shared/hire.ts');
const { parseSkillFrontmatter } = loadTs('src/main/skills.ts');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'resources', 'skills');

test('每个内置技能 id 都有 resources/skills/<id>/SKILL.md，且 frontmatter name 与目录名一致', () => {
  for (const id of BUNDLED_SKILL_IDS) {
    const md = path.join(SKILLS_DIR, id, 'SKILL.md');
    assert.ok(fs.existsSync(md), `missing ${md}`);
    const fm = parseSkillFrontmatter(fs.readFileSync(md, 'utf8'));
    assert.equal(fm.name, id, `${id}: frontmatter name must match the directory id`);
    assert.ok((fm.description ?? '').length > 0, `${id}: description required（它是触发面）`);
  }
});

test('新增周报 / 接口文档技能可从 hire 清单引用（validateHireManifest 接受）', () => {
  const res = validateHireManifest({
    spec: 'agflow/hire@1',
    name: '技能包校验',
    skills: ['af-weekly-report', 'af-api-docs']
  });
  assert.equal(res.ok, true, res.errors.join('; '));
});

test('磁盘上的内置技能目录覆盖 allowlist（temporal 工具技能不受 allowlist 约束）', () => {
  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md')))
    .map((e) => e.name);
  for (const id of BUNDLED_SKILL_IDS) assert.ok(dirs.includes(id), id);
  assert.ok(dirs.length >= BUNDLED_SKILL_IDS.size);
});