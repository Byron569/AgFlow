/**
 * 总控人设（P1-4）——风格 / 策略的合法值与注入文本。
 *
 * 值域与注入文本放在 shared：渲染端（设置面板的选项列表）与 main（hive 协议注入）
 * 读同一份。默认（未设置）不注入任何行——提示词与旧版逐字相同，兼容 prompt cache；
 * 注入本身在 spawn 时读一次，改动在下一次生成时生效。
 *
 * 名称不在本模块：真相源唯一——registry 的改名通道（hive.renameAgent）。
 */

export const GOD_STYLES = ['concise', 'warm', 'formal'] as const;
export type GodStyle = typeof GOD_STYLES[number];

export const GOD_STRATEGIES = ['cautious', 'aggressive'] as const;
export type GodStrategy = typeof GOD_STRATEGIES[number];

/** 设置面板 / 持久化的形状。avatar = cast key（'lead' / 'dev' …）。 */
export interface GodPersona {
  style?: GodStyle;
  strategy?: GodStrategy;
  avatar?: string;
}

export const GOD_STYLE_PROMPT: Record<GodStyle, string> = {
  concise: '沟通风格（用户设定）：言简意赅——先结论后细节，能一句说清就不写三句；对人类的汇报与对智能体的派发都照此收紧。',
  warm: '沟通风格（用户设定）：友好、有温度——像并肩干活的同事；鼓励具体而真诚，不客套、不敷衍。',
  formal: '沟通风格（用户设定）：正式、克制——用词规范、结论先行；避免口语、俚语与玩笑。'
};

export const GOD_STRATEGY_PROMPT: Record<GodStrategy, string> = {
  cautious: '编排策略（用户设定）：稳妥优先——小步验证再扩大；拿不准先做侦察或直接问人类，宁可慢一点，不做返工。',
  aggressive: '编排策略（用户设定）：主动出击——能并行就并行、能复用就复用；先跑起来再纠偏；破坏性操作与花真钱仍必须先经人类。'
};

/** 人设注入行：对合法值取对应文本，未设置 / 未知值 = 空串（调用方 filter 掉）。 */
export function buildGodPersonaPrompt(persona?: { style?: string; strategy?: string } | null): string {
  const style = GOD_STYLE_PROMPT[persona?.style as GodStyle] ?? '';
  const strategy = GOD_STRATEGY_PROMPT[persona?.strategy as GodStrategy] ?? '';
  return [style, strategy].filter(Boolean).join(' ');
}