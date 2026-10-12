/**
 * Closing Time — the graceful, data-loss-free shutdown protocol.
 *
 * Killing the PTYs mid-thought loses whatever the agents were holding in
 * working memory: uncommitted WIP, unrecorded decisions, half-updated
 * memory.md files. "Closing time" closes the floor the way a real office
 * does: the human announces it, every worker packs up and confirms, the
 * manager locks the door.
 *
 *   1. The human clicks "closing time" in the quit dialog.
 *   2. We mail the god agent a shutdown brief: broadcast closing time to the
 *      team; every worker commits/parks WIP, appends state + next steps to
 *      its memory.md, then replies with subject CLOSING-TIME-ACK.
 *   3. The god waits for every ACK (the harness shows live progress by
 *      watching the same inbox traffic), saves its own memory, and sends a
 *      message with subject CLOSING-TIME-COMPLETE.
 *   4. The router observer spots that message → the app tears down and quits.
 *
 * Everything rides the existing hive rails: inbox delivery, the idle
 * inbox-wake nudge, and Stop-hook draining already guarantee the messages
 * get acted on. This module only injects the kickoff mail and watches the
 * routed traffic — it never types into terminals.
 *
 * Runs in the Electron main process.
 */
import type { WebContents } from 'electron';
import type { HiveManager, HiveMessage } from './hive';
import type { ControlRegistry } from './control';

export type ClosingTimePhase =
  | 'started' | 'progress' | 'complete' | 'timeout' | 'cancelled';

export interface ClosingTimeEvent {
  phase: ClosingTimePhase;
  /** Workers that have ACKed so far / total workers being waited on. */
  acked: number;
  total: number;
}

/** Subject markers. Deliberately forgiving (case, -/_/space) — agents write
 *  these by hand, so "Closing Time Ack" must count as well as the canonical
 *  CLOSING-TIME-ACK the brief asks for. */
const ACK_RE = /CLOSING[-_\s]*TIME[-_\s]*ACK/i;
const COMPLETE_RE = /CLOSING[-_\s]*TIME[-_\s]*COMPLETE/i;

/** How long to wait before surfacing "this is taking long — force quit?".
 *  Compaction or a long tool call can easily hold an ACK for a few minutes. */
const TIMEOUT_MS = 6 * 60_000;
/** Grace after COMPLETE before tearing down, so the god's final commit/log
 *  writes land on disk and the floor visibly concludes. */
const TEARDOWN_GRACE_MS = 2_500;

export class ClosingTimeController {
  private active = false;
  private godId = 'god';
  private workers = new Set<string>();
  private acked = new Set<string>();
  private timeoutTimer: NodeJS.Timeout | null = null;
  private teardownTimer: NodeJS.Timeout | null = null;

  constructor(
    private hive: HiveManager,
    /** Agent ids that have a LIVE PTY right now. The hive registry alone is
     *  not enough: agents that died with the app (hard quit, crash) keep
     *  their registry record without ever being flagged `archived`, so a
     *  registry-based roster waits on ghosts that can never ACK. */
    private getLiveAgentIds: () => string[],
    private getWebContents: () => WebContents | null,
    /** Called once the god concluded — runs the real teardown + app.quit(). */
    private onConcluded: () => void,
    /** Mid-run steering (#7C.2): lets closing time reach DEEPLY BUSY agents at
     *  their next hook boundary instead of waiting for the Stop-hook inbox
     *  drain — the graceful interrupt. Optional so tests can omit it. */
    private control?: ControlRegistry
  ) {}

  isActive(): boolean {
    return this.active;
  }

  /** Kick off the protocol. Returns an error string when the floor cannot run
   *  it (no live god agent) so the UI can fall back to the hard quit. */
  start(): { ok: boolean; error?: string } {
    if (this.active) {
      // Re-pressed while running (e.g. from the timeout view): keep waiting.
      this.armTimeout();
      this.emitState('progress');
      return { ok: true };
    }
    const reg = this.hive.registry();
    this.godId = reg.godId ?? 'god';
    const live = new Set(this.getLiveAgentIds());
    if (!reg.agents[this.godId] || !live.has(this.godId)) {
      return { ok: false, error: '没有正在运行的总控智能体——关闭楼层需要它来收齐各方的收尾确认。' };
    }

    // Only agents with a live terminal are waited on — the registry is just
    // metadata here (names + god/assistant flags), never the roster source.
    this.workers = new Set(
      [...live].filter((id) => {
        const a = reg.agents[id];
        return id !== this.godId && !!a && !a.isGod;
      })
    );
    this.acked = new Set();
    this.active = true;

    const names = [...this.workers]
      .map((id) => `${reg.agents[id]?.name ?? id} (${id})`)
      .join(', ') || '（无——楼层上只有你）';

    this.hive.send({
      to: 'god',
      act: 'request',
      subject: '关闭楼层——立即执行收尾协议',
      body: [
        '人类按下了「关闭楼层」：只要你确认楼层安全，应用会立刻关闭。现在先执行这套收尾协议，其他事都放一放：',
        '',
        `1. 向全队广播关闭楼层（发一条 "to":"broadcast" 的消息）。当前在岗：${names}。`,
        '   要求每位智能体立刻：把进行中的工作安全地暂存或提交，把当前状态 + 明确的下一步追加到自己的 memory.md，然后回复你一条主题恰好为 "CLOSING-TIME-ACK" 的消息。',
        '2. 等待并持续清空收件箱，直到上面每位智能体都发来 CLOSING-TIME-ACK。必要时催一次掉队的人。',
        '3. 保存你自己的状态：更新 board.md，把本轮值班总结追加到你的 memory.md。',
        `4. 收尾：发一条 "to":"human"、主题恰好为 "CLOSING-TIME-COMPLETE" 的消息——应用会监听它并关闭。不要在每位智能体确认前发送：应用会独立核对 ACK，过早的结论会被驳回。`,
        '',
        this.workers.size === 0
          ? '当前楼层上没有其他智能体——直接做第 3、4 步。'
          : '预处理助手会单独保存自己的记忆——不要等它，也不要给它发消息。',
        '这是一次收尾下班：不要开始新工作，也不要接受新任务。'
      ].join('\n')
    }, 'human');

    // Graceful interrupt for the deeply busy (#7C.2): the inbox brief above
    // only lands when an agent next STOPS — a worker hours into a task would
    // hold the whole shutdown. A steer note rides the next hook boundary
    // (PostToolUse/UserPromptSubmit) instead, so every live agent learns about
    // closing time within one tool call. Idle agents are covered by the
    // inbox-wake nudge; busy ones by the steer — both rails, no PTY typing.
    this.control?.steer(this.godId,
      '人类按下了「关闭楼层」：在下一个合适的节点暂停手头的工作，立刻清空你的收件箱——里面有一封收尾简报在等你。先把楼层的收尾协调好，其他事都靠后。');
    for (const id of this.workers) {
      this.control?.steer(id,
        '关闭楼层——办公室要收工了。完成当前这一步，但不要开始新工作。把进行中的工作安全地暂存或提交，把当前状态 + 明确的下一步追加到你的 memory.md，然后回复 god 一条主题恰好为 "CLOSING-TIME-ACK" 的消息。');
    }

    this.armTimeout();
    this.emitState('started');
    return { ok: true };
  }

  /** Human changed their mind — stand the floor back up. */
  cancel(): void {
    if (!this.active) return;
    this.cleanup();
    // Drop closing-time steers that no hook boundary has consumed yet, so a
    // busy agent doesn't get told to shut down AFTER the human cancelled.
    // Agents that already saw the note get corrected via the god (below).
    this.control?.clearSteers(this.godId);
    for (const id of this.workers) this.control?.clearSteers(id);
    this.emitState('cancelled');
    try {
      this.hive.send({
        to: 'god',
        act: 'inform',
        subject: '关闭楼层已取消',
        body: '人类取消了这次收尾——忽略关闭楼层协议，恢复正常工作。已经保存过的记忆算额外收获，不是问题。'
      }, 'human');
    } catch { /* best-effort */ }
  }

  /** Router observer — called by the hive for every routed message. */
  onRouted(msg: HiveMessage, targets: string[]): void {
    if (!this.active) return;
    // A worker reporting in. Counted only for known workers, and only when the
    // ACK actually reached the god (not e.g. a stray broadcast echo).
    if (ACK_RE.test(msg.subject) && this.workers.has(msg.from) && targets.includes(this.godId)) {
      if (!this.acked.has(msg.from)) {
        this.acked.add(msg.from);
        this.emitState('progress');
      }
      return;
    }
    // The god concluding. COMPLETE is only honored from the god itself — a
    // worker can't (accidentally or otherwise) shut down the whole floor.
    if (COMPLETE_RE.test(msg.subject) && msg.from === this.godId) {
      // Trust but VERIFY: the god is told to wait for every ACK, but the
      // whole point of closing time is that no worker loses unsaved state —
      // so a premature COMPLETE must not close the floor. Workers whose
      // terminal died mid-protocol (tab closed, crash) are excused: their
      // ACK can never arrive and their session is gone either way.
      const reg = this.hive.registry();
      const liveNow = new Set(this.getLiveAgentIds());
      const pending = [...this.workers].filter(
        (id) => !this.acked.has(id) && liveNow.has(id) && !reg.agents[id]?.archived
      );
      if (pending.length > 0) {
        const names = pending.map((id) => `${reg.agents[id]?.name ?? id} (${id})`).join(', ');
        this.hive.send({
          to: 'god',
          act: 'refuse',
          subject: '关闭楼层——结论被驳回，仍有智能体未确认',
          body: [
            `应用还没有收到以下智能体的 CLOSING-TIME-ACK：${names}。`,
            '在每位智能体都确认自己的记忆已保存之前，应用会保持打开。',
            '去催一催掉队的人（把关闭楼层的指令重新发给他们），等他们的 ACK，然后再发一次 CLOSING-TIME-COMPLETE。'
          ].join('\n')
        }, 'human');
        this.emitState('progress');
        return;
      }
      this.cleanup();
      this.active = true; // stays "active" through the grace so the UI holds
      this.emitState('complete');
      this.teardownTimer = setTimeout(() => {
        this.active = false;
        this.onConcluded();
      }, TEARDOWN_GRACE_MS);
    }
  }

  private armTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (this.active) this.emitState('timeout');
    }, TIMEOUT_MS);
  }

  private cleanup(): void {
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.teardownTimer) { clearTimeout(this.teardownTimer); this.teardownTimer = null; }
    this.active = false;
  }

  private emitState(phase: ClosingTimePhase): void {
    const ev: ClosingTimeEvent = { phase, acked: this.acked.size, total: this.workers.size };
    try { this.getWebContents()?.send('app:closingTime', ev); } catch { /* window tore down */ }
  }
}
