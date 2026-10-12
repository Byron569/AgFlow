/**
 * Realtime 败龙 — voice ACTION tools (card rt-5, Phase 2).
 *
 * The write-side function-tools that turn voice-败龙 into an orchestrator: ping
 * / dispatch / steer / task CRUD / spawn-hire / kill / pause / halt / edit-schedule.
 * These are THIN — every tool just forwards a {verb, ...args} to the main process
 * (src/main/realtimeActions.ts), which owns the entire safety spine: the soft-vs-
 * destructive tiering, the two-step verbal echo-back confirm, the distinct-token
 * rule, the hard allowlist (kill-god / mass-ops forbidden), and the michael-voice
 * attribution. The renderer is the untrusted side, so it holds NO policy — it only
 * speaks back what main returns (`res.spoken`).
 *
 * Confirm flow: a destructive tool returns an echo-back ("…say 'confirm' or 'kill'")
 * and main stages a single pending action. The model then calls `confirm_action`
 * with the user's spoken phrase to commit, or `cancel_action` to drop it. Because
 * each tool call mutes the mic (session.ts agent_tool_start), the commit inside
 * confirm_action happens mic-idle — no stray audio can inject consent.
 *
 * Registered alongside the read-tools: session.ts uses
 *   tools: [...realtimeReadTools(), ...realtimeActionTools()]
 */
import { tool } from '@openai/agents-realtime';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** Forward a verb + args to the main action spine and return its spoken result.
 *  Instrumented for the rt-5 live-bug: any failure is logged to the (human-visible)
 *  renderer console with the verb + raw args so the next repro is self-diagnosing. */
async function act(verb: string, input: unknown): Promise<string> {
  // Graceful guard: if the preload bridge is missing (e.g. a dev hot-reload left the
  // renderer ahead of a stale preload), say so instead of throwing an opaque error.
  if (typeof window.cth?.realtimeAction !== 'function') {
    console.error('[realtime-action] window.cth.realtimeAction is not available — restart the app to load the rt-5 preload.', { verb });
    return '这个版本还不能用语音操作——试试重启应用。';
  }
  try {
    const res = await window.cth.realtimeAction({ verb, ...obj(input) });
    if (!res?.ok) console.warn('[realtime-action] verb=%s rejected: %s', verb, res?.spoken, { input });
    return res?.spoken || '完成。';
  } catch (e) {
    console.error('[realtime-action] verb=%s threw:', verb, e, { input });
    const msg = e instanceof Error ? e.message : '未知错误';
    return `我没能完成这个操作（${msg}）。`;
  }
}

export function realtimeActionTools(): ReturnType<typeof tool>[] {
  return [
    // ── soft writes (execute immediately) ─────────────────────────────────
    tool({
      name: 'ping_agent',
      description:
        '给某个智能体发一条简短消息（提醒或留言）。软操作——立即执行，无需确认。用于「告诉 Oscar 某事」或「问问 Jim 的情况」。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要发消息的智能体名称或 id。' },
          message: { type: 'string', description: '要对它说的话。' }
        },
        required: ['agentId', 'message'],
        additionalProperties: false
      },
      execute: (input) => act('ping', input)
    }),
    tool({
      name: 'dispatch_agent',
      description:
        '给某个智能体派一个任务，作为结构化的四部分工单（目标、上下文、约束、完成标准）投递到它的收件箱。软操作——立即执行。用于「让 Jim 做 X」或「让 Oscar 调查 Y」。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要派单的智能体名称或 id。' },
          objective: { type: 'string', description: '目标——它应该完成什么。' },
          context: { type: 'string', description: '可选。它需要的背景。' },
          constraints: { type: 'string', description: '可选。要遵守的限制或护栏。' },
          doneWhen: { type: 'string', description: '可选。完成的标准。' }
        },
        required: ['agentId', 'objective'],
        additionalProperties: false
      },
      execute: (input) => act('dispatch', input)
    }),
    tool({
      name: 'steer_agent',
      description:
        '给正在运行的智能体注入实时指引，在不打断它的情况下纠偏。软操作——立即执行。这是优先动词：「告诉 Jim 先专注那个 bug」「让 Oscar 别用那种思路」。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要纠偏的智能体名称或 id。' },
          text: { type: 'string', description: '要注入的纠偏指引。' }
        },
        required: ['agentId', 'text'],
        additionalProperties: false
      },
      execute: (input) => act('steer', input)
    }),
    tool({
      name: 'create_task',
      description:
        '往任务看板加一张新任务卡。软操作——立即执行。用于「建一个任务做 X」，可选地指派给某人。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题。' },
          description: { type: 'string', description: '可选。更多细节。' },
          assignee: { type: 'string', description: '可选。负责它的智能体 id 或名称。' },
          priority: { type: 'number', description: '可选。1（最高）到 10。' }
        },
        required: ['title'],
        additionalProperties: false
      },
      execute: (input) => act('create_task', input)
    }),
    tool({
      name: 'assign_task',
      description: '把一个已有任务指派给某个智能体。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要指派的任务 id 或标题。' },
          assignee: { type: 'string', description: '负责它的智能体 id 或名称。' }
        },
        required: ['taskId', 'assignee'],
        additionalProperties: false
      },
      execute: (input) => act('assign_task', input)
    }),
    tool({
      name: 'update_task',
      description:
        '修改一个已有任务：它的状态（todo/doing/blocked/done）、结果备注或负责人。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要更新的任务 id 或标题。' },
          status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'], description: '可选的新状态。' },
          result: { type: 'string', description: '可选的结果备注。' },
          assignee: { type: 'string', description: '可选的新负责人。' }
        },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: (input) => act('update_task', input)
    }),

    // ── wait for a dispatched task to finish (rt-12 await-in-session) ──────
    tool({
      name: 'wait_for',
      description:
        '等你派发的某个任务完成后回报。用于「X 完成时告诉我」或「那个做完后跟我说一声」。受超时限制。（如果不需要等待结果就不必用它——完成会自动通知。）',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要等待的任务 id（或派单关联 id）。' },
          timeoutSeconds: { type: 'number', description: '可选的最大等待秒数（默认 120，最多 600）。' }
        },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: async (input) => {
        try {
          const a = obj(input);
          const taskId = str(a.taskId);
          if (!taskId) return '我需要一个任务 id 才能等待。';
          const secs = typeof a.timeoutSeconds === 'number' && a.timeoutSeconds > 0 ? Math.min(a.timeoutSeconds, 600) : 120;
          const res = await window.cth.realtimeWaitFor(taskId, secs * 1000);
          if (res && 'timedOut' in res && res.timedOut) {
            return `等了这么久那个还在跑——它一完成我就告诉你。`;
          }
          return (res && 'summary' in res && res.summary) || '那个任务完成了。';
        } catch (e) {
          console.error('[realtime-action] wait_for threw:', e);
          const msg = e instanceof Error ? e.message : '未知错误';
          return `我没能等到它（${msg}）。`;
        }
      }
    }),

    // ── destructive / expensive (echo-back confirm required) ──────────────
    tool({
      name: 'spawn_agent',
      description:
        '雇佣一个新的智能体（引擎 + 可选角色）。这不会立即执行；它会先要求口头确认。用户说「确认」后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: '引擎：claude（默认）、codex、gemini、opencode、crush、pi、qwen、copilot、cursor。' },
          role: { type: 'string', description: '可选。新智能体的角色或职务。' },
          name: { type: 'string', description: '可选。给这个智能体取的名字。' },
          cwd: { type: 'string', description: '可选。工作目录；默认是蜂巢根目录。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) => act('spawn', input)
    }),
    tool({
      name: 'kill_agent',
      description:
        '关闭一个正在运行的智能体（关闭它的终端并归档）。破坏性操作——不会立即执行；会返回一段回显并要求口头确认。用户说「确认」后，调用 confirm_action。禁止关闭总控或一次性关闭所有智能体。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要关闭的智能体名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('kill', input)
    }),
    tool({
      name: 'pause_agent',
      description:
        '暂停一个正在运行的智能体（在恢复前它不再行动）。破坏性操作——不会立即执行；会返回一段回显并要求口头确认。用户说「确认」后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要暂停的智能体名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('pause', input)
    }),
    tool({
      name: 'halt_agent',
      description:
        '强制停止一个正在运行的智能体（硬停止它当前的工作）。破坏性操作——不会立即执行；会返回一段回显并要求口头确认。用户说「确认」后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要强制停止的智能体名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('halt', input)
    }),
    tool({
      name: 'edit_schedule',
      description:
        '启用、停用或删除一个周期性计划任务。破坏性操作——不会立即执行；会返回一段回显并要求口头确认。用户说「确认」后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', description: '要编辑的计划任务 id 或标签。' },
          action: { type: 'string', enum: ['enable', 'disable', 'delete'], description: '要对它做什么。' }
        },
        required: ['missionId', 'action'],
        additionalProperties: false
      },
      execute: (input) => act('edit_schedule', input)
    }),

    // ── v0.3.4 full-control verbs ─────────────────────────────────────────
    tool({
      name: 'resume_agent',
      description:
        '恢复一个被暂停或强制停止的智能体，让它的工具重新流动。软操作——立即执行。是 pause_agent / halt_agent 的撤销操作。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要恢复的智能体名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('resume', input)
    }),
    tool({
      name: 'set_auto_delivery',
      description:
        '暂停或恢复对某个智能体的自动消息队列投递。暂停时排队的消息会一直等到恢复。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '智能体名称或 id。' },
          state: { type: 'string', enum: ['pause', 'resume'], description: 'pause 会拦住队列；resume 让它继续流动。' }
        },
        required: ['agentId', 'state'],
        additionalProperties: false
      },
      execute: (input) => act('auto_delivery', input)
    }),
    tool({
      name: 'gate_tool',
      description:
        '对某个智能体屏蔽（gate）或解除屏蔽一个指定工具——例如为 Jim 屏蔽 Bash。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '智能体名称或 id。' },
          tool: { type: 'string', description: '精确的工具名，例如 Bash、WebFetch、Edit。' },
          state: { type: 'string', enum: ['gate', 'allow'], description: 'gate 屏蔽它；allow 解除屏蔽。' }
        },
        required: ['agentId', 'tool', 'state'],
        additionalProperties: false
      },
      execute: (input) => act('gate_tool', input)
    }),
    tool({
      name: 'delete_task',
      description:
        '按标题或 id 从看板删除一张任务卡。软操作——立即执行（删错了重建即可）。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '要删除的任务标题或 id。' } },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: (input) => act('delete_task', input)
    }),
    tool({
      name: 'unarchive_agent',
      description: '把一个已归档的智能体重新放回名单。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '已归档智能体的名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('unarchive', input)
    }),
    tool({
      name: 'clear_agent_context',
      description:
        "为某个智能体排队一次上下文清空（/clear）——清掉它对当前对话的工作记忆；投递要等该智能体空闲。破坏性操作——会返回一段回显并要求口头确认（说「确认」）。用户说「确认」后，调用 confirm_action。总控也允许清空（它可以恢复自己的会话）。",
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要清空上下文的智能体名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('clear_context', input)
    }),
    tool({
      name: 'archive_agent',
      description:
        '归档一个智能体——把它从楼层撤下，历史保留（取消归档可以把它带回来）。破坏性操作——会返回一段回显并要求口头确认。用户说「确认」后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要归档的智能体名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('archive', input)
    }),
    tool({
      name: 'create_schedule',
      description:
        '新建一个按间隔给智能体发消息的周期性计划任务。破坏性操作——会返回一段回显并要求口头确认。用户说「确认」后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '计划任务的简短名称。' },
          prompt: { type: 'string', description: '每次触发时智能体收到的消息。' },
          intervalMinutes: { type: 'number', description: '触发频率，以分钟计（最少 5）。默认 60。' },
          to: { type: 'string', description: '目标智能体名称或 id。默认：总控。' }
        },
        required: ['label', 'prompt'],
        additionalProperties: false
      },
      execute: (input) => act('create_schedule', input)
    }),
    tool({
      name: 'update_setting',
      description:
        "从允许语音修改的列表里改一项应用设置。外观/低风险的键（notifications、officeTheme、terminalTheme、freeflowEnabled、strongKeepalive、autoUpdate、tvShowOffices、realtimeIdleDisconnectMs）立即生效；会改变行为的键（autoMode、defaultModel、godProvider、godModel、maxConcurrentWorkers、costCapTokens、maxTurns、slackEnabled、webhookEnabled、semanticMemory、multiWindow）会返回一段旧值到新值的回显并需要口头确认（说「确认」）——然后调用 confirm_action。密钥、目录和任何未列出的项都会被拒绝。",
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '精确的设置键名，例如 autoMode 或 notifications。' },
          value: { type: 'string', description: '新值：true/false、一个数字，或选项名。' }
        },
        required: ['key', 'value'],
        additionalProperties: false
      },
      execute: (input) => act('update_setting', input)
    }),

    // ── confirm / cancel (drive the two-phase commit) ─────────────────────
    tool({
      name: 'confirm_action',
      description:
        '用用户刚刚说出的原话，提交那个正在等待确认的破坏性操作。只在破坏性工具返回回显、且用户口头确认之后才调用它。主进程不接受含糊的回应——要传用户真正说的那句确认话。',
      parameters: {
        type: 'object',
        properties: { phrase: { type: 'string', description: '用户实际说出的确认话。' } },
        required: ['phrase'],
        additionalProperties: false
      },
      execute: async (input) => {
        if (typeof window.cth?.realtimeActionConfirm !== 'function') {
          console.error('[realtime-action] window.cth.realtimeActionConfirm is not available — restart the app.');
          return '这个版本还不能用语音操作——试试重启应用。';
        }
        try {
          const res = await window.cth.realtimeActionConfirm({ phrase: str(obj(input).phrase) });
          if (!res?.ok) console.warn('[realtime-action] confirm rejected: %s', res?.spoken, { input });
          return res?.spoken || '完成。';
        } catch (e) {
          console.error('[realtime-action] confirm threw:', e, { input });
          const msg = e instanceof Error ? e.message : '未知错误';
          return `我没能确认那个操作（${msg}）。`;
        }
      }
    }),
    tool({
      name: 'cancel_action',
      description: '取消那个正在等待确认的破坏性操作。用户拒绝或改主意时调用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        try {
          const res = await window.cth?.realtimeActionCancel?.();
          return res?.spoken || '已取消。';
        } catch (e) {
          console.error('[realtime-action] cancel threw:', e);
          return '已取消。';
        }
      }
    })
  ];
}
