/**
 * Realtime Michael — voice ACTION spine (card rt-5, Phase 2).
 *
 * Phase 1 gave voice-Michael READ tools. Phase 2 gives him WRITE access: he can
 * ping/dispatch agents, edit the task board, steer/pause/halt/kill workers, hire
 * new ones, and edit schedules — entirely by voice. Because the confirm surface is
 * VOICE-ONLY (the human declined on-screen confirm cards), the echo-back spine in
 * this file is the ENTIRE safety surface, so ALL of it lives in MAIN (the trusted
 * side) — the renderer tools are thin callers. Defense in depth: even if the model
 * (or stray audio) tries something, MAIN enforces the tiering, the distinct-token
 * confirm, and the hard allowlist.
 *
 * TIERING (locked by the human 2026-06-25, see board.md Phase-2):
 *   • SOFT writes  — ping, create/assign/update task, dispatch, steer — execute
 *     directly (low blast radius; fully reversible / advisory).
 *   • DESTRUCTIVE / expensive — spawn-hire, kill, pause, halt, edit_schedule —
 *     require a two-step VERBAL echo-back: (1) read back exact verb + target
 *     (+ a $ estimate for spawn/hire — STUBBED here; rt-9 wires the real number),
 *     (2) a DISTINCT confirm token (the verb word or "confirm" — NEVER a bare
 *     "yes", so ambient speech can't authorize a kill), (3) mic-idle at the commit
 *     instant (the renderer mutes the mic during the confirm tool-call — see
 *     session.ts agent_tool_start), (4) the circuit-breaker still gates (actions go
 *     through the same control path it owns).
 *   • HARD ALLOWLIST — kill/pause/halt on the god orchestrator, and any mass /
 *     all-agent op, are VOICE-FORBIDDEN even with a valid confirm — rejected
 *     outright, no pending created.
 *
 * Every committed action is attributed to actor `michael-voice` (a log stamp on
 * every verb + `from: michael-voice` on messages). rt-7 deepens this into a live
 * god-PTY cross-notify; rt-5 just needs the attribution present.
 *
 * Thin wrappers ONLY — no new orchestration logic. Each verb maps onto a main fn
 * the god PTY already uses (hive.send / atomic task mutations / spawnAgentCore /
 * control.pause+steer+halt / pty kill / missions save), injected via deps so this
 * module stays decoupled from index.ts wiring.
 */
import { ipcMain } from 'electron';
import type { HiveMessage, HiveTask, Registry } from './hive';
import type { ScheduledMission } from './config';
import { inferAgentProvider } from '../shared/agentProvider';
import { clearCommandForProvider } from '../shared/providerAutomation';
import { resolveGodName } from '../shared/godIdentity';

export const VOICE_ACTOR = 'michael-voice';

/** A minimal spawn spec — index.ts adapts it to its AgentSpawnOptions + spawnAgentCore. */
export interface RealtimeSpawnSpec {
  id: string;
  cwd: string;
  command: string;
  provider?: string;
  hive?: { id: string; name: string; provider?: string; role?: string; cwd: string };
}

/** Existing main fns the voice actions wrap, injected from index.ts so the security
 *  logic here is unit-testable and index.ts stays a thin adapter. */
export interface RealtimeActionDeps {
  hiveEnabled(): boolean;
  hiveSend(partial: Partial<HiveMessage>, from: string): HiveMessage;
  hiveTasks(): unknown;
  hiveAddTask(task: HiveTask): boolean;
  hivePatchTask(id: string, patch: Partial<Omit<HiveTask, 'id'>>): boolean;
  hiveDeleteTask(id: string): boolean;
  hiveRegistry(): Registry;
  hiveLog(event: Record<string, unknown>): void;
  controlPause(agentId: string, on: boolean): void;
  controlSteer(agentId: string, text: string): void;
  controlHalt(agentId: string): void;
  controlSnapshot(agentId: string): { paused?: boolean; halted?: boolean } | null;
  killAgent(agentId: string): { ok: boolean; error?: string };
  spawnAgent(opts: RealtimeSpawnSpec): Promise<{ ok: boolean; error?: string }>;
  listMissions(): ScheduledMission[];
  saveMissions(missions: ScheduledMission[]): void;
  /** rt-12: register a voice dispatch with the completion watcher so the engine can
   *  detect it finishing and speak the notice. Optional — wired in index.ts. */
  trackDispatch?(d: { correlationId: string; targetAgentId: string; objective?: string; dispatchedAt: number; dispatchMessageId?: string }): void;
  // ── v0.3.4 full-control extensions ──
  controlResume(agentId: string): void;
  controlAutoDelivery(agentId: string, paused: boolean): void;
  controlGateTool(agentId: string, tool: string, on: boolean): void;
  setArchived(agentId: string, archived: boolean): { ok: boolean; error?: string };
  /** clear_context: push text into the agent's renderer message queue, so
   *  delivery rides EVERY existing gate (idle-only, boot grace, draft/picker
   *  safety, auto-delivery pause). */
  enqueueToAgent(agentId: string, text: string): void;
  /** update_setting: non-secret config snapshot + patch. The per-key policy
   *  table in THIS file is the only path from voice to config — never expose a
   *  raw patch. */
  getConfigValue(key: string): unknown;
  patchConfig(patch: Record<string, unknown>): void;
}

/** The result every action / confirm / cancel returns to the renderer tool, which
 *  hands `spoken` straight to the model to say. */
export interface ActionResult {
  ok: boolean;
  spoken: string;
  /** true when a destructive op is now PENDING a verbal confirm. */
  needsConfirm?: boolean;
}

type Tier = 'soft' | 'destructive';

/** Per-verb spec: tier + the human-facing word that must appear in a confirm. */
const VERBS: Record<string, { tier: Tier; confirmWord: string; agentTargeted: boolean }> = {
  ping: { tier: 'soft', confirmWord: 'ping', agentTargeted: true },
  create_task: { tier: 'soft', confirmWord: 'create', agentTargeted: false },
  assign_task: { tier: 'soft', confirmWord: 'assign', agentTargeted: false },
  update_task: { tier: 'soft', confirmWord: 'update', agentTargeted: false },
  dispatch: { tier: 'soft', confirmWord: 'dispatch', agentTargeted: true },
  steer: { tier: 'soft', confirmWord: 'steer', agentTargeted: true },
  spawn: { tier: 'destructive', confirmWord: 'spawn', agentTargeted: false },
  kill: { tier: 'destructive', confirmWord: 'kill', agentTargeted: true },
  pause: { tier: 'destructive', confirmWord: 'pause', agentTargeted: true },
  halt: { tier: 'destructive', confirmWord: 'halt', agentTargeted: true },
  edit_schedule: { tier: 'destructive', confirmWord: 'schedule', agentTargeted: false },
  // ── v0.3.4 full-control extensions ──
  resume: { tier: 'soft', confirmWord: 'resume', agentTargeted: true },
  auto_delivery: { tier: 'soft', confirmWord: 'delivery', agentTargeted: true },
  gate_tool: { tier: 'soft', confirmWord: 'gate', agentTargeted: true },
  delete_task: { tier: 'soft', confirmWord: 'delete', agentTargeted: false },
  unarchive: { tier: 'soft', confirmWord: 'unarchive', agentTargeted: true },
  clear_context: { tier: 'destructive', confirmWord: 'clear', agentTargeted: true },
  archive: { tier: 'destructive', confirmWord: 'archive', agentTargeted: true },
  create_schedule: { tier: 'destructive', confirmWord: 'schedule', agentTargeted: false },
  update_setting: { tier: 'destructive', confirmWord: 'setting', agentTargeted: false }
};

/** 口语动作名（P0-C）：VERBS 的键保持机器值，说出口用中文。 */
const VERB_ZH: Record<string, string> = {
  ping: '问候', create_task: '创建任务', assign_task: '分配任务', update_task: '更新任务',
  dispatch: '派单', steer: '纠偏', spawn: '雇佣', kill: '关闭', pause: '暂停', halt: '强制停止',
  edit_schedule: '修改计划', resume: '恢复', auto_delivery: '调整自动投递', gate_tool: '拦截工具',
  delete_task: '删除任务', unarchive: '取消归档', clear_context: '清空上下文', archive: '归档',
  create_schedule: '新建计划', update_setting: '修改设置'
};

/** 任务状态的中文说法（P0-C）：机器值仍是 todo/doing/blocked/done。 */
const STATUS_ZH: Record<string, string> = {
  todo: '待办', doing: '进行中', blocked: '受阻', done: '已完成'
};

/** v0.3.4 update_setting policy — the ONLY settings voice can touch, each with
 *  a tier and typed validation. Everything not listed (harnessHome, every
 *  secret-bearing key, provider base URLs, integrations, …) is refused
 *  outright: the raw config carries credentials and dangerous keys, and the
 *  unvalidated config:update IPC must never be reachable from speech. */
const SETTING_POLICY: Record<string, {
  tier: 'soft' | 'confirm';
  type: 'boolean' | 'number' | 'string';
  min?: number; max?: number; values?: string[];
}> = {
  // soft: cosmetic / low-blast, instantly reversible
  notifications: { tier: 'soft', type: 'boolean' },
  tvShowOffices: { tier: 'soft', type: 'boolean' },
  officeTheme: { tier: 'soft', type: 'string', values: ['office', 'friends', 'siliconvalley', 'got', 'hogwarts'] },
  terminalTheme: { tier: 'soft', type: 'string', values: ['light', 'dark'] },
  freeflowEnabled: { tier: 'soft', type: 'boolean' },
  strongKeepalive: { tier: 'soft', type: 'boolean' },
  autoUpdate: { tier: 'soft', type: 'boolean' },
  realtimeIdleDisconnectMs: { tier: 'soft', type: 'number', min: 30_000, max: 3_600_000 },
  // confirm: behavior-changing — echo old→new + distinct token
  autoMode: { tier: 'confirm', type: 'boolean' },
  defaultModel: { tier: 'confirm', type: 'string' },
  godProvider: { tier: 'confirm', type: 'string' },
  godModel: { tier: 'confirm', type: 'string' },
  maxConcurrentWorkers: { tier: 'confirm', type: 'number', min: 1, max: 16 },
  costCapTokens: { tier: 'confirm', type: 'number', min: 0, max: 1_000_000_000 },
  maxTurns: { tier: 'confirm', type: 'number', min: 1, max: 1000 },
  slackEnabled: { tier: 'confirm', type: 'boolean' },
  webhookEnabled: { tier: 'confirm', type: 'boolean' },
  semanticMemory: { tier: 'confirm', type: 'boolean' },
  multiWindow: { tier: 'confirm', type: 'boolean' }
};

const PENDING_TTL_MS = 120_000;

const PROVIDER_COMMAND: Record<string, string> = {
  claude: 'claude', codex: 'codex', antigravity: 'antigravity', gemini: 'gemini',
  opencode: 'opencode', crush: 'crush', pi: 'pi', qwen: 'qwen', copilot: 'copilot',
  cursor: 'cursor-agent',
  // 国产引擎 (P0-A8): doubao/glm/ollama/deepseek ride the OpenCode shell
  //（deepseek 在 2026-10 真机实测后从 dsh 改走该壳——dsh 无交互 profile）。
  doubao: 'opencode', glm: 'opencode', ollama: 'opencode', deepseek: 'opencode'
};

/** Bare affirmations that must NEVER authorize a destructive op on their own —
 *  ambient speech / a stray "yeah" cannot be allowed to confirm a kill. */
const BARE_AFFIRMATIONS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'k', 'sure', 'go', 'go ahead',
  'do it', 'please', 'fine', 'affirmative', 'uh huh', 'mhm', 'mm hmm', 'right', 'correct',
  // 中文随口答应（P0-C）：同样不能单独授权破坏性操作。
  '好', '好的', '是', '是的', '对', '对的', '嗯', '行', '可以', '没问题', '收到'
]);

// ─── helpers ────────────────────────────────────────────────────────────────

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const norm = (s: string): string => s.toLowerCase().replace(/[.!?,;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
/** N1 (rt-10 hardening): escape regex metachars before interpolating a verb word into
 *  `new RegExp`. Safe with today's verb vocab (plain words) — defense in depth. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shortId(): string {
  // app code (not a Workflow script) — Math.random is fine here.
  return Math.random().toString(36).slice(2, 8);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
}

/** Is the spoken target a mass / all-agent reference? Those are voice-forbidden for
 *  destructive verbs regardless of confirm. */
function isMassTarget(target: string): boolean {
  const t = norm(target);
  if (!t) return false;
  if (/\b(all|every|everyone|everybody)\b/.test(t)) return true;
  if (t === '*' || t === 'agents' || t === 'the team' || t === 'team' || t === 'fleet' || t === 'everything')
    return true;
  // Chinese mass targets (P0-C): 「所有/全部/大家」同样是全量指代，破坏性动词一律拒绝。
  if (/(?:所有|全部|全体|每个人|大家|整个团队|整个楼层|整个蜂巢)/.test(t)) return true;
  // a comma/and list of multiple targets
  if (/,| and |、|和|以及/.test(t)) return true;
  return false;
}

interface ResolvedAgent { id: string; name: string; isGod: boolean }

/** Resolve a spoken target ("dev-1", "关闭 小张", an id) to a single live agent, or
 *  return a spoken disambiguation error. Prefers non-archived matches. */
function resolveAgent(target: string, reg: Registry): ResolvedAgent | { error: string } {
  const t = norm(target);
  if (!t) return { error: '没有指定智能体名称' };
  const entries = Object.entries(reg.agents ?? {});
  const mk = (id: string, m: { name?: string; isGod?: boolean }): ResolvedAgent => ({
    id, name: m.name || id, isGod: !!m.isGod || id === reg.godId
  });
  // exact id
  const byId = entries.find(([id]) => id.toLowerCase() === t);
  if (byId) return mk(byId[0], byId[1]);
  // 'god' / 'michael' / '败龙' / '总控' alias for the orchestrator
  if ((t === 'god' || t === 'michael' || t === 'the god' || t === '败龙' || t === '总控') && reg.godId)
    return mk(reg.godId, reg.agents[reg.godId] ?? {});
  // exact name, prefer live
  const byName = entries.filter(([, m]) => (m.name || '').toLowerCase() === t);
  const liveName = byName.filter(([, m]) => !m.archived);
  const namePick = liveName.length ? liveName : byName;
  if (namePick.length === 1) return mk(namePick[0][0], namePick[0][1]);
  if (namePick.length > 1)
    return { error: `有 ${namePick.length} 个智能体都叫「${target}」——请说确切的智能体 id` };
  // partial contains, live only
  const partial = entries.filter(
    ([id, m]) => !m.archived && (id.toLowerCase().includes(t) || (m.name || '').toLowerCase().includes(t))
  );
  if (partial.length === 1) return mk(partial[0][0], partial[0][1]);
  if (partial.length > 1) return { error: `有多个智能体匹配「${target}」——说得更具体些，或直接说 id` };
  return { error: `没有找到匹配「${target}」的智能体` };
}

/** Distinct-token confirm check. Accept only if the phrase carries the verb word or
 *  the literal "confirm"; a bare affirmation ("yes", "ok") is rejected. */
function confirmAccepted(phrase: string, confirmWord: string): boolean {
  const p = norm(phrase);
  if (!p) return false;
  if (BARE_AFFIRMATIONS.has(p)) return false;
  if (/\bconfirm(ed|s)?\b/.test(p)) return true;
  if (new RegExp(`\\b${escapeRegExp(confirmWord)}\\b`).test(p)) return true;
  // 中文确认（P0-C）：明确说「确认」/「确定」才算。先排除否定式——「我不确定」绝不能当同意。
  if (/不\s*(?:确定|确认)|没(?:有)?(?:确定|确认)/.test(p)) return false;
  if (/确认|确定/.test(p)) return true;
  return false;
}

// ─── pending (single-slot two-phase confirm) ────────────────────────────────

interface Pending {
  verb: string;
  confirmWord: string;
  targetLabel: string;
  createdAt: number;
  commit: () => Promise<string>;
}
let pending: Pending | null = null;

function pendingFresh(): Pending | null {
  if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) pending = null;
  return pending;
}

// ─── soft-write executors (run immediately) ─────────────────────────────────

function attribute(deps: RealtimeActionDeps, verb: string, target: string, extra: Record<string, unknown> = {}): void {
  try {
    deps.hiveLog({ kind: 'voice_action', actor: VOICE_ACTOR, verb, target, ...extra });
  } catch {
    /* attribution is best-effort — never block the action */
  }
  // rt-7 dual-orchestrator coord: tell the god PTY what voice-Michael just COMMITTED, so
  // the two autonomous orchestrators stay aware and don't make duplicate/contradictory
  // moves. attribute() only runs on committed writes (soft execs + post-confirm commits),
  // so god is never notified for a merely-proposed/uncommitted destructive action.
  try {
    const detail =
      typeof extra.objective === 'string' ? `: ${extra.objective}`
      : typeof extra.text === 'string' ? `: ${extra.text}`
      : typeof extra.title === 'string' ? `: ${extra.title}`
      : typeof extra.status === 'string' ? ` → ${extra.status}`
      : typeof extra.action === 'string' ? ` (${extra.action})`
      : '';
    const reg = deps.hiveRegistry();
    const godName = resolveGodName(reg.agents[reg.godId ?? 'god']?.name);
    deps.hiveSend(
      {
        to: 'god',
        act: 'inform',
        subject: `语音操作：${verb} ${target}`,
        body: `${godName}（语音编排者 ${VOICE_ACTOR}）刚刚执行：${verb} → ${target}${detail}。特此同步以免重复——看板是唯一事实来源。`
      },
      VOICE_ACTOR
    );
  } catch {
    /* god cross-notify is best-effort — never block the action */
  }
}

function findTasks(deps: RealtimeActionDeps): HiveTask[] {
  const data = deps.hiveTasks() as { tasks?: unknown } | null;
  return Array.isArray(data?.tasks) ? (data!.tasks as HiveTask[]) : [];
}

function execPing(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const message = str(a.message) || str(a.text) || '来看看进展。';
  deps.hiveSend({ to: r.id, act: 'inform', subject: `语音问候：来自${resolveGodName(reg.agents[reg.godId ?? 'god']?.name)}`, body: message }, VOICE_ACTOR);
  attribute(deps, 'ping', r.id);
  return { ok: true, spoken: `已问候 ${r.name}。` };
}

function execDispatch(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const objective = str(a.objective) || str(a.task) || str(a.message);
  if (!objective) return { ok: false, spoken: '要派什么活？我需要一个目标。' };
  // 4-part contract → the agent's inbox.
  const body =
    `目标：${objective}\n` +
    `背景：${str(a.context) || '（未提供）'}\n` +
    `约束：${str(a.constraints) || '（自行判断，但遵守护栏）'}\n` +
    `完成标准：${str(a.doneWhen) || str(a.done) || '把结果回报给总控'}`;
  const msg = deps.hiveSend(
    { to: r.id, act: 'request', subject: `语音派单：${objective.slice(0, 60)}`, body, requires_reply: true },
    VOICE_ACTOR
  );
  attribute(deps, 'dispatch', r.id, { objective: objective.slice(0, 120) });
  // rt-12: register so the completion watcher can tell us when r.id finishes.
  deps.trackDispatch?.({ correlationId: msg.id, targetAgentId: r.id, objective, dispatchedAt: Date.now(), dispatchMessageId: msg.id });
  return { ok: true, spoken: `已派给 ${r.name}：${objective.slice(0, 80)}。` };
}

function execSteer(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const text = str(a.text) || str(a.message) || str(a.steer);
  if (!text) return { ok: false, spoken: '要给他们什么指导意见？' };
  deps.controlSteer(r.id, `[${VOICE_ACTOR}] ${text}`);
  attribute(deps, 'steer', r.id, { text: text.slice(0, 120) });
  return { ok: true, spoken: `正在纠偏 ${r.name}：${text.slice(0, 80)}。` };
}

function execCreateTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const title = str(a.title) || str(a.task) || str(a.name);
  if (!title) return { ok: false, spoken: '任务标题是什么？' };
  const id = `${slug(title)}-${shortId()}`;
  const card: HiveTask = {
    id,
    title,
    description: str(a.description) || undefined,
    assignee: str(a.assignee) || undefined,
    status: 'todo',
    dependsOn: [],
    priority: typeof a.priority === 'number' ? a.priority : 5,
    createdAt: new Date().toISOString()
  };
  if (!deps.hiveAddTask(card)) {
    return { ok: false, spoken: '这个任务已经存在，创建不了。' };
  }
  attribute(deps, 'create_task', id, { title: title.slice(0, 120), assignee: card.assignee });
  return { ok: true, spoken: `已创建任务「${title}」${card.assignee ? `，指派给 ${card.assignee}` : ''}。` };
}

// Match-only normalizer: strips ALL non-alphanumerics (hyphens included) so a
// spoken "message visibility" matches a stored "message-visibility". Kept
// separate from `norm` above, which must preserve token shape for the
// confirm-word echo-back rule.
const normMatch = (s: string): string =>
  // 保留 CJK（P0-C）：中文任务标题/名称必须能被语音匹配，不能被剥成空串。
  (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();
const toksMatch = (s: string): string[] => normMatch(s).split(' ').filter(Boolean);
const AMBIGUOUS_MARGIN = 0.08; // top two within this => ask which one, don't guess

/** Score how well a spoken/typed ref matches one card. 0..1. Tiered,
 *  order-independent, truncation- and punctuation-tolerant. Mirrors
 *  bin/find-task.cjs scoreTask (validated by its --selftest, 8/8). */
function scoreCard(refNorm: string, refToks: string[], c: HiveTask): number {
  if (!refNorm) return 0;
  const titleN = normMatch(c.title);
  const idN = normMatch(c.id);
  if (idN === refNorm || titleN === refNorm) return 1; // exact (after normalization)
  if (titleN && (titleN.startsWith(refNorm) || refNorm.startsWith(titleN))) return 0.92; // truncation
  if (idN && idN.startsWith(refNorm)) return 0.9;
  const hay = new Set(toksMatch(c.title).concat(toksMatch(c.id)));
  const coverage = refToks.length ? refToks.filter((w) => hay.has(w)).length / refToks.length : 0;
  const hayArr = [...hay];
  const prefixCov = refToks.length
    ? refToks.filter((w) => hayArr.some((h) => h.startsWith(w) || w.startsWith(h))).length / refToks.length
    : 0;
  if (coverage === 1) return 0.85; // every spoken word present (order-independent)
  if (titleN.includes(refNorm) || idN.includes(refNorm)) return Math.max(0.7, coverage); // contiguous substring
  if (prefixCov === 1) return 0.78; // every spoken word present as a prefix
  return Math.max(coverage, prefixCov) * 0.7; // partial overlap
}

/** Find the card a spoken/typed ref refers to. Returns the best scored match,
 *  or `ambiguous` (the close candidates) when the top two are within
 *  AMBIGUOUS_MARGIN — callers ask which rather than mutate the wrong card. */
function findCard(
  deps: RealtimeActionDeps,
  ref: string
): { tasks: HiveTask[]; card: HiveTask | null; ambiguous?: HiveTask[] } {
  const tasks = findTasks(deps);
  const refNorm = normMatch(ref);
  const refToks = toksMatch(ref);
  const scored = tasks
    .map((c) => ({ c, s: scoreCard(refNorm, refToks, c) }))
    .filter((x) => x.s >= 0.45)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { tasks, card: null };
  const top = scored[0];
  const close = scored.filter((x) => x.s >= top.s - AMBIGUOUS_MARGIN);
  if (close.length > 1) return { tasks, card: null, ambiguous: close.slice(0, 3).map((x) => x.c) };
  return { tasks, card: top.c };
}

function execAssignTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  const assignee = str(a.assignee) || str(a.to) || str(a.agentId);
  if (!ref || !assignee) return { ok: false, spoken: '我需要知道是哪个任务、指派给谁。' };
  const { card, ambiguous } = findCard(deps, ref);
  if (ambiguous) {
    return { ok: false, spoken: `是哪一个——${ambiguous.map((c) => `「${c.title}」`).join('，还是 ')}？` };
  }
  if (!card) return { ok: false, spoken: `没有找到匹配「${ref}」的任务。` };
  if (!deps.hivePatchTask(card.id, { assignee })) {
    return { ok: false, spoken: `暂时无法更新「${card.title}」。` };
  }
  attribute(deps, 'assign_task', card.id, { assignee });
  return { ok: true, spoken: `已把「${card.title}」指派给 ${assignee}。` };
}

function execUpdateTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  if (!ref) return { ok: false, spoken: '要更新哪个任务？' };
  const { card, ambiguous } = findCard(deps, ref);
  if (ambiguous) {
    return { ok: false, spoken: `是哪一个——${ambiguous.map((c) => `「${c.title}」`).join('，还是 ')}？` };
  }
  if (!card) return { ok: false, spoken: `没有找到匹配「${ref}」的任务。` };
  const status = str(a.status);
  const valid = ['todo', 'doing', 'blocked', 'done'];
  if (status && !valid.includes(status)) return { ok: false, spoken: `「${status}」不是有效的状态。` };
  const patch: Partial<Omit<HiveTask, 'id'>> = {};
  if (status) patch.status = status as HiveTask['status'];
  if (str(a.result)) patch.result = str(a.result);
  if (str(a.assignee)) patch.assignee = str(a.assignee);
  if (!deps.hivePatchTask(card.id, patch)) {
    return { ok: false, spoken: `暂时无法更新「${card.title}」。` };
  }
  attribute(deps, 'update_task', card.id, { status: patch.status ?? card.status });
  return { ok: true, spoken: `已更新「${card.title}」${status ? `为${STATUS_ZH[status] ?? status}` : ''}。` };
}

// ─── v0.3.4 soft executors ──────────────────────────────────────────────────

function execResume(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  deps.controlResume(r.id);
  attribute(deps, 'resume', r.id);
  return { ok: true, spoken: `已恢复 ${r.name}——工具可以继续用了。` };
}

function execAutoDelivery(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  const raw = norm(str(a.state) || str(a.action) || (a.paused === true ? 'pause' : a.paused === false ? 'resume' : ''));
  if (!raw) return { ok: false, spoken: '要暂停还是恢复消息投递？' };
  const paused = /pause|off|hold|stop/.test(raw);
  deps.controlAutoDelivery(r.id, paused);
  attribute(deps, 'auto_delivery', r.id, { action: paused ? 'paused' : 'resumed' });
  return {
    ok: true,
    spoken: paused
      ? `已暂停向 ${r.name} 自动投递——排队的消息会等待。`
      : `已恢复向 ${r.name} 自动投递。`
  };
}

function execGateTool(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  const toolName = str(a.tool) || str(a.toolName);
  if (!toolName || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(toolName)) {
    return { ok: false, spoken: '要拦截哪个工具？请给出确切名称，比如 Bash 或 WebFetch。' };
  }
  const raw = norm(str(a.state) || str(a.action));
  const on = !/off|allow|ungate|unblock|enable/.test(raw); // default: gate it
  deps.controlGateTool(r.id, toolName, on);
  attribute(deps, 'gate_tool', r.id, { action: `${on ? 'gated' : 'ungated'} ${toolName}` });
  return { ok: true, spoken: `已${on ? '拦截' : '放行'} ${r.name} 的 ${toolName} 工具。` };
}

function execDeleteTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  if (!ref) return { ok: false, spoken: '要删除哪个任务？' };
  const { card, ambiguous } = findCard(deps, ref);
  if (ambiguous) return { ok: false, spoken: `是哪一个——${ambiguous.map((c) => `「${c.title}」`).join('，还是 ')}？` };
  if (!card) return { ok: false, spoken: `没有找到匹配「${ref}」的任务。` };
  if (!deps.hiveDeleteTask(card.id)) {
    return { ok: false, spoken: `暂时无法删除「${card.title}」。` };
  }
  attribute(deps, 'delete_task', card.id, { title: card.title.slice(0, 120) });
  return { ok: true, spoken: `已删除任务「${card.title}」。如果删错了，随时可以重建。` };
}

function execUnarchive(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  const res = deps.setArchived(r.id, false);
  attribute(deps, 'unarchive', r.id);
  return res.ok
    ? { ok: true, spoken: `已把 ${r.name} 从归档中召回。` }
    : { ok: false, spoken: `无法取消归档 ${r.name}：${res.error || '未知错误'}。` };
}

// ─── destructive commit builders (run AFTER confirm) ────────────────────────

function buildKill(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    const res = deps.killAgent(r.id);
    attribute(deps, 'kill', r.id);
    return res.ok ? `已关闭 ${r.name}。` : `无法关闭 ${r.name}：${res.error || '未知错误'}。`;
  };
}

function buildPause(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    deps.controlPause(r.id, true);
    attribute(deps, 'pause', r.id);
    return `已暂停 ${r.name}。`;
  };
}

function buildHalt(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    deps.controlHalt(r.id);
    attribute(deps, 'halt', r.id);
    return `已强制停止 ${r.name}。`;
  };
}

function buildSpawn(deps: RealtimeActionDeps, spec: RealtimeSpawnSpec, label: string): () => Promise<string> {
  return async () => {
    const res = await deps.spawnAgent(spec);
    attribute(deps, 'spawn', spec.id, { provider: spec.provider, role: spec.hive?.role });
    return res.ok ? `已雇佣 ${label}。` : `雇佣 ${label} 失败：${res.error || '未知错误'}。`;
  };
}

function buildClearContext(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    // '/clear' is NOT universal — it was hardcoded here for every provider, which
    // meant Grok/OpenCode/pi (whose verb is '/new') got a literal "/clear" typed
    // as chat text, and Crush/Copilot got one with no prompt able to receive it.
    // Resolve the provider's own verb; null = nothing safe to type, so say so
    // rather than sending a command that does nothing.
    const provider = inferAgentProvider(undefined, deps.hiveRegistry().agents?.[r.id]?.provider);
    const command = clearCommandForProvider(provider);
    if (!command) {
      return `${r.name} 跑在 ${provider} 上，没有我可以输入的清空上下文命令。请在他们的终端里手动清空。`;
    }
    // Queue through the renderer message queue: delivery inherits every existing
    // safety gate (idle-only, boot grace, draft/picker protection).
    deps.enqueueToAgent(r.id, command);
    attribute(deps, 'clear_context', r.id);
    return `已为 ${r.name} 排队清空上下文——他们一空闲就执行。`;
  };
}

function buildArchive(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    const res = deps.setArchived(r.id, true);
    attribute(deps, 'archive', r.id);
    return res.ok
      ? `已归档 ${r.name}——请出楼层，历史保留。说「取消归档」可以召回。`
      : `无法归档 ${r.name}：${res.error || '未知错误'}。`;
  };
}

function buildEditSchedule(
  deps: RealtimeActionDeps,
  mission: ScheduledMission,
  action: 'enable' | 'disable' | 'delete'
): () => Promise<string> {
  return async () => {
    const all = deps.listMissions();
    let next: ScheduledMission[];
    if (action === 'delete') next = all.filter((m) => m.id !== mission.id);
    else next = all.map((m) => (m.id === mission.id ? { ...m, enabled: action === 'enable' } : m));
    deps.saveMissions(next);
    attribute(deps, 'edit_schedule', mission.id, { action });
    return `${action === 'delete' ? '已删除' : action === 'enable' ? '已启用' : '已停用'}计划「${mission.label}」。`;
  };
}

// ─── propose: classify, allowlist-gate, run-or-stage ────────────────────────

function proposeDestructive(deps: RealtimeActionDeps, verb: string, a: Record<string, unknown>): ActionResult {
  const spec = VERBS[verb];
  const reg = deps.hiveRegistry();

  // Agent-targeted destructive verbs: resolve + hard allowlist (god + mass).
  if (spec.agentTargeted) {
    const rawTarget = str(a.agentId) || str(a.target) || str(a.name);
    if (isMassTarget(rawTarget))
      return { ok: false, spoken: `语音不允许一次对全部智能体执行 ${verb}。请逐个来，或者用界面操作。` };
    const r = resolveAgent(rawTarget, reg);
    if ('error' in r) return { ok: false, spoken: r.error };
    // God policy per verb: kill/pause/halt/archive on god stay voice-forbidden.
    // clear_context on god is ALLOWED behind confirm — it's recoverable
    // (sessions resume) and "clear Michael's context" is a real operator need.
    if (r.isGod && verb !== 'clear_context')
      return { ok: false, spoken: `语音不允许对总控执行 ${verb}。这必须在界面里做。` };

    const commit =
      verb === 'kill' ? buildKill(deps, r)
      : verb === 'pause' ? buildPause(deps, r)
      : verb === 'halt' ? buildHalt(deps, r)
      : verb === 'clear_context' ? buildClearContext(deps, r)
      : buildArchive(deps, r);
    const breaker = deps.controlSnapshot(r.id);
    const note = breaker?.halted ? '（注意：已处于强制停止）' : breaker?.paused ? '（注意：已处于暂停）' : '';
    pending = { verb, confirmWord: spec.confirmWord, targetLabel: r.name, createdAt: Date.now(), commit };
    const consequence = verb === 'clear_context'
      ? `这会清空 ${r.name} 对当前对话的工作记忆。`
      : verb === 'archive'
        ? `这会把 ${r.name} 请出楼层（历史保留）。`
        : `这是破坏性操作。`;
    return {
      ok: true,
      needsConfirm: true,
      spoken: `你让我${VERB_ZH[verb] ?? verb} ${r.name}${note}。${consequence} 继续的话，请说「确认」；说「取消」可以停止。`
    };
  }

  // spawn / hire — expensive; stubbed $ estimate (rt-9 wires the real number).
  if (verb === 'spawn') {
    const provider = (str(a.provider) || 'claude').toLowerCase();
    const role = str(a.role) || str(a.job);
    const name = str(a.name) || (role ? role.replace(/\b\w/g, (c) => c.toUpperCase()) : provider) || '工作者';
    const godCwd = reg.godId ? reg.agents[reg.godId]?.cwd : undefined;
    const cwd =
      str(a.cwd) || godCwd || Object.values(reg.agents).find((m) => m.cwd)?.cwd || '';
    if (!cwd) return { ok: false, spoken: '需要一个工作目录才能雇佣——当前没有配置。' };
    const command = str(a.command) || PROVIDER_COMMAND[provider] || 'claude';
    const id = `${slug(name)}-${shortId()}`;
    const spec2: RealtimeSpawnSpec = { id, cwd, command, provider, hive: { id, name, provider, role: role || undefined, cwd } };
    pending = { verb, confirmWord: 'spawn', targetLabel: name, createdAt: Date.now(), commit: buildSpawn(deps, spec2, `${name}（${provider}）`) };
    return {
      ok: true,
      needsConfirm: true,
      // Spawn/hire is gated behind a verbal echo-back confirm. No cost is quoted —
      // the orchestrator persona does not surface money to the user.
      spoken: `你要雇佣一名跑 ${provider} 的智能体${role ? `，担任${role}` : ''}，名字叫 ${name}。雇佣请说「确认」；说「取消」可以停止。`
    };
  }

  // edit_schedule
  if (verb === 'edit_schedule') {
    const missions = deps.listMissions();
    if (!missions.length) return { ok: false, spoken: '目前没有可修改的计划任务。' };
    const ref = norm(str(a.missionId) || str(a.schedule) || str(a.label) || str(a.target));
    const m =
      missions.find((x) => x.id.toLowerCase() === ref) ||
      missions.find((x) => (x.label || '').toLowerCase() === ref) ||
      missions.find((x) => (x.label || '').toLowerCase().includes(ref) || x.id.toLowerCase().includes(ref));
    if (!m) return { ok: false, spoken: ref ? `没有找到匹配「${str(a.label) || ref}」的计划任务。` : '要修改哪个计划任务？' };
    const raw = norm(str(a.action) || str(a.op));
    const action: 'enable' | 'disable' | 'delete' =
      raw.includes('delete') || raw.includes('remove') ? 'delete' : raw.includes('disable') || raw.includes('off') || raw.includes('pause') ? 'disable' : 'enable';
    pending = {
      verb,
      confirmWord: 'schedule',
      targetLabel: m.label,
      createdAt: Date.now(),
      commit: buildEditSchedule(deps, m, action)
    };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `你要${action === 'delete' ? '删除' : action === 'enable' ? '启用' : '停用'}计划「${m.label}」。继续请说「确认」；说「取消」可以停止。`
    };
  }

  // v0.3.4: create a brand-new schedule (edit_schedule only toggles/deletes).
  if (verb === 'create_schedule') {
    const label = str(a.label) || str(a.name) || str(a.title);
    const body = str(a.prompt) || str(a.body) || str(a.message);
    if (!label || !body) return { ok: false, spoken: '需要计划任务的名称，以及每次运行要发给智能体的话。' };
    const minutes = typeof a.intervalMinutes === 'number' && isFinite(a.intervalMinutes)
      ? Math.min(7 * 24 * 60, Math.max(5, Math.round(a.intervalMinutes)))
      : 60;
    const to = str(a.to) || str(a.agentId) || 'god';
    const target = resolveAgent(to, reg);
    const targetId = 'error' in target ? 'god' : target.id;
    const mission: ScheduledMission = {
      id: `voice-${slug(label)}-${shortId()}`,
      label,
      intervalMs: minutes * 60_000,
      to: targetId,
      body,
      enabled: true
    };
    pending = {
      verb, confirmWord: 'schedule', targetLabel: label, createdAt: Date.now(),
      commit: async () => {
        deps.saveMissions([...deps.listMissions(), mission]);
        attribute(deps, 'create_schedule', mission.id, { title: label.slice(0, 120) });
        return `已创建计划「${label}」——每 ${minutes} 分钟发给 ${targetId}。`;
      }
    };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `你想新建计划「${label}」，每 ${minutes} 分钟给 ${targetId} 发消息。创建请说「确认」；说「取消」可以停止。`
    };
  }

  // v0.3.4: settings, through the policy table ONLY.
  if (verb === 'update_setting') {
    const key = str(a.key) || str(a.setting) || str(a.name);
    const policy = SETTING_POLICY[key];
    if (!key) return { ok: false, spoken: '要修改哪个设置？' };
    if (!policy) {
      return { ok: false, spoken: `「${key}」这个设置不能通过语音修改——请到设置界面去改。` };
    }
    // Coerce + validate the value against the key's declared type.
    let value: unknown = a.value;
    if (policy.type === 'boolean') {
      if (typeof value === 'string') value = /^(true|on|yes|enable|enabled|1)$/i.test(value.trim());
      if (typeof value !== 'boolean') return { ok: false, spoken: `${key} 要开还是关？` };
    } else if (policy.type === 'number') {
      if (typeof value === 'string') value = parseFloat(value);
      if (typeof value !== 'number' || !isFinite(value)) return { ok: false, spoken: `${key} 要设成多少？` };
      if (policy.min !== undefined && value < policy.min) return { ok: false, spoken: `${key} 不能低于 ${policy.min}。` };
      if (policy.max !== undefined && value > policy.max) return { ok: false, spoken: `${key} 不能超过 ${policy.max}。` };
      value = Math.round(value as number);
    } else {
      if (typeof value !== 'string' || !value.trim() || value.length > 200) {
        return { ok: false, spoken: `要把 ${key} 设成什么？` };
      }
      value = value.trim();
      if (policy.values && !policy.values.includes(value as string)) {
        return { ok: false, spoken: `${key} 只能是：${policy.values.join('、')}。` };
      }
    }
    const oldValue = deps.getConfigValue(key);
    const describe = (v: unknown): string => typeof v === 'boolean' ? (v ? '开启' : '关闭') : String(v ?? '未设置');
    if (describe(oldValue) === describe(value)) {
      return { ok: true, spoken: `${key} 已经是${describe(value)}——无需修改。` };
    }
    const applyNow = (): string => {
      deps.patchConfig({ [key]: value });
      attribute(deps, 'update_setting', key, { action: `${describe(oldValue)} → ${describe(value)}` });
      return `完成——${key} 现在是${describe(value)}（原来是${describe(oldValue)}）。`;
    };
    if (policy.tier === 'soft') {
      // Low-blast keys apply immediately, like other soft verbs.
      return { ok: true, spoken: applyNow() };
    }
    pending = { verb, confirmWord: 'setting', targetLabel: key, createdAt: Date.now(), commit: async () => applyNow() };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `${key} 现在是${describe(oldValue)}；你想改成${describe(value)}。确认请说「确认」；说「取消」可以停止。`
    };
  }

  return { ok: false, spoken: `我不知道怎么${verb}。` };
}

/** Top-level propose/execute for one verb. Soft writes run now; destructive ones
 *  stage a pending and ask for verbal confirm. */
function runAction(deps: RealtimeActionDeps, verb: string, a: Record<string, unknown>): ActionResult {
  if (!deps.hiveEnabled()) return { ok: false, spoken: '蜂巢尚未配置，无法执行该操作。' };
  const spec = VERBS[verb];
  if (!spec) return { ok: false, spoken: `没有名为「${verb}」的操作。` };
  // Any new proposal supersedes a stale pending.
  pending = null;
  if (spec.tier === 'soft') {
    switch (verb) {
      case 'ping': return execPing(deps, a);
      case 'dispatch': return execDispatch(deps, a);
      case 'steer': return execSteer(deps, a);
      case 'create_task': return execCreateTask(deps, a);
      case 'assign_task': return execAssignTask(deps, a);
      case 'update_task': return execUpdateTask(deps, a);
      case 'resume': return execResume(deps, a);
      case 'auto_delivery': return execAutoDelivery(deps, a);
      case 'gate_tool': return execGateTool(deps, a);
      case 'delete_task': return execDeleteTask(deps, a);
      case 'unarchive': return execUnarchive(deps, a);
      default: return { ok: false, spoken: `我不知道怎么${verb}。` };
    }
  }
  return proposeDestructive(deps, verb, a);
}

// ─── IPC registration ───────────────────────────────────────────────────────

/** rt-5 live-bug instrumentation: write the REAL error + stack to the console AND
 *  the hive log so the NEXT voice repro is self-diagnosing (the model only ever sees
 *  a friendly 'spoken' string, which hides the true failure). Best-effort. */
function logActionFailure(deps: RealtimeActionDeps, channel: string, verb: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[realtime-action] ${channel} verb=${verb} FAILED:`, err.stack || err.message);
  try {
    deps.hiveLog({
      kind: 'voice_action_error',
      actor: VOICE_ACTOR,
      channel,
      verb,
      error: err.message,
      stack: (err.stack || '').slice(0, 800)
    });
  } catch {
    /* never let logging throw into the handler */
  }
}

/**
 * Wire the voice-action IPC. Called once from index.ts with the existing main fns.
 * Channels:
 *   realtime:action          {verb, ...args}  → ActionResult (soft runs now;
 *                                                destructive stages a pending)
 *   realtime:action:confirm  {phrase}         → ActionResult (commits the pending
 *                                                iff the distinct token matches)
 *   realtime:action:cancel   {}               → ActionResult (drops the pending)
 */
export function registerRealtimeActionIpc(deps: RealtimeActionDeps): void {
  ipcMain.handle('realtime:action', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const verb = norm(str(p.verb)).replace(/\s+/g, '_');
    try {
      const res = runAction(deps, verb, p);
      // A non-ok result is an EXPECTED friendly rejection (bad target, hive off, etc.) —
      // log it quietly so a live repro can still be correlated, but it is not an error.
      if (!res.ok) console.warn(`[realtime-action] verb=${verb} rejected: ${res.spoken}`);
      return res;
    } catch (e) {
      logActionFailure(deps, 'realtime:action', verb, e);
      const msg = e instanceof Error ? e.message : '未知错误';
      return { ok: false, spoken: `那次操作失败了：${msg}。` } satisfies ActionResult;
    }
  });

  ipcMain.handle('realtime:action:confirm', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const cur = pendingFresh();
    if (!cur) return { ok: false, spoken: '现在没有待确认的操作。' } satisfies ActionResult;
    const phrase = str(p.phrase) || str(p.confirm) || str(p.text);
    if (!confirmAccepted(phrase, cur.confirmWord)) {
      return {
        ok: false,
        spoken: `出于安全，我不会仅凭这句话就${cur.verb} ${cur.targetLabel}——请清楚说出「确认」，而不是随口答应。再说一遍，或者说「取消」。`
      } satisfies ActionResult;
    }
    const commit = cur.commit;
    const verb = cur.verb;
    pending = null; // consume before running so a failure can't be re-confirmed
    try {
      const spoken = await commit();
      return { ok: true, spoken } satisfies ActionResult;
    } catch (e) {
      logActionFailure(deps, 'realtime:action:confirm', verb, e);
      const msg = e instanceof Error ? e.message : '未知错误';
      return { ok: false, spoken: `那次操作失败了：${msg}。` } satisfies ActionResult;
    }
  });

  ipcMain.handle('realtime:action:cancel', async () => {
    const had = pendingFresh();
    pending = null;
    return { ok: true, spoken: had ? `已取消${VERB_ZH[had.verb] ?? had.verb}。` : '没有可取消的操作。' } satisfies ActionResult;
  });
}
