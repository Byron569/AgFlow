/**
 * Command reference for the OpenAI Codex CLI.
 *
 * Mirrors the shape of claudeCommands.ts so any component that renders a
 * command reference can switch on provider. Curated from the Codex CLI
 * reference + slash-commands docs (developers.openai.com/codex/cli/).
 *
 * `kind` semantics match claudeCommands.ts:
 *   - `slash`  — typed inside the Codex interactive REPL session
 *   - `cli`    — shell flags / sub-commands passed at launch
 */
import type { CmdGroup } from './claudeCommands';

export const CODEX_COMMAND_GROUPS: CmdGroup[] = [
  {
    title: '会话',
    items: [
      { cmd: '/clear', kind: 'slash', desc: '开一段新对话，不用退出——清空当前上下文。' },
      // Verified present in the codex 0.137.0 binary's own command table. It was
      // missing here while providerAutomation sent it, so the two disagreed.
      // Unlike Claude's, this one ignores any trailing focus text.
      { cmd: '/compact', kind: 'slash', desc: '把到目前为止的对话压缩成摘要，保持在上下文上限之内。' },
      { cmd: '/help', kind: 'slash', desc: '列出所有可用的斜杠命令。' },
      { cmd: '/copy', kind: 'slash', desc: '把模型最近一次输出复制到剪贴板。' },
      { cmd: '/logout', kind: 'slash', desc: '清除本地保存的凭据。' },
      { cmd: '/rename', kind: 'slash', desc: '重命名当前对话。' }
    ]
  },
  {
    title: '界面与偏好',
    items: [
      { cmd: '/theme', kind: 'slash', desc: '在浅色与深色主题之间切换。' },
      { cmd: '/vim', kind: 'slash', desc: '切换输入框的 Vim 键位。' },
      { cmd: '/raw', kind: 'slash', desc: '切换模型输出的原始（无格式）显示。' }
    ]
  },
  {
    title: '记忆与技能',
    items: [
      { cmd: '/memories', kind: 'slash', desc: '查看和管理 Codex 记住的关于你的信息。' },
      { cmd: '/skills', kind: 'slash', desc: '浏览和管理已安装的 Codex 技能 / 扩展。' },
      { cmd: '/hooks', kind: 'slash', desc: '查看已配置的生命周期钩子。' }
    ]
  },
  {
    title: '审批与权限',
    items: [
      { cmd: 'codex --dangerously-bypass-approvals-and-sandbox', kind: 'cli', desc: '跳过所有审批提示，并卸掉系统沙箱（完整文件系统访问）。AgFlow 的自动模式已不再用它：现在保留沙箱，改用 --add-dir 把蜂巢智能体目录加进去。' },
      { cmd: 'codex -a never -s workspace-write', kind: 'cli', desc: '永不弹出审批（-a never），但把沙箱限制在项目工作区内（-s workspace-write）。这是 AgFlow 自动模式使用的组合；蜂巢智能体目录通过 --add-dir <dir> 追加。' },
      { cmd: 'codex -a untrusted', kind: 'cli', desc: '只不询问地运行受信任的命令；其他一律上报给用户。' },
      { cmd: 'codex -s danger-full-access', kind: 'cli', desc: '移除全部沙箱限制（细粒度开关——配合 -a 可完全掌控）。' }
    ]
  },
  {
    title: '自动化（无头模式）',
    items: [
      { cmd: 'codex -p "your prompt"', kind: 'cli', desc: '非交互的打印模式：跑完一条提示就退出。', usage: 'codex -p "summarise this file"' },
      { cmd: 'CODEX_NON_INTERACTIVE=1 codex', kind: 'cli', desc: '抑制所有交互式安装 / 首次运行提示。AgFlow 在自动模式下自动设置。' }
    ]
  },
  {
    title: '配置',
    items: [
      { cmd: 'codex --model <model>', kind: 'cli', desc: '选择模型（例如 o4-mini、o3）。', usage: 'codex --model o4-mini' },
      { cmd: 'codex --provider <provider>', kind: 'cli', desc: '选择 API 提供方（openai、azure、anthropic……）。', usage: 'codex --provider openai' }
    ]
  }
];