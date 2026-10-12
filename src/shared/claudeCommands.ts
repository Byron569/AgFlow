/**
 * Single source of truth for the command reference.
 *
 * Consumed by BOTH the renderer (the Command Center "commands" tab) and the main
 * process (rendered to `<hive>/COMMANDS.md`, which the orchestrator agent reads),
 * so the human's cheat-sheet and the agent's reference never drift.
 *
 * Web-verified against the Claude Code docs (slash + CLI reference) for v2.1.x.
 * Curated to the broadly-useful set — aliases and trivia are intentionally omitted.
 * Group titles and descriptions are Chinese (P0-B): this app is Chinese-only, and
 * both consumers are Chinese-facing (the UI tab and the hive's generated doc).
 *
 * `kind` doubles as the scope hint an orchestrator needs:
 *   - `slash` acts ONLY on the session it's typed into (you cannot run it on
 *     another agent's terminal).
 *   - `cli` runs in a shell and can target the fleet / spawn / query.
 */
export type CmdKind = 'slash' | 'cli';

export interface Cmd {
  cmd: string;
  kind: CmdKind;
  desc: string;
  usage?: string;
}

export interface CmdGroup {
  title: string;
  items: Cmd[];
}

export const COMMAND_GROUPS: CmdGroup[] = [
  {
    title: '会话',
    items: [
      { cmd: '/clear', kind: 'slash', desc: '开一段全新对话，把上下文窗口完整收回。旧会话仍留在 /resume 里。' },
      { cmd: '/resume', kind: 'slash', desc: '挑选或搜索一段历史会话继续。', usage: '/resume auth refactor' },
      { cmd: '/rewind', kind: 'slash', desc: '把代码和对话一起回退到更早的检查点。' },
      { cmd: '/compact', kind: 'slash', desc: '把到目前为止的对话压成摘要，腾出上下文又不断线。', usage: '/compact keep the auth decisions' },
      { cmd: 'claude -c', kind: 'cli', desc: '继续本目录下最近的一段会话。' },
      { cmd: 'claude -r', kind: 'cli', desc: '恢复——挑选或搜索一段历史会话。', usage: 'claude -r auth' },
      { cmd: 'claude --fork-session', kind: 'cli', desc: '恢复时新开一个会话 id 分支，而不是复用原会话。' }
    ]
  },
  {
    title: '上下文与记忆',
    items: [
      { cmd: '/context', kind: 'slash', desc: '可视化上下文窗口被什么占满，并给出优化建议。' },
      { cmd: '/memory', kind: 'slash', desc: '打开项目与用户的 CLAUDE.md 记忆文件进行编辑。' },
      { cmd: '/init', kind: 'slash', desc: '扫描仓库，生成一份记录其约定的 CLAUDE.md。' },
      { cmd: '# ', kind: 'slash', desc: '快速记忆：行首用 # 就能把一条长期笔记追加进记忆。', usage: '# always run prettier before committing' },
      { cmd: 'claude --add-dir ../other-repo', kind: 'cli', desc: '额外授权本会话读写某个目录。' }
    ]
  },
  {
    title: '模型与算力',
    items: [
      { cmd: '/model', kind: 'slash', desc: '切换本会话的模型（会存为默认）；方向键可调算力档。', usage: '/model opus' },
      { cmd: '/effort', kind: 'slash', desc: '设置推理强度：low / medium / high / xhigh / max。', usage: '/effort high' },
      { cmd: '/fast', kind: 'slash', desc: '切换快速模式——Opus 输出更快，不降级模型。' },
      { cmd: 'claude --model claude-sonnet-4-6[1m]', kind: 'cli', desc: '以指定模型启动。[1m] 后缀选择 100 万令牌窗口（Dwight）。' },
      { cmd: 'claude --fallback-model sonnet', kind: 'cli', desc: '主模型不可用时自动回退到另一个模型。' }
    ]
  },
  {
    title: '规划与执行',
    items: [
      { cmd: '/plan', kind: 'slash', desc: '进入规划模式——先设计改动，再动手编辑。', usage: '/plan refactor the auth module' },
      { cmd: '/goal', kind: 'slash', desc: '设定目标条件；达成之前会跨多轮持续工作。', usage: '/goal all tests pass' },
      { cmd: '/batch', kind: 'slash', desc: '把大改动拆成并行单元，各自跑在独立的 git worktree 里。', usage: '/batch migrate components to v2' },
      { cmd: '/diff', kind: 'slash', desc: '打开当前改动的交互式差异查看器。' },
      { cmd: '/run', kind: 'slash', desc: '启动并驱动项目应用，实际看到改动生效。' },
      { cmd: '/verify', kind: 'slash', desc: '构建、运行并观察，确认改动确实做到了该做的事。' },
      { cmd: 'claude --worktree feat/x', kind: 'cli', desc: '在独立的 git worktree 里启动会话。' }
    ]
  },
  {
    title: '审查与 Git',
    items: [
      { cmd: '/code-review', kind: 'slash', desc: '在差异里找正确性 bug。--fix 直接修复，--comment 发成行内评论；"ultra" 走云端深度审查。', usage: '/code-review high --fix' },
      { cmd: '/simplify', kind: 'slash', desc: '只对改动过的代码做清理（复用/简化）——不找 bug。' },
      { cmd: '/review', kind: 'slash', desc: '在本会话里审查一个 PR。', usage: '/review 123' },
      { cmd: '/security-review', kind: 'slash', desc: '扫描待提交改动里的安全漏洞。' },
      { cmd: '/ultrareview', kind: 'slash', desc: '对当前分支 / 某个 PR 做多智能体云端审查。' }
    ]
  },
  {
    title: '子智能体与后台',
    items: [
      { cmd: 'claude agents', kind: 'cli', desc: '打开智能体视图，纵览在跑的和后台的 Claude 会话。' },
      { cmd: 'claude agents --json', kind: 'cli', desc: '把在跑的会话以 JSON 打印——可脚本化的机队状态。' },
      { cmd: '/agents', kind: 'slash', desc: '创建并管理用于委派工作的自定义子智能体。' },
      { cmd: '/fork', kind: 'slash', desc: '派生一个继承完整对话的后台子智能体。', usage: '/fork implement the perf fix' },
      { cmd: '/background', kind: 'slash', desc: '让当前会话转为后台继续运行。' },
      { cmd: '/tasks', kind: 'slash', desc: '查看并管理后台运行的一切。' },
      { cmd: '/stop', kind: 'slash', desc: '停止当前后台会话（已挂载时）。' },
      { cmd: 'claude --agent reviewer', kind: 'cli', desc: '用指定的智能体配置启动会话。' }
    ]
  },
  {
    title: '工具与权限',
    items: [
      { cmd: '/permissions', kind: 'slash', desc: '查看并编辑哪些工具允许 / 询问 / 拒绝。' },
      { cmd: '/hooks', kind: 'slash', desc: '查看配置好的生命周期钩子（PreToolUse、Stop 等）。' },
      { cmd: 'claude --permission-mode bypassPermissions', kind: 'cli', desc: '运行时不逐个工具要批准（"auto mode" 走的就是这条）。' },
      { cmd: 'claude --allowedTools "Bash(git *) Edit Read"', kind: 'cli', desc: '预先放行指定工具，让它们不再弹窗。' }
    ]
  },
  {
    title: 'MCP 与插件',
    items: [
      { cmd: '/mcp', kind: 'slash', desc: '列出/管理已连接的 MCP 服务器并完成认证（OAuth）。' },
      { cmd: '/plugin', kind: 'slash', desc: '管理插件（列出、安装、启用、禁用）。' },
      { cmd: 'claude mcp list', kind: 'cli', desc: '列出已配置的 MCP 服务器及其健康状况。' },
      { cmd: 'claude mcp add <name> <command>', kind: 'cli', desc: '注册一个新的 MCP 服务器（stdio 或 HTTP）。' }
    ]
  },
  {
    title: '用量与成本',
    items: [
      { cmd: '/usage', kind: 'slash', desc: '本会话成本、套餐额度，以及按技能 / 子智能体 / MCP 的细分。' },
      { cmd: '/status', kind: 'slash', desc: '账号、当前模型、版本与连接状态。' },
      { cmd: 'claude -p "..." --max-budget-usd 5', kind: 'cli', desc: '给无头运行设置美元花费上限。' },
      { cmd: 'claude --max-turns 20', kind: 'cli', desc: '限制智能体轮数（粗粒度的失控保护）。' }
    ]
  },
  {
    title: '自动化（无头模式）',
    items: [
      { cmd: 'claude -p "your prompt"', kind: 'cli', desc: '打印模式：非交互地跑一条提示词后退出。', usage: 'cat log | claude -p "summarize"' },
      { cmd: 'claude -p "..." --output-format json', kind: 'cli', desc: '无头运行并输出结构化 JSON（结果、用量、成本）。' },
      { cmd: 'claude -p "..." --output-format stream-json', kind: 'cli', desc: '输出流式 JSON 事件，可实时消费。' },
      { cmd: 'claude -p "..." --json-schema <schema>', kind: 'cli', desc: '强制无头运行的结果符合某个 JSON Schema。' },
      { cmd: 'claude --append-system-prompt "..."', kind: 'cli', desc: '在默认系统提示词后追加额外指令。' }
    ]
  },
  {
    title: '国产引擎',
    items: [
      { cmd: 'qwen', kind: 'cli', desc: '启动 Qwen Code 交互会话（通义千问，OpenAI 兼容端点）。' },
      { cmd: 'qwen --model qwen3-coder-plus', kind: 'cli', desc: '以指定模型启动（qwen3-coder-plus / qwen3-coder / qwen-max，以 `qwen models` 为准）。' },
      { cmd: '/compress', kind: 'slash', desc: 'Qwen Code 会话内：压缩上下文腾出空间——qwen 用 /compress，不是 /compact。', usage: '/compress keep the auth decisions' },
      { cmd: 'kimi', kind: 'cli', desc: '启动 Kimi Code 会话（月之暗面）。' },
      { cmd: 'kimi --model kimi-for-coding', kind: 'cli', desc: '用指定别名启动（如 kimi-code/k3、kimi-code/kimi-for-coding，以 `kimi models` 为准）。' },
      { cmd: '/compact', kind: 'slash', desc: 'Kimi Code 会话内：压缩上下文（Kimi 用的就是 /compact）。', usage: '/compact keep the auth decisions' },
      { cmd: 'opencode', kind: 'cli', desc: '启动 OpenCode 外壳——豆包（火山方舟）、GLM（智谱）、Ollama 本地模型都通过它接入。' },
      { cmd: 'opencode --model doubao/doubao-seed-2.1-pro', kind: 'cli', desc: '以指定的 provider/model 启动（`opencode models` 是实时列表的准绳）。' },
      { cmd: 'dsh', kind: 'cli', desc: '启动 DeepSeek 官方 CLI。' }
    ]
  },
  {
    title: '配置',
    items: [
      { cmd: '/config', kind: 'slash', desc: '打开设置：主题、模型、输出风格、偏好。' },
      { cmd: '/theme', kind: 'slash', desc: '更换配色主题（auto / light / dark / colorblind / custom）。' },
      { cmd: '/statusline', kind: 'slash', desc: '配置 Claude Code 状态栏。' }
    ]
  },
  {
    title: '帮助与诊断',
    items: [
      { cmd: '/help', kind: 'slash', desc: '列出所有可用的 slash 命令。' },
      { cmd: '/doctor', kind: 'slash', desc: '诊断安装 / 健康问题（按 f 自动修复）。' },
      { cmd: '/debug', kind: 'slash', desc: '开启调试日志并排查当前会话。' },
      { cmd: '/release-notes', kind: 'slash', desc: '按版本浏览 Claude Code 更新日志。' },
      { cmd: '/remote-control', kind: 'slash', desc: '把这个会话开放给 claude.ai / 手机远程操控。' }
    ]
  }
];