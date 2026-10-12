import { spawnSync } from 'node:child_process';

/**
 * OpenCode 存在两条发行线，TUI 旗标面不同（2026-10 真机核实）：
 *   - npm `opencode-ai`（1.x，installCommand 装的那条）：TUI 有 `-m, --model`；
 *     进程自带服务，per-agent 的 OPENCODE_CONFIG_DIR / 插件即生效。
 *   - 桌面版内置 CLI（2.x，`opencode-cli`）：TUI **没有** `--model`（只有 `run`
 *     子命令有），且默认连**共享后台服务** —— 不带 `--standalone` 时 per-agent
 *     配置（model/theme）与插件目录全被忽略，会话还混进用户自己的 opencode。
 *
 * 实测证据（本机 opencode-cli 2.0.27）：
 *   - `--model` 进 TUI → "Unrecognized flag: --model"，进程直接退出；
 *   - 不写 `--standalone` 时 config 里的 `model` 不生效（仍用内置默认 exo-free），
 *     写了 `--standalone` 后同一配置真实跑通（DeepSeek 实际作答）。
 *
 * 本模块把「旗标能力探测 + argv 改写」做成纯逻辑/可注入的小工具：探测只跑一次
 * `--help`（按二进制路径缓存），改写不依赖 electron，测试可直接装载。
 */

export interface OpencodeCliProfile {
  /** TUI 接受 `--model`（v1）——为 false 时模型必须走 config 的 `model` 键。 */
  tuiModelFlag: boolean;
  /** 需要 `--standalone` 才会起私有服务（v2；否则连共享后台服务）。 */
  needsStandalone: boolean;
}

/** 纯解析：从 `--help` 文本判定 CLI 世代（便于单测，不触碰进程）。 */
export function parseOpencodeHelp(help: string): OpencodeCliProfile {
  return {
    // v1 帮助里是 `-m, --model`；v2 顶层旗标表没有 --model（只有 run 子命令）。
    tuiModelFlag: /-m,\s*--model|--model,\s*-m/.test(help),
    needsStandalone: /--standalone\b/.test(help)
  };
}

const cache = new Map<string, OpencodeCliProfile | null>();

/** 探测某 opencode 二进制的旗标能力（`--help`，按路径缓存；失败 → null = 不改写）。 */
export function probeOpencodeCli(bin: string): OpencodeCliProfile | null {
  const hit = cache.get(bin);
  if (hit !== undefined) return hit;
  let profile: OpencodeCliProfile | null = null;
  try {
    const res = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 5000 });
    const help = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    // 只认「这确实是 opencode 的帮助」——否则（别的 CLI 恰好被指过来）保持原样。
    profile = /\bopencode\b/i.test(help) ? parseOpencodeHelp(help) : null;
  } catch {
    profile = null;
  }
  cache.set(bin, profile);
  return profile;
}

/**
 * 按探测结果改写 argv：
 *   - v2（无 TUI `--model`）：摘下 `--model <slug>` 交回调用方（改注 config 的
 *     `model` 键），并补 `--standalone`（幂等）；
 *   - v1 / 探测失败：原样返回。
 */
export function adaptOpencodeArgs(
  args: readonly string[],
  profile: OpencodeCliProfile | null
): { args: string[]; model: string | null } {
  if (!profile || profile.tuiModelFlag) return { args: [...args], model: null };
  const out = [...args];
  let model: string | null = null;
  const idx = out.indexOf('--model');
  if (idx >= 0) {
    model = out[idx + 1] ?? null;
    out.splice(idx, 2);
  }
  if (profile.needsStandalone && !out.includes('--standalone')) out.unshift('--standalone');
  return { args: out, model };
}