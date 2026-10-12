/**
 * The Hive — the on-disk multi-agent coordination layer.
 *
 * Lives under `<harnessHome>/hive/` as a single git repo that ONLY this main
 * process commits to (agents never call git — they just write files). See
 * HIVE.md for the full design. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - hive identity (registry.json: id/role/cwd/session — what agents read),
 *     separate from the UI floor roster (`<harnessHome>/roster.json`)
 *   - shared blackboard (board.md), task ledger, and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). The hive keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the floor.
 *   - single-committer git with retry/backoff + stale-lock recovery
 *
 * Everything here runs in the Electron main process.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, lstatSync, realpathSync, rmSync, appendFileSync,
  symlinkSync, unlinkSync, copyFileSync, cpSync, chmodSync
} from 'node:fs';
import { join, dirname, basename, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentUsageSample } from './usage';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
import {
  isClaudeProvider,
  isHiveAwareProvider,
  canReceiveInbox,
  providerPreset,
  bridgeOf,
  type AgentProvider
} from '../shared/agentProvider';
import { MCP_CATALOG } from '../shared/mcpCatalog';
import { selectBroadcastTargets } from '../shared/broadcast';
import { preferredAgentRole } from '../shared/agentRole';
import { mergeTaskLedger } from '../shared/taskLedger';
import { expandTilde } from './fs';
import { resolveGodName } from '../shared/godIdentity';
import { buildGodPersonaPrompt } from '../shared/godPersona';
import { skillDropDirs, bundledSkillsLine } from '../shared/skillTargets';

/** The subset of HarnessConfig the hive consumes for the default-MCP merge.
 *  Kept as a local shape so hive.ts never imports the foundation-owned config
 *  module just for a type. */
type McpDefaultsMap = { [id: string]: { enabled: boolean } } | undefined;

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

/** What `settleInbox` did to a released worker's mailbox. */
export interface SettledInbox {
  /** Unread messages filed under inbox/.done. */
  moved: number;
  /** Unread messages left pending because they arrived after the cut-off. */
  kept: number;
  /** The filed messages that asked for something — their sender never gets
   *  an answer, and deserves to hear so instead of waiting on a dead worker.
   *  `conversation` lets the caller tell the worker's own work order (which
   *  it just completed) from a genuinely unanswered request. */
  unanswered: Array<{ id: string; act: MessageAct; from: string; subject: string; conversation: string }>;
}

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** One hive message reshaped for the voice read-layer (`hive:messages`): the
 *  operator-briefing view of an inbox/outbox message. `subject` and `body` are
 *  REDACTED main-side (see {@link redactSecrets}) before this ever leaves the
 *  main process — the renderer/voice layer never sees a raw body, and never a
 *  secret. PII-free + secret-free by construction. */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: MessageAct;
  /** REDACTED subject line. */
  subject: string;
  /** REDACTED message body. */
  body: string;
  requires_reply: boolean;
  /** Which mailbox folder this copy was read from, relative to `owner`. */
  direction: 'inbox' | 'outbox';
  /** The agent whose mailbox this copy lives in. */
  owner: string;
  /** True when read from an archived/handled subfolder (inbox/.done, outbox/.sent). */
  archived: boolean;
  created_at: string;
}

/** One question→answer exchange with the human, recorded ON the task card so
 *  the decision trail stays with the work it unblocked. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card can only
   *  proceed with the human's input (status goes blocked); the harness UI
   *  fills in {a}. The full history stays on the card forever. */
  humanQA?: HumanQA[];
  /** Outcome summary, surfaced by the Slack done-notifier when this card reaches
   *  'done'. Optional; the notifier falls back to description/title. */
  result?: string;
  /** Set when this task originated from a Slack message — the thread the
   *  done-summary reply is posted back into. Consumed OUTBOUND only; populating
   *  it is the inbound/kanban side's job and does not affect routing. */
  slack?: { channel: string; thread_ts: string };
  /** Set when this task originated from a generic webhook POST. Stores the SHA-256
   *  of the capability token (never the raw token — that's returned to the caller
   *  once and never persisted), so a GET status lookup can match by hashing the
   *  presented token. Read-only capability: it never widens routing or exposure. */
  webhook?: { tokenHash: string };
}

export interface AgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on. Defaults to 'claude' when unset (legacy). */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** 败龙's prep assistant — enriches prompts and forwards them to 败龙.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** The human has this agent 1:1 and 败龙 must leave it alone until they
   *  flip it back. Held agents stay ACTIVE and keep their terminal — this is
   *  "do not dispatch to them", not "they are gone", which is why it is its own
   *  flag rather than a reuse of `archived` or a breaker level. */
  onHold?: boolean;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
  /** Whether `cwd` is actually usable for a (re)spawn — i.e. an ABSOLUTE path
   *  that exists as a directory. Computed + persisted at spawn so the roster
   *  reliably exposes each worker's environment validity. A non-absolute fragment
   *  (e.g. "ClaudeTerminalHarness") spawns into a nonexistent dir and fails; this
   *  flag makes that visible instead of letting it slip through silently. */
  cwdValid?: boolean;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** Build env + extra spawn args that make an agent process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  /** The hive-protocol seed to TYPE into the TUI after boot rather than pass on
   *  argv — set only for `seedDelivery:'type-into-tui'` providers (Crush), whose
   *  bare TUI rejects a positional seed. The renderer types it through the same
   *  per-pty write-chain as the inbox-wake nudge. (ondev-b) */
  seedPrompt?: string;
  /** Set when the agent spawned in a DEGRADED posture the user should know about
   *  (today: the proxy-bridge sidecar never bound after retries, so a proxy-tier
   *  agent such as Crush runs without hive events). Human-readable, one line. */
  degraded?: string;
}

const HOP_CAP = 12;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** Non-memory files `mempalace mine` must not ingest (Claude Code hooks config,
 *  cursor, raw inbox/outbox JSON). `mempalace mine` honors .gitignore, so we drop
 *  one in each agent dir; written on birth here and refreshed by the mine loop.
 *
 *  `.codex/` is here for a second reason as well, and it is the load-bearing one:
 *  a Codex worker's CODEX_HOME lives INSIDE its agent dir (see installCodexHooks —
 *  Codex can only be given hooks through a config.toml in its own home, so it
 *  cannot share the user's ~/.codex). Codex then fills that folder with full
 *  session transcripts, an 80MB+ logs sqlite and a plugin cache, and the hive's
 *  git repo was faithfully versioning every revision of all of it. Twenty Codex
 *  agents took the hive's .git to 7.5GB, at which point git's own auto-gc tried to
 *  repack it and took 22GB of RAM doing so — the machine swapped, the app stopped
 *  responding. None of it was ever wanted in history: it is Codex's private
 *  scratch state, and it stays on disk (so resume still works) either way. */
/** Proxy-bridge sidecar bind attempts per spawn, and the pause before each retry. */
const PROXY_BIND_ATTEMPTS = 3;
const PROXY_BIND_BACKOFF_MS = [250, 750];

const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Append-only: writes only the missing lines, leaving any existing entries. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

/**
 * Strip secret-shaped substrings out of free text before it leaves the main
 * process toward the voice / renderer layer. This is the MAIN-SIDE privacy gate
 * for the voice read-layer's message-content path (`hive:messages`): a message
 * body can quote a key, paste a token, or echo a credential, so every body and
 * subject is run through this before it crosses IPC. The renderer holds ZERO
 * redaction policy — it only ever receives the already-cleaned string.
 *
 * Deliberately CONSERVATIVE: it matches known credential SHAPES (provider key
 * prefixes, JWTs, PEM private keys, bearer tokens) and sensitive key=value /
 * key: value assignments, then replaces the secret with `[redacted]`. It does
 * NOT blanket-redact on entropy, so operator-meaningful content the briefing
 * needs — git SHAs, agent ids, file paths, ordinary prose — survives intact.
 * Over-redaction (e.g. a non-secret `apikey:openai` ref) is acceptable; leaking
 * a real secret is not.
 *
 * LOCKSTEP: the regex battery below is mirrored character-identically in
 * test/voice-messages.test.cjs (a .cjs test cannot import this TS module). If
 * you change a pattern here, mirror it there — the test is what PROVES a
 * secret-shaped value is stripped.
 */
export function redactSecrets(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let s = text;
  // 1. PEM private-key blocks (RSA/EC/OPENSSH/PGP — header through footer).
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]');
  // 2. JSON Web Tokens — three base64url segments separated by dots.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
  // 3. Known credential prefixes: OpenAI/Anthropic (sk-, sk-ant-), Slack
  //    (xoxb/xoxp/xoxa/xoxr/xoxs-, xapp-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  //    github_pat_), AWS access-key ids (AKIA…), Google API keys (AIza…).
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    '[redacted]'
  );
  // 4. Bearer tokens — keep the label, drop the credential.
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  // 5. Sensitive key = value / key: value — keep the key name, drop the value.
  //    An optional namespace prefix (aws_, gcp_, …) is folded into the captured
  //    key so a LABELED secret survives the \b boundary: `aws_secret_access_key`
  //    is all word chars, so a bare `\b(secret)\b` never sees it. Listing
  //    secret_access_key / private_key alone is not enough — the prefix run is
  //    what lets `aws_secret_access_key=…` (no AKIA shape on the value) redact.
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`
  );
  return s;
}

// ─── HiveManager ────────────────────────────────────────────────────────────

/**
 * Repair only literal CR/LF characters that occur inside JSON strings.
 *
 * Agents normally publish outbox messages through JSON.stringify, but a manual
 * shell write can put real line-break bytes in a multi-line body. JSON rejects
 * those bytes inside a string even though the intended value is unambiguous.
 * Keep this lexical and deliberately narrow: JSON.parse remains the acceptance
 * gate, and every other malformed shape is left for quarantine.
 */
function repairLiteralLineBreaksInJsonStrings(raw: string): { text: string; changed: boolean } {
  let text = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (const ch of raw) {
    if (!inString) {
      text += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      text += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      text += ch;
      inString = false;
      continue;
    }

    if (ch === '\n') {
      text += '\\n';
      changed = true;
      continue;
    }

    if (ch === '\r') {
      text += '\\r';
      changed = true;
      continue;
    }

    text += ch;
  }

  return { text, changed };
}

/** Keep the crash directory bounded.
 *
 *  One file per abnormal exit, 8 KB each, is fine until the failure being
 *  diagnosed is a crash loop -- which is the case this exists for. A provider
 *  that dies during startup and gets relaunched writes a file per attempt, so
 *  the scenario that most needs the diagnostic also produces the most files.
 *
 *  Filenames begin with an ISO timestamp, so a lexicographic sort is already
 *  chronological and no stat() is needed to find the oldest.
 *
 *  Best-effort throughout: a diagnostic that breaks teardown is worse than one
 *  that keeps a few extra files. */
const MAX_CRASH_LOGS = 50;

function pruneCrashLogs(dir: string): void {
  try {
    const logs = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    for (const stale of logs.slice(0, Math.max(0, logs.length - MAX_CRASH_LOGS))) {
      try { unlinkSync(join(dir, stale)); } catch { /* already gone, or not ours */ }
    }
  } catch { /* unreadable directory is not worth failing an exit path over */ }
}

export class HiveManager {
  /**
   * @param getHome  Lazily resolve harnessHome so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to animate routed
   *                 messages on the office floor; a no-op in tests/headless.
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => boolean | void
  ) {}

  private routerTimer: NodeJS.Timeout | null = null;

  /** The embedded OTLP collector's loopback URL, set by the main process once the
   *  collector is bound (telemetry.ts). null = telemetry off → no OTel env is
   *  injected at spawn (the transcript reconciler remains the cost source). */
  private _otelEndpoint: string | null = null;
  /** Point newly-spawned agents at the live telemetry collector. Call after the
   *  collector starts; only affects spawns made afterwards. */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** The collector URL agents are pointed at, or null when telemetry is off. */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  /** What the app running this hive actually IS: its version, and whether it is a
   *  packaged build or a local dev run.
   *
   *  Agents could not see this before, and it cost real time. A multi-agent
   *  investigation into anomalous file modes ran for hours before the explanation
   *  turned out to be that the operator had quit a downloaded build and started a
   *  local one, which inherits the launching shell's umask instead of Finder's
   *  022. No agent could observe that, several published conclusions had to be
   *  withdrawn, and log.jsonl carried no app-start marker to notice the switch
   *  from either. */
  private _runtime: { version: string; packaged: boolean; appPath?: string } | null = null;
  setRuntimeInfo(info: { version: string; packaged: boolean; appPath?: string } | null): void {
    this._runtime = info;
  }
  runtimeInfo(): { version: string; packaged: boolean; appPath?: string } | null {
    return this._runtime;
  }

  /** Whether config.orchestratorMaySpawn is on, mirrored here so the prompt
   *  builder can decide whether to tell god the spawn queue is available. Set at
   *  bootstrap and on every config write; hive.ts deliberately does not import
   *  the config module. */
  private _maySpawn = false;
  setOrchestratorMaySpawn(on: boolean): void {
    this._maySpawn = on;
  }
  orchestratorMaySpawn(): boolean {
    return this._maySpawn;
  }

  /** 总控人设（P1-4）——mirror of config.godPersona, same rationale as _maySpawn:
   *  hive.ts 不 import config 模块；bootstrap 与每次配置写入时由 main 同步。
   *  只镜像注入用得到的字段（style/strategy）；avatar 是渲染层的形象，不进提示词。 */
  private _godPersona: { style?: string; strategy?: string } = {};
  setGodPersona(persona: { style?: string; strategy?: string } | null | undefined): void {
    this._godPersona = persona ?? {};
  }

  // — paths —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** IPC endpoint the cth-hook shim talks to (Phase 1 autonomy).
   *  On POSIX this is a Unix-domain socket file under the hive root. On Windows,
   *  Node's `net` IPC uses named pipes (a flat `\\.\pipe\` namespace, not the
   *  filesystem), so a raw file path fails to bind with EACCES — derive a stable,
   *  per-root pipe name instead. Both the server (`listen`) and the shim
   *  (`createConnection`) read this same value, so they stay in sync. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\agflow-${id}`;
    }
    return join(root, 'hooks.sock');
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }
  /** The proxy-bridge sidecar (qwen). Pure-Node loopback reverse-proxy that
   *  observes a hookless CLI's LLM traffic and synthesizes the same HIVE_SOCK
   *  payloads the hook shims emit. Written in ensureHive alongside cth-hook.cjs. */
  private proxyShimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'hive-proxy.cjs') : null;
  }

  /**
   * The BUNDLED-NODE launcher: `<root>/bin/hive-node` (POSIX) / `hive-node.cmd`
   * (Windows). Every `.cjs` shim in the hive is executed through it.
   *
   * Why it exists: hooks are run by the agent CLI through a plain
   * `/bin/sh -c` with a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A user whose
   * node comes from nvm (PATH set only by an interactive login shell) has NO node
   * there, so a hook written as `node "<shim>"` exits **127 — command not found**
   * and every payload is silently lost: no live status, no Stop→inbox drain, no
   * session ids. Electron's own binary IS a full Node runtime under
   * `ELECTRON_RUN_AS_NODE=1`, and it is guaranteed present (it is us).
   *
   * A wrapper SCRIPT rather than an inline `ELECTRON_RUN_AS_NODE=1 "<exe>" …`
   * prefix because that prefix is POSIX-sh syntax — it is a hard error under
   * cmd.exe, which is what runs hook commands on Windows. The wrapper also gives
   * agents a `$HIVE_NODE` they can invoke directly (running the Electron binary
   * WITHOUT the env var would launch a second app window, not a script).
   *
   * Rewritten on every bootstrap, so an app update/move re-bakes execPath.
   */
  private nodeLauncherPath(): string | null {
    const root = this.root();
    if (!root) return null;
    return join(root, 'bin', process.platform === 'win32' ? 'hive-node.cmd' : 'hive-node');
  }

  /** Write the launcher described above. Best-effort: on failure callers fall
   *  back to bare `node`, i.e. exactly the pre-fix behavior. */
  private writeNodeLauncher(): void {
    const p = this.nodeLauncherPath();
    if (!p) return;
    try {
      if (process.platform === 'win32') {
        writeFileSync(p, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`, 'utf8');
      } else {
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeNodeLauncher failed:', e);
    }
  }

  /** The launcher path if it is actually on disk, else null (→ callers fall back
   *  to bare `node`, i.e. exactly the pre-fix behavior — never worse than before). */
  private nodeLauncher(): string | null {
    const p = this.nodeLauncherPath();
    return p && existsSync(p) ? p : null;
  }

  /** The ABSOLUTE bundled-node command to BAKE into any text an agent is expected
   *  to run (`<launcher> <script> …`), falling back to bare `node`.
   *
   *  Exactly the value of the agent's `HIVE_NODE` env var — but agent-facing text
   *  must never spell it as `$HIVE_NODE`: that is POSIX shell syntax. A Windows
   *  agent runs its commands through cmd.exe/PowerShell, where `$HIVE_NODE`
   *  expands to NOTHING (cmd) or to an undefined variable (PowerShell), so every
   *  such instruction is dead on arrival there. The absolute path is correct on
   *  every platform and needs no expansion at all. */
  nodeCommand(): string {
    return this.nodeLauncher() ?? 'node';
  }

  /**
   * `<root>/bin/runtime` — the same bundled-node trick as `hive-node`, but the
   * wrapper is NAMED `node`, so anything that resolves `node` off PATH finds one.
   *
   * `hive-node` only covers commands WE generate. It does nothing for node that
   * the agent's own work needs at runtime: an MCP server declared as
   * `node ./server.js`, a provider CLI that shells out to node, a `.cjs` helper an
   * agent wrote itself. On a machine with no system node those all die with 127
   * exactly like the hooks did.
   *
   * This dir is APPENDED to the agent's PATH (see pty.spawn), never prepended: a
   * user who has their own node keeps their own version — we are strictly the
   * fallback. Prepending would silently swap every agent's node for Electron's
   * (20.18.1 as of Electron 32.3.3) underneath the user's own projects.
   *
   * NOTE: `node` only — deliberately no `npm`/`npx`. Electron bundles the Node
   * RUNTIME, not the npm CLI (which is ~12MB of JS we do not ship), so an `npm`
   * wrapper here could only be a stub that fails confusingly. A missing `npm` is
   * the honest signal; the install ladder (main/cliInstall.ts) detects it and
   * installs a REAL system Node — which brings npm with it. This shim is only the
   * last resort for when that install could not run (offline, or a platform with
   * no official installer).
   */
  runtimeBinDir(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'runtime') : null;
  }

  /** Write the `node` shim described above. Best-effort: on failure the dir is
   *  simply absent from PATH and behavior is exactly as before. */
  private writeRuntimeShims(): void {
    const dir = this.runtimeBinDir();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'node.cmd'),
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8'
        );
      } else {
        const p = join(dir, 'node');
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeRuntimeShims failed:', e);
    }
  }

  /** Build a hook command string that runs `script` under the guaranteed node,
   *  DOUBLE-QUOTED (safe for paths with spaces). */
  private nodeRun(script: string, ...args: string[]): string {
    const launcher = this.nodeLauncher();
    return [launcher ? `"${launcher}"` : 'node', `"${script}"`, ...args].join(' ');
  }

  /** Same, but UNQUOTED — only for configs or platforms that cannot preserve
   *  embedded quotes. POSIX JSON hook configs must use nodeRun() because the
   *  user-selected hive path may legitimately contain spaces. */
  private nodeRunUnquoted(script: string, ...args: string[]): string {
    return [this.nodeLauncher() ?? 'node', script, ...args].join(' ');
  }

  /** One proxy sidecar per live proxy-tier agent, keyed by agentId. Spawned in
   *  ensureAgent, killed on PTY exit / removeAgent / app quit (index.ts) — so a
   *  dead agent never leaks an orphan loopback listener. */
  private proxyChildren = new Map<string, ChildProcess>();

  // — bootstrap —

  /** Create the hive skeleton + git repo if missing. Idempotent. */
  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    for (const { filename, contents } of GENERATED_HIVE_DOCS) {
      const path = join(root, filename);
      if (!existsSync(path)) writeFileSync(path, contents, 'utf8');
    }

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const userCodexHome = join(homedir(), '.codex');
    for (const [id, agent] of Object.entries(this.registry().agents)) {
      const codexHome = join(root, 'agents', id, '.codex');
      if (agent.provider === 'codex' && existsSync(codexHome)) {
        this.exposeCodexDataDirs(codexHome, userCodexHome, id);
      }
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // Keep the churny/ephemeral live files out of the hive git repo.
    const gitignore = join(root, '.gitignore');
    // `crashes/` holds raw PTY output from abnormal agent exits. It is
    // DELIBERATELY ignored: that output is whatever the provider printed, which
    // can include tokens, paths and prompt fragments, and the hive repo is
    // committed on every change — a secret written there would be permanent.
    // log.jsonl gets the structured, non-sensitive fields; the dump stays local.
    const want = ['fleet.json', 'hooks.sock', 'cost-ledger.jsonl', 'crashes/', '.DS_Store'];
    let lines: string[] = [];
    if (existsSync(gitignore)) { try { lines = readFileSync(gitignore, 'utf8').split('\n'); } catch { lines = []; } }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length) writeFileSync(gitignore, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. Refreshed
    // on every bootstrap so it tracks code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');
    // The proxy-bridge sidecar for hookless CLIs (qwen). Same refresh policy.
    writeFileSync(this.proxyShimPath()!, PROXY_BRIDGE_SHIM, 'utf8');
    // The bundled-node launcher every shim above is invoked through — MUST be
    // written before any hook installer runs (they probe for it).
    this.writeNodeLauncher();
    // …and the PATH-visible `node` fallback for the agent's OWN subprocesses.
    this.writeRuntimeShims();

    if (!existsSync(join(root, '.git'))) {
      this.git(['init', '-q'], root);
      this.commit('hive: init');
    }
  }

  /** Deliberately replace generated hive docs with the bundled versions. */
  refreshGeneratedDocs(): void {
    const root = this.root();
    if (!root) return;
    for (const { filename, contents } of GENERATED_HIVE_DOCS) {
      writeFileSync(join(root, filename), contents, 'utf8');
    }
  }

  /** Validate an agent's cwd the way a spawn does — it must be an ABSOLUTE path
   *  that exists as a directory. Surfaced as `cwdValid` on the registry entry so
   *  the roster reliably exposes whether a worker's working directory is usable.
   *  Best-effort; never throws (a stat error degrades to invalid). */
  private cwdValidity(cwd: string | undefined): { valid: boolean; issue: string | null } {
    if (!cwd || typeof cwd !== 'string') return { valid: false, issue: 'missing' };
    // Defense-in-depth: a `~/…` cwd from an older registry entry (written before
    // ingestion-time expansion) would read as 'not-absolute' forever. Expand first
    // so the roster reports the truth about the directory the spawn would use.
    cwd = expandTilde(cwd);
    if (!isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
    try {
      return statSync(cwd).isDirectory()
        ? { valid: true, issue: null }
        : { valid: false, issue: 'not-a-directory' };
    } catch {
      return { valid: false, issue: 'missing-dir' };
    }
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (provider-specific args + env) that makes the process hive-aware.
   */
  async ensureAgent(
    meta: AgentMeta,
    opts: {
      semanticMemory?: boolean;
      knowledgeGraph?: boolean;
      /** ABSOLUTE path to the Knowledge-Graph CLI (`knowledge.env().KG_CLI`), baked
       *  into the agent's prompt instead of a `$KG_CLI` shell reference — `$VAR` is
       *  POSIX-only and expands to nothing under cmd.exe/PowerShell, so the KG
       *  instructions were unusable on Windows. Optional: undefined degrades to the
       *  old env-var spelling. */
      kgCliPath?: string;
      theme?: 'light' | 'dark';
      /** Consent state for the default-MCP bundle (W3). Threaded from the live
       *  HarnessConfig by the caller; undefined → catalog defaults apply. */
      mcpDefaults?: { [id: string]: { enabled: boolean } };
      /** App-resources `skills/` source dir (W3). The bundled read-only skills are
       *  copied into the agent's `.claude/skills/` per spawn; undefined or missing
       *  is a no-op (tolerated until Kevin populates the resource dir). */
      skillsDir?: string;
      /** Extra directories the agent's sandbox may write (e.g. the shared
       *  MemPalace dir, which `mempalace` mutates). Absolute paths; ignored
       *  for providers without a sandbox. */
      extraWritableDirs?: string[];
      /** OpenCode 2.x（桌面内置 CLI，真机实测）：插件契约不认 v1 事件名 →
       *  只建 per-agent 配置目录，不投放 v1 插件（见 installOpenCodePlugin）。 */
      opencodeV2?: boolean;
    } = {}
  ): Promise<SpawnInjection> {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHive();

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });

    // Resolve role BEFORE writing identity.md. A restart passes the floor
    // roster's `description`, which can be a status caption ("on standby").
    // identity.md and registry.role are the durable job from the hire.
    const reg = this.registry();
    const prev = reg.agents[meta.id];
    if (meta.cwd) meta = { ...meta, cwd: expandTilde(meta.cwd) };
    const role = preferredAgentRole(meta.role, prev?.role, !!meta.isGod);
    meta = { ...meta, role };

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta), 'utf8'); // refresh on each spawn

    // W3/P1-3 — bundled read-only skills: refresh each engine's OWN skill dir(s)
    // from the app-resources skills/ dir on every spawn (same policy as
    // identity.md), so an agent always rides with the shipped safe skill set.
    // P1-3: the drop targets are per-engine (OpenCode family also scans
    // `$OPENCODE_CONFIG_DIR/skills`, which spawn points at <agentDir>/.opencode for
    // the plugin bridge) — see shared/skillTargets.ts for the verified conventions.
    // Tolerant: a missing or partial source dir is a no-op.
    const skillDirs = opts.skillsDir ? skillDropDirs(meta.provider) : [];
    if (opts.skillsDir) for (const rel of skillDirs) this.copyBundledSkills(opts.skillsDir, join(dir, rel));
    // P0's promised fallback, landed here: engines whose native skill discovery is
    // absent or unverified get the bundled list + read path in the injected prompt.
    // Claude is left to its own discovery (the W3 copy above) — no extra line.
    const skillsLine = opts.skillsDir && meta.provider && meta.provider !== 'claude'
      ? bundledSkillsLine(join(dir, skillDirs[0]), this.bundledSkillIds(opts.skillsDir))
      : '';

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(memory, `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n`, 'utf8');
    }
    ensureMineIgnore(dir); // keep settings.json / cursor / messages out of mempalace's index
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry — spread the PRIOR entry first so a respawn preserves
    // fields the spawn `meta` doesn't carry, above all `sessionId`. Without this,
    // ensureAgent (which runs before the resume lookup in the pty:spawn handler)
    // would wipe the recorded session id, so `lastSession()` returns undefined and
    // `--resume` is never attached — i.e. every restart starts a fresh thread.
    // Validate the working directory at the source so a bad value is visible on
    // the roster (cwdValid) rather than silently spawning into a nonexistent dir.
    // Store the EXPANDED cwd, never the raw `~/…` the user typed — the registry is
    // read by hooks, the roster and the worker watcher, none of which run a shell.
    const cwd = this.cwdValidity(meta.cwd);
    reg.agents[meta.id] = {
      ...prev,
      ...meta,
      capabilities: meta.capabilities ?? prev?.capabilities ?? [],
      role,
      status: 'idle',
      cwdValid: cwd.valid,
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      archived: false,
      lastSeen: Date.now()
    };
    if (meta.isGod) reg.godId = meta.id;
    this.atomicWriteJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    // Only logs on an invalid cwd (rare) — not a per-spawn line, so no log spam.
    if (!cwd.valid) {
      this.appendLog({ kind: 'cwd_invalid', agentId: meta.id, cwd: meta.cwd, issue: cwd.issue });
    }
    this.commit(`hive: register ${meta.id}`);

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir
    };
    // The bundled-node launcher, so an agent can run the hive's .cjs helpers (KG
    // CLI, Slack reply helper) even when `node` is not on its PATH. Invoking the
    // Electron binary directly would open a second app window, so this must stay
    // the wrapper path and never process.execPath.
    //
    // Kept as an env var for agent CONVENIENCE and for anything that reads it
    // programmatically — but agent-facing TEXT no longer references it by name:
    // `$HIVE_NODE` is POSIX-only syntax and expands to nothing under cmd.exe /
    // PowerShell, so every such instruction was dead on a Windows floor. Commands
    // we write for an agent to run bake `nodeCommand()`'s absolute path instead.
    env.HIVE_NODE = this.nodeCommand();
    // Generic light/dark hint for TUIs that paint their own background. The app
    // defaults to light but every agent CLI assumed a dark terminal, so Crush and
    // OpenCode looked pasted into a light window. COLORFGBG is the classic
    // "fg;bg" convention (rxvt/konsole) that lipgloss/termenv fall back to when
    // an OSC 11 query gets no answer. Claude Code gets the same hint through its
    // per-session settings.json (hookSettings); Crush and OpenCode through their
    // per-agent config dirs below. A running TUI does not re-read this: new
    // agents pick up the current theme, running ones keep the one they started with.
    if (opts.theme) env.COLORFGBG = opts.theme === 'dark' ? '15;0' : '0;15';

    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');

    // Non-hive-aware providers (for example Antigravity, Codex, Grok and Pi) don't
    // understand Claude Code's flags (no `--append-system-prompt`, no telemetry,
    // no `--settings`). Instead: (1) the hive identity+protocol rides in as the
    // session's INITIAL prompt — the closest thing to `--append-system-prompt`
    // these CLIs offer (after the first turn the session continues normally); and
    // (2) lifecycle hooks are wired via the preset's `hookBridge` below. Together
    // that makes a Gemini/Codex worker a full hive citizen — live status +
    // Stop→inbox-drain — without Claude installed at all.
    //
    // How the prompt rides in differs by CLI:
    //  - agy takes it under a flag (`agy -i "<prompt>"`) → push [flag, prompt].
    //  - codex/grok/pi take it POSITIONALLY (`codex|grok|pi "<prompt>"`) → push the
    //    bare prompt as a trailing arg (node-pty passes argv literally, so it
    //    arrives as one positional argument after codex's own flags).
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag = preset.initialPromptFlag;
      const prompt = this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, skillsLine);
      // agy, codex, and grok expose a Claude-style lifecycle-hook surface, so each
      // gets the SAME live status + Stop→inbox-drain Claude does — selected by the
      // preset's `hookBridge`. agy needs a translating shim (its hook stdin/stdout
      // shape differs from Claude's); codex reuses the Claude `cth-hook` shim
      // verbatim (its hook payload + response contract are already Claude-shaped)
      // and is isolated to a per-agent CODEX_HOME so the user's global Codex
      // configuration is never mutated. Both share the HIVE_SOCK wiring below.
      const preArgs: string[] = [];
      let degraded: string | undefined;
      // Dispatch on the structured bridge descriptor (the foundation's `bridgeOf`
      // derives {kind:'hooks'} from the legacy `hookBridge` for agy/codex, and
      // returns the explicit {kind:'proxy'} for qwen). Two ways a hookless CLI
      // becomes a hive citizen:
      //   - 'hooks' → install a config-file hook shim (agy translator / codex verbatim).
      //   - 'proxy' → spawn a loopback reverse-proxy sidecar that observes the CLI's
      //               LLM traffic and SYNTHESIZES the same HIVE_SOCK payloads.
      const desc = bridgeOf(meta.provider);
      const sock = this.sockPath();
      if (desc && sock) {
        env.HIVE_SOCK = sock;
        try {
          if (desc.kind === 'hooks') {
            if (desc.shim === 'agy') this.installAgyHooks();
            else if (desc.shim === 'codex') {
              env.CODEX_HOME = this.installCodexHooks(dir, meta.id);
              // Codex refuses to run hooks from a config dir without persisted
              // "hook trust" (normally an interactive gate). Our hooks.json is
              // hive-authored inside an isolated CODEX_HOME, so we bypass that gate
              // for this automated spawn — the flag's documented use ("automation
              // that already vets hook sources"). Without it the hooks silently
              // never fire. Must precede the positional prompt.
              preArgs.push('--dangerously-bypass-hook-trust');
              // Auto mode keeps codex's OS sandbox (`-a never -s workspace-write`,
              // agentProvider.ts). workspace-write only covers cwd, so the agent
              // folder (inbox/.done, memory.md, outbox) and the shared hive root
              // (research deliverables, the board for god) are added as extra
              // writable roots. Harmless outside auto mode.
              for (const d of this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs)) preArgs.push('--add-dir', d);
            }
            else if (desc.shim === 'pi') {
              // Pi (earendil-works) has a rich pi.on(event) lifecycle. We drop a
              // bundled extension into a PER-AGENT PI_CODING_AGENT_DIR (so the user's
              // global ~/.pi is never touched) that posts cth-hook-shaped payloads to
              // HIVE_SOCK on tool_call/agent_end and auto-approves tools when the floor
              // is in auto mode. HIVE_AUTO_APPROVE (set in spawnAgentCore from
              // config.autoMode) gates the auto-allow — Pam guardrail #5.
              // LIVE-UNVERIFIED: the exact extension API surface needs BYOK keys to
              // prove; the renderer idle inbox-wake nudge is the guaranteed drain.
              env.PI_CODING_AGENT_DIR = this.installPiHooks(dir);
            }
            else if (desc.shim === 'opencode') {
              // OpenCode (anomalyco/opencode) has no Claude-shaped Stop hook, but its
              // plugin API exposes a real session.idle event (god Decision 1). We drop
              // a bundled plugin into a PER-AGENT OPENCODE config dir that posts
              // HIVE_SOCK payloads on tool.execute.before/after + session.idle — the
              // same Stop→drain semantics, provider-agnostic, no traffic interception.
              // 真机实测（2026-10）：投放 + 事件名在 npm v1 上成立；桌面内置 CLI v2
              // 会加载 plugin/ 目录但插件契约不同（加载即报 plugins failed、事件名
              // 不触发），故 v2 只建隔离配置目录、不投放 v1 插件——该发行线上的实时
              // 状态与收件箱唤醒走渲染端空闲 nudge 兜底。两种情况都设置
              // OPENCODE_CONFIG_DIR（v2 起 --standalone 后它会被读取，用于隔离
              // theme/模型等 per-agent 配置）。
              env.OPENCODE_CONFIG_DIR = this.installOpenCodePlugin(dir, opts.theme, opts.opencodeV2 === true);
            }
            else if (desc.shim === 'gemini') {
              // Point only this worker at a per-agent system settings file so
              // the bridge is trusted and ~/.gemini/settings.json stays untouched.
              env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = this.installGeminiHooks(dir);
            }
            else if (desc.shim === 'grok') this.installGrokHooks();
          } else if (desc.kind === 'proxy') {
            // Stable per-spawn session id, stamped on every synthesized payload so
            // recordSession (registry resume key) and the cost ledger persist.
            const spawnTs = String(Date.now());
            const sessionId = `proxy-${meta.id}-${createHash('sha1').update(root + meta.id + spawnTs).digest('hex').slice(0, 12)}`;
            env.HIVE_PROXY_SESSION = sessionId;
            // The CLI normally reads its upstream base URL from `baseUrlEnv`; capture
            // the user's configured value as the sidecar's UPSTREAM, then point the
            // CLI at the loopback proxy instead. Fall back to the cloud default if
            // the user hasn't set one.
            const upstream = process.env[desc.baseUrlEnv]
              || (desc.api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
            // A loopback bind on port 0 fails only transiently (a busy moment, a
            // slow sidecar start past the 4s ceiling), so try a few times before
            // giving up: without this ONE bad moment at spawn cost the agent its
            // hive events for the whole session.
            const port = await this.startProxyBridgeWithRetry(meta.id, { sock, sessionId, api: desc.api, upstream });
            // Only redirect the CLI through the proxy if the sidecar actually bound a
            // port. On failure leave routing untouched → the CLI talks to its real
            // upstream directly (degraded: no synthesized hive events, but it still
            // runs). Deliberate degradation is fine; SILENT degradation is not, so
            // the failure goes to log.jsonl, the renderer and the spawn result.
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
              if (meta.provider === 'crush') {
                // Crush has NO base-URL env override, so the generic env-rewrite is a
                // no-op for it. Route it instead via a per-agent CRUSH_GLOBAL_CONFIG
                // whose chosen provider's base_url points at the loopback proxy
                // (installCrushConfig — sibling of installCodexHooks). `upstream`
                // (captured above from the inert sentinel env or cloud default) is the
                // proxy's real target. Per-agent CRUSH_GLOBAL_DATA isolates session
                // state from the user's global ~/.config/crush.
                const crush = this.installCrushConfig(dir, loopback, desc.api, opts.theme);
                env.CRUSH_GLOBAL_CONFIG = dir;
                env.CRUSH_GLOBAL_DATA = crush.data;
              } else {
                env[desc.baseUrlEnv] = loopback;
              }
            }
            else {
              degraded = `${meta.name} 正在以「无蜂巢事件」模式运行：其代理桥接在 ${PROXY_BIND_ATTEMPTS} 次尝试后仍未绑定。本次会话中，实时状态、成本与收件箱唤醒将不可用。重新生成该智能体可重试。`;
              console.error(`[hive] ${meta.id} 的代理桥接未绑定——已按无蜂巢事件模式生成`);
              this.appendLog({ kind: 'proxy-degraded', agentId: meta.id, name: meta.name, provider: meta.provider, attempts: PROXY_BIND_ATTEMPTS });
              this.emit?.('hive:degraded', { agentId: meta.id, name: meta.name, reason: 'proxy-bind', message: degraded });
            }
          }
        } catch (e) { console.error(`[hive] install ${desc.kind} bridge failed:`, e); }
      }
      // Inject the protocol text whichever way the CLI accepts it.
      // type-into-tui (Crush): the bare TUI reads a positional as a Cobra subcommand
      // → `Unknown command`. So DROP the positional and hand the protocol back as
      // seedPrompt; the renderer types it into the TUI after boot (ondev-b).
      const deg = degraded ? { degraded } : {};
      if (preset.seedDelivery === 'type-into-tui') return { args: [...preArgs], env, seedPrompt: prompt, ...deg };
      // Providers with no declared seed strategy intentionally spawn bare. Inbox-capable
      // non-hive-aware presets are guarded by the provider contract tests.
      if (flag) return { args: [...preArgs, flag, prompt], env, ...deg };
      if (preset.positionalInitialPrompt) return { args: [...preArgs, prompt], env, ...deg };
      return { args: preArgs, env, ...deg };
    }

    // Stage 7A — first-party Claude Code telemetry → the embedded loopback OTLP
    // collector (telemetry.ts). Pure env, no --settings change. Only injected
    // for Claude Code once the collector is up (otelEndpoint set), so telemetry-
    // off installs and non-Claude providers spawn exactly as before.
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5s — near-live without spamming
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args: string[] = [];
    if (!claudeProvider) return { args, env };

    args.push('--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, skillsLine));

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      this.writeJson(settingsPath, this.hookSettings(shim, meta.cwd, opts.mcpDefaults, opts.theme, this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs)));
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /** Update the durable job string (hire role) without respawning. Refreshes
   *  registry.json + identity.md so the floor editor and the hive stay aligned. */
  patchAgentRole(id: string, role: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: '蜂巢未启用' };
    const next = role.trim();
    if (!next) return { ok: false, error: '岗位不能为空' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: '未知的智能体' };
      if (agent.role === next) return { ok: true };
      agent.role = next;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      writeFileSync(join(this.agentDir(id), 'identity.md'), this.identityText(agent), 'utf8');
      this.appendLog({ kind: 'role', agentId: id, role: next });
      this.commit(`hive: role ${id}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || agent.archived === archived) return;
      agent.archived = archived;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
      this.commit(`hive: ${archived ? 'archive' : 'unarchive'} ${id}`);
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /**
   * Move every unread message in an agent's inbox to inbox/.done — the agent has
   * finished with the whole mailbox (an ephemeral worker that signaled done), so
   * nothing left in it is pending any more. Workers rarely file their own work
   * order before signaling done, and a worker id is reused on every re-hire of
   * the same name (`worker-<request name>`), so without this each new incarnation
   * boots into its predecessors' stale orders: it is told to "work everything
   * still pending", spends its first turns re-triaging tasks its memory says are
   * finished, and the inbox-wake watchdog reads the oldest of those as mail that
   * has been unanswered for days.
   *
   * Only mail that was already there when the worker signaled done is finished
   * with: `before` is that signal's timestamp, and a message created after it
   * (a follow-up question from god that crossed the worker's done) is left in
   * place, still pending, for whoever picks the mailbox up next. Without the
   * cut-off such a message was filed as read and nobody ever saw it. Messages
   * whose `created_at` is unreadable fall back to the file's mtime.
   *
   * Returns what happened — how many were filed, how many were kept, and the
   * filed messages that asked for something (`request` / `query`), so the
   * caller can tell their sender that no answer is coming. Best-effort — never
   * throws, so the release path that calls it can't be crashed by a
   * half-written file.
   */
  settleInbox(id: string, before = Number.POSITIVE_INFINITY): SettledInbox {
    const out: SettledInbox = { moved: 0, kept: 0, unanswered: [] };
    const root = this.root();
    if (!root) return out;
    const inbox = join(root, 'agents', id, 'inbox');
    if (!existsSync(inbox)) return out;
    let files: string[];
    try { files = readdirSync(inbox).filter((f) => f.endsWith('.json')); } catch { return out; }
    if (files.length === 0) return out;
    const done = join(inbox, '.done');
    try { mkdirSync(done, { recursive: true }); } catch { return out; }
    for (const f of files) {
      const fp = join(inbox, f);
      let msg: Partial<HiveMessage> = {};
      try { msg = JSON.parse(readFileSync(fp, 'utf8')) as Partial<HiveMessage>; } catch { /* half-written: file it by mtime */ }
      let at = Date.parse(msg.created_at ?? '');
      if (!Number.isFinite(at)) { try { at = statSync(fp).mtimeMs; } catch { at = 0; } }
      if (at > before) { out.kept++; continue; }
      // A rename that fails (EPERM on a file another process holds) leaves the
      // message where it was — still pending, exactly the pre-settle state.
      try { renameSync(fp, join(done, f)); out.moved++; } catch { continue; }
      if (msg.act === 'request' || msg.act === 'query') {
        out.unanswered.push({
          id: msg.id ?? f, act: msg.act, from: msg.from ?? 'unknown', subject: msg.subject ?? '',
          conversation: msg.conversation ?? ''
        });
      }
    }
    if (out.moved > 0) {
      try {
        this.appendLog({ kind: 'inbox-settled', agentId: id, count: out.moved });
        this.commit(`hive: settle inbox of ${id} (${out.moved} unread)`);
      } catch { /* best-effort */ }
    }
    return out;
  }

  /**
   * Change an agent's display name without changing its durable identity.
   * The registry key, agent directory, session id, and every mailbox path remain
   * keyed by `id`; only the human-facing name is updated.
   *
   * `fleet.json` is patched in the same operation so god's next prompt receives
   * the new name immediately rather than waiting for the periodic fleet refresh.
   */
  /**
   * Put an agent on hold, or take it off, and tell 败龙 immediately.
   *
   * `fleet.json` is patched in the same operation for the same reason
   * `renameAgent` does it: god's roster is injected from that file on its next
   * prompt, and waiting up to 8s for the periodic refresh means one more
   * dispatch can still land on someone the human has just claimed.
   */
  setAgentHold(id: string, hold: boolean): { ok: boolean; onHold?: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: '蜂巢未启用（没有 harnessHome）' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: '找不到这个智能体' };
      if (!!agent.onHold === hold) return { ok: true, onHold: hold };

      agent.onHold = hold;
      this.writeJson(join(root, 'registry.json'), reg);

      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; onHold?: boolean }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) { row.onHold = hold; this.writeJson(fleetPath, fleet); }
          }
        } catch { /* fleet is a cache — the registry above is the record */ }
      }
      this.appendLog({ kind: 'agent-hold', id, onHold: hold });
      return { ok: true, onHold: hold };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  renameAgent(id: string, name: string): { ok: boolean; name?: string; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: '蜂巢未启用（没有 harnessHome）' };

    const nextName = name.trim();
    if (!nextName) return { ok: false, error: '名称不能为空' };

    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: '找不到这个智能体' };
      if (agent.name === nextName) return { ok: true, name: nextName };

      const previousName = agent.name;
      agent.name = nextName;
      this.writeJson(join(root, 'registry.json'), reg);

      // fleet.json is ephemeral and may not exist yet. When it does, keep its
      // display name in lockstep with the registry so rosterContext() is fresh.
      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; name?: string }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) {
              row.name = nextName;
              this.writeJson(fleetPath, fleet);
            }
          }
        } catch { /* periodic snapshot will repair a malformed/stale fleet file */ }
      }

      this.appendLog({ kind: 'rename', agentId: id, previousName, name: nextName });
      this.commit(`hive: rename ${id}`);
      return { ok: true, name: nextName };
    } catch {
      return { ok: false, error: '无法重命名智能体' };
    }
  }

  /**
   * Persist the agent's Claude Code session_id (Lane A #6.6a). Captured from hook
   * payloads; written only when it actually changes (a new session), so this is a
   * no-op on the vast majority of hook events. The id is the `--resume` key for
   * idempotent resume after a crash/restart AND the accounting/dedup key for cost
   * samples. Best-effort — never throws into a hook handler.
   */
  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return; // unknown agent or unchanged → no write
      agent.sessionId = sessionId;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session', agentId, sessionId });
      this.commit(`hive: session ${agentId}`);
    } catch { /* best-effort — never crash a hook handler */ }
  }

  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /** Claude Code settings that route every relevant hook through the shim, plus
   *  (W3) the default MCP bundle merged into this PER-SESSION settings file. cwd
   *  scopes the filesystem/git servers; cfg (the consent map) gates which servers
   *  are written. Claude-only — this is invoked solely on the Claude spawn path. */
  /**
   * Directories a sandboxed agent may write BESIDES its cwd: its own agent
   * folder (hive housekeeping) and the hive root (research deliverables; the
   * board and tasks.json for god; outbox delivery is done by main, not the agent).
   * This is what lets auto mode keep the OS sandbox on — the old full-bypass
   * posture existed only because these paths sit outside the project cwd.
   */
  private sandboxWritableDirs(meta: AgentMeta, dir: string, root: string, extra?: string[]): string[] {
    const out = [dir, root, ...(extra ?? [])].filter((d) => typeof d === 'string' && d.length > 0);
    return Array.from(new Set(out));
  }

  private hookSettings(shim: string, cwd: string, cfg: McpDefaultsMap, theme?: 'light' | 'dark', writableDirs: string[] = []): unknown {
    // Bundled node, NOT bare `node` — see nodeLauncherPath(). Claude runs each of
    // these through `sh -c` with a stripped PATH, where `node` is often absent.
    const cmd = this.nodeRun(shim);
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    const mcpServers = this.buildDefaultMcpServers(cwd, cfg);
    return {
      // Match the TUI's truecolor palette to the harness terminal theme —
      // PER SESSION, so the user's global Claude theme (their own terminals
      // outside the app) is never touched.
      //
      // 'auto', not the literal light/dark. Pinning the value matched the theme at
      // SPAWN and then ignored every change: Claude Code supports DEC 2031 theme
      // notifications, but a pinned theme has nothing to reconsider, so flipping
      // the app left a running agent painting its message blocks in the old
      // palette (black highlight on a cream terminal). 'auto' is the value that
      // listens. The terminal reports the current theme the moment the CLI enables
      // 2031, so startup still matches without pinning anything.
      ...(theme ? { theme: 'auto' } : {}),
      // W3 — default skills/MCP bundle. Written into the PER-SESSION settings file
      // only (never ~/.claude), so the user's own MCP servers are never clobbered;
      // Claude merges this additively. Omitted entirely when empty so a settings
      // file with no enabled servers is unchanged from before.
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      // The status line gets the session status JSON after every response —
      // including context_window.{total_input_tokens,context_window_size},
      // the only clean programmatic source for the session's REAL context
      // window. The shim prints a compact in-terminal gauge and forwards the
      // payload to the harness (agent-card context gauge, exact limit).
      statusLine: { type: 'command', command: `${cmd} --status`, padding: 0 },
      // Native OS sandbox for Bash subprocesses (macOS Seatbelt / Linux bubblewrap).
      // Auto mode spawns with `--permission-mode bypassPermissions`, which only
      // silences PROMPTS; the sandbox is a separate, opt-in layer that was never
      // switched on. Verified live (claude 2.1.239): with this block, bypass mode
      // still writes cwd and the listed dirs but `touch $HOME/x` fails with
      // "Operation not permitted". Two layers are needed: `sandbox.filesystem`
      // governs Bash children, `permissions.additionalDirectories` governs the
      // Edit/Write tools; with only one the agent deadlocks on its own inbox.
      // failIfUnavailable stays false: a platform without a sandbox (Windows)
      // runs as before rather than refusing to spawn.
      ...(writableDirs.length
        ? {
            sandbox: { enabled: true, filesystem: { allowWrite: writableDirs } },
            permissions: { additionalDirectories: writableDirs }
          }
        : {}),
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()],
        // #5C: surface mid-`/compact` so an agent boxing up its context reads as
        // 'compacting' on the floor instead of looking frozen.
        PreCompact: [entry()],
        PostCompact: [entry()]
      }
    };
  }

  /**
   * W3 — build the per-agent `mcpServers` map from the default catalog. Includes a
   * server only when it's enabled (catalog ∩ consent), scopes filesystem/git to the
   * agent cwd (never whole-disk), and namespaces every id `agflow-<id>` so a server
   * of the same name in the user's own ~/.claude is never clobbered. A write/secret
   * server is included ONLY on an explicit `enabled:true` consent — never via a
   * default — so a malformed/partial config can't silently arm a keyed server.
   */
  private buildDefaultMcpServers(
    cwd: string,
    cfg: McpDefaultsMap
  ): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
    const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
    for (const e of MCP_CATALOG) {
      const consented = cfg?.[e.id]?.enabled;
      const enabled = consented ?? e.defaultEnabled;
      if (!enabled) continue;
      // Defense-in-depth: a write/secret server requires an EXPLICIT opt-in; it can
      // never ride in on a default (the catalog already ships these OFF, but this
      // guards a hand-edited/partial mcpDefaults map too).
      if (e.tier !== 'safe-readonly' && consented !== true) continue;
      // Replace the `<cwd>` placeholder (filesystem/git) with the agent cwd at merge
      // time so these stay strictly workspace-scoped.
      const args = e.spec.args.map((a) => (a === '<cwd>' ? cwd : a));
      out[`agflow-${e.id}`] = {
        command: e.spec.command,
        args,
        ...(e.spec.env ? { env: e.spec.env } : {})
      };
    }
    return out;
  }

  /**
   * W3 — refresh an agent's bundled skills from the app-resources `skills/` dir.
   * Mirrors `identity.md`: overwritten every spawn so the shipped safe set tracks
   * the app. Best-effort and fully tolerant — a missing/empty source dir is a no-op
   * (Kevin populates the resource dir in lp-manifest), and any IO error is swallowed
   * so skill provisioning can never block a spawn.
   */
  private copyBundledSkills(srcDir: string, destDir: string): void {
    try {
      if (!existsSync(srcDir)) return;
      const copyTree = (from: string, to: string): void => {
        const entries = readdirSync(from, { withFileTypes: true });
        if (!entries.length) return;
        mkdirSync(to, { recursive: true });
        for (const ent of entries) {
          const s = join(from, ent.name);
          const d = join(to, ent.name);
          if (ent.isDirectory()) copyTree(s, d);
          else if (ent.isFile()) copyFileSync(s, d);
        }
      };
      copyTree(srcDir, destDir);
    } catch (e) { console.error('[hive] copyBundledSkills failed:', e); }
  }

  /** 内置技能 id 清单：resources/skills 下每个含 SKILL.md 的目录名（提示词兜底行用）。
   *  读不到源目录 → 空数组（该行随之消失，不让技能清单阻断注入）。 */
  private bundledSkillIds(srcDir: string): string[] {
    try {
      return readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(srcDir, e.name, 'SKILL.md')))
        .map((e) => e.name)
        .sort();
    } catch { return []; }
  }

  /**
   * W1 — start a proxy-bridge sidecar for a hookless proxy-tier agent (qwen).
   * Spawns `<root>/bin/hive-proxy.cjs` under Node, which binds a loopback port and
   * reports it back as a one-line `{"port":N}` on stdout. Resolves the bound port
   * (or 0 on failure, so the caller degrades gracefully without redirecting the
   * CLI). Idempotent: any prior sidecar for the agent is killed first, so a respawn
   * never leaks a listener. Tracked in `proxyChildren` for teardown.
   */
  /** startProxyBridge with a short retry ladder. Every attempt kills the previous
   *  sidecar first (startProxyBridge is idempotent), so a retry never leaks a
   *  listener. Resolves the bound port, or 0 once every attempt has failed. */
  private async startProxyBridgeWithRetry(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string }
  ): Promise<number> {
    for (let attempt = 1; attempt <= PROXY_BIND_ATTEMPTS; attempt++) {
      const port = await this.startProxyBridge(agentId, cfg);
      if (port > 0) return port;
      if (attempt < PROXY_BIND_ATTEMPTS) {
        console.warn(`[hive] proxy bridge for ${agentId} did not bind (attempt ${attempt}/${PROXY_BIND_ATTEMPTS}), retrying`);
        await new Promise((r) => setTimeout(r, PROXY_BIND_BACKOFF_MS[attempt - 1] ?? 1000));
      }
    }
    return 0;
  }

  private startProxyBridge(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string }
  ): Promise<number> {
    this.stopProxyBridge(agentId);
    const script = this.proxyShimPath();
    if (!script) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      let settled = false;
      const settle = (port: number): void => { if (!settled) { settled = true; resolve(port); } };
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            // Run the .cjs under Electron's bundled Node, not as a second app window.
            ELECTRON_RUN_AS_NODE: '1',
            HIVE_SOCK: cfg.sock,
            AGENT_ID: agentId,
            UPSTREAM_BASE_URL: cfg.upstream,
            HIVE_PROXY_SESSION: cfg.sessionId,
            HIVE_PROXY_API: cfg.api
          },
          // Read the port line from stdout; never inherit stdio (the sidecar must
          // never write into the agent's terminal or leak request bodies to a log).
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch (e) {
        console.error(`[hive] startProxyBridge spawn failed for ${agentId}:`, e);
        return settle(0);
      }
      this.proxyChildren.set(agentId, child);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (settled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (typeof msg.port === 'number' && msg.port > 0) settle(msg.port);
          else settle(0);
        } catch { settle(0); }
      });
      child.on('error', () => settle(0));
      child.on('exit', () => {
        if (this.proxyChildren.get(agentId) === child) this.proxyChildren.delete(agentId);
        settle(0); // never hang the spawn if the sidecar dies before reporting
      });
      // Hard ceiling: if the sidecar never reports a port, degrade rather than hang.
      setTimeout(() => settle(0), 4000).unref?.();
    });
  }

  /** Kill the proxy sidecar for an agent, if any. Idempotent; never throws. */
  stopProxyBridge(agentId: string): void {
    const child = this.proxyChildren.get(agentId);
    if (!child) return;
    this.proxyChildren.delete(agentId);
    try { child.kill(); } catch { /* already gone */ }
  }

  /** Kill every live proxy sidecar (app quit). Best-effort. */
  stopAllProxyBridges(): void {
    for (const id of [...this.proxyChildren.keys()]) this.stopProxyBridge(id);
  }

  /**
   * Drain an agent's inbox for the Stop hook. Returns whether to block-to-continue
   * and the message text to feed back. Uses the per-agent cursor so a message is
   * surfaced exactly once (no infinite loop).
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.atomicWriteJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [来自 ${m.from}，${m.act}] ${m.subject}：${m.body}`).join('\n');
    const reason = [
      `你的收件箱里有 ${fresh.length} 条新的蜂巢消息。完成手头工作之前先处理它们：`,
      lines,
      // Native separators (join, not string-concatenated `/`) so a Windows agent is
      // handed a path its own shell/tools accept, not `C:\…\agents\god/inbox/`.
      `完整内容见 ${join(dir, 'inbox')} 下的文件；逐条处理完，把已处理的移进 ${join(dir, 'inbox', '.done')}。需要回复的消息通过你的 outbox 回复。`
    ].join('\n');
    return { block: true, reason };
  }

  // — agent-facing text —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? '总控（god）' : '智能体')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- 你是本蜂巢工作区的 **总控 / 统筹者（god / orchestrator）**。你打理整个楼层——掌握全队的动态，把执行分派出去，只亲自拍板重要的事（任务拆解、验收签署、冲突调解、集成合并），不做苦力活。' : '',
      meta.isGod ? '- 用 `fleet.json`（每个智能体的实时状态/令牌/成本/熔断等级）与 `registry.json` 监控团队；完整命令参考见 `COMMANDS.md`。`claude agents` 不会列出你蜂巢工作区里的同伴智能体。' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  /**
   * The system-prompt prefix injected into every spawn via --append-system-prompt.
   *
   * 🔒 PROMPT-CACHE INVARIANT — keep this prefix VOLATILE-FREE. It interpolates
   * only values stable for an agent's whole lifetime (name, id, dir, root,
   * semanticMemory). Do NOT add dates, UUIDs, counters, board/registry state, or
   * any `Date.now()`-derived text here: a prefix that changes per spawn defeats
   * Anthropic's prompt cache (re-priming the whole system prompt every turn).
   * Volatile context belongs on the live channels — the inbox (hive messages) and
   * the PTY — never baked into this prefix. (Lane A #6.1.)
   *
   * 🪟 NO SHELL SYNTAX. Every path and command here is written the way the AGENT
   * will actually type it, on the platform it is running on. That rules out two
   * habits that were silently Windows-only breakage:
   *  - `$VAR` — POSIX-only. Under cmd.exe `$HIVE_NODE`/`$KG_CLI` expand to nothing
   *    and under PowerShell to an undefined variable, so those instructions were
   *    dead on every Windows floor. Bake the ABSOLUTE resolved path instead: it is
   *    platform-independent, needs no expansion, and stays prompt-cache-stable.
   *  - `'…' + '/inbox/'` — string-concatenating separators told a Windows agent to
   *    read `C:\Users\x\hive\agents\god/inbox/`. Use join() so the agent's own
   *    tooling gets a path it can pass straight to its shell.
   */
  private injectedPrompt(
    meta: AgentMeta,
    dir: string,
    root: string,
    semanticMemory: boolean,
    knowledgeGraph: boolean,
    kgCliPath?: string,
    skillsLine = ''
  ): string {
    // Native-separator path helpers — see the 🪟 note above.
    const inDir = (...parts: string[]): string => join(dir, ...parts);
    const inRoot = (...parts: string[]): string => join(root, ...parts);
    // Resolved ONCE here, at THIS agent's own spawn — same prompt-cache-stable
    // shape as name/id/dir/root above it, not a live re-read on every turn.
    // Needed for the PREP ASSISTANT persona and every WORKER's fallback line,
    // which refer to god by name in prose; god's own prompt already gets its
    // name via `meta.name`. A rename lands on the next spawn (spawn-time read).
    const godRegistry = meta.isGod ? null : this.registry();
    const godNameForPrompt = godRegistry
      ? resolveGodName(godRegistry.agents[godRegistry.godId ?? 'god']?.name)
      : '';
    const ctxLine = '实时上下文：实时花名册里每个智能体都带一个 `ctx NN%` 标记——它的上下文窗口占用率。派活时把它当作真实的余量信号：大任务优先给 `ctx` 低的智能体；`ctx` 接近 100% 的要当成忙碌而不是空闲，即使累计令牌数看起来不大。';

    const memoryLine = semanticMemory
      // The palace location is named, not spelled as `$MEMPALACE_PALACE_PATH`:
      // `mempalace` reads that env var itself, and the POSIX `$` form was noise
      // (or an empty expansion) for a Windows agent that tried to use it literally.
      ? '语义记忆：整个蜂巢工作区共享一座可检索的记忆宫殿（MemPalace），路径在你的 MEMPALACE_PALACE_PATH 环境变量里。想跨团队召回相关的历史知识，运行 `mempalace search "<查询>"`；任务开始时先运行 `mempalace wake-up` 拿一份记忆摘要。你写在 memory.md 里的笔记会自动汇入记忆宫殿——把长期有效的事实写在那里。'
      : '';
    // Enterprise Knowledge Graph (opt-in). Volatile-free: the bundled-node launcher
    // and the KG CLI are both fixed absolute paths for an install, so baking them
    // keeps the prefix prompt-cache-stable while making the command runnable in
    // cmd.exe/PowerShell as well as a POSIX shell.
    const hiveNode = this.nodeCommand();
    const kgCli = kgCliPath || (process.platform === 'win32' ? '%KG_CLI%' : '$KG_CLI');
    const knowledgeLine = knowledgeGraph
      ? `企业知识：本组织有一套私有的知识图谱，收录自己的文档、制度与业务背景。任务需要这些上下文时——公司特有的事实、行文规范、内部流程——去查它，不要猜：运行 \`"${hiveNode}" "${kgCli}" search "<查询>"\` 取按相关度排序的段落，\`"${hiveNode}" "${kgCli}" list\` 看有哪些可用，\`"${hiveNode}" "${kgCli}" get <id>\` 读整篇文档。（最前面这份 Node 是 AgFlow 自带的运行时，请用它，不要用裸 \`node\`——它不一定在你的 PATH 里。）`
      : '';
    // Item 13: state the build. Agents had no way to tell which version, or even
    // which KIND of build, they were running inside, so anything that varies
    // between a packaged app and a local dev run (umask being the one that bit
    // us) was invisible to every investigation.
    const rt = this.runtimeInfo();
    const runtimeLine = rt
      ? `运行版本：AgFlow v${rt.version}，${rt.packaged ? '打包应用' : '本地开发版'}${rt.appPath ? `，来自 ${rt.appPath}` : ''}。被问到运行的是哪个版本就照此回答，不要拿旧版本的行为做假设。本地开发版会继承启动它的 shell 的环境（含 umask），打包应用不会，所以两者的文件权限与继承环境可以合理地不同。\`log.jsonl\` 每次启动都会记一条 \`app-start\` 事件，用它分辨重启或切换构建。`
      : '';
    // Item 11: god could not find the spawn queue. The mechanism has worked since
    // v0.4.4, but nothing told him it existed — the prompt said "spawn" without
    // saying how, COMMANDS.md and PROTOCOL.md did not mention it, and the only
    // description lived in a source comment. So he fell back to writing a hire
    // manifest, which needs a human to click confirm, and it looked like nothing
    // happened. Gated on the toggle: advertising a disabled path is worse than
    // saying nothing, and COMMANDS.md documents it either way for the case where
    // the operator turns it on after god was already running.
    const spawnQueueLine = meta.isGod && this.orchestratorMaySpawn()
      ? `生成临时工：你可以自己启动一个临时智能体——往 ${inRoot('spawn-requests')}/<id>.json 写一个 JSON 文件即可。必填：\`objective\`（这个工人要做什么）与 \`cwd\`（它在哪个仓库里跑）。可选：\`name\`、\`command\`（覆盖提供方的默认命令）、\`provider\`（省略 command 时用它挑默认 CLI）、\`model\`、\`isolate\`（默认 true = 给它一个独立的 git worktree）、\`tokenCap\`、\`slack\`（{channel, thread_ts}，把它的失败回传到某个话题）。AgFlow 会轮询这个目录，生成 \`worker-<id>\`，成功时把请求移到 \`spawn-requests/.done/\`，失败时移到 \`.failed/\` 并附上原因。这是你唯一能独立完成的生成方式；research/hires/ 下的雇佣清单需要人类在界面上确认，不是你一个人能走通的路径。先按上面说的复用现有智能体——每生成一个工人，都是一笔新的开销。`
      : '';
    const godLine = meta.isGod
      ? '你是这个蜂巢工作区的总控智能体（GOD / ORCHESTRATOR）——你的职责是统筹调度，不是亲自实现：保持实时态势感知，把工作分派出去。(1) 感知——始终知道正在发生什么：对每个智能体（在岗 / 已归档 / 空闲）、任务看板与所有在办工作了如指掌；持续清空自己的收件箱，处理其他智能体的每一个请求，把疑问答复清楚，让团队自主运转。(2) 分派——把工作拆解后通过收件箱扇出给蜂巢里的智能体（转发消息、指定负责人；不要替他们干活）；不要自己去做苦力实现。要清楚谁已经在楼层上，机会主义地派活：在生成任何新智能体之前，先查实时花名册（registry.json 里的在岗智能体 + fleet.json 里它们的状态），优先把活路由给已有的合适智能体——尤其是请求里点名的时候（「让 Pam 去…」「让 Jim…」），就派给那个人，别条件反射式地新建一个。复用空闲或已在运行、角色匹配的智能体；只有当现有智能体都不合适时才新建，并说明你已经查过。一个能干的人胜过两个重复的人。(3) 只亲自抓重要的、高杠杆的事——任务拆解、派发决策、验收签署、冲突调解、分支合并与最终质检——并且始终是 board.md 唯一的执笔人。除此之外你完全自主——没有单独的审批队列。真正关键的事（破坏性操作、花真钱、范围变更、无法调和的冲突），直接在你自己的会话里问人类，让工具权限提示来把关；人类会就地批准，也可以通过 /remote-control 在手机上远程批准。保持团队不被阻塞。派发任务时，写成四段式契约，让智能体能自主执行：(1) 目标——具体要达成什么；(2) 产出——预期的交付物与格式；(3) 工具——用什么、避开什么，以及该先读哪些参考而不是重新推导；(4) 边界——范围限制 + 完成标准。传引用（文件路径、消息 id、看板章节），不要粘贴内容——派发要短。'
        + ` 通过读 ${inRoot('fleet.json')}（每个智能体的实时令牌、成本、状态、最近一次工具、熔断等级、收件箱积压）与 ${inRoot('registry.json')} 来监控楼层——注意运行 'claude agents' 不会列出蜂巢工作区里的同伴智能体。完整的 Claude Code 命令参考在 ${inRoot('COMMANDS.md')}（slash 命令只作用于你自己的会话；CLI 命令在你的 shell 里跑，可以作用于整个机队）。你会周期性地收到调度器发来的「心跳」例会请求——每收到一次，就用 fleet.json 逐个检查智能体，把卡住的、超预算的、熔断已触发的重新叫起来，并保持 board.md 与 tasks.json 的准确。在 tasks.json 里，派发的当下就必须把每张任务的 "assignee" 设成执行者智能体的 id，之后状态变化也绝不清空——已完成的卡片也要看得出是谁做的（人类是按「谁做了什么」来看板的）。人类反馈在这套账本里是一等公民：当一张任务卡只有靠人类的输入才能推进——一个需要回答的问题，或一件只有人类能做的动作（注册账号、批准采购、提供凭据/截图、在他们的设备上测试）——把它的状态设为 "blocked"，并把具体的请求追加到卡片的 "humanQA" 数组（push {"q":"...","askedAt":"<iso>"}；动作要写成清晰的待办；保留每一条历史记录——这段记录就是这张卡片的决策史）。请求要写得短，用 Markdown。人类是在卡片上读它，不是在终端里，所以超过一小段话加选项（大约 700 字）的请求是报告，不是问题——砍掉叙述，留下决策。开头用一句 **加粗** 的话说清楚到底需要他们做什么；路径、命令、取值与标识符放进 \`反引号\`；每个选项或步骤各占一行，用 "-" 项目符号或 "1." 编号；段落之间空一行（单个换行只算换行，这样每个选项才能各占一行）。请求源自其他智能体的汇报时，把它改写成这个形状——绝不把汇报正文原样当作问题，也绝不让人类读完整篇调查才找到决策点。AgFlow 会把未决问题展示在办公室楼层的 ASK ME 看板上；人类的回答会写进同一条记录的 "a" 字段，同时作为一封收件箱消息送到你这里——读了它、照做，把卡片解锁让工作继续。不要把人类问题存进单独的文件（不要 HumanQuestion.md），也绝不要在自己会话里干等人类。管好令牌预算。`
      : meta.isAssistant
      ? `你是 ${godNameForPrompt} 的预处理助手。你会收到简短、有时含糊的指令（每条都以 "ENRICH TASK:" 开头）。对每一条：(1) 判断它涉及哪个项目，cd 到最相关的仓库——你的起点是 ${godNameForPrompt} 的主目录；(2) 以只读方式收集具体上下文（确切的文件路径、当前状态、相关代码、约定、当前分支、坑点）——绝不修改、创建或删除文件；(3) 把指令改写成一条清晰、自洽、${godNameForPrompt} 能自主执行的提示词，保留用户的原始意图，不要自行发明范围。然后交付它：往你的 outbox 里写一个消息 JSON，"to":"god"，"act":"request"，一个简短的 subject，正文就是改好的提示词。不要自己去执行任务——你唯一的产出就是发给 ${godNameForPrompt} 的改进版提示词。`
      : `遇到任何含糊、跨部门或需要签署的事，写一封消息发给 "god"（总控：${godNameForPrompt}）。`;
    // 总控人设（P1-4）：只在用户设了风格/策略时出现；默认值=空行，被下面的
    // filter(Boolean) 丢掉——提示词与旧版逐字相同。
    const personaLine = meta.isGod ? buildGodPersonaPrompt(this._godPersona) : '';
    const guardrailsLine = '护栏：熔断机制在盯着整个楼层——收到「熔断机制：引导」或「熔断机制：限制」的消息，说明你在循环或超支：立即停止重复，总结你试过什么，并照它执行。要节省令牌（楼层级或按智能体的令牌预算都可能把你暂停）。共享计划分两部分：board.md（自由叙述；只有总控可以执笔）与 tasks.json（结构化看板——todo/doing/blocked/done）。';
    const slackLine = meta.isGod
      ? 'SLACK 回复：撰写 Slack 回复（或填写 Slack 来源任务卡的 `result` 字段）时，必须：(1) 直接回应对方问的事——绝不用一句光秃秃的 "done"；(2) 带上相关的具体情况、结果与细节；(3) 按 Slack mrkdwn 排版——开头一句 *加粗* 短标题，多项内容用项目符号，代码/路径用 `反引号` 包起来，保持简洁（不要大段文字）。完成 Slack 来源的任务时，务必在任务卡上写一条完整、面向用户、排版良好的 `result`——系统会把它原样发到 Slack 作为完成回复。'
      : `SLACK 回复：如果总控派给你一个来自 Slack 的任务，消息里会带上确切的 \`"${hiveNode}" "<helper>" --channel … --thread … --text "…"\` 回复命令——做完后原样运行它，把结果自己发回那个话题。回复必须是言之有物的 Slack mrkdwn（一句 *加粗* 短标题 + 实际结果/细节/链接），绝不只是 "done"。`;
    return [
      `你是 "${meta.name}"（${meta.id}），一个协作型智能体蜂巢工作区中的自主智能体。`,
      `你的私人工作目录是 ${dir}。共享的蜂巢工作区是 ${root}。完整协议：${inRoot('PROTOCOL.md')}。`,
      '',
      '蜂巢工作区协议——每个任务都照做：',
      `1. 任务开始时，先读 ${inDir('memory.md')} 和 ${inDir('inbox')} 里的每一个文件（其他智能体发给你的消息）。处理完一条收件箱消息后，把文件移进 ${inDir('inbox', '.done')}。`,
      `2. 把长期有效的事实、决策与上下文追加到 ${inDir('memory.md')}。`,
      `3. 要请求别的智能体做事或分享信息，往 ${inDir('outbox')} 写一个消息 JSON（schema 见 PROTOCOL.md）。绝不写入其他智能体的目录——总控会投递你的 outbox。`,
      '4. 任务结束时，把你学到的东西追加到 memory.md，让以后的你记得。',
      guardrailsLine,
      memoryLine,
      knowledgeLine,
      skillsLine,
      godLine,
      personaLine,
      spawnQueueLine,
      runtimeLine,
      slackLine,
      ctxLine,
      `可用环境变量：AGENT_ID、AGENT_NAME、HIVE_ROOT、AGENT_DIR。`
    ].filter(Boolean).join('\n');
  }

  // — messaging —

  /** Normalize a partial message into a full HiveMessage. */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      // hops is harness-owned (PROTOCOL.md: "The harness fills in `id`, `from`,
      // `hops`, and timestamps"), so an agent-authored value is only a carried
      // count, never authoritative. Clamp it into range: an echoed relay must
      // keep climbing toward the cap, while a copied-forward `hops: 13` must
      // not read as a runaway loop (only a harness bounce moves the counter —
      // see bounceToGod). A negative value would just buy more free bounces,
      // so the floor is 0.
      hops: Math.max(0, Math.min(typeof partial.hops === 'number' ? partial.hops : 0, HOP_CAP)),
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString()
    };
  }

  /** Atomically deliver a message into a recipient agent's inbox.
   *  Returns false when the recipient has no inbox, so the caller can bounce and
   *  log the drop rather than let the message vanish. */
  private deliver(msg: HiveMessage, toId: string): boolean {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return false; // unknown recipient — the caller reports it
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
    return true;
  }

  /** One harness bounce of `msg` to god: bump the hop counter, rewrite the
   *  subject, and log the drop once the counter passes HOP_CAP. Agents can't
   *  move hops past the cap themselves (normalize clamps what they wrote), so
   *  this fuse can only fire on a REAL relay loop — a bounced mail that keeps
   *  coming back undeliverable — and never on an agent-authored number. */
  private bounceToGod(msg: HiveMessage, godId: string, subject: string): void {
    const hops = msg.hops + 1;
    if (hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    this.deliver({ ...msg, hops, to: godId, subject }, godId);
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    const targets = msg.to === 'broadcast'
      // The roster for fan-out is the ACTIVE registry: skip the send-only prep
      // assistant and any archived agent (closed tab). Hookless providers are
      // NOT skipped — the per-target path below already serves them a terminal
      // work order, so excluding them here only made a broadcast invisible to an
      // agent that direct mail reaches fine. See selectBroadcastTargets.
      ? selectBroadcastTargets(reg.agents, msg.from)
      // Never deliver to self — guards a god → "human" message looping back to god.
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    // Targets that actually took delivery. The log below reports these instead of
    // intent, so a bounced or dropped message can never read as delivered.
    const delivered: string[] = [];
    for (const t of targets) {
      // The send-only prep assistant must never be a delivery target: it doesn't
      // drain an inbox, so direct mail to it would rot unread (observed live: a
      // task brief plus the follow-up reprimand about the unread inbox, both
      // unread for hours). Bounce such mail to god instead, so the sender's intent
      // surfaces immediately and nothing is silently lost.
      if (reg.agents[t]?.isAssistant) {
        this.bounceToGod(msg, godId, `[已退回——"${t}" 是只发不收的预处理助手；请把工作交给真正的智能体] ${msg.subject}`);
        continue;
      }
      // An ARCHIVED recipient (its terminal is gone) still has an inbox, so the
      // mail lands there and reads as delivered — and stays unread. Filing it
      // is right: a worker re-hired under the same id reads it on its first turn
      // (a released worker's inbox is settled only up to its done signal). But
      // the sender learned nothing, so god kept mailing dead agents for hours
      // (seen live 2026-08-16), and a request to a worker nobody re-hires was
      // simply lost. Now mail that expects an answer is filed AND its sender is
      // told, at once, that no one is there to answer it. Inform-only mail
      // (status, done, agree) is filed quietly. This comes BEFORE the provider
      // branches below on purpose: with no terminal there is nothing to hand a
      // work order to, whatever the engine — the inbox is the only place left.
      // The notice itself is ROUTED, not dropped into an inbox, so a sender on
      // a hookless or proxy-tier engine gets it the way it gets any mail.
      if (t !== godId && reg.agents[t]?.archived) {
        if (this.deliver(msg, t)) delivered.push(t);
        this.appendLog({ kind: 'archived-recipient', from: msg.from, to: t, id: msg.id, act: msg.act });
        const sender = reg.agents[msg.from];
        if (msg.requires_reply && sender && !sender.archived) {
          this.routeMessage(this.normalize({
            to: msg.from,
            act: 'inform',
            in_reply_to: msg.id,
            conversation: msg.conversation,
            hops: msg.hops + 1,
            requires_reply: false,
            subject: `[无人应答——"${t}" 已归档] ${msg.subject}`,
            body: `你发给 ${t} 的 ${msg.act} 已归入它的收件箱，但 ${t} 没有存活的终端（已归档），`
              + `所以只有当 ${t} 被恢复或以同一 id 重新雇佣时才会被读到。`
              + '如果这件事现在就要办，请把它路由给花名册上在岗的智能体，或雇一个新人。'
          }, 'system'));
        }
        continue;
      }
      // A provider without safe-idle lifecycle state (a hookless custom command)
      // would let direct mail rot unread. Claude and bridged Antigravity/Codex
      // receive directly into inbox/ for guarded renderer delivery. Otherwise try
      // a terminal work-order handoff to its REPL (#53);
      // if the renderer is unavailable, bounce to god to relay. God is exempt
      // (the bounce target).
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.bounceToGod(msg, godId, `[无法投递——"${t}" 运行的是 ${reg.agents[t]?.provider ?? '一个没有钩子的 CLI'}，终端交接失败（渲染进程不可用）；请代为转发] ${msg.subject}`);
        } else delivered.push(t);
        continue;
      }
      // 1d — proxy-tier providers (qwen) CAN receive inbox, but only via a
      // SYNTHESIZED Stop, which just advances the cursor — the sidecar observes the
      // CLI's stream and can't inject a drain reason back into its turn. So the real
      // mail rides the terminal work-order path verbatim, exactly like a hookless
      // provider; the synthesized Stop→drain keeps the cursor in step.
      const proxyDesc = bridgeOf(reg.agents[t]?.provider);
      if (t !== godId && proxyDesc?.kind === 'proxy' && proxyDesc.inboxDelivery === 'terminal') {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.bounceToGod(msg, godId, `[无法投递——"${t}" 运行的是 ${reg.agents[t]?.provider ?? '一个代理层 CLI'}，终端交接失败（渲染进程不可用）；请代为转发] ${msg.subject}`);
        } else delivered.push(t);
        continue;
      }
      if (this.deliver(msg, t)) { delivered.push(t); continue; }
      // No agents/<t>/inbox — an id that isn't on the floor. This was the one
      // delivery failure with neither bounce nor log, so the sender saw a routed
      // message and the mail simply ceased to exist. Record the drop beside the
      // hop-cap one and bounce to god, mirroring the undeliverable bounces above.
      this.appendLog({ kind: 'drop', reason: 'no-inbox', from: msg.from, to: t, id: msg.id });
      if (t !== godId) {
        this.bounceToGod(msg, godId, `[无法投递——这个楼层上没有名为 "${t}" 的智能体；请对照花名册检查 id] ${msg.subject}`);
      }
    }
    this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id, delivered });
    this.emitMessage(msg, targets);
    // Main-process observer (e.g. the closing-time controller watching for the
    // team's ACKs and the god's COMPLETE). Best-effort, never breaks routing.
    try { this.routedObserver?.(msg, targets); } catch { /* observer error */ }
  }

  /** Observer invoked for EVERY routed message with its resolved targets.
   *  Used by main-process features that react to hive traffic (closing time). */
  private routedObserver: ((msg: HiveMessage, targets: string[]) => void) | null = null;
  setRoutedObserver(cb: ((msg: HiveMessage, targets: string[]) => void) | null): void {
    this.routedObserver = cb;
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human'
    });
  }

  /** Non-Claude providers cannot drain hive inbox; hand direct mail to the
   *  renderer so it can queue a terminal work order for the target PTY. */
  private emitTerminalHandoff(msg: HiveMessage, targetId: string): boolean {
    const delivered = this.emit?.('hive:terminalHandoff', {
      id: msg.id,
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      body: msg.body,
      requiresReply: msg.requires_reply,
      createdAt: msg.created_at
    }) === true;
    this.appendLog({
      kind: 'terminal-handoff',
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered
    });
    return delivered;
  }

  // — router: drain outboxes → inboxes —

  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS. */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => {
      try { this.routeOnce(); } catch { /* keep the loop alive */ }
    }, intervalMs);
  }
  stopRouter(): void {
    if (this.routerTimer) { clearInterval(this.routerTimer); this.routerTimer = null; }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const raw = readFileSync(full, 'utf8');
          let partial: Partial<HiveMessage>;
          try {
            partial = JSON.parse(raw) as Partial<HiveMessage>;
          } catch {
            const repaired = repairLiteralLineBreaksInJsonStrings(raw);
            if (!repaired.changed) {
              this.appendLog({ kind: 'drop', reason: 'malformed-json', from: id, file: f });
              try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
              continue;
            }
            try {
              partial = JSON.parse(repaired.text) as Partial<HiveMessage>;
            } catch {
              this.appendLog({ kind: 'drop', reason: 'malformed-json', from: id, file: f });
              try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
              continue;
            }
            this.appendLog({
              kind: 'outbox-repair',
              from: id,
              file: f,
              repair: 'literal-line-break'
            });
          }
          const msg = this.normalize(partial, id);
          msg.from = id; // sender is authoritative — the owning directory
          this.routeMessage(msg);
          renameSync(full, join(outbox, '.sent', f)); // archive, don't reprocess
          routed++;
        } catch {
          // malformed file — quarantine so we don't spin on it
          try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
        }
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    return routed;
  }

  // — read helpers (for IPC / UI) —

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    return this.readJson<Registry>(join(root, 'registry.json'), { godId: null, agents: {} });
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }
  tasks(): unknown {
    const root = this.root();
    return root ? this.readJson(join(root, 'tasks.json'), { tasks: [] }) : { tasks: [] };
  }

  /** Persist the task ledger to hive/tasks.json and commit it. Mirrors the
   *  board/message persist pattern: write JSON, log the change, single-commit.
   *
   *  MERGES by card id instead of clobbering. Callers hold PARTIAL models of a
   *  card — the renderer's kanban parser knows nine fields, the god writes as
   *  many as the work needs (`result`, the verbatim Slack reply posted back to
   *  the user; `repo`; `scope`; `origin`; `commit`; …). A wholesale write meant
   *  one small edit through the UI deleted every unmodelled field on EVERY card
   *  on the board. Now an unmentioned field keeps its on-disk value.
   *
   *  Deleting a card still works: the incoming list IS the membership, so a card
   *  dropped from it (TasksKanban dismiss, the voice delete_task action) is
   *  gone. Merging protects fields, never card membership. */
  writeTasks(tasks: HiveTask[]): void {
    const root = this.root();
    if (!root) return;
    this.ensureHive();
    const path = join(root, 'tasks.json');
    const current = this.readJson<{ tasks?: unknown }>(path, { tasks: [] });
    const merged = mergeTaskLedger(current?.tasks, tasks);
    this.writeJson(path, { tasks: merged });
    this.appendLog({ kind: 'tasks', count: merged.length });
    this.commit(`hive: tasks (${merged.length})`);
  }

  /** Append one card against the latest on-disk ledger. Renderer callers must
   *  use this instead of re-writing a collection they read before another
   *  source (webhook, Slack, god, voice) added work. Idempotent by task id. */
  addTask(task: HiveTask): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    if (tasks.some((current) => current?.id === task.id)) return false;
    this.writeTasks([...tasks, task]);
    return true;
  }

  /** Patch one card against the latest on-disk ledger, preserving unrelated
   *  cards and fields (notably webhook.tokenHash and Slack thread metadata). */
  patchTask(id: string, patch: Partial<Omit<HiveTask, 'id'>>): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const index = tasks.findIndex((task) => task?.id === id);
    if (index < 0) return false;
    const next = tasks.slice();
    next[index] = { ...tasks[index], ...patch, id };
    this.writeTasks(next);
    return true;
  }

  /** Delete only the named card from the latest on-disk ledger. */
  deleteTask(id: string): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const next = tasks.filter((task) => task?.id !== id);
    if (next.length === tasks.length) return false;
    this.writeTasks(next);
    return true;
  }
  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  /** Whether an agent has recorded NON-TRIVIAL memory — i.e. has appended real
   *  notes beyond the boilerplate header ensureAgent seeds. Lets the voice
   *  read-layer answer "what has the team remembered" and enumerate who has
   *  anything worth reading (every registered agent technically has a memory.md,
   *  but most of the floor's history lives in a handful of them). Cheap: reads a
   *  small markdown file; never throws. Works for ANY id, active OR archived. */
  hasMemory(id: string): boolean {
    const p = join(this.agentDir(id), 'memory.md');
    if (!existsSync(p)) return false;
    try {
      // A fresh seed is ~90 chars (one header line + the prompt). Anything
      // meaningfully longer means the agent appended durable facts.
      return readFileSync(p, 'utf8').trim().length > 200;
    } catch { return false; }
  }
  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** Read an agent's OUTBOX (messages it has authored/sent). Symmetric with
   *  inbox(); the router drains live outbox files into recipients' inboxes and
   *  archives the original under outbox/.sent, so a sent message survives there. */
  outbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'outbox'));
  }

  /**
   * Voice read-layer: recent message CONTENT (inbox + outbox bodies) for the
   * operator briefing, REDACTED main-side. This is the message-content half of
   * the voice query surface (the activity half is logTail()).
   *
   * Modes:
   *   - { id }                → the single message with that id, wherever it lives.
   *   - { agentId }           → recent messages in that agent's mailbox only.
   *   - {}                    → recent messages across the whole floor, newest first.
   * `limit` caps the list (default 12, max 40); `includeArchived` (default true)
   * also reads the handled subfolders (inbox/.done, outbox/.sent).
   *
   * SECURITY: every subject + body is passed through redactSecrets() here, in
   * main, so no secret and no raw body ever crosses IPC. Delivered messages exist
   * in both the sender's outbox/.sent and the recipient's inbox/.done; we dedup
   * by message id so each appears once.
   */
  voiceMessages(opts: { agentId?: string; id?: string; limit?: number; includeArchived?: boolean } = {}): VoiceMessage[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];

    const wantId = typeof opts.id === 'string' ? opts.id.trim() : '';
    const onlyAgent = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    const includeArchived = opts.includeArchived !== false; // default true

    let owners: string[];
    try {
      owners = onlyAgent
        ? [onlyAgent]
        : readdirSync(agentsDir).filter((id) => !id.startsWith('.') && existsSync(this.agentDir(id)));
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const out: VoiceMessage[] = [];
    for (const owner of owners) {
      const base = this.agentDir(owner);
      const folders: Array<{ dir: string; direction: 'inbox' | 'outbox'; archived: boolean }> = [
        { dir: join(base, 'inbox'), direction: 'inbox', archived: false },
        { dir: join(base, 'outbox'), direction: 'outbox', archived: false }
      ];
      if (includeArchived) {
        folders.push({ dir: join(base, 'inbox', '.done'), direction: 'inbox', archived: true });
        folders.push({ dir: join(base, 'outbox', '.sent'), direction: 'outbox', archived: true });
      }
      for (const f of folders) {
        for (const m of this.listMessages(f.dir)) {
          if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
          seen.add(m.id);
          if (wantId && m.id !== wantId) continue;
          out.push({
            id: m.id,
            conversation: m.conversation,
            from: m.from,
            to: m.to,
            act: m.act,
            subject: redactSecrets(m.subject),
            body: redactSecrets(m.body),
            requires_reply: !!m.requires_reply,
            direction: f.direction,
            owner,
            archived: f.archived,
            created_at: m.created_at
          });
        }
      }
    }

    // Newest first by ISO created_at (lexicographic == chronological for ISO-8601).
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (wantId) return out.slice(0, 1);
    const lim = typeof opts.limit === 'number' && isFinite(opts.limit)
      ? Math.max(1, Math.min(40, Math.round(opts.limit)))
      : 12;
    return out.slice(0, lim);
  }
  /** Count undrained inbox messages for an agent (cheap — for the fleet snapshot). */
  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }
  /** Install the Antigravity (`agy`) lifecycle-hook bridge: write the normalizer
   *  shim and merge a `agflow-hive` hook group into agy's global hooks.json so a
   *  Gemini worker reports PreToolUse/PostToolUse/Stop/PreInvocation/PostInvocation
   *  to this HookServer (live status + guarded idle delivery), reusing the Claude pipeline.
   *
   *  Two agy-isms handled: (1) antigravity-cli#49 — agy LOADS hooks from
   *  `~/.gemini/antigravity-cli/hooks.json` but TRIGGERS from `~/.gemini/config/
   *  hooks.json`, so we write BOTH; (2) on Windows commands go to cmd.exe and
   *  agy mangles embedded quotes, so that platform retains the legacy form.
   *  Runtime-scoped by AGENT_ID (the shim no-ops for non-hive agy sessions), so
   *  this global config never disturbs the user's own `agy` usage. Best-effort,
   *  idempotent (only our own group is overwritten). */
  private installAgyHooks(): void {
    const root = this.root();
    if (!root) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    const command = (event: string) => process.platform === 'win32'
      ? this.nodeRunUnquoted(shim, event)
      : this.nodeRun(shim, event);
    const tool = (event: string) => ({
      matcher: '*',
      hooks: [{ type: 'command', command: command(event), timeout: 0 }]
    });
    const plain = (event: string) => ({
      hooks: [{ type: 'command', command: command(event), timeout: 0 }]
    });
    const group = {
      PreToolUse: [tool('PreToolUse')],
      PostToolUse: [tool('PostToolUse')],
      PreInvocation: [plain('PreInvocation')],
      PostInvocation: [plain('PostInvocation')],
      Stop: [plain('Stop')]
    };
    const gem = join(homedir(), '.gemini');
    for (const p of [join(gem, 'config', 'hooks.json'), join(gem, 'antigravity-cli', 'hooks.json')]) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        let existing: Record<string, unknown> = {};
        if (existsSync(p)) {
          try { existing = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { existing = {}; }
        }
        existing['agflow-hive'] = group;
        writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      } catch { /* best-effort per file */ }
    }
  }

  /** Official Google Gemini CLI lifecycle bridge. Gemini's hook payload is
   *  already snake_case; the shim maps event names into HookServer's common
   *  vocabulary and translates deny/steering replies back to Gemini.
   *
   *  The system settings path is per agent. Gemini merges object and array
   *  settings across layers, so auth and user settings remain in their normal
   *  GEMINI_CLI_HOME while this trusted bridge stays isolated. */
  private installGeminiHooks(dir: string): string {
    const home = join(dir, '.gemini-hive');
    const settingsPath = join(home, 'system-settings.json');
    try {
      mkdirSync(home, { recursive: true });
      const shim = join(home, 'gemini-hook.cjs');
      writeFileSync(shim, GEMINI_HOOK_SHIM, 'utf8');
      const hook = (name: string, matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        sequential: true,
        hooks: [{
          name: `agflow-hive-${name}`,
          type: 'command',
          command: process.platform === 'win32'
            ? this.nodeRunUnquoted(shim)
            : this.nodeRun(shim),
          timeout: 30000
        }]
      });
      const settings = {
        hooksConfig: { enabled: true, notifications: false },
        hooks: {
          SessionStart: [hook('session-start')],
          BeforeAgent: [hook('before-agent')],
          BeforeTool: [hook('before-tool', '.*')],
          AfterTool: [hook('after-tool', '.*')],
          AfterAgent: [hook('after-agent')]
        }
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installGeminiHooks failed:', e); }
    return settingsPath;
  }

  /** Codex lifecycle-hook bridge → full hive parity for a `codex` worker (live
   *  status + Stop→inbox-drain), the codex counterpart of installAgyHooks().
   *
   *  Codex's hook contract is already Claude-shaped: snake_case stdin
   *  (hook_event_name/tool_name/tool_input/session_id/cwd) and a matching response
   *  contract, where `Stop` honoring {decision:'block',reason} means "continue,
   *  using reason as the next prompt" — exactly what drainForStop() returns. So we
   *  reuse the Claude `cth-hook` shim VERBATIM (no translator, unlike agy) and let
   *  HookServer handle everything unchanged.
   *
   *  ISOLATION: rather than mutate the user's global Codex configuration (which
   *  also holds their login), we point this worker at a PER-AGENT CODEX_HOME
   *  (`<dir>/.codex`, alongside Claude's settings.json) holding our own config.toml
   *  with `[hooks]` tables — so the hooks fire ONLY for hive workers and a personal
   *  `codex` run is untouched. Rollout directories are linked into that isolated
   *  home from namespaced paths under the standard global scan roots. The user's
   *  ~/.codex/auth.json is linked in and their config.toml is copied + extended
   *  (login + model/provider/trust settings still apply).
   *  Returns the CODEX_HOME path for the caller to put in the worker's env. */
  private installCodexHooks(dir: string, agentId: string): string {
    const home = join(dir, '.codex');
    try {
      mkdirSync(home, { recursive: true });
      const userHome = join(homedir(), '.codex');
      // Symlink the user's login so the isolated home authenticates as them.
      // (config.toml is NOT symlinked — we write our own below, seeded from theirs,
      // because it must carry our [hooks] tables.) Fall back to copy where symlinks
      // need privilege (Windows). Idempotent — skip if already linked.
      const authSrc = join(userHome, 'auth.json');
      const authDest = join(home, 'auth.json');
      if (existsSync(authSrc) && !existsSync(authDest)) {
        try { symlinkSync(authSrc, authDest); }
        catch { try { copyFileSync(authSrc, authDest); } catch { /* best-effort */ } }
      }
      // The managed app-server daemon used by Codex Remote Control is launched
      // from the standalone install rooted at $CODEX_HOME/packages. Share the
      // user's installed binaries without duplicating them into every agent.
      const packagesSrc = join(userHome, 'packages');
      const packagesDest = join(home, 'packages');
      if (existsSync(packagesSrc) && !existsSync(packagesDest)) {
        try {
          symlinkSync(packagesSrc, packagesDest, process.platform === 'win32' ? 'junction' : 'dir');
        } catch { /* remote integration falls back to a local TUI if unavailable */ }
      }
      // Wire lifecycle hooks via config.toml `[hooks]` tables — the user-layer
      // discovery surface Codex actually scans. (A bare $CODEX_HOME/hooks.json is
      // plugin-scoped — referenced FROM a plugin manifest — and is NOT discovered
      // for a plain config dir; verified empirically that it never fires.) We seed
      // this config.toml from the user's (their model/provider/trust settings carry
      // over) and append a `[[hooks.<Event>]]` group per event, each pointing at the
      // SAME cth-hook shim — reused verbatim (Codex's hook payload + response are
      // already Claude-shaped, so HookServer/drainForStop run unchanged). Regenerated
      // each spawn (idempotent). Serialize the generated command as a TOML basic
      // string; JSON string escaping is compatible here and, on POSIX, preserves
      // the embedded quotes required when a user-selected hive path has spaces.
      // NOTE: hooks fire in INTERACTIVE codex sessions (how hive workers run),
      // not in headless `codex exec`.
      //
      // `timeout` IS SECONDS HERE — do NOT copy Claude's `timeout: 0` sentinel into
      // this file. Codex parses the key as `timeout_sec` and normalizes it with
      // `timeout_sec.unwrap_or(600).max(1)`, so 0 does not mean "no timeout": it is
      // floored to ONE SECOND, the shortest budget there is. That shipped through
      // v0.3.7 and made every codex worker log `SessionStart hook (failed) — hook
      // timed out after 1s` (same for UserPromptSubmit), because each hook cold-starts
      // the Electron binary via hive-node and then waits on hooks.sock — measured
      // 0.08-0.16s idle but 0.6-0.7s under 8 concurrent spawns, which is exactly what
      // session start and prompt dispatch look like. 30s clears that by two orders of
      // magnitude while still capping a wedged shim well before its own 5s internal
      // cap stops mattering; bare omission (600s) would leave a hang looking like a
      // freeze. Verify any change with codex's own resolver, no model spend:
      // `codex app-server` → initialize → `hooks/list` reports the normalized
      // timeoutSec per event.
      const shim = this.shimPath();
      let config = existsSync(join(userHome, 'config.toml'))
        ? readFileSync(join(userHome, 'config.toml'), 'utf8') : '';
      if (shim) {
        const events = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
          'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'];
        // Preserve the existing Windows .cmd shape: nested command quotes pass
        // through a different shell stack there (#350). The reported Codex bug
        // is POSIX, where ordinary shell quoting is both necessary and verified.
        const command = process.platform === 'win32'
          ? this.nodeRunUnquoted(shim)
          : this.nodeRun(shim);
        config += '\n# --- agflow-hive lifecycle hooks (auto-generated; do not edit) ---\n';
        for (const ev of events) {
          config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`;
        }
      }
      writeFileSync(join(home, 'config.toml'), config, 'utf8');

      // Keep each worker's CODEX_HOME isolated while putting its rollout data
      // below Codex's standard scan roots. External usage tools can then discover
      // the sessions without understanding the hive's private directory layout.
      this.exposeCodexDataDirs(home, userHome, agentId);
    } catch (e) { console.error('[hive] installCodexHooks failed:', e); }
    return home;
  }

  private exposeCodexDataDirs(home: string, userHome: string, agentId: string): void {
    for (const kind of ['sessions', 'archived_sessions'] as const) {
      try { this.exposeCodexDataDir(home, userHome, agentId, kind); }
      catch (e) { console.error(`[hive] exposeCodexDataDir(${kind}) failed:`, e); }
    }
  }

  private moveCodexDataDir(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      rmSync(from, { recursive: true, force: true });
    }
  }

  private exposeCodexDataDir(
    home: string,
    userHome: string,
    agentId: string,
    kind: 'sessions' | 'archived_sessions'
  ): void {
    const root = this.root();
    if (!root) return;
    if (!agentId || basename(agentId) !== agentId || agentId === '.' || agentId === '..') {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    const source = join(home, kind);
    const scanRoot = join(userHome, kind, 'agflow');
    const hiveId = createHash('sha1').update(root).digest('hex').slice(0, 12);
    const target = join(scanRoot, hiveId, agentId);

    let sourceStat: ReturnType<typeof lstatSync> | null = null;
    try { sourceStat = lstatSync(source); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

    if (sourceStat?.isSymbolicLink()) {
      let current: string | null = null;
      try { current = realpathSync(source); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        unlinkSync(source);
        sourceStat = null;
      }
      if (current) {
        const rel = relative(realpathSync(scanRoot), current);
        const scope = dirname(rel);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)
          && dirname(scope) === '.' && basename(rel) === agentId) return;
        throw new Error(`${source} points outside ${scanRoot}`);
      }
    }
    if (sourceStat && !sourceStat.isDirectory()) throw new Error(`${source} is not a directory`);

    mkdirSync(dirname(target), { recursive: true });
    if (sourceStat) {
      if (existsSync(target)) {
        if (readdirSync(target).length > 0) throw new Error(`${source} and ${target} both contain data`);
        rmSync(target, { recursive: true, force: true });
      }
      this.moveCodexDataDir(source, target);
    } else if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }

    try {
      symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (!existsSync(source) && existsSync(target)) {
        try { this.moveCodexDataDir(target, source); } catch { /* data remains at target */ }
      }
      throw e;
    }
  }

  /** Remove rollout directories moved under the user's standard Codex scan
   *  roots before a full hive reset removes the isolated CODEX_HOME links. */
  removeExposedCodexData(): void {
    const root = this.root();
    if (!root) return;
    const agents = join(root, 'agents');
    if (!existsSync(agents)) return;
    const userHome = join(homedir(), '.codex');

    for (const entry of readdirSync(agents, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const kind of ['sessions', 'archived_sessions'] as const) {
        const source = join(agents, entry.name, '.codex', kind);
        try {
          if (!lstatSync(source).isSymbolicLink()) continue;
          const target = realpathSync(source);
          const scanRoot = realpathSync(join(userHome, kind, 'agflow'));
          const rel = relative(scanRoot, target);
          const scope = dirname(rel);
          if (!rel || rel.startsWith('..') || isAbsolute(rel)
            || dirname(scope) !== '.' || basename(rel) !== entry.name) continue;
          rmSync(target, { recursive: true, force: true });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[hive] removeExposedCodexData failed:', e);
          }
        }
      }
    }
  }

  /** Pi (earendil-works) bridge. Pi has a rich `pi.on(event, …)` lifecycle but no
   *  Claude-shaped hook file; instead we drop a bundled EXTENSION into a PER-AGENT
   *  PI_CODING_AGENT_DIR (so the user's global ~/.pi is never mutated) that, when Pi
   *  loads it, posts cth-hook-shaped payloads to HIVE_SOCK on tool_call/agent_end and
   *  auto-approves tool calls when the floor is in auto mode (HIVE_AUTO_APPROVE).
   *  Emitting an `agent_end`→`Stop` keeps the harness status in step (→ idle), which
   *  lets the renderer idle inbox-wake nudge deliver mail. Returns the per-agent dir
   *  for PI_CODING_AGENT_DIR.
   *
   *  LIVE-UNVERIFIED: Pi's exact extension-discovery path + event API need BYOK keys
   *  to confirm; this is written best-effort and wrapped so a wrong guess can never
   *  break the spawn. The renderer nudge is the guaranteed drain regardless. */
  private installPiHooks(dir: string): string {
    const home = join(dir, '.pi-agent');
    try {
      // Pi discovers extensions under its agent dir; we write to the documented
      // `extensions/` location (and keep it isolated per agent).
      const extDir = join(home, 'extensions');
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, 'hive-bridge.js'), PI_EXTENSION, 'utf8');
      // A manifest so Pi auto-loads the extension on start (best-effort; harmless if
      // Pi ignores it). Kept minimal and hive-authored.
      const manifest = { name: 'agflow-hive-bridge', version: '0.3.2', main: 'extensions/hive-bridge.js', auto: true };
      writeFileSync(join(home, 'extensions.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const userPiDir = join(homedir(), '.pi', 'agent');
      for (const fileName of ['models.json', 'models-store.json'] as const) {
        try {
          const data = readFileSync(join(userPiDir, fileName), 'utf8');
          writeFileSync(join(home, fileName), data, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[hive] installPiHooks copy ${fileName} failed:`, e);
        }
      }
    } catch (e) { console.error('[hive] installPiHooks failed:', e); }
    return home;
  }

  /** OpenCode (anomalyco/opencode) bridge — god Decision 1 (native plugin, not proxy).
   *  OpenCode has no Claude-shaped Stop hook, but its plugin API exposes a real
   *  `session.idle` lifecycle event. We drop a bundled PLUGIN into a PER-AGENT config
   *  dir's `plugin/` folder (OpenCode auto-loads `*.js` plugins from there) that posts
   *  HIVE_SOCK payloads on tool.execute.before/after + session.idle — the same
   *  Stop→drain semantics as codex's hooks, provider-agnostic, no traffic interception.
   *  Returns the config dir for OPENCODE_CONFIG_DIR (isolates from ~/.config/opencode).
   *
   *  真机实测（2026-10，opencode-cli 2.0.27 桌面内置版）：`plugin/`、`plugins/`
   *  两个目录都会被扫描加载，但 v2 的插件契约不认这里的事件名（加载即报
   *  "plugins failed"、session.idle 不触发）。所以 v2 走 skipV1Plugin=true：
   *  只保留隔离配置目录（theme/模型等 per-agent 配置在 --standalone 下会被读取），
   *  不投放 v1 插件；该发行线的收件箱唤醒由渲染端空闲 nudge 兜底。 */
  private installOpenCodePlugin(dir: string, theme?: 'light' | 'dark', skipV1Plugin?: boolean): string {
    const home = join(dir, '.opencode');
    try {
      // Theme: OpenCode's `system` theme keeps the terminal's own fg/bg (xterm's,
      // which already follows the app theme) and builds its greys from the
      // detected background, so it reads right on light AND dark. Written to
      // tui.json (current builds) and opencode.json (older builds read `theme`
      // there and migrate it; the migration skips when tui.json already exists).
      // Per-agent dir only, the user's ~/.config/opencode is never touched.
      if (theme) {
        mkdirSync(home, { recursive: true });
        const choice = { theme: 'system' };
        writeFileSync(join(home, 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', ...choice }, null, 2), 'utf8');
        writeFileSync(join(home, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...choice }, null, 2), 'utf8');
      }
      // BOTH `plugin/` and `plugins/`. OpenCode's current docs specify `plugins/`
      // (plural); older builds — and the shape this bridge was originally written
      // against — auto-load from `plugin/` (singular). Writing the same ~2KB file
      // twice costs nothing and is idempotent.
      // v2（桌面内置 CLI，真机实测 2026-10）虽然也会扫这两个目录，但其插件契约
      // 不认 v1 的事件名——投放只会在 TUI 里报 "plugins failed"，故跳过（该发行线
      // 的兜底是渲染端空闲 nudge）。
      if (!skipV1Plugin) {
        for (const name of ['plugin', 'plugins']) {
          const pluginDir = join(home, name);
          mkdirSync(pluginDir, { recursive: true });
          writeFileSync(join(pluginDir, 'hive-bridge.js'), OPENCODE_PLUGIN, 'utf8');
        }
      }
    } catch (e) { console.error('[hive] installOpenCodePlugin failed:', e); }
    return home;
  }

  /** Crush (charmbracelet/crush) proxy routing. Crush has NO base-URL env override, so
   *  the generic proxy env-rewrite is a no-op for it; instead we write a per-agent
   *  CRUSH_GLOBAL_CONFIG whose standard providers' `base_url` all point at the loopback
   *  proxy (so whatever model the worker picks, its LLM traffic routes through the
   *  sidecar → synthesized Status/Stop/cost → status goes idle → the terminal
   *  work-order + renderer nudge deliver mail). A per-agent CRUSH_GLOBAL_DATA isolates
   *  session state from the user's global ~/.config/crush. Keys ride BYOK env vars
   *  (Crush reads ANTHROPIC_API_KEY/OPENAI_API_KEY/… directly), so none are written
   *  here. `api` follows the proxy's wire shape (advisory). Returns the config + data
   *  paths for the spawn env.
   *
   *  LIVE-UNVERIFIED: the single-upstream proxy serves one provider/endpoint shape at a
   *  time — for full synthesized events pick a model whose provider matches the
   *  configured upstream (or a local OpenAI-compatible endpoint). Cross-provider mixing
   *  is humanQA; the renderer nudge still delivers mail regardless. */
  private installCrushConfig(dir: string, loopbackUrl: string, api: 'openai' | 'anthropic', theme?: 'light' | 'dark'): { config: string; data: string } {
    const config = join(dir, 'crush.json');
    const data = join(dir, '.crush-data');
    try {
      mkdirSync(data, { recursive: true });
      // Override base_url → loopback for ONLY the provider whose wire-shape matches
      // the proxy (`api`): the single-upstream sidecar forwards bytes unchanged, so
      // routing a different-wire/host provider (e.g. anthropic when api='openai', or
      // openrouter/groq which are openai-wire but different hosts) through it would
      // hit the wrong endpoint and the call would fail. Those are left to their real
      // upstreams (working calls, un-proxied — no synthesized events, but mail still
      // drains via the renderer nudge + the pty-quiescence idle fallback). For the
      // default god (openai-wire) and a local OpenAI-compatible endpoint this routes
      // through the proxy cleanly. Cross-provider Crush-via-proxy is on-device
      // live-verify (Dwight verify-crush MF1; the default god model is openai-wire to
      // match). Literal loopback (Dwight's b1 — no ${VAR} expansion edge cases);
      // Crush merges config so only base_url is rewritten.
      const wireProvider = api === 'anthropic' ? 'anthropic' : 'openai';
      const providers: Record<string, { base_url: string }> = { [wireProvider]: { base_url: loopbackUrl } };
      // Theme: Crush ships one (dark) palette and no light theme, but
      // `options.tui.transparent` stops it painting its own background, so it
      // sits on xterm's, which follows the app theme. Set whenever the app
      // passes a theme, dark included, so both modes look the same way.
      const options = theme ? { tui: { transparent: true } } : undefined;
      writeFileSync(config, JSON.stringify(options ? { providers, options } : { providers }, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installCrushConfig failed:', e); }
    return { config, data };
  }

  /** Grok lifecycle-hook bridge → live hive status, session capture, guarded
   *  inbox delivery, and operator gates for `grok` workers.
   *
   *  Grok supports the same hook events and decision vocabulary as Claude Code,
   *  but its stdin payload uses camelCase keys. A small adapter normalizes those
   *  keys to HookServer's Claude-shaped contract. The hook is installed in the
   *  user's global Grok hook directory because global hooks are trusted and
   *  Grok sessions/resume stay in the user's normal GROK_HOME. The adapter is
   *  strictly scoped by AGENT_ID, so ordinary Grok sessions exit without doing
   *  anything. Best-effort and idempotent. */
  private installGrokHooks(): void {
    const root = this.root();
    if (!root) return;
    try {
      const shim = join(root, 'bin', 'grok-hook.cjs');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(shim, GROK_HOOK_SHIM, 'utf8');
      const tool = (matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        // Let Grok apply its event-aware defaults (5s normally, 600s for Stop).
        // Grok is a HOOK bridge (not a proxy sidecar), so it is hit by the same
        // `node: command not found` 127 — bundled node here too.
        hooks: [{ type: 'command', command: this.nodeRun(shim) }]
      });
      const hooks = {
        PreToolUse: [tool('.*')],
        PostToolUse: [tool('.*')],
        Stop: [tool()],
        SubagentStop: [tool('.*')],
        SessionStart: [tool('.*')],
        UserPromptSubmit: [tool()],
        PreCompact: [tool('.*')],
        PostCompact: [tool('.*')]
      };
      const hookDir = join(homedir(), '.grok', 'hooks');
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(
        join(hookDir, 'agflow-hive.json'),
        JSON.stringify({ hooks }, null, 2),
        'utf8'
      );
    } catch (e) { console.error('[hive] installGrokHooks failed:', e); }
  }

  /** Write the live fleet snapshot 败龙 reads (`fleet.json`, gitignored).
   *  Best-effort — called from a timer, must never throw. */
  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    try { writeFileSync(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8'); } catch { /* noop */ }
  }

  /** Is this agent the hive's god/orchestrator? */
  isGod(agentId: string): boolean {
    try {
      const reg = this.registry();
      return reg.godId === agentId || !!reg.agents[agentId]?.isGod;
    } catch { return false; }
  }

  /**
   * A compact, one-shot LIVE ROSTER line built from `fleet.json` — injected into
   * god's context as `additionalContext` on SessionStart and every
   * UserPromptSubmit (see HookServer).
   *
   * Why: fleet.json/registry.json are always fresh on disk (8s snapshot +
   * archiveOrphanedAgents on boot + PTY-exit archiving), but god's CONTEXT is not.
   * After an app restart god resumes a session whose transcript still describes
   * the OLD floor, and it will happily message agents that no longer exist. It is
   * told to read fleet.json, but "told to" is not "always knows" — so we push the
   * truth in on every turn instead. One line, so the cost is negligible.
   *
   * `ctxOf` (optional, supplied by HookServer) lets the caller layer the LIVE
   * context-window occupancy on top of the disk snapshot — each agent gets a
   * `ctx NN%` so god can see at a glance whose context is nearly full when it
   * routes work. fleet.json only carries cumulative `tokens`, which is a spend
   * figure, not how full the CURRENT window is; the real occupancy lives in
   * HookServer.contextById (from the statusLine shim). Omitted when the callback
   * is absent or an agent has no Status tick yet.
   *
   * Returns null when there is nothing to say (no hive, no snapshot, no agents),
   * so the hook stays a no-op rather than injecting noise.
   */
  rosterContext(
    ctxOf?: (agentId: string) => { tokens: number; limit: number } | undefined
  ): string | null {
    const root = this.root();
    if (!root) return null;
    try {
      const raw = readFileSync(join(root, 'fleet.json'), 'utf8');
      const snap = JSON.parse(raw) as {
        ts?: number;
        agents?: Array<{
          id: string; name?: string; role?: string; isGod?: boolean;
          breaker?: string; tokens?: number; usd?: number;
          lastTool?: string | null; lastActiveSecAgo?: number | null; inboxBacklog?: number;
          onHold?: boolean;
        }>;
      };
      const agents = Array.isArray(snap.agents) ? snap.agents : [];
      if (!agents.length) return null;

      const ago = (s: number | null | undefined): string =>
        typeof s !== 'number' ? '未知'
          : s < 90 ? `${s} 秒前`
            : s < 5400 ? `${Math.round(s / 60)} 分钟前`
              : `${Math.round(s / 3600)} 小时前`;

      // Cap the list so a big floor can't crowd out the actual prompt. The
      // remainder is still counted, and fleet.json is one Read away.
      const MAX = 24;
      const shown = agents.slice(0, MAX);
      let anyCtx = false;
      let anyHold = false;
      const rows = shown.map((a) => {
        const bits = [a.role ?? 'agent',
          typeof a.lastActiveSecAgo === 'number' ? `活跃 ${ago(a.lastActiveSecAgo)}` : '尚无活动'];
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1000)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        if (a.inboxBacklog) bits.push(`收件箱 ${a.inboxBacklog}`);
        if (a.breaker && a.breaker !== 'ok' && a.breaker !== 'none') bits.push(`熔断 ${a.breaker}`);
        if (a.isGod) bits.push('你（总控）');
        // First in the row after the role would be louder, but this reads in
        // the same scan as `breaker` and `inbox`, and god already treats those
        // as routing signals.
        if (a.onHold) { bits.push('暂停——正在与人类 1:1'); anyHold = true; }
        // Live context-window occupancy from the statusLine shim — lets god see
        // which agents are near-full when routing, instead of guessing from the
        // cumulative token count. Clamp to 0-100; a fresh meter can briefly
        // report more than 100% before a window rotation.
        const cw = ctxOf?.(a.id);
        if (cw && cw.limit > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((cw.tokens / cw.limit) * 100)));
          bits.push(`ctx ${pct}%`);
          anyCtx = true;
        }
        return `${a.id}${a.name ? ` "${a.name}"` : ''}（${bits.join('，')}）`;
      });
      const more = agents.length > shown.length ? `，另有 ${agents.length - shown.length} 名未列出` : '';
      const age = typeof snap.ts === 'number' ? ago(Math.round((Date.now() - snap.ts) / 1000)) : '未知';

      return `[实时花名册——自动注入自 ${join(root, 'fleet.json')}，快照 ${age}] `
        + `在岗智能体 ${agents.length} 名：${rows.join('；')}。${more} `
        + '这是当前楼层，优先于本对话中此前出现的任何花名册——'
        + '你记得、但这里没有出现的智能体已被归档或终止，不要再给它们发消息。 '
        + (anyCtx
          ? '`ctx NN%` = 实时上下文窗口占用率；未显示 = 尚未上报（是未知，不是空）。 '
          : '')
        + (anyHold
          ? '标注「暂停——正在与人类 1:1」的智能体不可用：人类正在直接与它协作。'
            + '不要给它发消息、不要向它派活、挑负责人时也不要算上它。改派别人，或说明这项工作在等。'
            + '它仍在运行、终端还活着，所以这不是归档它或另雇人接替的理由。人类办完事会关掉这个标记。 '
          : '')
        + '优先把工作派给名单上的人，再考虑雇新人。';
    } catch { return null; }
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root || !existsSync(join(root, 'log.jsonl'))) return [];
    const lines = readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage; } catch { return null; } })
      .filter((m): m is HiveMessage => m !== null);
  }

  /**
   * Record an agent's process exit so a death has a durable cause.
   *
   * Before this, an agent killed by its provider crashing was archived with
   * `{kind:'archive', agentId, archived:true}` and NOTHING else — no exit code,
   * no signal, no output. A two-second SIGILL death and a completed agent were
   * indistinguishable in the only record the hive keeps, and the crash banner
   * lived solely in a UI terminal pane. Observed live 2026-08-24: 败龙's
   * `claude` CLI panicked 923ms into startup and left no trace on disk.
   *
   * Split by design:
   *   - log.jsonl  gets structured, non-sensitive fields (code, signal, path).
   *   - crashes/   gets the raw tail, and is gitignored — see ensureHive.
   * A normal exit writes nothing at all; this is a diagnostic, not an audit log.
   * The tail file is written 0600 and the directory is capped at
   * MAX_CRASH_LOGS files, oldest dropped first.
   */
  recordAgentExit(
    agentId: string,
    info: { exitCode?: number; signal?: number; tail?: string; command?: string }
  ): void {
    const root = this.root();
    if (!root) return;
    const { exitCode, signal, tail, command } = info;
    // A signal means killed (SIGILL/SIGSEGV/SIGKILL); node-pty reports exitCode 0
    // in that case, so signal must be checked independently of the code.
    const abnormal = (typeof signal === 'number' && signal !== 0) || (typeof exitCode === 'number' && exitCode !== 0);
    if (!abnormal) return;

    let tailPath: string | null = null;
    if (tail && tail.length) {
      try {
        const dir = join(root, 'crashes');
        mkdirSync(dir, { recursive: true });
        // Colons are illegal in filenames on Windows and awkward everywhere.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeId = agentId.replace(/[^A-Za-z0-9._-]/g, '_');
        const p = join(dir, `${stamp}-${safeId}.log`);
        const header = [
          `agent:    ${agentId}`,
          `exitCode: ${String(exitCode)}`,
          `signal:   ${String(signal)}`,
          command ? `command:  ${command}` : null,
          `captured: ${new Date().toISOString()}`,
          `--- last ${tail.length} bytes of pty output ---`,
          ''
        ].filter(Boolean).join('\n');
        // 0600 explicitly. writeFileSync otherwise takes the process umask, and
        // the usual 022 (or 002) yields a world-readable file holding exactly
        // what the comment above says to keep out of git: paths, prompt
        // fragments, and whatever a provider printed as it died. A packaged
        // Electron app does not inherit the launching shell's umask the way a
        // dev build does, so the mode observed locally is not the mode a user
        // gets -- passing it removes the question.
        writeFileSync(p, header + tail, { encoding: 'utf8', mode: 0o600 });
        tailPath = p;
        pruneCrashLogs(dir);
      } catch { /* a diagnostic must never break teardown */ }
    }

    this.appendLog({
      kind: 'agent-exit',
      agentId,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      abnormal: true,
      tailPath
    });
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    try { appendFileSync(join(root, 'log.jsonl'), line, 'utf8'); } catch { /* noop */ }
  }

  /**
   * Append one cost sample to the durable, append-only ledger at
   * `<root>/cost-ledger.jsonl` (Lane A #6.6d). This is the SOLE durable cost
   * store; its row is exactly the shape Kevin (#4) reserves for the cost_ledger
   * SQLite table, so migration is a mechanical INSERT…SELECT.
   *
   * 🔒 PII: persist ONLY the allowlisted AgentUsageSample — NEVER a raw OTel
   * record (those carry user.email / account / org / hashed-user-id). The sample
   * is PII-free by construction upstream (the provider's normalize step), so we
   * add no redaction here; we just must not widen what we write. The file lives
   * at the hive ROOT, so `mempalace mine` (which only scans per-agent dirs) never
   * ingests it — no palace noise, no MINE_IGNORE entry needed.
   *
   * Like appendLog: append to disk now (durable immediately), let it ride the
   * next natural commit. Best-effort — never throws into the beat.
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // Fully snake_case so the row maps 1:1 onto Kevin's (#4) cost_ledger SQLite
    // columns (agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd) — migration is a straight INSERT…SELECT.
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd
    };
    try { appendFileSync(join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n', 'utf8'); } catch { /* noop */ }
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private writeJson(p: string, data: unknown): void {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }
  private atomicWriteJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // — git (single committer, retry + stale-lock recovery) —
  //
  // `gc.autoDetach=false` is what makes this call actually synchronous.
  //
  // A commit runs `gc --auto`, and git detaches that into a BACKGROUND process
  // by default. `spawnSync` returns when `git commit` exits, so the caller
  // believes the hive is quiescent while a gc it cannot see is still writing
  // into `.git/objects/`. Anything that touches the hive directory right after
  // a commit races that process: removing a hive home throws ENOTEMPTY, and a
  // read can catch a half-written pack.
  //
  // It reproduces on its own — create a HiveManager on a fresh temp home, call
  // ensureAgent, then remove the home: ~3.5% of iterations throw ENOTEMPTY,
  // and the leftover is always `.git/objects/`, sometimes still holding a
  // `bitmap-ref-tips_*` temp file that vanishes a fraction of a second later.
  // With this flag, gc runs inline and 200 iterations pass clean.
  //
  // The gc still happens — this only stops it from outliving the command that
  // triggered it, which is what "single committer" was supposed to mean.
  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'gc.autoDetach=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args], {
      cwd, encoding: 'utf8', timeout: 8000
    });
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** Has the one-time cost-ledger untrack pass run in this process yet? */
  private untrackedCostLedger = false;

  /**
   * Stop versioning the cost ledger.
   *
   * `cost-ledger.jsonl` is append-only and gains a row per usage sample, so a
   * repo that tracks it stores a fresh copy of the WHOLE file on every hive
   * commit — and the hive commits constantly. A quarter-gigabyte ledger with a
   * few thousand commits behind it is several hundred gigabytes of blob that
   * git has to walk, which is what turns a routine `gc` into a multi-gigabyte
   * `pack-objects` run. The ignore line in ensureHive keeps new copies out;
   * this drops the one already in the index, because git keeps recording a
   * file it is already tracking no matter what .gitignore says — so the ignore
   * line alone reads as a fix while the repo goes on growing. The ledger stays
   * on disk, so the cost history the app reads is untouched.
   */
  private untrackCostLedger(root: string): void {
    if (this.untrackedCostLedger) return;
    this.untrackedCostLedger = true;
    // Probe before mutating: `rm --cached` on a repo that never tracked it
    // would still rewrite the index on every launch, inside the retry path.
    const tracked = this.git(['ls-files', '--', 'cost-ledger.jsonl'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', 'cost-ledger.jsonl'], root);
    console.warn('[hive] untracked the cost ledger from the hive repo');
  }

  /** Has the one-time Codex-home untrack pass run in this process yet? */
  private untrackedCodexHomes = false;

  /**
   * Stop versioning Codex worker homes that are ALREADY in the index.
   *
   * Adding `.codex/` to each agent's .gitignore only keeps NEW paths out; git
   * happily keeps recording a file it is already tracking, so a hive that
   * predates that ignore line goes on committing every SQLite and transcript
   * revision exactly as before — the .gitignore reads as a fix while the repo
   * keeps growing. This closes that: once per process, refresh every agent's
   * ignore file (agents that are not running never pass through spawn, and the
   * mine loop only reaches them if mempalace is installed) and drop any tracked
   * `.codex` path from the index. The files stay on disk, so `codex --resume`
   * is unaffected; only their history stops.
   */
  private untrackCodexHomes(root: string): void {
    if (this.untrackedCodexHomes) return;
    this.untrackedCodexHomes = true;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return;
    try {
      for (const id of readdirSync(agentsDir)) ensureMineIgnore(join(agentsDir, id));
    } catch { /* best-effort */ }
    // Probe before mutating: `rm --cached` on a clean repo would still rewrite
    // the index on every launch, and this runs inside the commit retry path.
    const tracked = this.git(['ls-files', '--', 'agents/*/.codex'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', 'agents/*/.codex'], root);
    console.warn('[hive] untracked previously-committed Codex homes from the hive repo');
  }

  /** Commit all hive changes. No-op if there is nothing staged. */
  commit(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    this.untrackCostLedger(root);
    this.untrackCodexHomes(root);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A'], root);
      const commit = this.git(['commit', '-q', '-m', message], root);
      if (commit.ok) return;
      if (/nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) { sleepSync(50 * (attempt + 1)); continue; }
      console.warn(`[hive] commit gave up after ${attempt + 1} attempts:`, commit.err || commit.out);
      return;
    }
    console.warn('[hive] commit gave up after 5 attempts');
  }

  private clearStaleLock(root: string): void {
    const STALE_THRESHOLD_MS = 10_000;
    try {
      for (const lock of ['index.lock', 'HEAD.lock']) {
        const path = join(root, '.git', lock);
        if (existsSync(path) && Date.now() - statSync(path).mtimeMs > STALE_THRESHOLD_MS) rmSync(path);
      }
    } catch { /* noop */ }
  }
}

// ─── Generated hive docs (written into the hive for every agent) ─────────────

const GENERATED_DOC_NOTICE =
  '<!-- Generated and managed by AgFlow. 由 AgFlow 生成并管理，本地修改可能在蜂巢工作区引导时被覆盖。 -->';

/** The Claude Code command reference written to <hive>/COMMANDS.md, rendered from
 *  the SAME source as the UI "commands" tab so they never drift. Leads with the
 *  orchestrator note: slash = own session only, cli = shell/fleet; monitor
 *  siblings via fleet.json (claude agents does NOT see them). */
function renderCommandsMd(): string {
  const lines: string[] = [
    GENERATED_DOC_NOTICE,
    '',
    '# 命令参考',
    '',
    '你能用的命令参考（以 Claude Code 为主，附国产引擎常用命令）。分两类：',
    '- **slash** 命令只作用于你自己的会话——你无法在别的智能体的终端上运行它们。',
    '- **cli** 命令在你的 shell（Bash）里运行，可以作用于机队、生成新智能体或查询。',
    '',
    '要监控本蜂巢工作区里的其他智能体，读根目录的 `fleet.json`（每个智能体的实时令牌、成本、状态、最近使用的工具、熔断等级、收件箱积压）与 `registry.json`——`claude agents` 不会列出你蜂巢工作区里的同伴。要跑一次性无头查询，用 `claude -p "..." --output-format json`。',
    ''
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` 例：\`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const COMMANDS_MD = renderCommandsMd();

const PROTOCOL_MD = `${GENERATED_DOC_NOTICE}

# 蜂巢工作区协议

你是共享这座蜂巢工作区的若干智能体之一。协作完全基于文件；AgFlow（主进程）是
唯一会执行 git、也是唯一会在智能体之间搬运消息的一方。

## 你的工作目录 —— \`agents/<your-id>/\`
- \`identity.md\`  —— 你是谁（只读；由 AgFlow 写入）。
- \`memory.md\`    —— 你的长期记忆。任务开始时读它；学到东西就追加进去。
- \`inbox/\`       —— 发给你的消息。任务开始时读一遍。
- \`inbox/.done/\` —— 处理完的消息移到这里。
- \`outbox/\`      —— 要发消息就往这里丢。AgFlow 负责投递。

**绝不写入其他智能体的目录。** 写到自己的 \`outbox/\`，由总控转发。这样每个
文件都只有一个写入者。

## 发一条消息
往 \`outbox/\` 写一个 JSON 文件（文件名以 \`.json\` 结尾即可）：

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "一句话摘要",
  "body": "详细内容",
  "conversation": "在一个话题里带上它（可选）",
  "in_reply_to": "<你在回复的消息 id>（可选）"
}
\`\`\`

\`id\`、\`from\`、\`hops\` 与时间戳由 AgFlow 填写。

## 行路规则
- 只有 \`request\`、\`query\`、\`propose\` 期待回复。\`inform\` 与 \`done\` 是终态——
  不要回复它们，否则两个智能体会永远来回打转。
- 遇到任何含糊、跨部门或需要签署的事，给 \`god\` 发消息——总控会替你
  把疑问问清楚，所以很少需要直接找人类。
- 没有单独的人类审批队列。人在回路是原生能力：你运行的工具如需授权，会在
  你自己的会话里弹出提示（人类可以用手机通过 \`/remote-control\` 远程批准）。
  确实需要人类决策时，交给 \`god\`（\`"to": "human"\` 的消息会被路由给总控，
  也就是人类在楼层上的代理人）。
- \`board.md\` 是共享计划。不要直接改它——把改动 \`propose\` 给 \`god\`，
  它是唯一的执笔人。
- 已经移进 \`.done/\` 的消息再读一遍没有意义，不要重复处理。

## 工作在哪儿：board.md 与 tasks.json
有两个共享面，都在蜂巢工作区根目录：
- \`board.md\` —— 自由叙述的计划。只有总控可以执笔；其他人用 \`propose\` 提改动。
- \`tasks.json\` —— 结构化任务账本（看板：\`todo / doing / blocked / done\`，
  含标题、负责人、优先级、依赖）。你手上的任务要保持状态同步。

## 向人类提问（ASK ME 卡片）
当一张卡片只有靠人类才能推进——一个要回答的问题，或一件只有他们能做的事
（注册账号、批准支出、交付凭据、在他们的设备上测试）——总控会把卡片设为
\`"status": "blocked"\`，并把请求追加到它的 \`humanQA\` 数组：

\`\`\`json
{ "q": "请求内容，用 markdown", "askedAt": "<iso 时间戳>" }
\`\`\`

AgFlow 会把未决请求显示在 ASK ME 看板和 ASK ME 标签页里，人类的回复会写进
同一条记录的 \`"a"\` 字段，同时作为一封收件箱消息发给总控。所有历史条目都留在
卡片上——这条轨迹就是决策史。

**请求要写得短，用 markdown。** 卡片会原样渲染，所以纯文本的星号和反引号会
直接显示出来；卡片不是终端——超过一小段话加选项（大约 700 字）的请求是报告，
不是问题。砍掉叙述，留下决策：
- 开头用一句 **加粗** 的话说清楚到底需要他们做什么；
- 路径、命令、取值、标识符用 \`反引号\`；
- 每个选项或步骤都用 \`-\` 项目符号或 \`1.\` 编号；
- 段落之间空一行；单个换行会渲染成换行，所以每个选项各占一行。

请求源自其他智能体的汇报时，把它改写成这个形状。绝不把汇报正文原样当成问题，
也绝不让人类读完整篇调查才找到决策点。不要把人类问题存进单独的文件（不要
\`HumanQuestion.md\`），也绝不要干等回复——继续做别的，等答案到了再接着办。

## 护栏：熔断机制与令牌预算
熔断机制会盯着每个智能体的失控行为（在同一个工具上打转、错误风暴、超支）。
它温和地逐级升级：\`steer\` → \`constrain\` → \`stop\`。如果收件箱里出现
「熔断机制：引导」或「熔断机制：限制」的消息，你就是它抓到的问题——停止重复，
总结你试过什么，并严格照消息说的做（限制 = 转为只读，做更多工具调用前先拿到
总控的同意）。**节省令牌**：楼层有令牌预算，每个智能体也可能有自己的上限，
一旦越过就会触发熔断。优先传引用而不是粘贴内容，上下文变重时对自己的会话
执行 \`/compact\`。

## 机队监控（总控）
你（总控）负责态势感知。要看每个智能体的实时状态，读蜂巢工作区根目录的
\`fleet.json\`——它会持续刷新每个智能体的令牌、成本、状态、熔断等级、最近
使用的工具、最近活跃时间与收件箱积压。再配合 \`registry.json\`（花名册）与
\`log.jsonl\`（事件流）。重要：\`claude agents\` 不会显示你蜂巢工作区里的同伴
会话（它们是独立启动的）——\`fleet.json\` 才是它们的实况来源。想深入了解某个
智能体，读它的 \`agents/<id>/memory.md\` 与 \`inbox/\`，或给它发一个 \`query\`。
完整的 Claude Code 命令参考（slash = 只作用于你自己的会话；CLI = 在你的 shell
里跑，可以作用于整个机队）在蜂巢工作区根目录的 \`COMMANDS.md\`。

## 生成临时工（总控）
你可以自己启动一个临时智能体。往蜂巢工作区根目录的 \`spawn-requests/<id>.json\`
写一个 JSON 文件：

\`\`\`json
{
  "objective": "这个工人要做什么（必填）",
  "cwd": "/绝对/路径/到/仓库（必填）",
  "name": "显示名（可选）",
  "command": "引擎 CLI（可选；覆盖提供方默认命令）",
  "provider": "claude | codex | cursor | antigravity | …（可选；省略 command 时用它挑默认 CLI）",
  "model": "覆盖模型（可选）",
  "isolate": true,
  "tokenCap": 0,
  "slack": { "channel": "C…", "thread_ts": "…" },
  "character": "dev",
  "accent": "coral"
}
\`\`\`

AgFlow 会轮询该目录，生成 \`worker-<id>\`，请求一旦开始就移到
\`spawn-requests/.done/\`，失败则移到 \`spawn-requests/.failed/\` 并附原因。
\`isolate\` 默认为 true，会给工人一个独立的 git worktree。\`slack\` 把它的失败
回传到某个话题。这是你唯一能独立完成的生成方式：\`research/hires/\` 下的雇佣
清单需要人类在界面上确认。

\`character\` 与 \`accent\` 决定工人在办公室楼层上的样子，都可以省略。用演员表里
的名字给工人命名就会自动获得对应的形象，所以只有当名字和形象需要不一致时才
需要写 \`character\`。无法识别的值会回退，不会导致生成失败。

**它可以被关掉。** 操作者在「设置 → 自主性与预算」里控制，默认关闭，因为你每
启动一个工人就会消耗无人批准的令牌。关闭期间你的请求不会被判失败或删除，它
会停在 \`spawn-requests/\` 里，等操作者打开后执行。你的请求如果迟迟不动，就是
这个原因——这该拿去和人类商量，而不是重试。无论哪种情况，都先把活路由给已经
在楼层上的智能体。

## 语义记忆（可选——安装了 \`mempalace\` 时）
当你的环境里设置了 \`MEMPALACE_PALACE_PATH\`，整个蜂巢工作区就共享一座可检索
的记忆宫殿，你也有 \`mempalace\` CLI：
- \`mempalace search "<查询>"\` —— 按语义（而不只是关键词）跨团队召回相关的
  历史知识。加 \`--wing <agent-id>\` 限定到某个智能体，\`--results N\` 扩大条数。
- \`mempalace wake-up\` —— 一份简短的要点摘要，适合任务开始时看。

你的 \`memory.md\` 会自动汇入记忆宫殿，所以你写在那里的长期事实，每个智能体
都能检索到。不需要你自己运行 \`mine\`。
`;

const GENERATED_HIVE_DOCS = [
  { filename: 'PROTOCOL.md', contents: PROTOCOL_MD },
  { filename: 'COMMANDS.md', contents: COMMANDS_MD }
] as const;

// ─── cth-hook shim (written to <hive>/bin/cth-hook.cjs) ──────────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the hive's UDS, and relay the response back to `claude`. All the
// real logic lives in the main process (HookServer). Never blocks a stop on error.
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line mode: Claude Code pipes the session status JSON (incl.
    // context_window.total_input_tokens / .context_window_size) after every
    // response. Print the in-terminal gauge IMMEDIATELY (the TUI is waiting),
    // then forward the payload to the harness fire-and-forget so the agent
    // card's context gauge updates push-based, with the EXACT window size.
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write('ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)');
    }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

// ─── agy-hook shim (written to <hive>/bin/agy-hook.cjs) ──────────────────────
// Antigravity's `agy` CLI fires lifecycle hooks (PreToolUse/PostToolUse/Stop/
// PreInvocation/PostInvocation) but with a DIFFERENT stdin shape than Claude
// (conversationId / toolCall{name,args} / workspacePaths, and no hook_event_name
// — the event arrives as argv from the hooks.json command). This shim normalizes
// that into the same HookPayload the HookServer already consumes, so status,
// inbox-drain-on-Stop, and tool gating are reused UNCHANGED, then translates the
// server's Claude-shaped response back into agy's stdout contract (decision:
// allow|deny|block + a message). Scoped by AGENT_ID: a personal agy session
// (no AGENT_ID in env) is a no-op, so the global hooks.json never disturbs the
// user's own agy usage — only hive workers (spawned with AGENT_ID set) bridge.
// NOTE (agy bug, antigravity-cli#49): the loader reads ~/.gemini/antigravity-cli/
// hooks.json but the trigger reads ~/.gemini/config/hooks.json — we write BOTH.
const AGY_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const event = process.argv[2] || 'Unknown';
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); } // not a hive worker → ignore
  let agy = {};
  try { agy = JSON.parse(data || '{}'); } catch (_) {}
  const tc = agy.toolCall || {};
  const payload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: agy.conversationId,
    transcript_path: agy.transcriptPath,
    cwd: Array.isArray(agy.workspacePaths) ? agy.workspacePaths[0] : undefined,
    tool_name: tc.name,
    tool_input: tc.args
  };
  let resp = '';
  const done = () => {
    // Translate the HookServer's Claude-shaped reply into agy's contract. CRITICAL:
    // agy treats ANY object written to stdout as a decision and FAIL-CLOSES (an
    // empty/decision-less object = DENY). So emit JSON ONLY when there's a real
    // directive (deny/block/steer); otherwise write NOTHING — no output = allow.
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.decision === 'block') out = { decision: 'block', reason: r.reason, stopReason: r.reason, systemMessage: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      else if (r.continue === false) out = { decision: 'block', stopReason: r.stopReason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { systemMessage: r.hookSpecificOutput.additionalContext };
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── pi bridge extension (written to <agentDir>/.pi-agent/extensions/) ───────
// A bundled extension for Pi (earendil-works). Pi exposes a pi.on(event,…)
// lifecycle; this posts cth-hook-shaped payloads to HIVE_SOCK on tool_call /
// tool_result / agent_end and AUTO-APPROVES tool calls when the floor is in auto
// mode (HIVE_AUTO_APPROVE, gated by config.autoMode — Pam guardrail #5). The
// agent_end→Stop keeps the harness status in step (→ idle) so the renderer idle
// inbox-wake nudge can deliver mail. Fully wrapped so a wrong API guess can never
// break the spawn. LIVE-UNVERIFIED (Pi's exact extension surface needs BYOK keys).
const PI_EXTENSION = `'use strict';
var net = require('node:net');
var SOCK = process.env.HIVE_SOCK;
var AGENT = process.env.AGENT_ID || null;
var AUTO = process.env.HIVE_AUTO_APPROVE === '1';
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    var c = net.createConnection(SOCK, function () { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', function () {});
  } catch (e) {}
}
function firstDefined(primary, fallback) {
  return primary !== undefined && primary !== null ? primary : fallback;
}
function piField(ev, key) {
  try { return ev == null ? undefined : ev[key]; } catch (e) { return undefined; }
}
function piToolName(ev) {
  var tool = piField(ev, 'tool');
  return firstDefined(piField(ev, 'toolName'), firstDefined(piField(ev, 'name'), piField(tool, 'name')));
}
function piToolInput(ev) {
  return firstDefined(piField(ev, 'input'), piField(ev, 'args'));
}
function piToolPayload(hookEventName, ev) {
  return {
    hook_event_name: hookEventName,
    tool_name: piToolName(ev),
    tool_input: piToolInput(ev)
  };
}
function register(pi) {
  if (!pi || typeof pi.on !== 'function') return false;
  try {
    pi.on('tool_call', function (ev) {
      post(piToolPayload('PreToolUse', ev));
      if (AUTO) { try { if (ev && typeof ev.approve === 'function') ev.approve(); } catch (e) {} return { approve: true }; }
      return undefined;
    });
    pi.on('tool_result', function (ev) { post(piToolPayload('PostToolUse', ev)); });
    pi.on('agent_end', function () { post({ hook_event_name: 'Stop' }); });
    return true;
  } catch (e) { return false; }
}
try { if (typeof globalThis !== 'undefined' && globalThis.pi) register(globalThis.pi); } catch (e) {}
module.exports = function (pi) { return register(pi); };
module.exports.activate = function (pi) { return register(pi); };
module.exports.default = module.exports;
`;

// ─── opencode bridge plugin (written to <agentDir>/.opencode/plugin/) ────────
// A bundled plugin for OpenCode (anomalyco/opencode) — god Decision 1. OpenCode
// has no Claude-shaped Stop hook but its plugin API exposes a real session.idle
// event; this posts cth-hook-shaped payloads to HIVE_SOCK on tool.execute.before/
// after + session.idle. The session.idle→Stop keeps status in step (→ idle) so the
// renderer idle inbox-wake nudge delivers mail. ESM (OpenCode runs on Bun). Fully
// wrapped. LIVE-UNVERIFIED (plugin auto-load + session.idle firing need BYOK keys).
const OPENCODE_PLUGIN = `import { createConnection } from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID || null;
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    const c = createConnection(SOCK, () => { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', () => {});
  } catch (e) {}
}
export const HiveBridge = async () => {
  return {
    event: async (input) => {
      try { if (input && input.event && input.event.type === 'session.idle') post({ hook_event_name: 'Stop' }); } catch (e) {}
    },
    'tool.execute.before': async (input) => {
      try { post({ hook_event_name: 'PreToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    },
    'tool.execute.after': async (input) => {
      try { post({ hook_event_name: 'PostToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    }
  };
};
export default HiveBridge;
`;

// ─── proxy-bridge sidecar (written to <hive>/bin/hive-proxy.cjs) ─────────────
// One per proxy-tier agent (qwen). A dependency-free, loopback-only reverse
// proxy: the agent's CLI is pointed at this (via ANTHROPIC_BASE_URL/OPENAI_BASE_URL),
// and it forwards every request to the user's real upstream UNCHANGED (headers,
// body, streaming). It TEES each response to synthesize the same HIVE_SOCK payloads
// the hook shims emit — Status (context gauge), PostToolUse (breaker), Stop (idle
// drain), and the new CostSample (cost ledger) — so a hookless CLI becomes a hive
// citizen. NEVER logs bodies or keys; the captured body is parsed in-memory and
// dropped. Idle is heuristic: a turn that ends with no tool call and no new request
// within an ~800ms debounce → Stop (a new request cancels it).
const PROXY_BRIDGE_SHIM = `#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const SOCK = process.env.HIVE_SOCK;
const AGENT_ID = process.env.AGENT_ID || null;
const UPSTREAM = process.env.UPSTREAM_BASE_URL || '';
const SESSION = process.env.HIVE_PROXY_SESSION || null;
const API = process.env.HIVE_PROXY_API === 'anthropic' ? 'anthropic' : 'openai';

function trimSlash(s) { while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s; }

// Per-model context-window size for the Status gauge; fallback 200k.
function ctxSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('[1m]') !== -1 || m.indexOf('-1m') !== -1) return 1000000;
  if (m.indexOf('claude') !== -1) return 200000;
  if (m.indexOf('gpt-4o') !== -1 || m.indexOf('gpt-4.1') !== -1 || m.indexOf('o1') !== -1 || m.indexOf('o3') !== -1) return 128000;
  if (m.indexOf('qwen') !== -1) return 262144;
  return 200000;
}

// Fire-and-forget emit of a shim-shaped payload to the hive socket. Never throws.
function emit(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection(SOCK, function () { c.end(JSON.stringify(payload) + '\\n'); });
    c.on('error', function () {});
  } catch (e) {}
}

let stopTimer = null;
function armStop() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(function () {
    stopTimer = null;
    emit({ hook_event_name: 'Stop', agent_id: AGENT_ID, session_id: SESSION });
  }, 800);
  if (stopTimer.unref) stopTimer.unref();
}
function cancelStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }

function safeArgs(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return { _raw: String(s).slice(0, 500) }; }
}

// Parse a completed response (single JSON or an SSE stream) and synthesize events.
function parseAndEmit(bodyStr, isSse) {
  const objs = [];
  if (isSse) {
    const lines = bodyStr.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const idx = ln.indexOf('data:');
      if (idx === -1) continue;
      const data = ln.slice(idx + 5).trim();
      if (!data || data === '[DONE]') continue;
      try { objs.push(JSON.parse(data)); } catch (e) {}
    }
  } else {
    try { objs.push(JSON.parse(bodyStr)); } catch (e) {}
  }
  if (!objs.length) { armStop(); return; }

  let model = null, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sawUsage = false;
  const toolCalls = [];
  const oaiTools = {}; // accumulate streaming openai tool_calls by index

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o || typeof o !== 'object') continue;
    if (o.model) model = o.model;
    if (API === 'anthropic') {
      if (o.type === 'message_start' && o.message) {
        if (o.message.model) model = o.message.model;
        const u = o.message.usage || {};
        input += u.input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'message_delta' && o.usage) {
        output += o.usage.output_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
        toolCalls.push({ name: o.content_block.name, input: o.content_block.input || {} });
      } else if (o.usage && !o.type) {
        // non-streaming full message body
        const u = o.usage;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      }
      if (Array.isArray(o.content)) {
        for (let j = 0; j < o.content.length; j++) {
          const blk = o.content[j];
          if (blk && blk.type === 'tool_use') toolCalls.push({ name: blk.name, input: blk.input || {} });
        }
      }
    } else {
      if (o.usage) {
        const u = o.usage;
        input += u.prompt_tokens || 0;
        output += u.completion_tokens || 0;
        if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) cacheRead += u.prompt_tokens_details.cached_tokens;
        sawUsage = true;
      }
      const choices = o.choices || [];
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c];
        if (!ch) continue;
        if (ch.message && Array.isArray(ch.message.tool_calls)) {
          for (let t = 0; t < ch.message.tool_calls.length; t++) {
            const tc = ch.message.tool_calls[t];
            if (tc && tc.function) toolCalls.push({ name: tc.function.name, input: safeArgs(tc.function.arguments) });
          }
        }
        if (ch.delta && Array.isArray(ch.delta.tool_calls)) {
          for (let t = 0; t < ch.delta.tool_calls.length; t++) {
            const tc = ch.delta.tool_calls[t];
            if (!tc) continue;
            const k = (tc.index != null ? tc.index : t);
            if (!oaiTools[k]) oaiTools[k] = { name: null, args: '' };
            if (tc.function) {
              if (tc.function.name) oaiTools[k].name = tc.function.name;
              if (tc.function.arguments) oaiTools[k].args += tc.function.arguments;
            }
          }
        }
      }
    }
  }
  const keys = Object.keys(oaiTools);
  for (let i = 0; i < keys.length; i++) {
    const t = oaiTools[keys[i]];
    if (t.name) toolCalls.push({ name: t.name, input: safeArgs(t.args) });
  }

  if (sawUsage) {
    emit({ hook_event_name: 'Status', agent_id: AGENT_ID, context_window: { total_input_tokens: input + cacheRead + cacheCreation, context_window_size: ctxSize(model) } });
    emit({ hook_event_name: 'CostSample', agent_id: AGENT_ID, session_id: SESSION, model: model, input: input, output: output, cache_read: cacheRead, cache_creation: cacheCreation });
  }
  if (toolCalls.length) {
    cancelStop(); // a tool call means the turn continues
    for (let i = 0; i < toolCalls.length; i++) {
      emit({ hook_event_name: 'PostToolUse', agent_id: AGENT_ID, session_id: SESSION, tool_name: toolCalls[i].name, tool_input: toolCalls[i].input });
    }
  } else {
    armStop();
  }
}

let upstreamUrl = null;
try { upstreamUrl = new URL(UPSTREAM); } catch (e) {}

const server = http.createServer(function (req, res) {
  cancelStop(); // a new request means the turn is still going
  if (!upstreamUrl) { res.statusCode = 502; res.end('proxy: no upstream'); return; }
  let target;
  try { target = new URL(trimSlash(UPSTREAM) + req.url); } catch (e) { res.statusCode = 502; res.end('proxy: bad url'); return; }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  // Ask upstream for plaintext so the tee can parse SSE/JSON reliably; the client
  // gets uncompressed bytes (loopback — negligible) and no content-encoding to undo.
  delete headers['accept-encoding'];
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers
  };
  const upReq = lib.request(opts, function (upRes) {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    const ct = String((upRes.headers['content-type'] || ''));
    const wantParse = ct.indexOf('json') !== -1 || ct.indexOf('event-stream') !== -1;
    const isSse = ct.indexOf('event-stream') !== -1;
    const chunks = [];
    let total = 0;
    upRes.on('data', function (chunk) {
      res.write(chunk); // stream straight through to the CLI
      if (wantParse && total < 4194304) { chunks.push(chunk); total += chunk.length; }
    });
    upRes.on('end', function () {
      res.end();
      if (wantParse && chunks.length) {
        try { parseAndEmit(Buffer.concat(chunks).toString('utf8'), isSse); } catch (e) {}
      }
    });
    upRes.on('error', function () { try { res.end(); } catch (e) {} });
  });
  upReq.on('error', function () { try { res.statusCode = 502; res.end('proxy: upstream error'); } catch (e) {} });
  req.pipe(upReq);
});

server.on('error', function () {
  try { process.stdout.write(JSON.stringify({ port: 0 }) + '\\n'); } catch (e) {}
  process.exit(0);
});
server.listen(0, '127.0.0.1', function () {
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  try { process.stdout.write(JSON.stringify({ port: port }) + '\\n'); } catch (e) {}
});
`;

// Official Gemini CLI bridge. Gemini already sends snake_case payload fields;
// normalize its event names, then translate HookServer decisions back into
// Gemini's documented hook output contract.
const GEMINI_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let gemini = {};
  try { gemini = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    SessionStart: 'SessionStart',
    BeforeAgent: 'UserPromptSubmit',
    BeforeTool: 'PreToolUse',
    AfterTool: 'PostToolUse',
    AfterAgent: 'Stop'
  };
  const payload = {
    ...gemini,
    hook_event_name: names[gemini.hook_event_name] || gemini.hook_event_name || 'Unknown',
    agent_id: agentId
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'deny', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = { hookSpecificOutput: { additionalContext: r.hookSpecificOutput.additionalContext } };
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── grok-hook shim (written to <hive>/bin/grok-hook.cjs) ───────────────────
// Grok's lifecycle events and decisions are Claude-compatible, but the wire
// payload is camelCase and uses snake_case event values. Normalize the input for
// HookServer and translate its Claude-style permission denial into Grok's direct
// decision form. Scoped by AGENT_ID so the trusted global hook is inert outside
// AgFlow-spawned workers.
const GROK_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let grok = {};
  try { grok = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    permission_denied: 'PermissionDenied',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    notification: 'Notification',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact'
  };
  const payload = {
    hook_event_name: names[grok.hookEventName] || grok.hookEventName || 'Unknown',
    agent_id: agentId,
    session_id: grok.sessionId,
    cwd: grok.cwd || grok.workspaceRoot,
    tool_name: grok.toolName,
    tool_input: grok.toolInput,
    stop_hook_active: grok.stopHookActive,
    prompt: grok.prompt,
    source: grok.source,
    notification_type: grok.notificationType,
    message: grok.message
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'block', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = r;
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;
