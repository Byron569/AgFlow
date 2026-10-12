/**
 * Command reference for the xAI Grok CLI.
 *
 * Kept in the same shape as the Claude/Codex references so the Command Center
 * and generated hive command guide can render provider-native commands.
 */
import type { CmdGroup } from './claudeCommands';

export const GROK_COMMAND_GROUPS: CmdGroup[] = [
  {
    title: '会话',
    items: [
      { cmd: '/new', kind: 'slash', desc: '开一段新会话并清空当前上下文。' },
      { cmd: '/load', kind: 'slash', desc: '载入之前的工作区会话。', usage: '/load [workspace] [session]' },
      { cmd: '/compact', kind: 'slash', desc: '压缩对话历史，同时保留重要的工作上下文。', usage: '/compact keep the current task and next step' },
      { cmd: 'grok --resume <session-id>', kind: 'cli', desc: '按 ID 或标题恢复现有的 Grok 会话。' }
    ]
  },
  {
    title: '模型与权限',
    items: [
      { cmd: '/model', kind: 'slash', desc: '切换当前会话使用的模型。' },
      { cmd: 'grok --model grok-4.6', kind: 'cli', desc: '以 Grok 4.6 编码模型启动（CLI 默认值）。' },
      { cmd: '/always-approve', kind: 'slash', desc: '切换是否自动批准工具执行。' },
      { cmd: 'grok --permission-mode bypassPermissions', kind: 'cli', desc: '以始终批准模式启动。AgFlow 在自动模式开启时使用它。' }
    ]
  },
  {
    title: '工具与工作流',
    items: [
      { cmd: '/rewind', kind: 'slash', desc: '回退到之前的一条提示，并恢复当时的文件状态。' },
      { cmd: '/hooks-list', kind: 'slash', desc: '显示本会话中生效的生命周期钩子。' },
      { cmd: '/skills', kind: 'slash', desc: '列出或加载已安装的技能。' },
      { cmd: '/multiline', kind: 'slash', desc: '切换多行提示输入。' }
    ]
  }
];