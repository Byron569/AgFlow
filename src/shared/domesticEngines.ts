import type { AgentProvider } from './agentProvider';

/**
 * 国产引擎注册表 (P0-C C-1) — the single source of truth for how a domestic
 * engine is run. doubao/glm/ollama/deepseek ride the OpenCode shell with a
 * generated provider block (spawnAgentCore's OPENCODE_CONFIG_CONTENT path).
 * deepseek 曾默认走官方 Harness CLI（`dsh`）；真机实测（2026-10，dsh 0.2.0-rc.2）
 * 证明该发行线只有 web/desktop/headless 三种 profile、没有可交互的终端 profile
 * （npm 与桌面包均无 tui bundle；裸 `dsh` 报 `--profile <name> is required` 后
 * 退出，`dsh headless` 必须带 argv 任务且一轮即退）——无法承载常驻工人，故按
 * C-7 验证结论把默认壳切回 OpenCode（dsh 仍可手动在命令框使用）。
 *
 * `baseUrl`/`keyEnv` are DEFAULT values; the user's per-provider override in
 * HarnessConfig.providerBaseUrls always wins. Key MATERIAL is not here — it
 * stays write-only in the secret broker under `apikey:<keyRef>` and is
 * materialized main-only at spawn (never over IPC, never logged).
 *
 * Shared between main and renderer; keep it dependency-free.
 */
export interface DomesticEngine {
  id: Extract<AgentProvider, 'doubao' | 'glm' | 'deepseek' | 'ollama'>;
  label: string;
  /** Which CLI carries the engine. */
  shell: 'opencode' | 'dsh';
  /** OpenAI-compatible endpoint used when the user has not set an override. */
  baseUrl: string;
  /** Env var the shell reads for its key at spawn. '' = keyless (local Ollama). */
  keyEnv: string;
  /** Secret-broker backend name — the key is stored as `apikey:<keyRef>`, and
   *  the same name is the backend id the Settings key form submits. '' = keyless. */
  keyRef: string;
  /** Model ids offered for this engine, WITHOUT the `<id>/` spawn-slug prefix
   *  (the OpenCode provider block declares these as its inner ids). */
  models: { id: string; label: string }[];
  /** 设置页端点输入框的用户提示（可选）。缺省 = `${baseUrl}（默认端点，可覆盖）`；
   *  有订阅专用端点等额外说明的引擎在此覆盖（如 GLM 的 Coding Plan / ZCode 端点）。 */
  hint?: string;
}

export const DOMESTIC_ENGINES: DomesticEngine[] = [
  {
    id: 'doubao',
    label: '豆包 · 火山方舟',
    shell: 'opencode',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyEnv: 'ARK_API_KEY',
    keyRef: 'ark',
    models: [
      { id: 'doubao-seed-2.1-pro', label: '豆包 Seed 2.1 Pro' },
      { id: 'doubao-seed-2.1-lite', label: '豆包 Seed 2.1 Lite' }
    ]
  },
  {
    id: 'glm',
    label: 'GLM · 智谱',
    shell: 'opencode',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyEnv: 'GLM_API_KEY',
    keyRef: 'glm',
    // ZCode（智谱官方 ADE，仅 GUI、无 CLI）等价接入 = 同一把 GLM 密钥 + Coding Plan
    // 专用端点：订阅用户（GLM Coding Plan，ZCode 同款套餐）应改用该端点。
    hint: 'https://open.bigmodel.cn/api/paas/v4（默认端点，可覆盖）；GLM Coding Plan（ZCode 同款套餐）订阅用户请填 https://open.bigmodel.cn/api/coding/paas/v4',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3' },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash' }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // 真机实测（2026-10）后改走 OpenCode 壳：dsh 无交互 profile（见文件头注释）。
    // 端点/key 走注册表生成的 provider 块，slug 为 `deepseek/<id>`。
    shell: 'opencode',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    keyRef: 'deepseek',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4 Pro' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek-V4 Flash' }
    ]
  },
  {
    id: 'ollama',
    label: 'Ollama · 本地模型',
    shell: 'opencode',
    // 本机默认端口；可在设置中覆盖为 LM Studio/vLLM 等任意 OpenAI 兼容端点。
    // 注入侧同时声明 local/ 与 ollama/ 两个 provider 块（catalog 用前者、本地
    // 快选用后者）；已装模型发现走 <root>/api/tags（shared/ollamaScan.ts）。
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: '',
    keyRef: '',
    models: [
      { id: 'qwen3-coder:30b', label: '本地 · Qwen3-Coder 30B' },
      { id: 'deepseek-r1:32b', label: '本地 · DeepSeek-R1 32B' },
      { id: 'glm-4.7-flash', label: '本地 · GLM-4.7-Flash' }
    ]
  }
];

/** The registry row for a provider, or undefined when it is not 国产. */
export function domesticEngineFor(provider: AgentProvider | undefined): DomesticEngine | undefined {
  return DOMESTIC_ENGINES.find((e) => e.id === provider);
}

/**
 * 生成国产引擎在 OpenCode 壳里的 provider 块（真机实测脚本与 spawnAgentCore 共用，
 * 保证「实测跑的配置 = 产品生成的配置」）。
 * - blockIds：Ollama 需要 `local/` 与 `ollama/` 两个同端点块（catalog 用前者、
 *   本地快选用后者，两种 slug 都能解析）；其余引擎只声明自身 id。
 * - 未选中模型（无 `<id>/` 前缀或前缀不匹配）时回落注册表首个模型；
 *   模型显示名取注册表 label，找不到则用原始 id。
 */
export function domesticOpencodeProviderBlocks(
  eng: DomesticEngine,
  baseUrl: string,
  modelSlug: string
): Record<string, unknown> {
  const blockIds = eng.id === 'ollama' ? ['local', 'ollama'] : [eng.id];
  const prefix = modelSlug.includes('/') ? modelSlug.split('/')[0].toLowerCase() : '';
  const matched = blockIds.find((b) => prefix === b && modelSlug.length > b.length + 1);
  const inner = matched ? modelSlug.slice(matched.length + 1) : eng.models[0]?.id ?? 'default';
  const options: Record<string, unknown> = { baseURL: baseUrl };
  if (eng.keyEnv) options.apiKey = `{env:${eng.keyEnv}}`;
  return Object.fromEntries(blockIds.map((b) => [b, {
    npm: '@ai-sdk/openai-compatible',
    name: eng.label,
    options,
    models: { [inner]: { name: eng.models.find((m) => m.id === inner)?.label ?? inner } }
  }]));
}