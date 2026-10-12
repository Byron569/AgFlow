/**
 * The missing-engine-CLI install ladder.
 *
 * Split out of index.ts deliberately: it imports NOTHING from electron, so the
 * decision ("which installer can actually succeed on this machine?") and the
 * script it emits are both testable without booting an app.
 */
import type { AgentProvider, ProviderInstallInfo } from '../shared/agentProvider';
import { installInfoForProvider } from '../shared/agentProvider';
import { withNpmRegistry } from '../shared/mirrors';
import type { NodeInstaller } from './nodeInstall';
import { buildNodeInstallScript } from './nodeInstall';

export type InstallRungKind = 'npm' | 'node-then-npm' | 'native' | 'manual';

/** Pick which rung of the install ladder to run, given what this machine has.
 *
 *  Every provider's `installCommand` is `npm install -g …`, which needs npm,
 *  which needs node. On a machine with no node the banner used to print that
 *  command anyway and run it — so the user watched `npm: command not found`
 *  scroll past and concluded the app was broken. Classify first:
 *
 *    npm usable                        → npm install (unchanged; the common case)
 *    npm absent, Node installer found  → install real Node + npm, THEN npm install
 *    npm absent, native installer      → the vendor's self-contained installer
 *    neither                           → manual only. Do NOT run a doomed command.
 *
 *  Founder decision (2026-08-07) put `node-then-npm` ABOVE `native`, reversing the
 *  earlier "never auto-install a system Node" rule: a user who only ever gets the
 *  node-free Claude installer still has no runtime for MCP servers, hooks, or any
 *  other provider — so the default is to fix the machine, not to route around it.
 *  `native` survives as the fallback for when no installer could be resolved
 *  (offline, or a platform nodejs.org ships no package for).
 *
 *  `npmAvailable` means npm is present AND its Node is new enough (see
 *  nodeInstall.NODE_FLOOR_MAJOR) — an ancient Node routes into the upgrade rung. */
export function chooseInstallRung(
  info: ProviderInstallInfo,
  npmAvailable: boolean,
  nodeInstaller?: NodeInstaller | null
): { command?: string; kind: InstallRungKind; nodeMissing: boolean } {
  if (info.command && npmAvailable) return { command: info.command, kind: 'npm', nodeMissing: false };
  if (info.command && nodeInstaller) return { command: info.command, kind: 'node-then-npm', nodeMissing: true };
  if (info.nativeCommand) return { command: info.nativeCommand, kind: 'native', nodeMissing: !npmAvailable };
  return { kind: 'manual', nodeMissing: !npmAvailable };
}

/** Build the shell script the missing-CLI auto-install path runs IN PLACE of a
 *  missing engine CLI. When a rung of the ladder above is runnable it prints a
 *  banner then RUNS it visibly (so the user can watch + finish any sign-in);
 *  otherwise it prints a manual instruction only and runs nothing. The script is
 *  emitted in the target platform's shell syntax ($SHELL on unix, cmd.exe on
 *  Windows) — `platform` is a parameter only so the Windows branch is reachable
 *  from a test on macOS. The only user-derived value (the missing binary name) is
 *  sanitized to a safe identifier; the install commands are trusted constants, and the
 *  optional npm registry override is validated by shared/mirrors.ts before splicing. */
export function buildMissingCliScript(
  bin: string,
  provider: AgentProvider,
  npmAvailable: boolean,
  platform: string = process.platform,
  nodeInstaller?: NodeInstaller | null,
  npmRegistry?: string
): string {
  const info: ProviderInstallInfo = installInfoForProvider(provider, platform);
  const safeBin = (bin || provider).replace(/[^A-Za-z0-9._-]/g, '') || provider;
  const rung = chooseInstallRung(info, npmAvailable, nodeInstaller);
  // Only the rung that actually needs it gets the Node install spliced in.
  const nodeSteps = rung.kind === 'node-then-npm' && nodeInstaller
    ? buildNodeInstallScript(nodeInstaller, platform)
    : null;
  const cmd = rung.command ? withNpmRegistry(rung.command, npmRegistry) : rung.command; // trusted constant (+可选镜像源), or undefined → manual hint only
  const label = info.label;
  const docs = info.docsUrl;
  const rule = '------------------------------------------------------------';

  if (platform === 'win32') {
    // ONE cmd.exe line: `&` chains steps, `^&` prints a literal ampersand, and the
    // script carries NO double-quotes (it is wrapped verbatim in `/d /s /c "..."`).
    // We avoid `if errorlevel` branching (untestable here) — a combined success/
    // failure hint after the install is robust and satisfies the manual-fallback DoD.
    const parts: string[] = ['echo.', `echo ${rule}`, `echo   未找到引擎 CLI：${safeBin}`, 'echo.'];
    if (nodeSteps && nodeInstaller) {
      parts.push(
        'echo   这台机器上还没有 Node.js，常规 npm',
        `echo   安装程序暂时跑不了。先安装 Node ${nodeInstaller.version} ^(+ npm^)，`,
        'echo   从 nodejs.org 官方下载，带校验。',
        'echo.',
        ...nodeSteps,
        'echo.'
      );
    } else if (rung.nodeMissing) {
      parts.push('echo   这台机器上还没有 Node.js，常规 npm', 'echo   安装程序在这里跑不了。', 'echo.');
    }
    if (cmd) {
      if (rung.kind === 'native') parts.push(`echo   改用 ${label} 自带的安装程序 ^(无需 Node^)：`);
      else parts.push(`echo   正在安装 ${label} CLI，你可以看着它跑：`);
      parts.push(
        'echo.',
        `echo     ${cmd}`,
        `echo ${rule}`,
        'echo.',
        cmd,
        'echo.',
        'echo   [完成] 如果安装成功，智能体会自动启动。',
        'echo   如果没成功，请手动运行上面的命令，然后重新生成该智能体。'
      );
    } else {
      if (rung.nodeMissing) {
        parts.push(
          `echo   先安装 Node.js ^(nodejs.org^)，再装 ${label} CLI：`,
          `echo     ${info.command ? withNpmRegistry(info.command, npmRegistry) : ''}`,
          'echo   …或者按它文档推荐的任意方式安装 CLI。'
        );
      } else {
        parts.push(
          `echo   ${label} 提供方没有可用的安装程序。`,
          'echo   请手动安装，然后重新生成该智能体以启动它。'
        );
      }
      if (docs) parts.push(`echo   文档：${docs}`);
      parts.push(`echo ${rule}`);
    }
    return parts.join(' & ');
  }

  // unix ($SHELL -lc <script>): one statement per line, single-quoted echo text so
  // no shell metacharacter expands. We avoid `!` so any shell with history
  // expansion never fires. npm is found via the interactive PATH spawn() injects.
  const lines: string[] = [
    `echo ''`,
    `echo '${rule}'`,
    `echo '  未找到引擎 CLI：${safeBin}'`,
    `echo ''`
  ];
  if (nodeSteps && nodeInstaller) {
    // The default path on a bare machine: fix the runtime, then use it. Every
    // step aborts the whole script on failure, so the npm install below only
    // ever runs against a Node that actually landed.
    lines.push(
      `echo '  这台机器上还没有 Node.js，常规 npm 安装暂时跑不了。'`,
      `echo '  先安装 Node ${nodeInstaller.version}（含 npm），'`,
      `echo '  从 nodejs.org 官方下载，带校验。'`,
      `echo ''`,
      ...nodeSteps,
      `echo ''`
    );
  } else if (rung.nodeMissing) {
    lines.push(
      `echo '  这台机器上还没有 Node.js，常规 npm 安装在这里跑不了。'`,
      `echo ''`
    );
  }
  if (cmd) {
    lines.push(
      ...(rung.kind === 'native'
        ? [`echo '  改用 ${label} 自带的安装程序（无需 Node）——'`,
           `echo '  按它的提示完成登录，然后回到这个终端。'`]
        : [`echo '  正在安装 ${label} CLI，你可以看着它跑——完成'`,
           `echo '  它的登录提示后回到这个终端。'`]),
      `echo ''`,
      `echo '    ${cmd}'`,
      `echo '${rule}'`,
      `echo ''`,
      cmd,
      `__clirc=$?`,
      `echo ''`,
      `if [ $__clirc -eq 0 ]; then`,
      `  echo '  [完成] 已安装——正在启动智能体…'`,
      `else`,
      `  echo "  [x] 安装退出码 $__clirc——请手动完成："`,
      `  echo '    ${cmd}'`,
      ...(docs ? [`  echo '    文档：${docs}'`] : []),
      `  echo '  然后重新生成该智能体以启动它。'`,
      `fi`
    );
  } else if (rung.nodeMissing) {
    // The honest dead end: no node, and this vendor ships no node-free installer.
    // Say what is actually missing instead of running a command that cannot work.
    lines.push(
      `echo '  先安装 Node.js（nodejs.org），再装 ${label} CLI：'`,
      ...(info.command ? [`echo '    ${withNpmRegistry(info.command, npmRegistry)}'`] : []),
      `echo '  …或者按它文档推荐的任意方式安装 CLI。'`,
      ...(docs ? [`echo '  文档：${docs}'`] : []),
      `echo '${rule}'`
    );
  } else {
    lines.push(
      `echo '  ${label} 提供方没有可用的安装程序。'`,
      `echo '  请手动安装，然后重新生成该智能体以启动它。'`,
      ...(docs ? [`echo '  文档：${docs}'`] : []),
      `echo '${rule}'`
    );
  }
  return lines.join(String.fromCharCode(10));
}
