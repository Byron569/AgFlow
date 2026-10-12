/**
 * Shareable "hires" — portable agent role templates (manifest spec v1).
 *
 * A hire manifest is a small JSON document that describes a role-configured
 * agent (name, provider, model, flags, goal, budget) so it can be shared as a
 * file or hosted in a community gallery and imported with one click via the
 * `agflow://hire?src=<https-url>` deep link or an in-app file picker.
 *
 * SECURITY MODEL — a manifest is untrusted input:
 *   - It can NEVER auto-spawn an agent. Importing only pre-fills the Add-Agent
 *     modal; the human reviews the final command and clicks spawn.
 *   - It cannot carry a raw executable/command. The spawn binary always comes
 *     from the locally configured provider preset; a manifest may only append
 *     flag-shaped arguments (validated below), which the modal shows in full.
 *   - All fields are length/shape-capped here, in one dependency-free module
 *     shared by main (deep link / file import) and renderer (prefill).
 *   - `skills` and `mcpServers` are references into the BUNDLED allowlists only —
 *     never raw specs. This is the same threat model as `commandFlags`: a manifest
 *     can never inject an arbitrary executable path, env var, or MCP spec.
 *     Write/secret MCP servers are surfaced for human consent at import, never
 *     auto-enabled (consistent with "import only pre-fills; human clicks spawn").
 */

import { mcpCatalogEntry } from './mcpCatalog';
import { MAX_AGENT_TOKEN_CAP } from './tokenCaps';

export const HIRE_SPEC_V1 = 'agflow/hire@1';

/** Skill ids bundled in app resources (the only values a hire manifest may request
 *  in the `skills` field). A manifest can never name an arbitrary skill path —
 *  only these curated, read-only, no-secret skill ids are allowlisted. */
export const BUNDLED_SKILL_IDS: ReadonlySet<string> = new Set([
  'af-hive-sync',
  'af-fetch-summarize',
  'af-audit',
  'af-weekly-report',
  'af-api-docs'
]);

/** Providers a manifest may request ('agy' is accepted as an alias for
 *  'antigravity'). The domestic engines (qwen / doubao / kimi / deepseek /
 *  glm) are allowed since P0-D-3 — they spawn through the same locally-built
 *  provider presets, so the security posture is unchanged. traecli (TraeCode
 *  CLI)、codebuddy（腾讯 CodeBuddy）与 zcode（智谱 GLM 命令行版）在 P1-5 以同
 *  口径加入。'custom' is deliberately NOT allowed — it would let a manifest
 *  choose an arbitrary local binary. */
export type HireProvider =
  | 'claude' | 'antigravity' | 'codex' | 'cursor'
  | 'qwen' | 'doubao' | 'kimi' | 'deepseek' | 'glm'
  | 'traecli' | 'codebuddy' | 'zcode';

export interface HireManifest {
  /** Spec tag; exactly `agflow/hire@1` for this version. */
  spec: typeof HIRE_SPEC_V1;
  /** Agent display name (also seeds the hive id). Required. */
  name: string;
  /** One-line role, e.g. "Documentation writer" — lands in identity.md + card. */
  description?: string;
  /** The standing goal/mission text pre-filled into the goal field. */
  goal?: string;
  /** Office cast sprite id (e.g. 'designer'); unknown values fall back to default. */
  character?: string;
  /** Accent color name (e.g. 'mint'); unknown values fall back to default. */
  accent?: string;
  /** Which CLI the role is designed for. Default: the user's default provider. */
  provider?: HireProvider;
  /** Model id/label for that provider (e.g. 'claude-sonnet-4-6'). */
  model?: string;
  /** Extra flag-shaped args appended to the locally-built spawn command. Each flag
   *  must be in the safe-flag allowlist (see SAFE_FLAG_NAMES) and shell-metachar-free;
   *  anything else rejects the manifest (the command stays editable post-import). */
  commandFlags?: string[];
  /** Capability tags for the hive registry (routing hints). */
  capabilities?: string[];
  /** Spawn in an isolated git worktree. */
  isolate?: boolean;
  /** Per-agent total-token ceiling, applied to agentTokenCaps after spawn. */
  tokenCap?: number;
  /** Attribution shown in the import preview. */
  author?: string;
  /** Manifest home (gallery page). https only. */
  homepage?: string;
  /** Bundled skill ids to activate in the agent's workspace. References into
   *  BUNDLED_SKILL_IDS only — never raw file paths or arbitrary skill names. */
  skills?: string[];
  /** Default MCP catalog ids to enable for this agent. References into the
   *  MCP_CATALOG allowlist only — never raw specs. Safe-readonly ids are
   *  pre-filled; write/secret ids are surfaced for human consent at import
   *  and never auto-enabled. */
  mcpServers?: string[];
}

export interface HireValidation {
  ok: boolean;
  manifest?: HireManifest;
  errors: string[];
  /** MCP catalog ids present in the manifest's `mcpServers` that are NOT
   *  safe-readonly (write or secret tier). These must be surfaced to the human
   *  for explicit consent before they are enabled — they are NEVER auto-enabled. */
  consentRequired?: string[];
}

const PROVIDERS: readonly string[] = ['claude', 'antigravity', 'codex', 'cursor', 'qwen', 'doubao', 'kimi', 'deepseek', 'glm', 'traecli', 'codebuddy', 'zcode'];
const MAX_BYTES = 64 * 1024;

/** A flag ("-x", "--flag", "--flag=value") or a bare value token that may follow
 *  a flag. Letters/digits plus a conservative punctuation set; no quotes,
 *  backticks, semicolons, pipes, ampersands, redirects, percent (cmd.exe
 *  %VAR% env-expansion), or whitespace. Args are passed to node-pty as argv
 *  (no shell), so this is defense in depth. */
const FLAG_RE = /^[A-Za-z0-9._\/=:,@+-]{1,100}$/;

/** Allowed characters in a model id/label. Model values flow into the spawn
 *  command line (`--model <value>`), so this MUST reject shell metacharacters —
 *  on Windows a `.cmd`/`.bat` provider shim routes the command through cmd.exe,
 *  where an unquoted `&`/`|`/`^`/`<`/`>`/`(`/`)` would chain a second command.
 *  Real model ids/labels only need letters, digits, spaces, and a little
 *  punctuation: `claude-sonnet-4-6[1m]`, `Gemini 3.1 Pro (High)`. No quotes,
 *  backticks, `$`, `;`, `&`, `|`, `^`, `<`, `>`, `%`, `!`. (The command field
 *  stays editable, so a legitimate exotic value can still be typed by hand.) */
const MODEL_RE = /^[A-Za-z0-9 ._()[\]\/:@+-]{1,80}$/;

/** Flags a manifest is ALLOWED to append — a default-deny ALLOWLIST.
 *
 *  WHY AN ALLOWLIST: a manifest's `provider` is attacker-chosen and each CLI keeps
 *  adding flags, so a denylist of "dangerous" flags drifts and leaks (three rounds
 *  of re-review each found one more spelling that escaped — codex `-a`/`-s`, then
 *  `-c model_providers.*.base_url=…` backend-redirect credential exfil, then
 *  `--provider`). Default-deny closes the CLASS: only flags that PROVABLY cannot
 *  escalate permissions, redirect the backend / exfil credentials, read/write
 *  arbitrary files, inject prompt/config/MCP, or run commands may pass; every
 *  other flag-shaped token rejects the manifest outright.
 *
 *  These names are the curated SAFE set, mined from the provider command
 *  references (claudeCommands.ts / codexCommands.ts) and presets
 *  (agentProvider.ts). The list is deliberately tiny — biased hard to EXCLUDE,
 *  because the spawn command stays editable after import, so a user who needs an
 *  exotic flag can add it by hand. Each is behavioral / output / a safety-cap
 *  only, with a single non-escalating value (or none):
 *    --model          select the model id           (claude/codex/agy modelFlag)
 *    --max-turns      cap agentic turns (runaway guard, strictly safety-↑)
 *    --output-format  headless output shape: text / json / stream-json
 *    --verbose        logging verbosity only
 *  Matched case-insensitively against the flag NAME (part before any `=`), so both
 *  `--flag value` and `--flag=value` are covered. NOTHING permission / sandbox /
 *  approval / dir / config (incl. codex `-c`) / mcp / provider / base-url /
 *  system-prompt / settings related is ever allowlisted. */
const SAFE_FLAG_NAMES: ReadonlySet<string> = new Set([
  '--model',
  '--max-turns',
  '--output-format',
  '--verbose'
]);

/** True if a commandFlags token is an allowed flag. Handles `--x` and `--x=value`
 *  (matches the NAME before `=`, case-insensitive); short `-x` forms are not in
 *  the allowlist and so are rejected by default. */
function isSafeFlag(token: string): boolean {
  if (!token.startsWith('-')) return false;
  const name = token.split('=', 1)[0].toLowerCase();
  return SAFE_FLAG_NAMES.has(name);
}

function str(v: unknown): v is string { return typeof v === 'string'; }

function capped(v: unknown, max: number, field: string, errors: string[], required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) errors.push(`"${field}" 为必填`);
    return undefined;
  }
  if (!str(v)) { errors.push(`"${field}" 必须是字符串`); return undefined; }
  const t = v.trim();
  if (required && !t) { errors.push(`"${field}" 不能为空`); return undefined; }
  if (t.length > max) { errors.push(`"${field}" 超过 ${max} 个字符`); return undefined; }
  return t || undefined;
}

/** Validate an untrusted parsed JSON value into a HireManifest. Pure; no I/O. */
export function validateHireManifest(raw: unknown): HireValidation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['清单必须是一个 JSON 对象'] };
  }
  const o = raw as Record<string, unknown>;

  if (o.spec !== HIRE_SPEC_V1) {
    return { ok: false, errors: [`不支持的 spec "${String(o.spec)}"（应为 "${HIRE_SPEC_V1}"）`] };
  }

  const name = capped(o.name, 40, 'name', errors, true);
  const description = capped(o.description, 200, 'description', errors);
  const goal = capped(o.goal, 4000, 'goal', errors);
  const character = capped(o.character, 24, 'character', errors)?.toLowerCase();
  const accent = capped(o.accent, 24, 'accent', errors)?.toLowerCase();
  const model = capped(o.model, 80, 'model', errors);
  if (model !== undefined && !MODEL_RE.test(model)) {
    errors.push('"model" 含有不允许的字符（它会被放到派生命令行上；只允许字母、数字、空格与 . _ - ( ) [ ] / : @ +）');
  }
  const author = capped(o.author, 80, 'author', errors);
  const homepage = capped(o.homepage, 300, 'homepage', errors);

  let provider: HireProvider | undefined;
  if (o.provider !== undefined) {
    const p = str(o.provider) ? (o.provider === 'agy' ? 'antigravity' : o.provider) : o.provider;
    if (str(p) && PROVIDERS.includes(p)) provider = p as HireProvider;
    else errors.push(`"provider" 必须是以下之一：${PROVIDERS.join('、')}（或 "agy"）`);
  }

  let commandFlags: string[] | undefined;
  if (o.commandFlags !== undefined) {
    if (!Array.isArray(o.commandFlags) || o.commandFlags.length > 16) {
      errors.push('"commandFlags" 必须是最多 16 项的数组');
    } else {
      commandFlags = [];
      // DEFAULT-DENY: every flag-shaped token must name an allowlisted safe flag;
      // a bare token is allowed only as the value immediately following an allowed
      // `--flag` (so a value can never smuggle in a second, unknown flag).
      let valueAllowed = false; // previous token was an allowed `--flag` (no inline =)
      for (let i = 0; i < o.commandFlags.length; i++) {
        const f = o.commandFlags[i];
        if (!str(f) || !FLAG_RE.test(f)) {
          errors.push(`commandFlags 项 ${JSON.stringify(f)} 不是安全的 flag 令牌`);
          valueAllowed = false;
          continue;
        }
        // The FIRST entry must be flag-shaped (defense in depth; kept explicit).
        if (i === 0 && !f.startsWith('-')) {
          errors.push('"commandFlags" 必须以 flag 开头（例如 "--model"）');
          valueAllowed = false;
          continue;
        }
        if (f.startsWith('-')) {
          if (!isSafeFlag(f)) {
            errors.push(`commandFlags 项 ${JSON.stringify(f)} 不在共享雇佣的安全 flag 列表里——出于安全考虑，共享雇佣只能内嵌已知无害的 flag（${[...SAFE_FLAG_NAMES].join('、')}）。如需这个 flag，请在导入后手动把它加进命令字段。`);
            valueAllowed = false;
            continue;
          }
          commandFlags.push(f);
          valueAllowed = !f.includes('='); // a `--flag value` form may take one value next
        } else {
          if (!valueAllowed) {
            errors.push(`commandFlags 项 ${JSON.stringify(f)} 在这里不允许（值只能紧跟在一个允许的 flag 如 "--model" 之后）`);
            continue;
          }
          commandFlags.push(f);
          valueAllowed = false; // consume the value; no chained second value
        }
      }
      if (commandFlags.length === 0) commandFlags = undefined;
    }
  }

  let capabilities: string[] | undefined;
  if (o.capabilities !== undefined) {
    if (!Array.isArray(o.capabilities) || o.capabilities.length > 12) {
      errors.push('"capabilities" 必须是最多 12 项的数组');
    } else {
      capabilities = o.capabilities.filter(str).map(c => c.trim().slice(0, 40)).filter(Boolean);
      if (capabilities.length === 0) capabilities = undefined;
    }
  }

  let isolate: boolean | undefined;
  if (o.isolate !== undefined) {
    if (typeof o.isolate === 'boolean') isolate = o.isolate;
    else errors.push('"isolate" 必须是布尔值');
  }

  let tokenCap: number | undefined;
  if (o.tokenCap !== undefined) {
    if (typeof o.tokenCap === 'number' && Number.isInteger(o.tokenCap) && o.tokenCap > 0 && o.tokenCap <= MAX_AGENT_TOKEN_CAP) tokenCap = o.tokenCap;
    else errors.push('"tokenCap" 必须是正整数（最大 1e10）');
  }

  // skills — allowlist: references into BUNDLED_SKILL_IDS only; max 8
  let skills: string[] | undefined;
  if (o.skills !== undefined) {
    if (!Array.isArray(o.skills) || o.skills.length > 8) {
      errors.push('"skills" 必须是最多 8 项的数组');
    } else {
      skills = [];
      for (const s of o.skills) {
        if (!str(s) || !s.trim()) { errors.push('"skills" 的每一项必须是非空字符串'); continue; }
        const id = s.trim();
        if (!BUNDLED_SKILL_IDS.has(id)) {
          errors.push(`"skills" 项 ${JSON.stringify(id)} 不是内置技能 id —— 雇佣只能引用内置的安全技能（${[...BUNDLED_SKILL_IDS].join('、')}）`);
        } else {
          skills.push(id);
        }
      }
      if (skills.length === 0) skills = undefined;
    }
  }

  // mcpServers — allowlist: references into MCP_CATALOG only; max 8; write/secret surfaced for consent
  let mcpServers: string[] | undefined;
  const consentRequired: string[] = [];
  if (o.mcpServers !== undefined) {
    if (!Array.isArray(o.mcpServers) || o.mcpServers.length > 8) {
      errors.push('"mcpServers" 必须是最多 8 项的数组');
    } else {
      mcpServers = [];
      for (const s of o.mcpServers) {
        if (!str(s) || !s.trim()) { errors.push('"mcpServers" 的每一项必须是非空字符串'); continue; }
        const id = s.trim();
        const entry = mcpCatalogEntry(id);
        if (!entry) {
          errors.push(`"mcpServers" 项 ${JSON.stringify(id)} 不是已知的目录 id —— 雇佣只能引用内置的 MCP 服务器`);
        } else {
          mcpServers.push(id);
          if (entry.tier !== 'safe-readonly') consentRequired.push(id);
        }
      }
      if (mcpServers.length === 0) mcpServers = undefined;
    }
  }

  if (homepage && !homepage.startsWith('https://')) errors.push('"homepage" 必须是 https');

  if (errors.length > 0 || !name) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    consentRequired: consentRequired.length > 0 ? consentRequired : undefined,
    manifest: { spec: HIRE_SPEC_V1, name, description, goal, character, accent, provider, model, commandFlags, capabilities, isolate, tokenCap, author, homepage, skills, mcpServers }
  };
}

/** Parse a `agflow://hire?src=<https-url>` deep link. Returns the https
 *  manifest URL, or null if the link is not a well-formed hire link. */
export function parseHireDeepLink(link: string): string | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'agflow:') return null;
  // Both agflow://hire?src= (host) and agflow:hire?src= (path).
  const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'hire') return null;
  const src = u.searchParams.get('src');
  if (!src) return null;
  let s: URL;
  try { s = new URL(src); } catch { return null; }
  if (!isAllowedManifestUrl(s)) return null;
  return s.toString();
}

/** https everywhere; plain http is allowed ONLY for loopback (local gallery
 *  development) — a remote page can never point the app at an http manifest. */
export function isAllowedManifestUrl(u: URL): boolean {
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

/** Byte cap shared by the deep-link fetcher and the file importer. */
export const HIRE_MAX_BYTES = MAX_BYTES;
