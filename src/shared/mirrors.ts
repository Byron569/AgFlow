/**
 * 镜像/自定义源 URL 的校验与注入（npm registry、更新源）。
 *
 * 这些值会被写进 shell 安装脚本（`npm --registry …`）和 electron-updater 的
 * feed 配置，所以在这里集中做边界校验：只接受 https 且字符集保守的 URL
 * （不含引号、&、空格、$ 等 shell 元字符——Windows 的 cmd.exe 单行脚本尤其
 * 怕 `&` 和引号）。非法值一律按“未配置”处理：绝不把用户输入原样拼进命令。
 */

/** 校验一个镜像/自定义源 URL；非法或缺失时返回 undefined（= 用官方默认）。 */
export function sanitizeMirrorUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (!/^https:\/\/[A-Za-z0-9._\-:/]+$/.test(v)) return undefined;
  return v;
}

/**
 * 给 npm 安装命令追加 `--registry <源>`；只处理 `npm install …` 形态的命令
 * （curl / uv / winget / powershell 等原样返回）。未配置或非法时原样返回。
 */
export function withNpmRegistry(command: string, raw: unknown): string {
  const registry = sanitizeMirrorUrl(raw);
  if (!registry) return command;
  if (!/^npm\s+(install|i|add)\b/.test(command)) return command;
  return `${command} --registry ${registry}`;
}