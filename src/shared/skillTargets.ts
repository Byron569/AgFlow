/**
 * 技能投放目标（P1-3）— 内置只读技能在「各引擎自己的技能目录」里的落点。
 *
 * 依据各 CLI 官方文档核实（2026-10）：
 *  - Claude Code：`.claude/skills/`（W3 既有投放，行为不变）。
 *  - OpenCode 家族（opencode / 豆包 / GLM / Ollama，以及 DeepSeek 的壳回退）：
 *    官方文档列出四个扫描位置，其中「全局配置目录 `$OPENCODE_CONFIG_DIR/skills/`」
 *    是本应用可控的一个——spawn 时已把 OPENCODE_CONFIG_DIR 指向
 *    `<agentDir>/.opencode`（plugin 桥），所以 `<agentDir>/.opencode/skills/`
 *    会被自动发现；`.claude/skills/`（Claude 兼容路径）一并保留，互为兜底。
 *  - Qwen Code：目录约定是 `~/.qwen/skills/`（个人）与 `<项目>/.qwen/skills/`（项目），
 *    没有 per-agent 配置通道——写用户家目录或用户仓库都不可以，改为由注入提示词的
 *    技能清单兜底（qwen 有 `-i` 种子通道）。
 *  - Kimi：`~/.kimi/skills/`、`<项目根>/.kimi/skills/`，以及 `--skills-dir` 参数
 *    （且该参数会「替代」自动发现目录）；既无 per-agent 配置通道也无提示词通道——
 *    本轮不投放，记为遗留（待 Kimi 桥落地后再接）。
 *  - DeepSeek：2026-10 真机实测后从 dsh 改走 OpenCode 壳（dsh 无交互 profile），
 *    随 OpenCode 家族投放 `.opencode/skills`（在 agent 私有目录内，无副作用）。
 *    若用户手动改用 dsh（命令框填 `dsh <profile>`），技能由提示词清单兜底覆盖。
 *  - ZCode（zcode，智谱 GLM 命令行版）：技能目录约定未在官方文档核实，且二进制
 *    可能来自桌面 bundle（无 per-agent 配置通道）——不投目录，提示词兜底
 *    （种子打字投递）覆盖；二进制在 PATH 时才可 spawn（探测口径一致）。
 */
import type { AgentProvider } from './agentProvider';

/** agent 私有目录内的相对投放路径，按引擎的技能发现约定排列（首个 = 提示词引用路径）。 */
export function skillDropDirs(provider: AgentProvider | undefined): string[] {
  switch (provider) {
    case 'opencode':
    case 'doubao':
    case 'glm':
    case 'ollama':
    case 'deepseek':
      return ['.opencode/skills', '.claude/skills'];
    default:
      return ['.claude/skills'];
  }
}

/** 提示词兜底行：引擎没有可靠的自动发现面时，由注入提示词列出内置技能清单与读取
 *  方式（方案 P0 承诺的兜底，P1 落地）。ids 为空 → 空串（调用方 filter(Boolean) 丢弃）。 */
export function bundledSkillsLine(dir: string, ids: readonly string[]): string {
  if (!ids.length) return '';
  return `内置技能：应用随附了一组只读技能包，位于 ${dir}（每项是一个含 SKILL.md 的目录：${ids.join('、')}）。任务契合其中某项时，先读它的 SKILL.md 再照做；这些目录是只读的，不要修改。`;
}