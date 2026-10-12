/**
 * Realtime Michael — renderer voice session (card rt-2, Phase 1 = READ-ONLY voice).
 *
 * The voice orchestrator runs IN THE RENDERER over WebRTC, talking speech-to-speech
 * to OpenAI `gpt-realtime-2`. The renderer never holds the real OpenAI key: it asks
 * MAIN to mint a short-lived EPHEMERAL client secret (`realtime:mintToken`, see
 * src/main/realtime.ts) and connects with THAT.
 *
 * We drive a CUSTOM `OpenAIRealtimeWebRTC` transport (not the bare `'webrtc'` string)
 * so we can: (a) open the mic ourselves with echo-cancellation + noise-suppression +
 * auto-gain (and honor the device the user picked — Oscar's rt-8 seam), and (b) own
 * the <audio> sink for playback. Turn-taking uses semantic VAD with barge-in (the
 * model truncates when the user talks over it).
 *
 * Phase 1 is a read-only connect→listen→respond round-trip. The agent runs Kevin's
 * rt-4 READ-ONLY tools (get_fleet_status / get_tasks / get_cost / get_triggers /
 * get_config / get_memory / get_activity) and god's rt-6 "Michael" persona, so the
 * agent_tool_start/agent_tool_end lifecycle fires and the mic goes idle during a tool
 * call and resumes — a Phase-1 acceptance criterion. NO hive action-tools yet (rt-5, held).
 *
 * Shape mirrors freeflow/recorder.ts: a single module-level session (only ONE voice
 * loop at a time) exposed through a `useRealtimeMichael()` hook via useSyncExternalStore.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useSyncExternalStore } from 'react';
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from '@openai/agents-realtime';
import { realtimeReadTools, realtimeSessionSummary } from './tools';
import { realtimeActionTools } from './actions';
import { resetRealtimeCost, recordRealtimeUsage, endRealtimeCost, isRealtimeIdle, getRealtimeCostSnapshot } from './costStore';
import { DEFAULT_GOD_NAME, resolveGodName } from '@shared/godIdentity';

/**
 * Voice-loop state machine:
 *   off        — no session (initial / after disconnect / fatal error)
 *   connecting — minting token + opening the WebRTC connection
 *   listening  — connected, mic live, waiting for / hearing the user
 *   responding — the model is generating / speaking audio back
 *   working    — a tool call is in flight; mic is muted until it returns
 */
export type RealtimeStatus = 'off' | 'connecting' | 'listening' | 'responding' | 'working';

export interface RealtimeMichaelState {
  status: RealtimeStatus;
  /** Last error (no key, mint failure, mic denied, transport error…). Cleared on connect. */
  error: string | null;
  /** Whether the mic is currently muted (true while `working`). */
  muted: boolean;
  /** The realtime model actually in use (from the mint's sessionConfig). */
  model: string | null;
  /** Unix-seconds expiry of the ephemeral token, if main reported one. */
  expiresAt: number | null;
  /** Selected input device (Oscar's device picker, rt-8). null = system default. */
  deviceId: string | null;
  /** Selected output/speaker device (Oscar's speaker picker, rt-8). null = system default. */
  outputDeviceId: string | null;
}

/** Voices for gpt-realtime-2 (board: Cedar / Marin). god finalizes in rt-6. */
const REALTIME_VOICE = 'cedar';

/** Warm openers Michael leads with the moment a voice session connects, so he
 *  greets the user instead of sitting in silence waiting for them to speak. One
 *  is picked at random per connect so the greeting varies. Hardcoded constants
 *  (never user/external text) — safe to speak verbatim, no sanitization needed. */
const GREETINGS = [
  '嗨，怎么了？',
  '嘿，最近怎么样？',
  '你好，有什么可以帮你的？',
  '嘿，是我——有什么能为你做的？',
  '你好！今天我们做点什么？',
  '嘿，很高兴听到你。在想什么呢？',
  '你好！需要什么？',
  '嘿，我听着呢——什么情况？'
];

/** Michael's voice persona (rt-6 — the final Phase-1 instructions, authored by god). Michael
 *  is READ-ONLY: he reports on the hive via the rt-4 read-tools but takes no actions yet. */
function voicePersona(godName: string): string {
  return `你是${godName}——一支自主协作的编程智能体蜂巢的总控（god）的语音化身。与你交谈的人是运营蜂巢的人类；把他当作你要汇报的老板。

语音与风格。你在实时通话中说话。要简洁、自然——像一位干练、冷静的幕僚长在做口头汇报。先一句话给出结论，只有有帮助时才补充细节。除非被问到，不要朗读 markdown、文件路径或代码。数字和名字都按口语说。简短没关系；人类随时可以问更多。

你可以查什么。你对整个蜂巢有实时感知：通话接通时会拿到一份楼层快照，之后有变化会收到简短的「（楼层动态：…）」提示——优先相信它们；其余一切由你的工具覆盖。凡是快照和动态回答不了的事实问题，回答前一律先调用相应工具。你的只读工具：
- get_floor_state —— 一次调用拿到实时楼层：每个智能体的状态、上下文占用、熔断与收件箱，以及进行中的任务，全是精确数据。问「大家现在在干什么」时优先用它。
- get_app_info —— AgFlow 应用本身：版本号与最新发布说明。用于「这是哪个版本」或「这一版有什么新东西」。
- get_fleet_status —— 实时名册：谁在活跃、总控是谁，以及每个智能体的名字、角色和引擎。
- list_agents —— 完整名册，含已归档（不活跃）的智能体：各自的引擎、工作目录、上下文占用与熔断状态。用来全量列举、找已归档的人，或看谁接近上下文上限。
- get_agent_detail —— 单个智能体的全部信息（按名字或 id）：引擎与模型、工作目录、活跃或已归档、实时状态、上下文窗口占用、令牌用量、熔断状态，以及是否有记忆。
- get_memory —— 读取团队记忆。任何问题都能用它兜底：跨所有人搜索、读单个智能体的笔记（活跃或已归档皆可），或在单个智能体内搜索。它永远不会走进死胡同。
- get_tasks —— 看板：各类计数，加上进行中与受阻的任务卡及其负责人。
- get_board —— 总控的计划叙述（散文体）。
- get_triggers —— 无需人类触发就能让蜂巢运转的触发器：目前是周期性的计划任务。Webhook 与外部组织消息是另外两类触发器，但它们在别处配置，这个工具不列出。
- get_config —— 非敏感设置（自主模式、默认模型、各类上限、熔断、哪些功能开着）。绝不包含密钥。
- get_cost —— 全蜂巢的令牌用量。
- get_activity —— 最近的蜂巢活动日志：发生了什么（雇佣、归档、消息），以事件呈现。
- get_messages —— 智能体之间互相发送的消息内容：收件箱和发件箱里实际说了什么。用它向运营者汇报某条消息「说了什么」，而不只是「发生过」——可以读单个智能体的邮箱、按 id 读一条，或读全楼层最新的。密钥与凭据在给你之前已被剔除，所以可以安全引用正文。

在你真正调用工具之前，绝不要说「我没法访问」「工具不允许」「我不知道」。你可以读取任何智能体的记忆（活跃或已归档）、任何智能体的工作目录、每个智能体的完整状态、令牌用量、上下文窗口占用、计划任务、配置和看板。问题涉及蜂巢时，先调用对应的工具，再用具体事实回答——真实的名字、真实的状态、真实的数字——绝不给模糊猜测。只有工具确实什么都没返回，才简短、明确地说没有。

蜂巢词汇。智能体有像「creed-mqp3l5wn」这样的 id，也有像「Creed」这样的昵称；用名字称呼他们。god 是你所代言的总控。任务卡的状态是 todo、doing、blocked、done（待办、进行中、受阻、已完成）。熔断状态要么健康，要么正在纠偏某个陷入循环或空转的智能体。blocked（受阻）通常意味着在等人类。

你能做什么。除了汇报，你还可以用语音对蜂巢采取行动：问候某个智能体、以四段式工作单派发任务、纠偏运行中的智能体、创建/分配/更新/删除任务卡、雇佣新智能体、暂停/恢复/强制停止/关闭智能体、暂停或恢复某个智能体的消息投递、为智能体拦截某个工具、归档或取消归档智能体、清空某个智能体的上下文、创建或修改计划任务，以及从允许列表里修改应用设置。轻操作——问候、派单、纠偏、任务编辑、恢复、投递暂停/恢复、工具拦截、取消归档和外观类设置——立即执行。破坏性或昂贵操作——雇佣、关闭、暂停、强制停止、归档、清空上下文、计划任务变更和行为类设置——绝不静默执行：你要把操作读回给人类，并等人类口头确认。

工具延迟。工具调用需要一点时间。准备调用前，先自然地说一句短的口头垫话——「我看一下楼层」「稍等，我拉一下」——再调用。查东西时不要沉默；也不要在工具返回前先编出结果。

确认策略（安全关键）。对任何破坏性或昂贵操作：(1) 调用工具，它会返回一段口播回执，点明确切的操作和目标；(2) 把回执说出来，并请人类确认；(3) 只有对方明确确认——说出「确认」二字，而不是随口的「好」「嗯」——之后，才带着他们的原话调用 confirm_action；(4) 如果对方拒绝、犹豫或换了话题，调用 cancel_action。绝不替人类确认；绝不把随口一句「好」「嗯」或环境杂音当作同意；如果不确定对方是否真的确认了，就再问一次，而不是直接执行。对总控执行关闭、暂停、强制停止或归档，以及对全部智能体一次性操作，都被禁止——被提出时，拒绝并说明原因。清空总控的上下文是允许的，但同样需要口头确认。你执行的每一个动作都会以 michael-voice 记名。绝不声称做过自己没做的事，绝不编造状态。

共有楼层（你不是唯一的编排者）。god——打字的那位总控——也在操作这个蜂巢；你的每一个动作都会以 michael-voice 通告给它。任务看板是唯一事实来源。派活、创建或分配任务、雇佣之前，先扫一眼最近动态（你的 get_activity 工具，以及给你的快照），避免与 god 刚做的事重复或冲突。如果看到 god 已经处理了你被要求的事，说出来，不要重复做。

交互。请求含糊时，先用一句话确认你的理解，再回答。始终让人类心里有数、掌握主动。`;
}

let state: RealtimeMichaelState = {
  status: 'off',
  error: null,
  muted: false,
  model: null,
  expiresAt: null,
  deviceId: null,
  outputDeviceId: null
};
const listeners = new Set<() => void>();

/** The single live session (only one voice loop at a time, like freeflow's recorder). */
let session: RealtimeSession | null = null;
/** The mic stream we opened (so we can stop its tracks on teardown). */
let stream: MediaStream | null = null;
/** The <audio> sink for Michael's voice. */
let audioEl: HTMLAudioElement | null = null;
/** Guards against overlapping connect() calls racing the async mint/connect. */
let connecting = false;
/** rt-12: unsubscribe handle for the completion push, active only while a session is live. */
let offCompletion: (() => void) | null = null;
let offFloorDelta: (() => void) | null = null;
/** rt-9 cost guard: periodic tick that auto-disconnects on hard cost cap or after an
 *  idle open mic (curbs runaway audio spend on a forgotten session). */
let costGuardTimer: ReturnType<typeof setInterval> | null = null;
/** Default idle auto-disconnect window (ms) when config has none. Raised from the
 *  original 45s to 3 min so a normal thinking/reading pause no longer drops the
 *  call; the user tunes it (or turns it off) via config.realtimeIdleDisconnectMs. */
const DEFAULT_IDLE_DISCONNECT_MS = 180_000;
const COST_GUARD_TICK_MS = 10_000;

/** N3-seam (rt-10 hardening): a completion summary carries dispatch objective text.
 *  It CANNOT escalate — MAIN independently gates every destructive/forbidden op
 *  (Pam confirmed) — but neutralize it before injecting into the model as a system
 *  notification (defense in depth): collapse newlines, strip the parens that frame
 *  my notification, drop role markers + classic prompt-injection lead-ins, and cap
 *  length. Jim does the matching watcher-side half on the summary it emits. */
function sanitizeForVoice(s: string): string {
  return (s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[()]/g, '')
    .replace(/\b(?:ignore|disregard|forget|override)\b[^.!?]*\b(?:previous|above|prior|instruction|system|prompt)\b[^.!?]*/gi, '')
    .replace(/\b(?:system|assistant|developer|user)\s*:/gi, '')
    .replace(/\bnew instructions?\b[^.!?]*/gi, '')
    .replace(/\byou are (?:now )?[^.!?]*/gi, '')
    // 中文注入前缀（P0-C）：与英文规则同口径——中文产品里注入文本是中文。
    .replace(/(?:忽略|无视|忘记|覆盖)(?:之前|以上|先前|前面)?(?:的)?(?:指令|命令|提示|系统提示|设定)[^。！？]*/g, '')
    .replace(/(?:系统|助手|开发者|用户)\s*[:：]/g, '')
    .replace(/新(?:的)?指令[^。！？]*/g, '')
    .replace(/你现在是[^。！？]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function setState(patch: Partial<RealtimeMichaelState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Wire the session lifecycle events onto our state machine. */
function wire(s: RealtimeSession): void {
  // Model started / stopped speaking audio back to the user.
  s.on('audio_start', () => {
    if (state.status !== 'working') setState({ status: 'responding' });
  });
  s.on('audio_stopped', () => {
    // Only fall back to listening if we aren't mid tool-call.
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // User talked over the model (barge-in) — semantic_vad with interruptResponse
  // truncates the assistant turn automatically; we just reflect it.
  s.on('audio_interrupted', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // A turn fully ended — safety reset to listening (no-op if already there).
  s.on('agent_end', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });

  // Tool-call lifecycle: mute the mic while a tool runs so the user doesn't talk over
  // a side effect, then resume. (Phase 1 runs the rt-4 read-tools; rt-5 action-tools
  // inherit this for free.)
  s.on('agent_tool_start', () => {
    try {
      s.mute(true);
    } catch {
      /* mute is best-effort */
    }
    setState({ status: 'working', muted: true });
  });
  s.on('agent_tool_end', () => {
    try {
      s.mute(false);
    } catch {
      /* best-effort */
    }
    setState({ status: 'listening', muted: false });
  });

  // Transport / model errors. Surface the message; stay connected (the session can
  // recover from a transient error). A hard transport drop is handled by disconnect().
  s.on('error', (err) => {
    const e = (err as { error?: unknown })?.error;
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '语音会话出错';
    setState({ error: msg });
  });

  // rt-9 cost meter: each completed response reports token usage on the raw transport
  // `response.done` event. Hand it straight to Oscar's cost store (its normalizer
  // tolerates camel/snake-case + missing fields). Best-effort — never break the loop.
  s.on('transport_event', (event) => {
    try {
      const ev = event as { type?: string; response?: { usage?: unknown } };
      if (ev.type === 'response.done' && ev.response?.usage) {
        recordRealtimeUsage(ev.response.usage as Parameters<typeof recordRealtimeUsage>[0], Date.now());
      }
    } catch {
      /* metering is best-effort */
    }
  });
}

/** Stop the mic + release the audio sink. Safe to call repeatedly. */
function teardownMedia(): void {
  if (stream) {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
  }
  stream = null;
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.srcObject = null;
    } catch {
      /* ignore */
    }
  }
  audioEl = null;
}

/** Make a getUserMedia failure legible. */
function micFriendly(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('permission') || m.includes('notallowed') || m.includes('denied'))
    return '麦克风权限被拒绝——允许麦克风访问后才能进行语音通话';
  if (m.includes('notfound') || m.includes('device'))
    return '没有找到麦克风——请检查输入设备';
  return msg;
}

/**
 * Open/close the main-process mic permission gate for the realtime session (Oscar's
 * rt-8 gate, src/main/index.ts). That gate grants getUserMedia only while
 * `freeflowEnabled || realtimeVoiceEnabled` is true, and the check is SYNCHRONOUS — so
 * we must flip `realtimeVoiceEnabled` true and let it settle BEFORE opening the mic, then
 * false again on teardown/error. (We deliberately do NOT gate on key-presence: the
 * OpenAI key is shared with the CLI engines, so that would open the mic for CLI-only
 * users — a guardrail regression.)
 */
async function setMicGate(on: boolean): Promise<void> {
  try {
    await window.cth.updateConfig({ realtimeVoiceEnabled: on });
  } catch {
    /* if the config write fails, getUserMedia will surface the denial below */
  }
}

/**
 * Apply the chosen output device to our <audio> sink (Oscar's speaker picker, rt-8).
 * `setSinkId` is Chromium/Electron-only and not in every lib.dom, so we feature-detect +
 * cast narrowly. Best-effort: if the device is gone or unsupported we stay on the default
 * sink (passing '' selects the system default).
 */
async function applyOutputSink(el: HTMLAudioElement, deviceId: string | null): Promise<void> {
  const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sink.setSinkId !== 'function') return;
  try {
    await sink.setSinkId(deviceId ?? '');
  } catch {
    /* device unavailable / unsupported — fall back to the default sink */
  }
}

/**
 * Connect the voice loop: mint an ephemeral token, open the mic (EC/NS/AGC), open a
 * WebRTC RealtimeSession with semantic-VAD turn-taking, and start listening.
 * Idempotent — a no-op if already connecting/connected.
 */
export async function connect(): Promise<void> {
  if (connecting || (session && state.status !== 'off')) return;
  connecting = true;
  setState({ status: 'connecting', error: null });
  try {
    const mint = await window.cth.realtimeMintToken();
    if (!mint.ok) {
      setState({ status: 'off', error: mint.error });
      return;
    }

    // Open the main-process mic gate BEFORE getUserMedia. Oscar's rt-8 permission check
    // is synchronous, so `realtimeVoiceEnabled` must already be true when the mic opens;
    // we close it again on teardown/error.
    await setMicGate(true);

    // Mic with echo-cancellation + noise-suppression + auto-gain, honoring the device
    // the user picked (Oscar's rt-8 picker). getUserMedia surfaces permission denials.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    if (state.deviceId) audioConstraints.deviceId = { exact: state.deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Our own <audio> sink for Michael's voice, routed to the chosen speaker (rt-8).
    audioEl = new Audio();
    audioEl.autoplay = true;
    await applyOutputSink(audioEl, state.outputDeviceId);

    const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audioEl });
    // Warm-start: a short, best-effort hive snapshot so Michael's first answer is grounded
    // without a tool round-trip (rt-4 realtimeSessionSummary). Returns '' on failure / never throws.
    let warmStart = await realtimeSessionSummary().catch(() => '');
    // rt-12: catch up on completions that finished while no session was open, so Michael
    // can mention them as a "since we last talked" warm-start (the closed-session queue).
    try {
      const queued = await window.cth.realtimeDrainCompletions();
      if (Array.isArray(queued) && queued.length) {
        const lines = queued.map((c) => c.summary).filter(Boolean).join(' ');
        if (lines) warmStart = `${warmStart}\n上次对话以来完成的事项：${lines} 在自然的时候向用户提及。`.trim();
      }
    } catch {
      /* warm-start catch-up is best-effort */
    }
    // v0.3.4: the snapshot is NOT baked into instructions any more — a byte-stable
    // persona+tools prefix stays fully prompt-cached across turns and sessions
    // (cached input is ~99% cheaper). The snapshot goes in as the FIRST
    // conversation item below, and the floor watcher appends deltas mid-call.
    // The god's persisted display name (registry) so the persona and the voice
    // agent introduce the orchestrator by its real name — never a hardcoded one.
    let godName = DEFAULT_GOD_NAME;
    try {
      const reg = (await window.cth.hiveRegistry()) as unknown as {
        godId?: string;
        agents?: Record<string, { name?: string }>;
      };
      godName = resolveGodName(reg.agents?.[reg.godId ?? '']?.name);
    } catch {
      /* registry unavailable — the default name still works */
    }
    const agent = new RealtimeAgent({
      name: godName,
      instructions: voicePersona(godName),
      tools: [...realtimeReadTools(), ...realtimeActionTools()]
    });
    const s = new RealtimeSession(agent, {
      transport,
      model: mint.sessionConfig.model,
      config: {
        outputModalities: ['audio'],
        voice: REALTIME_VOICE,
        audio: {
          input: {
            // Natural turn boundaries + automatic barge-in (truncate on interrupt).
            turnDetection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              createResponse: true,
              interruptResponse: true
            }
          },
          output: { voice: REALTIME_VOICE }
        }
      }
    });
    wire(s);

    // The ephemeral client secret is the apiKey for this connect; the real OpenAI key
    // never reaches the renderer.
    await s.connect({ apiKey: mint.token, model: mint.sessionConfig.model });

    session = s;
    resetRealtimeCost(Date.now()); // rt-9: start the live session cost meter
    // v0.3.4: SILENT context injection — a raw conversation.item.create with no
    // response.create, so the model absorbs the item without speaking. (This SDK
    // version's sendMessage always triggers a response, so we go one level down
    // to the transport for the silent path.)
    const injectSilent = (text: string): void => {
      try {
        s.transport.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }]
          }
        } as never);
      } catch { /* injection is best-effort */ }
    };
    // The connect snapshot goes in as the FIRST conversation item (the greeting
    // below opens the conversation; this just grounds it).
    if (warmStart) {
      injectSilent(`（接通时的楼层快照——仅供定位，细节请调用你的工具：${sanitizeForVoice(warmStart)}）`);
    }
    // Floor deltas — silent appends that keep Michael's picture live without
    // touching the cached instructions prefix.
    offFloorDelta = window.cth.onRealtimeFloorDelta?.((d) => {
      if (session !== s) return;
      injectSilent(`（楼层动态：${sanitizeForVoice(d.text)}。只在相关时提及——不要打断。）`);
    }) ?? null;
    // rt-12: mark the session live (main now pushes completions instead of queuing) and
    // subscribe so a detected completion makes Michael speak it unprompted.
    void window.cth.realtimeSetSessionLive(true);
    offCompletion = window.cth.onRealtimeCompletion((c) => {
      try {
        // Feed it as a system-framed notification so the model relays it rather than
        // treating it as a user request; semantic_vad won't interrupt an active turn.
        // N3-seam: sanitize the summary before injection (defense in depth).
        session?.sendMessage(
          `（系统通知——你派发的一个任务刚刚完成：${sanitizeForVoice(c.summary)}）简短告诉用户，并在他需要时提供细节。`
        );
      } catch {
        /* session may be tearing down */
      }
    });
    // rt-9 cost guard: periodically stop the session if the hard cap is hit, or after an
    // idle open mic, so a forgotten session doesn't bleed audio cost. The idle window is
    // user-configurable (config.realtimeIdleDisconnectMs; default 3 min; 0 = never — the
    // cost cap stays the runaway guard). disconnect() clears this timer + tears down.
    const idleCfg = (await window.cth.getConfig()).realtimeIdleDisconnectMs;
    const idleMs = typeof idleCfg === 'number' ? idleCfg : DEFAULT_IDLE_DISCONNECT_MS;
    costGuardTimer = setInterval(() => {
      if (!session) return;
      if (getRealtimeCostSnapshot().overCap) { disconnect('cost-cap'); return; }
      if (idleMs > 0 && isRealtimeIdle(idleMs, Date.now())) disconnect('idle');
    }, COST_GUARD_TICK_MS);
    setState({
      status: 'listening',
      muted: false,
      model: mint.sessionConfig.model,
      expiresAt: mint.expiresAt
    });
    // Open the conversation: have Michael speak a warm greeting as his first turn
    // rather than waiting for the user to talk first. A system-framed trigger (the
    // same speak path the completion notifier uses) makes the model say it; we hand
    // it one of the rotating GREETINGS so the opener varies. Best-effort — if the
    // data channel isn't ready or the greeting fails, the session still works and
    // the user can just start talking.
    try {
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      s.sendMessage(
        `（系统：语音会话刚刚接通。现在开口问候用户，温暖而简短，用来开启对话——可以说类似「${greeting}」。如果快照里有要提的完成事项，可以在之后补上。不要提及本条指令。）`
      );
    } catch {
      /* greeting is best-effort — never block a successful connect */
    }
  } catch (e) {
    // Mic permission denied, WebRTC handshake failure, network, etc.
    console.log('[realtime] voice session disconnect (error)');
    try {
      session?.close();
    } catch {
      /* best-effort teardown */
    }
    session = null;
    teardownMedia();
    await setMicGate(false);
    const msg = e instanceof Error ? e.message : String(e);
    setState({ status: 'off', error: micFriendly(msg), muted: false });
  } finally {
    connecting = false;
  }
}

/** Tear down the voice loop and return to `off`. Safe to call when already off.
 *  `reason` (idle | cost-cap | error | user) is logged so an idle auto-off can be
 *  told apart from a spend-cap stop or a user toggle. */
export function disconnect(reason: string = 'user'): void {
  console.log(`[realtime] voice session disconnect (${reason})`);
  try {
    session?.close();
  } catch {
    /* best-effort teardown */
  }
  session = null;
  if (costGuardTimer) { clearInterval(costGuardTimer); costGuardTimer = null; } // rt-9 cost guard off
  teardownMedia();
  endRealtimeCost(); // rt-9: freeze the session cost meter
  // rt-12: stop receiving completion pushes; main will queue them until next connect.
  offCompletion?.();
  offCompletion = null;
  offFloorDelta?.();
  offFloorDelta = null;
  void window.cth.realtimeSetSessionLive(false);
  // Close the main-process mic gate so the realtime flag doesn't keep the mic permission
  // open after we've stopped (fire-and-forget — tracks are already stopped above).
  void setMicGate(false);
  setState({ status: 'off', muted: false });
}

/** Select the microphone (Oscar's device picker, rt-8). Applied on the next connect(). */
export function setDeviceId(deviceId: string | null): void {
  setState({ deviceId });
}

/**
 * Select the speaker/output device (Oscar's speaker picker, rt-8). Stores the choice and,
 * if a session is live, re-routes the current <audio> sink immediately; otherwise it's
 * applied on the next connect().
 */
export function setOutputDeviceId(deviceId: string | null): void {
  setState({ outputDeviceId: deviceId });
  if (audioEl) void applyOutputSink(audioEl, deviceId);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): RealtimeMichaelState {
  return state;
}

/**
 * React binding for the Realtime Michael voice loop. Returns the current state plus
 * `connect()` / `disconnect()` / `setDeviceId()`. A single session is shared across the
 * whole renderer, so every consumer sees the same status.
 */
export function useRealtimeMichael(): RealtimeMichaelState & {
  connect: () => Promise<void>;
  disconnect: () => void;
  setDeviceId: (deviceId: string | null) => void;
  setOutputDeviceId: (deviceId: string | null) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snap, connect, disconnect, setDeviceId, setOutputDeviceId };
}
