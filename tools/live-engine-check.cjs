#!/usr/bin/env node
'use strict';

/**
 * 真机实测（P2 / C-7 遗留项补口）：用本机已装的引擎 CLI 跑一遍真实链路。
 *
 *   node tools/live-engine-check.cjs opencode            # 默认推荐（DeepSeek 后端可达）
 *   node tools/live-engine-check.cjs deepseek | agy | gemini | zcode
 *      （deepseek = 产品默认的 OpenCode 壳 + api.deepseek.com，走共享 provider 块生成器）
 *   node tools/live-engine-check.cjs opencode --short    # 短提示替代完整蜂巢协议种子
 *   node tools/live-engine-check.cjs opencode --shim-only     # 只验桥面（不拉 CLI）
 *   node tools/live-engine-check.cjs opencode --keep     # 保留临时 harnessHome 供排查
 *   node tools/live-engine-check.cjs opencode --timeout=180000
 *
 * 验证链路（跑完即清理，不留副作用）：
 *   ① 桥面安装：hive.ensureAgent() 真实调用 → 断言 agent 目录/注册表/各引擎桥面
 *      （agy：~/.gemini 两份全局 hooks.json，跑前备份跑后还原；gemini：per-agent
 *      system-settings.json；opencode 壳（opencode 本体 + deepseek）：per-agent
 *      .opencode 目录 —— v2 跳过 v1 插件投放；zcode：无桥）。
 *   ② 种子投递：断言注入 argv = [initialPromptFlag, 提示词]（agy/gemini/opencode），
 *      或 seedDelivery=type-into-tui 时断言返回 seedPrompt（zcode，由本脚本打字递送；
 *      本机只有桌面内置 cjs、无 TUI 运行时 → 改用其 headless --prompt 实测启动链路）。
 *   ③ 真实拉起：node-pty 起真 CLI，HIVE_SOCK 上跑裸 socket 服务收 hook 回报；
 *      「随行引擎」类目（opencode/zcode，不在 PATH）走 **真实 PtyManager +
 *      setEnginesDir** 拉起 —— 同时真机验证 P2 引擎随行目录的解析优先。
 *      拉起不来（未登录 / 网络不通）时自动降级到 ③b。
 *   ③b shim 级实测：直接喂真实生成的 shim（真实 stdin 形状）→ 断言 socket 收到
 *      规范化事件（仅带 shim 的引擎；opencode 走插件、zcode 无桥，标记不适用）。
 *   ④ 汇报：hook 事件清单 + TUI 输出尾部；--keep 时打印临时目录。
 *
 * 退出码：0 全绿；1 断言失败；2 拉起成功但 CLI 侧未闭环（未收到 hook 回报，或无桥
 *  引擎的交互态限制——zcode 桌面内置 cjs 需 TUI 内 /model 选模型）——常见原因：CLI
 *  未登录、后端网络不通；报告给出 TUI 输出尾部供判断。
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test/load-ts.cjs');
const pty = require('node-pty');

/**
 * 各引擎的本机形态。`bundled` 是随桌面版安装包附带、不在 PATH 的 CLI 路径；
 * `stageEngines` 表示把该 CLI 备料进临时 <数据目录>/engines 后用真实 PtyManager
 * （裸命令名）拉起 —— 顺带真机验证 P2 引擎随行目录。`extraArgs` 用于钉住一个
 * 本机可达的后端（opencode 经 DEEPSEEK_API_KEY 识别 DeepSeek）。
 */
const ENGINES = {
  agy: { provider: 'antigravity', bin: 'agy', hasShim: true },
  gemini: { provider: 'gemini', bin: 'gemini', hasShim: true },
  opencode: {
    provider: 'opencode',
    bin: 'opencode',
    bundled: ['/Applications/OpenCode.app/Contents/Resources/opencode-cli'],
    stageEngines: true,
    extraArgs: ['--model', 'deepseek/deepseek-flash'],
    // v2 桌面内置 CLI 已核实：plugin/ 目录会被加载，但 v1 的事件契约
    //（session.idle / tool.execute.*）不触发 → payload 作信息性处理（v1 仍按必需）。
    payloadInformationalWhenV2: true
  },
  deepseek: {
    // 产品路径 = OpenCode 壳（2026-10 真机实测后 deepseek 由 dsh 默认切到该壳；
    // dsh 0.2.0-rc.2 无交互 profile：裸 dsh 报 --profile 必填后退出）。本机
    // OpenCode.app 内置 v2 CLI + DEEPSEEK_API_KEY 环境变量即真实链路。
    provider: 'deepseek',
    opencodeShell: true,
    bin: 'opencode',
    bundled: ['/Applications/OpenCode.app/Contents/Resources/opencode-cli'],
    stageEngines: true,
    extraArgs: ['--model', 'deepseek/deepseek-v4-flash'],
    payloadInformationalWhenV2: true
  },
  zcode: {
    provider: 'zcode',
    bin: 'zcode',
    bundled: ['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'],
    wrapNode: true,
    stageEngines: true,
    expectSock: false, // zcode preset 无桥：种子走打字投递（type-into-tui）
    // 真机实测（2026-10，桌面内置 cjs 0.16.9）：本机只有桌面内置 cjs（非独立命令行版），
    // ① 必须给 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 才能定位内置 provider 配置（否则
    // 报「无法定位 CLI ZCode Built-in Provider Config」）；② TUI 运行时（@zcode/tui）
    // 仅随 SEA / agent bundle 分发，raw cjs 开不了 TUI → 本脚本改用它支持的
    // headless 模式（--prompt）实测启动链路。
    headlessSeed: true,
    builtinProviderConfig: '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'
  }
};

const argv = process.argv.slice(2);
const engineKey = argv.find((a) => !a.startsWith('--')) ?? 'opencode';
const keep = argv.includes('--keep');
const short = argv.includes('--short');
const shimOnly = argv.includes('--shim-only');
const timeoutArg = argv.find((a) => a.startsWith('--timeout='));
const timeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) || 150000 : 150000;

const engine = ENGINES[engineKey];
if (!engine) {
  console.error(`未知引擎：${engineKey}（可用：${Object.keys(ENGINES).join(' / ')}）`);
  process.exit(1);
}
const expectSock = engine.expectSock !== false;
/** OpenCode 壳（opencode 本体、以及 deepseek 这类改走壳的国产引擎）共用同一套
 *  世代探测 / argv 自适应 / 断言。 */
const isOpencodeShell = engine.provider === 'opencode' || engine.opencodeShell === true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

function resolveBin() {
  const which = spawnSync('which', [engine.bin], { encoding: 'utf8' });
  const p = (which.stdout ?? '').trim().split('\n')[0];
  if (p && fs.existsSync(p)) return p;
  for (const c of [`/opt/homebrew/bin/${engine.bin}`, `/usr/local/bin/${engine.bin}`, `${process.env.HOME}/.local/bin/${engine.bin}`]) {
    if (fs.existsSync(c)) return c;
  }
  for (const c of engine.bundled ?? []) if (fs.existsSync(c)) return c;
  return null;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

async function main() {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const bin = resolveBin();
  console.log(`\n=== 真机实测：${engineKey}（provider=${engine.provider}）===`);
  if (!bin) {
    console.error(`未找到 ${engine.bin}，请先安装`);
    process.exit(1);
  }
  console.log(`二进制：${bin}`);
  if (bin.endsWith('.cjs') || bin.endsWith('.js')) {
    const v = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 30000 });
    console.log(`版本：${(v.stdout ?? v.stderr ?? '').trim().split('\n')[0] || '未知'}`);
  } else {
    const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000 });
    console.log(`版本：${(v.stdout ?? v.stderr ?? '').trim().split('\n')[0] || '未知'}`);
  }

  const root = fs.mkdtempSync('/tmp/agflow-live-');
  const harnessHome = path.join(root, 'home');
  fs.mkdirSync(harnessHome, { recursive: true });
  const hive = new HiveManager(() => harnessHome);
  const hiveRoot = hive.root();

  // ── ① 桥面安装（agy 会写用户全局 ~/.gemini/hooks.json → 先备份）──
  const agyGlobalFiles = [
    path.join(process.env.HOME, '.gemini', 'config', 'hooks.json'),
    path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'hooks.json')
  ];
  const backups = agyGlobalFiles.map((p) => ({ p, content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null }));
  // 无论正常结束还是中途抛错，都还原用户的 ~/.gemini（幂等）。
  const restored = { done: false };
  const restoreBackups = () => {
    if (restored.done) return;
    restored.done = true;
    for (const b of backups) {
      try {
        if (b.content === null) fs.rmSync(b.p, { force: true });
        else fs.writeFileSync(b.p, b.content, 'utf8');
      } catch (e) { console.error(`还原 ${b.p} 失败：${e.message}`); }
    }
  };
  process.on('exit', restoreBackups);

  console.log('\n[1/4] 桥面安装（真实调用 hive.ensureAgent）');
  // opencode 壳（opencode 本体与 deepseek）：先探测 CLI 世代（与应用侧
  // spawnAgentCore 同款），v2 传 opencodeV2 → 只建隔离配置目录、不投放 v1 插件
  //（v2 插件契约不同，投放会报 plugins failed）。
  let profile = null;
  if (isOpencodeShell) {
    const { probeOpencodeCli } = loadTs('src/main/opencodeCli.ts');
    profile = probeOpencodeCli(bin);
    check(!!profile, '探测 opencode CLI 旗标面',
      profile ? `tuiModelFlag=${profile.tuiModelFlag} needsStandalone=${profile.needsStandalone}` : '探测失败');
  }
  const meta = { id: 'livecheck', name: '实测员', provider: engine.provider, cwd: root, role: '开发' };
  const promptOverride = short ? '只回复：HIVE-OK（不要调用任何工具）' : null;
  const injection = await hive.ensureAgent(meta, {
    skillsDir: path.resolve(__dirname, '..', 'resources', 'skills'),
    theme: 'light', // 与应用侧 spawnAgentCore 一致（v2 下配置目录靠 theme 落盘）
    ...(profile && !profile.tuiModelFlag ? { opencodeV2: true } : {})
  });

  check(fs.existsSync(path.join(hiveRoot, 'registry.json')), '注册表已写入 registry.json');
  check(fs.existsSync(path.join(hiveRoot, 'agents', 'livecheck', 'identity.md')), 'identity.md 已写入');
  check(fs.existsSync(path.join(hiveRoot, 'agents', 'livecheck', 'inbox')), 'inbox/ 已建');

  const sockPath = injection.env.HIVE_SOCK ?? null;
  if (expectSock) {
    check(!!sockPath && sockPath === hive.sockPath(), 'HIVE_SOCK 已注入', sockPath ?? '缺失');
  } else {
    check(!injection.env.HIVE_SOCK, '无桥引擎不注入 HIVE_SOCK（契约一致）');
  }

  // 种子投递：argv 型（-i / --prompt）或打字型（seedPrompt）
  const typedSeed = injection.seedPrompt ?? null;
  let args = [];
  if (typedSeed !== null) {
    check(!!typedSeed && typedSeed.length > 100, '种子走打字投递（seedPrompt 已返回）', `${typedSeed.length} 字符`);
    if (engine.headlessSeed) {
      // 本地只有桌面内置 cjs（开不了 TUI）→ 用它支持的 headless 模式真跑一次
      args.push('--prompt', promptOverride ?? typedSeed);
    }
  } else {
    for (const a of engine.extraArgs ?? []) args.push(a);
    if (promptOverride) {
      const flag = injection.args.find((a) => a === '-i' || a === '--prompt') ?? '-i';
      args.push(flag, promptOverride);
    } else {
      args.push(...injection.args);
    }
    check(args.includes('-i') || args.includes('--prompt'), '种子投递 argv 含引擎首提示旗标', args.join(' ').slice(0, 80) + '…');
  }

  if (engine.provider === 'antigravity') {
    const shim = path.join(hiveRoot, 'bin', 'agy-hook.cjs');
    check(fs.existsSync(shim), 'agy-hook.cjs 翻译 shim 已落盘');
    for (const p of agyGlobalFiles) {
      let group = null;
      try { group = JSON.parse(fs.readFileSync(p, 'utf8'))['agflow-hive']; } catch { /* 缺失/坏 JSON */ }
      check(!!group && !!group.Stop, `agy 全局 hooks.json 已注入 agflow-hive 组（${path.relative(process.env.HOME, p)}）`);
    }
  } else if (engine.provider === 'gemini') {
    const settingsPath = injection.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    let hooks = null;
    try { hooks = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks; } catch { /* 缺失/坏 JSON */ }
    check(!!settingsPath && fs.existsSync(settingsPath), 'per-agent system-settings.json 已写入');
    check(!!hooks && !!hooks.BeforeTool && !!hooks.AfterAgent, 'gemini hooks 配置齐全（BeforeTool/AfterAgent）');
  } else if (isOpencodeShell) {
    const cfgDir = injection.env.OPENCODE_CONFIG_DIR;
    check(!!cfgDir && fs.existsSync(cfgDir), 'per-agent 隔离配置目录已就绪（不动用户 ~/.config/opencode）', cfgDir ?? '');
    check(cfgDir === path.join(hiveRoot, 'agents', 'livecheck', '.opencode'),
      '配置目录位于 per-agent 隔离目录');
    const inPlugin = !!cfgDir && fs.existsSync(path.join(cfgDir, 'plugin', 'hive-bridge.js'));
    const inPlugins = !!cfgDir && fs.existsSync(path.join(cfgDir, 'plugins', 'hive-bridge.js'));
    if (profile && !profile.tuiModelFlag) {
      check(!inPlugin && !inPlugins, 'v2：跳过 v1 插件投放（不再触发 TUI 的 plugins failed）');
    } else {
      check(inPlugin && inPlugins, 'v1：桥插件双写 plugin/ + plugins/');
    }
  }

  // ── ②③ 裸 socket 服务 + 真实拉起 ──
  const payloads = [];
  let closeServer = null;
  if (expectSock) {
    const server = net.createServer((conn) => {
      let buf = '';
      let replied = false;
      conn.setEncoding('utf8');
      conn.on('data', (d) => {
        buf += d;
        if (replied || !buf.includes('\n')) return;
        replied = true;
        for (const line of buf.split('\n').filter(Boolean)) {
          try {
            const p = JSON.parse(line);
            payloads.push({ at: Date.now(), event: p.hook_event_name, agent: p.agent_id, tool: p.tool_name });
          } catch { /* 非 JSON 行忽略 */ }
        }
        // 与真实 HookServer 对齐：答复即 end()，shim/插件的回调才会收尾
        conn.end();
      });
      conn.on('error', () => {});
    });
    await new Promise((res) => server.listen(sockPath, res));
    closeServer = () => new Promise((res) => server.close(res));
  }

  let output = '';
  let manager = null;
  let ptyProc = null;
  const firstPayloadAt = { t: 0 };
  let exitedAt = 0;
  /** v2 桌面内置 CLI（payload 契约差异 → 信息性）；v1 保持必需。 */
  let v2Opencode = false;

  if (!shimOnly) {
    console.log(`\n[2/4] 真实拉起：${engineKey} ${short ? '(短提示)' : '(完整蜂巢协议种子)'} @ ${root}`);
    // opencode 壳：调用应用侧同一适配器（main/opencodeCli.ts）——探测 CLI 世代后
    // 改写 argv（v2 摘 --model 改注 config、补 --standalone），与 spawnAgentCore 同款；
    // 国产引擎（deepseek）的 provider 块用共享生成器（产品同款，含端点/密钥引用）。
    let liveArgs = args;
    const extraEnv = { ...injection.env };
    if (isOpencodeShell) {
      const { adaptOpencodeArgs } = loadTs('src/main/opencodeCli.ts');
      const adapted = adaptOpencodeArgs(args, profile); // 复用 ① 步探测结果（同应用侧缓存行为）
      liveArgs = adapted.args;
      v2Opencode = !!profile && !profile.tuiModelFlag;
      if (adapted.model) {
        const oc = { model: adapted.model };
        const { DOMESTIC_ENGINES, domesticOpencodeProviderBlocks } = loadTs('src/shared/domesticEngines.ts');
        const engRow = DOMESTIC_ENGINES.find((e) => e.id === engine.provider);
        if (engRow) oc.provider = domesticOpencodeProviderBlocks(engRow, engRow.baseUrl, adapted.model);
        extraEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
        check(liveArgs.includes('--standalone') && !liveArgs.includes('--model'),
          'v2 自适应：--model 摘除 + 模型改注 config + --standalone 补上',
          liveArgs.join(' ').slice(0, 70));
      }
    }
    if (engine.builtinProviderConfig) {
      // 真机实测的必需项（桌面内置 cjs）：靠它定位内置 provider 配置，否则启动即报
      //「无法定位 CLI ZCode Built-in Provider Config」。
      check(fs.existsSync(engine.builtinProviderConfig),
        'zcode：注入 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（桌面内置 provider 配置）',
        engine.builtinProviderConfig);
      extraEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = engine.builtinProviderConfig;
    }
    if (engine.stageEngines) {
      // P2 引擎随行目录真机验证：CLI 不在 PATH，备料进 <数据目录>/engines，
      // 用真实 PtyManager（裸命令名）拉起 —— 能起来就证明解析优先命中随行目录。
      const enginesDir = path.join(root, 'data', 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const target = path.join(enginesDir, engine.bin);
      if (engine.wrapNode) {
        fs.writeFileSync(target, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`, { mode: 0o755 });
      } else {
        fs.copyFileSync(bin, target);
        fs.chmodSync(target, 0o755);
      }
      const { PtyManager } = loadTs('src/main/pty.ts');
      manager = new PtyManager();
      manager.setEnginesDir(enginesDir);
      manager.setExitHandler((id) => { if (id === 'livecheck') exitedAt = Date.now(); });
      manager.attachWebContents({
        isDestroyed: () => false,
        send: (_ch, data) => { if (typeof data === 'string') output += data; }
      });
      const res = manager.spawn({
        id: 'livecheck',
        cwd: root,
        command: engine.bin,
        args: liveArgs,
        cols: 140,
        rows: 36,
        env: { ...process.env, ...extraEnv, TERM: 'xterm-256color', COLORFGBG: '15;0' }
      });
      check(res.ok, `引擎随行目录：不在 PATH 的 ${engine.bin} 由 <数据目录>/engines 解析并拉起`, res.error ?? '');
      const session = manager.list().find((s) => s.id === 'livecheck');
      check(!!session && session.command === target, '解析结果 = 随行目录内的路径（优先于系统 PATH）',
        session?.command ?? '无会话');
    } else {
      ptyProc = pty.spawn(bin, liveArgs, {
        name: 'xterm-256color',
        cols: 140,
        rows: 36,
        cwd: root,
        env: { ...process.env, ...extraEnv, TERM: 'xterm-256color', COLORFGBG: '15;0' }
      });
      ptyProc.onData((d) => { output += d; });
      ptyProc.onExit(() => { exitedAt = Date.now(); });
    }

    // 打字投递型（zcode 的 TUI 路径）：等 TUI 起来后把种子打进终端（渲染端平时做的同一件事）
    // headless 模式（本机 cjs 产物）种子已随 argv 送达，无需打字。
    if (typedSeed !== null && manager && !engine.headlessSeed) {
      await sleep(short ? 6000 : 9000);
      manager.write('livecheck', (short ? '只回复：HIVE-OK' : typedSeed) + '\r');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (payloads.length > 0 && !firstPayloadAt.t) firstPayloadAt.t = Date.now();
      if (firstPayloadAt.t && Date.now() - firstPayloadAt.t > 8000) break;
      if (exitedAt && !firstPayloadAt.t && Date.now() - exitedAt > 3000) break;
      await sleep(400);
    }
    try { if (manager) manager.kill('livecheck'); } catch { /* 已退出 */ }
    try { if (ptyProc) ptyProc.kill(); } catch { /* 已退出 */ }
  }
  const lived = firstPayloadAt.t ? Date.now() - firstPayloadAt.t : 0;
  const livePayloads = payloads.length;

  console.log(`\n[3/4] 实时 hook 回报`);
  if (shimOnly) {
    console.log('  （已跳过）');
  } else if (!expectSock) {
    console.log('  （该引擎无桥，hook 回报不适用；以拉起 + TUI 输出为准）');
  } else if (payloads.length === 0) {
    console.log(v2Opencode && engine.payloadInformationalWhenV2
      ? '  （未收到 payload —— v2 桌面内置 CLI 的插件契约差异，信息性，不阻塞）'
      : '  （未收到任何 payload）');
  } else {
    for (const p of payloads) {
      const rel = firstPayloadAt.t ? ((p.at - firstPayloadAt.t) / 1000).toFixed(1) : '0.0';
      console.log(`  +${rel}s ${p.event ?? '?'} agent=${p.agent ?? '-'} tool=${p.tool ?? '-'}`);
    }
  }

  // ── ③b shim 级实测：CLI 拉不起来时的降级验证（仅带 shim 的引擎）──
  let shimOk = false;
  if (engine.hasShim && (shimOnly || livePayloads === 0)) {
    console.log('\n[3b/4] shim 级实测（真实 shim 产物 + 真实 socket）');
    const shimPath = engine.provider === 'antigravity'
      ? path.join(hiveRoot, 'bin', 'agy-hook.cjs')
      : path.join(path.dirname(injection.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH), 'gemini-hook.cjs');
    const cases = engine.provider === 'antigravity'
      ? [
          { argv: ['PreToolUse'], stdin: { toolCall: { name: 'run_command', args: { CommandLine: 'pwd' } }, conversationId: 'live-check', workspacePaths: [root] }, expect: 'PreToolUse' },
          { argv: ['Stop'], stdin: {}, expect: 'Stop' }
        ]
      : [
          { argv: [], stdin: { hook_event_name: 'BeforeTool', tool_name: 'shell', tool_input: { command: 'pwd' }, session_id: 'live-check', cwd: root }, expect: 'PreToolUse' },
          { argv: [], stdin: { hook_event_name: 'AfterAgent', session_id: 'live-check', cwd: root }, expect: 'Stop' }
        ];
    let all = true;
    for (const c of cases) {
      const before = payloads.length;
      const res = spawnSync(process.execPath, [shimPath, ...c.argv], {
        input: JSON.stringify(c.stdin),
        env: { ...process.env, AGENT_ID: 'livecheck', HIVE_SOCK: sockPath },
        encoding: 'utf8',
        timeout: 10000
      });
      const deadline2 = Date.now() + 4000;
      while (payloads.length === before && Date.now() < deadline2) await sleep(100);
      const got = payloads.slice(before).find((p) => p.event === c.expect);
      const ok = !!got;
      if (!ok) all = false;
      check(ok, `shim ${c.argv[0] || c.stdin.hook_event_name} → 事件 ${c.expect}`, ok ? `tool=${got.tool ?? '-'}` : `无回报（exit=${res.status}）`);
    }
    shimOk = all;
  } else if (!engine.hasShim && (shimOnly || livePayloads === 0)) {
    console.log('\n[3b/4] shim 级实测：不适用（该引擎无 shim：opencode 走插件 / zcode 无桥）');
  }

  console.log(`\n[4/4] TUI 输出尾部（ANSI 已剥离，最近 24 行）`);
  const tail = stripAnsi(output).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-24);
  for (const line of tail) console.log(`  │ ${line}`);
  if (!shimOnly && output.length === 0) check(false, 'TUI 有输出（进程真实存活）');
  // OpenCode 壳（opencode 本体与 deepseek）：证明「模型经 config 注入」真实生效
  //（否则会退回内置默认并报 deprecated）。
  if (!shimOnly && isOpencodeShell) {
    check(/deepseek/i.test(stripAnsi(output)), 'config 注入的模型真实生效（TUI 显示 DeepSeek，非内置默认）');
    if (v2Opencode) check(!/plugins?\s+failed/i.test(stripAnsi(output)), 'v2：跳过 v1 插件投放后 TUI 无 plugins failed 警告');
  }
  // zcode（桌面内置 cjs）：启动链路 = provider 配置可定位 + 无缺包；模型回合要求先在
  // TUI 里 /model 选模型，而 raw cjs 没有 TUI 运行时（@zcode/tui 仅随 SEA/agent bundle）
  // → 记为 CLI 侧交互态限制（环境限制），不作 AgFlow 侧失败。
  let zcodeModelBlocked = false;
  if (!shimOnly && engine.provider === 'zcode') {
    const clean = stripAnsi(output);
    check(!/无法定位 CLI ZCode Built-in Provider Config|Cannot find package/.test(clean),
      'zcode CLI 启动链路正常（内置 provider 配置可定位、无缺包）');
    zcodeModelBlocked = /Select a model before continuing|Model creation failed/.test(clean);
    if (zcodeModelBlocked) {
      console.log('  （信息性）CLI 已进入会话初始化（session / MCP 均启动），但要求先在 TUI 里');
      console.log('  用 /model 选择模型；本机只有桌面内置 cjs（非独立命令行版），无法产生该交互态。');
    }
  }

  // ── 清理 ──
  if (expectSock) {
    await closeServer();
    try { fs.unlinkSync(sockPath); } catch { /* server.close 已释放 */ }
  }
  restoreBackups();
  if (keep) console.log(`\n临时目录保留：${root}`);
  else fs.rmSync(root, { recursive: true, force: true });

  // ── 结论 ──
  console.log('\n=== 结论 ===');
  if (failures.length > 0) {
    console.log(`断言失败 ${failures.length} 项：${failures.join('；')}`);
    process.exit(1);
  }
  if (shimOnly) {
    console.log(`桥面安装 ✔ / 种子 argv ✔ / shim ↔ socket 链路 ${engine.hasShim ? (shimOk ? '✔' : '✘') : '（不适用）'}`);
    process.exit(engine.hasShim && !shimOk ? 1 : 0);
  }
  if (!expectSock) {
    if (zcodeModelBlocked) {
      console.log('zcode 实测结论：AgFlow 侧链路全部通过（种子打字投递契约 ✔ / 随行目录解析 ✔ / 真实拉起 ✔）；');
      console.log('CLI 本体会话初始化 ✔（session / MCP 启动、内置 provider 配置定位成功），但模型选择是 CLI 自身的');
      console.log('交互态（TUI /model），本机产物（桌面内置 cjs）无法产生 → 模型回合未完成（环境限制，非 AgFlow 侧）。');
      process.exit(2);
    }
    console.log(`全链路通过（无桥引擎）：桥面 ✔ / 种子打字投递 ✔ / 真实拉起 ✔ / 随行目录解析 ✔`);
    console.log('登录态与模型可用性以上方 TUI 输出为准。');
    process.exit(0);
  }
  if (livePayloads === 0) {
    if (engine.payloadInformationalWhenV2 && v2Opencode) {
      console.log('插件桥事件未触发 —— 已核实为 v2 桌面内置 CLI 的插件契约差异（v1 事件名不生效），非 AgFlow 侧回归。');
      console.log('桥面安装 / 种子投递 / 真实拉起 / 随行目录解析 / 配置模型注入 全部通过；该发行线上的实时状态与收件箱唤醒走渲染端兜底（产品内已注明）。');
      process.exit(0);
    }
    console.log(`拉起与桥面安装均通过，但 ${Math.round(timeoutMs / 1000)}s 内未收到 CLI 的 hook 回报。`);
    console.log('常见原因：CLI 未登录（停在登录界面）、引擎后端网络不通、或该版本 hooks 未触发——对照上方 TUI 输出尾部判断。');
    console.log(`shim 级链路：${shimOk ? '✔ 已通过（真实 shim → socket 契约成立，缺的只是 CLI 触发那一跳）' : '✘ 未通过——问题在 AgFlow 侧，需排查'}`);
    process.exit(shimOk ? 2 : 1);
  }
  console.log(`全链路通过：桥面安装 ✔ / 种子投递 ✔ / 真实拉起 ✔ / hook 回报 ${livePayloads} 次（首个 ${lived > 0 ? (lived / 1000).toFixed(1) + 's' : '即时'}）${engine.stageEngines ? ' / 随行目录解析 ✔' : ''}`);
}

main().catch((e) => {
  console.error('实测脚本异常：', e);
  process.exit(1);
});