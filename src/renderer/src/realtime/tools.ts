/**
 * Realtime 败龙 — read-tools (rt-4, Realtime 败龙 Phase 1).
 *
 * The real function-tools that replace rt-2's placeholder no-op. Each one is a
 * thin, READ-ONLY wrapper over a window.cth bridge that already powers the office
 * floor UI, formatted as short spoken prose — a TTS voice reads these aloud, so
 * there is no markdown, no bullet characters, and no asterisks. Phase 1 is
 * read-only by construction: there is not a single mutating call in this file
 * (action-tools are rt-5, held).
 *
 * SECURITY: tools run in the RENDERER and only touch already-exposed read IPC.
 * The real OpenAI key never appears here (rt-1's mint keeps it main-only). And
 * get_config NEVER dumps HarnessConfig — that object carries secrets
 * (groqApiKey, slack/webhook tokens); we surface a hand-picked, non-sensitive
 * allowlist only.
 *
 * INTEGRATION (rt-2's src/renderer/src/realtime/session.ts — Jim's file):
 *   import { realtimeReadTools, realtimeSessionSummary } from './tools';
 *   ...
 *   tools: realtimeReadTools()            // swap for placeholderTools() at the `tools:` field
 * and optionally prepend `await realtimeSessionSummary()` to the agent instructions
 * for a warm-start orientation. The agent_tool_start / agent_tool_end mic-idle
 * lifecycle in session.ts is tool-agnostic, so it survives the swap unchanged.
 */
import { tool } from '@openai/agents-realtime';

// ─── spoken-prose formatting helpers ────────────────────────────────────────

/** Relative "x ago" for a unix-ms timestamp; voice-safe and defensive. */
function ago(ts: unknown): string {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '时间未知';
  const ms = Date.now() - ts;
  if (ms < 5_000) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return `${d} 天前`;
}

/** Humanize an interval in ms into spoken cadence ("every 5 minutes"). */
function every(ms: unknown): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '间隔未知';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '每 1 分钟以内';
  if (m < 60) return `每 ${m} 分钟`;
  const h = Math.round(m / 60);
  return `每 ${h} 小时`;
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${one}`;
}

/** Compact a big number for speech (1.2 thousand / 3.4 million). */
function tokens(n: unknown): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} 百万`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)} 千`;
  return `${Math.round(v)}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + '（已截断）' : s;
}

/** The trailing folder name of a path — speech-friendly (the persona avoids
 *  reading full file paths aloud unless asked). e.g. /a/b/cth-voice-tools → cth-voice-tools. */
function shortDir(p: string): string {
  const parts = (p || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Strip markdown to plain speakable prose (headers, emphasis, bullets, links,
 *  code fences) and collapse whitespace. */
function despan(md: string): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};

const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** Wrap a tool body so a read failure degrades to a spoken sentence rather than
 *  rejecting the model's tool call. */
async function spoken(fn: () => Promise<string>, what: string): Promise<string> {
  try {
    const out = (await fn()).trim();
    return out || `我暂时没有查到${what}。`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : '未知错误';
    return `刚才没能读取${what}（${msg}）。`;
  }
}

// ─── the read-tools ──────────────────────────────────────────────────────────

/**
 * The real Phase-1 read-tools. Returned as an array so rt-2's session can pass it
 * straight to `tools:` in place of placeholderTools().
 */
export function realtimeReadTools(): ReturnType<typeof tool>[] {
  return [
    // ── get_fleet_status ──────────────────────────────────────────────────
    tool({
      name: 'get_fleet_status',
      description:
        '蜂巢里现在都有谁：有多少个智能体、哪些在运行哪些已归档、总控是谁，以及每个在运行智能体的名称、角色和引擎。当用户问谁在工作、谁在楼层上，或要一份名单时调用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const reg = await window.cth.hiveRegistry();
          const entries = Object.entries(obj(reg.agents));
          if (!entries.length) return '蜂巢里还没有注册任何智能体。';
          const active = entries.filter(([, a]) => !obj(a).archived);
          const archived = entries.length - active.length;
          const godId = reg.godId;
          const godName = godId ? str(obj(obj(reg.agents)[godId]).name) || godId : null;
          const lines = active
            .filter(([id]) => id !== godId)
            .map(([, a]) => {
              const m = obj(a);
              const name = str(m.name) || '一个未命名智能体';
              const role = str(m.role);
              const provider = str(m.provider) || 'claude';
              const status = str(m.status) || '未知';
              return `${name}${role ? `，担任${role}` : ''}，跑在 ${provider} 引擎上（${status}）`;
            });
          const head = `有 ${plural(active.length, '个智能体')}在运行${
            archived ? `，另有 ${plural(archived, '个已归档智能体')}` : ''
          }。`;
          const god = godName ? ` ${godName} 是总控。` : '';
          const roster = lines.length ? ` 正在工作的智能体：${lines.join('；')}。` : '';
          return head + god + roster;
        }, '团队状态')
    }),

    // ── get_tasks ─────────────────────────────────────────────────────────
    tool({
      name: 'get_tasks',
      description:
        '当前的任务看板：有多少任务处于待办、进行中、受阻和已完成，以及进行中和受阻任务的标题与负责人。可选地按单个状态过滤。当用户问团队在做什么、什么被卡住，或问进度时调用。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['todo', 'doing', 'blocked', 'done'],
            description: '可选。把回答限定在某个状态。'
          }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const filter = typeof a.status === 'string' ? a.status : null;
          const raw = await window.cth.hiveTasks();
          const list = Array.isArray(obj(raw).tasks) ? (obj(raw).tasks as unknown[]) : [];
          if (!list.length) return '任务看板现在是空的。';
          const tasks = list.map(obj);
          const by = (s: string): Record<string, unknown>[] => tasks.filter((t) => str(t.status) === s);
          const statusZh: Record<string, string> = { todo: '待办', doing: '进行中', blocked: '受阻', done: '已完成' };
          const counts = `${plural(by('todo').length, '个待办')}，${by('doing').length} 个进行中，${plural(
            by('blocked').length,
            '个受阻'
          )}，${by('done').length} 个已完成`;
          const describe = (t: Record<string, unknown>): string => {
            const who = str(t.assignee);
            return `「${clip(str(t.title) || str(t.id) || '未命名', 90)}」${who ? `（${who}）` : ''}`;
          };
          if (filter) {
            const sel = by(filter);
            if (!sel.length) return `现在没有处于${statusZh[filter] ?? filter}的任务。总体情况：${counts}。`;
            return `${plural(sel.length, '个任务')}处于${statusZh[filter] ?? filter}：${sel.slice(0, 12).map(describe).join('；')}。`;
          }
          const doing = by('doing');
          const blocked = by('blocked');
          const detail = [
            doing.length ? `进行中：${doing.slice(0, 8).map(describe).join('；')}。` : '',
            blocked.length ? `受阻：${blocked.slice(0, 8).map(describe).join('；')}。` : ''
          ]
            .filter(Boolean)
            .join(' ');
          return `共有 ${plural(tasks.length, '个任务')}：${counts}。${
            detail ? ' ' + detail : ''
          }`;
        }, '任务看板')
    }),

    // ── get_cost ──────────────────────────────────────────────────────────
    tool({
      name: 'get_cost',
      description:
        '蜂巢这次会话正在用掉多少：所有智能体的令牌总量，以及用得最多的几个。以令牌计（不报金额）。当用户问用量或令牌消耗时调用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const snap = await window.cth.telemetrySnapshot();
          const usage = Array.isArray(snap.usage) ? snap.usage : [];
          if (!usage.length) return '这次会话还没有记录到令牌用量。';
          let totIn = 0;
          let totOut = 0;
          const perAgent = new Map<string, number>();
          for (const s of usage) {
            const m = obj(s);
            const inTok = typeof m.input === 'number' ? m.input : 0;
            const outTok = typeof m.output === 'number' ? m.output : 0;
            totIn += inTok;
            totOut += outTok;
            const id = str(m.agentId) || '未知';
            perAgent.set(id, (perAgent.get(id) ?? 0) + inTok + outTok);
          }
          const top = [...perAgent.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([id, tok]) => `${id} 用了 ${tokens(tok)} 令牌`);
          return `这次会话到目前为止，蜂巢用了 ${tokens(totIn)} 输入令牌和 ${tokens(totOut)} 输出令牌，涉及 ${plural(
            perAgent.size,
            '个智能体'
          )}。${top.length ? ` 用得最多的：${top.join('，')}。` : ''}`;
        }, '令牌用量')
    }),

    // ── get_triggers ──────────────────────────────────────────────────────
    tool({
      name: 'get_triggers',
      description:
        '不靠人打字就能触发蜂巢的触发器。目前这里报告计划任务：蜂巢按定时器运行的周期性任务，包含标签、频率、接收方，以及各自上次触发的时间。其他触发器类型——webhook 和外部组织消息——在别处配置，不在这里列出。当用户问触发器、计划任务、周期任务、心跳或自动化时调用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const missions = await window.cth.listMissions();
          const list = Array.isArray(missions) ? missions : [];
          if (!list.length) return '还没有配置任何计划任务。';
          const enabled = list.filter((m) => obj(m).enabled);
          if (!enabled.length) return `一共有 ${plural(list.length, '个计划任务')}，但全部已停用。`;
          const lines = enabled.slice(0, 8).map((m) => {
            const o = obj(m);
            const label = str(o.label) || '一个计划任务';
            const to = str(o.to);
            const last = o.lastFiredAt ? `，上次触发于${ago(o.lastFiredAt)}` : '，还没触发过';
            return `${label}，${every(o.intervalMs)}${to ? `，发给 ${to}` : ''}${last}`;
          });
          return `有 ${plural(
            enabled.length,
            '个已启用的计划任务'
          )}：${lines.join('；')}。`;
        }, '计划任务')
    }),

    // ── get_config ────────────────────────────────────────────────────────
    tool({
      name: 'get_config',
      description:
        '蜂巢的非敏感设置：自治模式、默认模型和总控引擎、预算上限、智能体数量上限、熔断，以及哪些功能开着。绝不返回密钥或 API key。当用户问蜂巢是怎么配置的、上限或预算是多少，或某个功能是否启用时调用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const c = await window.cth.getConfig();
          // Hand-picked NON-SENSITIVE allowlist. Never iterate the object — it
          // carries groqApiKey, slack/webhook tokens, and signing secrets. Read
          // through obj() so the renderer's HarnessConfig mirror can lag the main
          // one (it is hand-mirrored across three files) without breaking us.
          const cc = obj(c);
          const parts: string[] = [];
          parts.push(`自治模式是${c.autoMode ? '开' : '关'}。`);
          if (c.defaultModel) parts.push(`默认模型是 ${c.defaultModel}。`);
          if (c.godProvider || c.godModel)
            parts.push(`总控运行在 ${[c.godProvider, c.godModel].filter(Boolean).join(' ')}。`);
          if (typeof cc.maxConcurrentWorkers === 'number')
            parts.push(`最多 ${plural(cc.maxConcurrentWorkers, '个智能体')}可同时运行。`);
          // De-monetized: report only the token cap (no dollar cap), and avoid
          // money words. The $ runaway guard still exists + fires; it just isn't spoken.
          if (typeof c.costCapTokens === 'number' && c.costCapTokens > 0)
            parts.push(`令牌上限：${tokens(c.costCapTokens)} 令牌。`);
          const breakerOn = obj(c.circuitBreaker).enabled;
          parts.push(`熔断${breakerOn ? '已启用' : '已关闭'}。`);
          parts.push(`桌面通知是${c.notifications ? '开' : '关'}。`);
          const features = [
            c.slackEnabled && 'Slack',
            c.webhookEnabled && 'webhook',
            c.freeflowEnabled && 'Free Flow 语音',
            c.realtimeVoiceEnabled && '实时语音（本次会话）',
            c.semanticMemory && '语义记忆',
            obj(c.knowledgeGraph).enabled && '知识图谱'
          ].filter(Boolean);
          if (features.length) parts.push(`已启用的功能：${features.join('、')}。`);
          return parts.join(' ');
        }, '配置')
    }),

    // ── get_memory ────────────────────────────────────────────────────────
    tool({
      name: 'get_memory',
      description:
        "读取团队的记忆。你总是可以用它回答——它绝不会无果而终。传 query 搜索蜂巢学到的一切；传 agentId 读取某个智能体的笔记（对任何智能体都有效，在运行或已归档都行）；两个都传就在那个智能体范围内搜索；都不传则返回记忆状态。可用时用语义搜索，否则在每个智能体的记忆文件里做直接文本搜索。当用户问团队学到了什么、记住了什么、决定了什么或记录了什么都调用。",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选。要在团队记忆里搜索什么。' },
          agentId: { type: 'string', description: '可选。要读取或限定搜索范围的智能体 id——任何智能体都行，在运行或已归档。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const query = str(a.query).trim();
          const agentId = str(a.agentId).trim();

          // Direct text fallback across every agent's memory.md (INCLUDING archived
          // agents), the board, and tasks — works with or without the semantic
          // memory CLI, so a query can never dead-end. Optionally narrow to one agent.
          const textFallback = async (q: string, onlyAgent?: string): Promise<string> => {
            const res = await window.cth.textSearch(q);
            if (!res.ok || !res.results.length) return '';
            let hits = res.results;
            if (onlyAgent) hits = hits.filter((r) => r.source.startsWith(`${onlyAgent}/`) || r.source === onlyAgent);
            if (!hits.length) return '';
            const bySource = new Map<string, string[]>();
            for (const r of hits.slice(0, 14)) {
              const who = r.source.replace(/\/memory\.md$/, '');
              if (!bySource.has(who)) bySource.set(who, []);
              bySource.get(who)!.push(r.excerpt);
            }
            const lines = [...bySource.entries()].slice(0, 6).map(([who, ex]) => `${who} 记录说 ${ex.slice(0, 2).join('；')}`);
            return `来自团队的笔记：${lines.join('；')}。`;
          };

          // query + agentId → search WITHIN one agent (semantic wing first, then text).
          if (query && agentId) {
            const res = await window.cth.searchMemory(query, agentId);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query, agentId);
            if (tf) return clip(tf, 1600);
            const mem = await window.cth.hiveMemory(agentId);
            const ql = query.toLowerCase();
            const matched = mem.split('\n').map((l) => l.trim()).filter((l) => l.toLowerCase().includes(ql)).slice(0, 8);
            if (matched.length) return clip(`来自 ${agentId} 的记忆：${matched.join(' ')}`, 1600);
            return mem.trim()
              ? `我读了 ${agentId} 的记忆，但没有找到关于「${query}」的内容。`
              : `${agentId} 还没有记录任何记忆。`;
          }

          // query alone → semantic across the whole palace, then text fallback across all agents.
          if (query) {
            const res = await window.cth.searchMemory(query);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query);
            if (tf) return clip(tf, 1600);
            return `我搜索了团队的记忆，但没有找到关于「${query}」的内容。`;
          }

          // agentId alone → read that agent's notes directly (any agent, active OR archived).
          if (agentId) {
            const mem = await window.cth.hiveMemory(agentId);
            return mem.trim() ? clip(mem.trim(), 1600) : `${agentId} 还没有记录任何记忆。`;
          }

          // neither → status, but make clear search always works.
          const status = await window.cth.memoryStatus();
          const sem = status.active
            ? '语义记忆正在运行'
            : status.available
            ? '语义记忆已启用但闲置'
            : '语义记忆未上线';
          return `${sem}——不过我随时可以对每个智能体的笔记做文本搜索，无论它是在运行还是已归档。你可以让我搜索某个主题，或者说出一个智能体的名字，我来读它的记忆。`;
        }, '记忆')
    }),

    // ── get_activity ──────────────────────────────────────────────────────
    tool({
      name: 'get_activity',
      description:
        '最近的蜂巢活动日志：生成、归档、消息和其他生命周期事件，最新的排在最前。当用户问刚刚发生了什么、最近的活动，或要一段流水账时调用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '可选。要汇总多少条最近的事件（默认 12，最多 40）。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 12;
          const log = await window.cth.hiveLog(want);
          const list = Array.isArray(log) ? log : [];
          if (!list.length) return '还没有记录任何蜂巢活动。';
          const lines = list
            .slice(-want)
            .reverse()
            .map((e) => {
              const o = obj(e);
              const kind = str(o.kind) || str(o.event) || '事件';
              const who = str(o.agentId) || str(o.name) || str(o.from);
              const when = ago(o.ts);
              return `${kind}${who ? `，来自 ${who}` : ''}，${when}`;
            });
          return `最近的活动：${lines.join('；')}。`;
        }, '活动日志')
    }),

    // ── get_messages ──────────────────────────────────────────────────────
    tool({
      name: 'get_messages',
      description:
        "读取蜂巢消息的实际内容——智能体们在各自收件箱和发件箱里互相说了什么，而不只是发生了某个事件。当用户想知道某条消息说了什么、谁问了或汇报了什么，或想了解最新的往来时用这个。传 agentId 聚焦某个智能体的信箱，传 messageId 完整读取某一条具体消息，都不传则给出整个楼层最近的几条消息。密钥在你看之前总会被剥掉，所以可以放心引用正文。",
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '可选。聚焦某个智能体的收件箱和发件箱（id，如果有的话用精确的 id）。' },
          messageId: { type: 'string', description: '可选。按 id 完整读取某一条具体消息。' },
          limit: { type: 'number', description: '可选。要汇总多少条最近的消息（默认 8，最多 40）。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const agentId = str(a.agentId).trim();
          const messageId = str(a.messageId).trim();
          const limit = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 8;

          // Speak one message's body relative to a perspective. from→to + subject + body.
          const speakOne = (m: { from: string; to: string; subject: string; body: string; created_at: string; requires_reply: boolean }, full: boolean): string => {
            const subj = str(m.subject).trim();
            const body = despan(str(m.body)).trim();
            const head = `${str(m.from) || '某人'} 发给 ${str(m.to) || '某人'}${subj ? `，关于「${clip(subj, 80)}」` : ''}，${ago(Date.parse(m.created_at))}`;
            if (!body) return `${head}，没有正文。`;
            return `${head}：${clip(body, full ? 700 : 220)}${m.requires_reply ? '（对方要求回复）' : ''}`;
          };

          if (messageId) {
            const found = await window.cth.hiveMessages({ id: messageId });
            if (!found.length) return `我没找到 id 为 ${messageId} 的消息。`;
            return `那条消息——${speakOne(found[0], true)}。`;
          }

          const msgs = await window.cth.hiveMessages(agentId ? { agentId, limit } : { limit });
          if (!msgs.length)
            return agentId ? `我在 ${agentId} 的信箱里没看到任何消息。` : '还没有可读取的蜂巢消息。';
          const scope = agentId ? `${agentId} 的信箱` : '整个楼层';
          const lines = msgs.slice(0, limit).map((m) => speakOne(m, false));
          return `${scope}最近的消息有 ${plural(lines.length, '条')}：${lines.join('。')}。`;
        }, '消息')
    }),

    // ── get_agent_detail ──────────────────────────────────────────────────
    tool({
      name: 'get_agent_detail',
      description:
        '关于某个智能体的全部已知信息：名称、角色、运行的引擎和模型、工作目录、是运行中还是已归档、实时状态、上下文窗口有多满、用了多少令牌、熔断状态、上次做了什么，以及是否记录过记忆。当用户问某个具体智能体——它在哪工作、在哪个目录、状态如何，或要它的完整状态时调用。接受 id 或名称。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要查询的智能体 id 或昵称（例如「kevin-mqpbq43v」或「Kevin」）。' }
        },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = str(a.agentId).trim().toLowerCase();
          if (!want) return '告诉我你指的是哪个智能体。';
          const dir = await window.cth.hiveAgentDirectory();
          const list = Array.isArray(dir.agents) ? dir.agents : [];
          const e =
            list.find((x) => x.id.toLowerCase() === want) ??
            list.find((x) => x.name.toLowerCase() === want) ??
            list.find((x) => x.id.toLowerCase().startsWith(want) || x.name.toLowerCase().startsWith(want));
          if (!e) return `我没有看到匹配「${str(a.agentId)}」的智能体。`;
          const parts: string[] = [];
          const role = e.role ? `，担任${e.role}` : '';
          const where = e.archived
            ? '已归档——终端已关闭，但工作目录和记忆都还在'
            : `在运行，状态${e.status}`;
          parts.push(`${e.name}${role}跑在 ${e.provider} 引擎上${e.model ? `，模型是 ${e.model}` : ''}，${where}。`);
          if (e.cwd)
            parts.push(
              `工作目录：${e.cwd}${e.cwdValid === false ? '，这不是一个有效目录——在那里生成智能体会失败' : ''}。`
            );
          if (typeof e.contextPct === 'number') parts.push(`它的上下文窗口已用 ${e.contextPct}%。`);
          else if (typeof e.contextTokens === 'number') parts.push(`它当前承载了 ${tokens(e.contextTokens)} 令牌的上下文。`);
          if (e.tokens) parts.push(`它到现在用了 ${tokens(e.tokens)} 令牌。`);
          parts.push(`熔断：${e.breaker}。`);
          if (e.lastTool) parts.push(`上次用的工具是 ${e.lastTool}${typeof e.lastActiveSecAgo === 'number' ? `，${ago(Date.now() - e.lastActiveSecAgo * 1000)}` : ''}。`);
          if (e.inboxBacklog) parts.push(`收件箱里还有 ${plural(e.inboxBacklog, '条消息')}在等待。`);
          parts.push(e.hasMemory ? '它记录过记忆——可以让我读给你听。' : '它还没有记录多少记忆。');
          return parts.join(' ');
        }, '智能体详情')
    }),

    // ── list_agents ───────────────────────────────────────────────────────
    tool({
      name: 'list_agents',
      description:
        '完整名单，包含已归档（未启用）的智能体：每个的名称、引擎、运行或归档状态、工作目录、上下文占用，以及熔断状态。用它来列出所有人（包括未启用的智能体），或回答「X 在哪工作」「谁被归档了」「谁快撞到上下文上限了」。如果只看在工作的智能体，用 get_fleet_status 更轻。',
      parameters: {
        type: 'object',
        properties: {
          includeArchived: { type: 'boolean', description: '默认 true。设为 false 则只列出在运行的智能体。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const includeArchived = a.includeArchived !== false;
          const dir = await window.cth.hiveAgentDirectory();
          const all = Array.isArray(dir.agents) ? dir.agents : [];
          if (!all.length) return '蜂巢里没有注册任何智能体。';
          const active = all.filter((e) => !e.archived);
          const archived = all.filter((e) => e.archived);
          const near = active
            .filter((e) => typeof e.contextPct === 'number' && e.contextPct >= 70)
            .map((e) => `${e.name} 已用 ${e.contextPct}%`);
          const describe = (e: typeof all[number]): string =>
            `${e.name}，引擎 ${e.provider}${e.cwd ? `，在 ${shortDir(e.cwd)}` : ''}${
              typeof e.contextPct === 'number' ? `，上下文已用 ${e.contextPct}%` : ''
            }`;
          const parts: string[] = [];
          parts.push(
            `${plural(active.length, '个在运行的智能体')}${archived.length ? `，另有 ${plural(archived.length, '个已归档智能体')}` : ''}。`
          );
          if (active.length) parts.push(`在运行：${active.slice(0, 12).map(describe).join('；')}。`);
          if (includeArchived && archived.length)
            parts.push(
              `已归档：${archived
                .slice(0, 12)
                .map((e) => `${e.name}${e.cwd ? `（最后一次在 ${shortDir(e.cwd)}）` : ''}`)
                .join('；')}。`
            );
          if (near.length) parts.push(`快撞到上下文上限：${near.join('，')}。`);
          return parts.join(' ');
        }, '智能体名单')
    }),

    // ── get_board ─────────────────────────────────────────────────────────
    tool({
      name: 'get_board',
      description:
        '蜂巢计划的叙述——总控用文字维护的、给人看的看板（当前计划、优先级和备注）。当用户问计划、策略、路线图，或看板上写了什么时调用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const board = await window.cth.hiveBoard();
          const text = despan(board || '');
          if (!text) return '看板现在是空的。';
          return clip(text, 1800);
        }, '看板')
    }),

    // ── get_floor_state (v0.3.4) ──────────────────────────────────────────
    tool({
      name: 'get_floor_state',
      description:
        '一次调用拿到整个实时楼层：每个在运行的智能体及其当前状态、上下文占用、熔断状态和收件箱积压，外加进行中的任务。返回紧凑 JSON 加一行朗读摘要。问「大家现在都在做什么」这类问题时优先用它。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const dir = await window.cth.hiveAgentDirectory();
          const tasksRaw = (await window.cth.hiveTasks()) as { tasks?: unknown } | null;
          const tasks = Array.isArray(tasksRaw?.tasks) ? (tasksRaw!.tasks as unknown[]).map(obj) : [];
          const rows = (Array.isArray(dir?.agents) ? (dir.agents as unknown[]) : [])
            .map(obj)
            .filter((a) => !a.archived)
            .map((a) => ({
              name: str(a.name) || str(a.id),
              status: str(a.status) || '未知',
              engine: str(a.provider) || undefined,
              contextPct: typeof a.contextPct === 'number' ? a.contextPct : undefined,
              breaker: str(a.breaker) && str(a.breaker) !== 'healthy' ? str(a.breaker) : undefined,
              inbox: typeof a.inboxBacklog === 'number' && a.inboxBacklog > 0 ? a.inboxBacklog : undefined
            }));
          const doing = tasks.filter((t) => str(t.status) === 'doing').map((t) => ({ title: str(t.title), owner: str(t.assignee) || undefined }));
          const blocked = tasks.filter((t) => str(t.status) === 'blocked').map((t) => ({ title: str(t.title), owner: str(t.assignee) || undefined }));
          const summary = `楼层上有 ${plural(rows.length, '个智能体')}，${doing.length} 个进行中，${blocked.length} 个受阻。`;
          // Flagged JSON per the Realtime prompting guidance: precise fields the
          // model can quote verbatim, with the spoken line separate.
          return `${summary} DATA: ${JSON.stringify({ agents: rows, doing, blocked })}`;
        }, '楼层状态')
    }),

    // ── get_app_info (v0.3.4) ─────────────────────────────────────────────
    tool({
      name: 'get_app_info',
      description:
        '关于 AgFlow 应用本身：当前版本和最新的发行说明（更新日志）。用于「这是哪个版本」或「这个版本有什么新东西」。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const info = await window.cth.appInfo();
          const notes = despan(info.changelog || '');
          return `这是 AgFlow 版本 ${info.version}。${notes ? `最新发行说明：${clip(notes, 1600)}` : '这个版本没有附带发行说明。'}`;
        }, '应用信息')
    })
  ];
}

/**
 * A short, preloaded orientation 败龙 can open the session with — the hive
 * size, who god is, and how many tasks are in flight — so the first answer is
 * grounded without a tool round-trip. Best-effort: returns '' if reads fail, so
 * the caller can safely concatenate it onto the agent instructions.
 */
export async function realtimeSessionSummary(): Promise<string> {
  try {
    // v0.3.4: a COMPACT PER-AGENT TABLE, not just counts — most "what's
    // happening" questions should be answerable from this alone, with zero
    // tool round-trips. Injected as the FIRST CONVERSATION ITEM (not into the
    // instructions), so the cached prompt prefix stays byte-stable.
    const [dir, tasksRaw] = await Promise.all([
      window.cth.hiveAgentDirectory(),
      window.cth.hiveTasks()
    ]);
    const rows = (Array.isArray(dir?.agents) ? (dir.agents as unknown[]) : []).map(obj).filter((a) => !a.archived);
    const godRow = rows.find((a) => a.isGod === true);
    const lines = rows.slice(0, 20).map((a) => {
      const bits = [
        `${str(a.name) || str(a.id)}，状态${str(a.status) || '未知'}`,
        str(a.provider) ? `引擎 ${str(a.provider)}` : '',
        typeof a.contextPct === 'number' ? `上下文已用 ${Math.round(a.contextPct as number)}%` : '',
        str(a.breaker) && str(a.breaker) !== 'healthy' ? `熔断 ${str(a.breaker)}` : '',
        typeof a.inboxBacklog === 'number' && (a.inboxBacklog as number) > 0 ? `收件箱 ${a.inboxBacklog} 条未读` : ''
      ].filter(Boolean);
      return bits.join('，');
    });
    const list = Array.isArray(obj(tasksRaw).tasks) ? (obj(tasksRaw).tasks as unknown[]).map(obj) : [];
    const doing = list.filter((t) => str(t.status) === 'doing');
    const blocked = list.filter((t) => str(t.status) === 'blocked');
    const taskLine = [
      doing.length
        ? `进行中：${doing.slice(0, 5).map((t) => `「${str(t.title)}」${str(t.assignee) ? `，负责人 ${str(t.assignee)}` : ''}`).join('；')}。`
        : '看板上没有进行中的任务。',
      blocked.length ? `受阻：${blocked.slice(0, 4).map((t) => `「${str(t.title)}」`).join('；')}。` : ''
    ].filter(Boolean).join(' ');
    return (
      `当前楼层——${plural(rows.length, '个智能体')}在运行` +
      `${godRow ? `，${str(godRow.name)} 与你一同总控` : ''}。` +
      `各智能体：${lines.join('；') || '无'}。` +
      taskLine +
      ` 通话过程中，变化时你还会收到简短的「（楼层动态：…）」提示——以它们为准，而不是这份快照。` +
      ` 你和总控共同使用这个楼层，看板是唯一的事实来源。`
    );
  } catch {
    return '';
  }
}
