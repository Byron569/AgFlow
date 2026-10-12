/**
 * Ollama 本地模型发现（P1「GLM / Ollama 完整化」）。
 *
 * 读取本机 Ollama 的 `/api/tags`（根地址 = OpenAI 兼容 base 去掉尾部 `/v1`）。
 * 纯函数 + fetch，不依赖 node/electron：main 用它执行扫描（避开渲染进程的
 * CORS/CSP），渲染端只 import 类型；测试直接装载本模块。
 */

export interface OllamaModelInfo {
  /** 模型标签，如 `qwen3-coder:30b`（拼派生 slug 时保持原样，含冒号）。 */
  name: string;
  /** 磁盘占用（字节）；未知为 0。 */
  sizeBytes: number;
  /** 参数量描述，如 `30.5B`（来自 details.parameter_size）。 */
  parameters?: string;
  /** 模型族，如 `qwen3`（来自 details.family）。 */
  family?: string;
}

export interface OllamaScanResult {
  ok: boolean;
  models?: OllamaModelInfo[];
  error?: string;
}

/** OpenAI 兼容 base（`http://127.0.0.1:11434/v1`）→ Ollama 根（去尾 `/v1` 与斜杠）。 */
export function ollamaRootFromBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** 解析 `/api/tags` 响应；形状不符的条目丢弃，绝不抛。 */
export function parseOllamaTags(raw: unknown): OllamaModelInfo[] {
  const list = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  const out: OllamaModelInfo[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : typeof o.model === 'string' ? o.model : '';
    if (!name) continue;
    const details = (typeof o.details === 'object' && o.details !== null ? o.details : {}) as Record<string, unknown>;
    out.push({
      name,
      sizeBytes: typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : 0,
      parameters: typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
      family: typeof details.family === 'string' ? details.family : undefined
    });
  }
  return out;
}

/** 扫描本机 Ollama；超时/连接失败返回 ok:false（不抛，UI 直接展示原因）。 */
export async function listOllamaModels(rootUrl: string, timeoutMs = 3000): Promise<OllamaScanResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${rootUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `Ollama 返回 HTTP ${res.status}` };
    return { ok: true, models: parseOllamaTags(await res.json()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}