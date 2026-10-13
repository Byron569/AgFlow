/**
 * Built-in agent role templates (P0-D-3) — the one-click briefings in the
 * Add-Agent modal's 简报 section. Neutral Chinese office roles with a suggested
 * domestic-first engine (P0-A), a ready-to-run goal, the bundled skills worth
 * activating, and the cwd rule the operator has to satisfy before spawning.
 *
 * Shared between the modal and (P1) the custom-template store; keep it
 * dependency-free apart from the provider type.
 */

import type { AgentProvider } from './agentProvider';

export interface AgentTemplate {
  id: string;
  /** 岗位名（模板选择器上的一键按钮文案）。 */
  name: string;
  /** 建议引擎 — 国产优先（P0-A）；用户仍可在引擎区换掉。 */
  provider: AgentProvider;
  /** 建议模型 id（该引擎的常用档）。 */
  model: string;
  /** 一句话岗位描述，预填进 Description。 */
  description: string;
  /** 长期目标文本，预填进 Goal。 */
  goal: string;
  /** 建议启用的内置技能 id（引用 BUNDLED_SKILL_IDS，绝不携带裸路径）。 */
  skills: string[];
  /** 工作目录要求提示（预填/自检依据；不强制）。 */
  cwdRule: string;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'backend',
    name: '后端开发工程师',
    provider: 'qwen',
    model: 'qwen3-coder-plus',
    description: '实现后端功能、修复缺陷',
    goal: '按任务实现后端功能、修复缺陷：先读代码与现有测试，再做最小可验证的改动；改完运行相关测试与构建，把结果和遗留风险写清楚。未经标注不得改变对外行为。',
    skills: ['af-hive-sync'],
    cwdRule: '选择目标代码仓库目录（含工程文件：package.json / go.mod / pom.xml 等）'
  },
  {
    id: 'frontend',
    name: '前端开发工程师',
    provider: 'doubao',
    model: 'doubao/doubao-seed-2.1-pro',
    description: '实现界面、打磨交互',
    goal: '实现与打磨前端功能：遵循项目已有的设计规范与组件结构，注意响应式与可访问性；改完在本地跑起来自检，附上关键界面截图或说明。',
    skills: ['af-hive-sync'],
    cwdRule: '选择前端工程目录（含 package.json）'
  },
  {
    id: 'docs',
    name: '文档整理专员',
    provider: 'kimi',
    model: 'kimi-code/kimi-for-coding',
    description: '维护文档、保持与代码同步',
    goal: '让文档与代码保持同步：盯住会让 README 与使用文档过时的改动并及时更新；面向新读者写作，多用具体示例，少讲空话；发现失效链接先核实再改。',
    skills: ['af-fetch-summarize'],
    cwdRule: '选择需要维护文档的仓库或文档目录'
  },
  {
    id: 'data',
    name: '数据处理助手',
    provider: 'deepseek',
    model: 'deepseek/deepseek-v4-pro',
    description: '数据清洗、统计与报表',
    goal: '处理数据与报表任务：先核对口径与数据源，再产出可复现的脚本与结论；关键数字附上计算方式和样本范围，存疑的数据先标注再上报。',
    skills: ['af-fetch-summarize'],
    cwdRule: '选择数据文件与脚本所在的目录'
  },
  {
    id: 'qa',
    name: '测试工程师',
    provider: 'qwen',
    model: 'qwen3-coder-plus',
    description: '编写与运行测试、定位缺陷',
    goal: '把关质量：为改动补充并运行测试；对上报的问题先复现、再定位根因，上报时给出最小复现步骤与证据。没有确认根因之前不做修复。',
    skills: ['af-audit'],
    cwdRule: '选择待测项目目录'
  },
  {
    id: 'ops',
    name: '运维助手',
    provider: 'glm',
    model: 'glm/glm-5.3',
    description: '部署、监控与稳定性维护',
    goal: '维护部署与运行稳定性：改动前先确认回滚路径，所有操作留痕；遇到告警先收集证据再动手，处理完把现象、动作、结果记进记忆。',
    skills: ['af-audit'],
    cwdRule: '选择部署脚本或项目目录'
  }
];