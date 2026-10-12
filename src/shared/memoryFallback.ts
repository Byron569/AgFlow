/**
 * 记忆检索的全文回退（中文优先）。
 *
 * 语义通道走 mempalace（向量模型由 embeddingModel 决定）：默认已是多语言
 * embeddinggemma，但用户可切回仅英文的 minilm；mempalace 也可能未安装、
 * 未启用，或刚写入的记忆还没被 mine 进宫殿。这些情况下中文查询最可靠的
 * 通道是全文精确匹配——hive:textSearch 是全文件子串扫描（indexOf），没有
 * 分词步骤，对 CJK 天然可靠。
 *
 * 这里保持纯函数，便于 node:test 直接覆盖（test/memory-fallback.test.cjs）。
 */

/** hive:textSearch 的一行命中：来源标签 + 匹配行摘录。 */
export interface TextHit {
  source: string;
  excerpt: string;
}

/**
 * 是否追加全文回退：
 *   - 查询含 CJK 统一表意文字（含扩展 A / 兼容区）→ 总是回退，
 *     因为语义模型是否命中中文取决于用户选的模型；
 *   - 其余情况只在语义检索失败或零结果时回退。
 */
export function wantsTextFallback(
  query: string,
  semantic: { ok: boolean; output: string }
): boolean {
  if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(query)) return true;
  return !semantic.ok || !semantic.output.trim();
}

/** 把命中渲染成面板文本：一条两行（来源、缩进摘录），条目间换行。 */
export function formatTextHits(hits: readonly TextHit[]): string {
  return hits.map((h) => `${h.source}\n  ${h.excerpt}`).join('\n');
}