# AgFlow 二次开发 · 开发对话记录

> 项目：`/Users/user/AgFlow`（Munder Difflin v0.4.6 基线）
> 日期：2026-10-10 ｜ 参与者：Byron（项目负责人） × TRAE 助手（Plan 模式 → 默认模式）
> 本记录忠实还原本次会话的：需求原文、代码勘察发现、联网核实事实、决策问答、方案版本演变与当前状态。未涉及任何密钥/凭据。

---

## 一、会话目标

Byron 提交《AgFlow 二次开发详细需求 Prompt》，要求：基于 Munder Difflin 深度二次开发为**国产多智能体编排桌面工具 AgFlow**，并**先出计划**——"每一个改造再开发内容你都要给我一个十分详细的可行性方案"。

需求文档要点（全文见附录 A）：

- **定位**：本地运行的 AI 团队协同平台，包装国产主流 AI CLI，实现多智能体分工/调度/记忆共享/可视化办公；跨平台桌面客户端、全中文、支持便携模式。
- **改造边界**：保留 Hive 蜂巢文件系统、单提交者 Git、终端伪进程、事件调度、记忆宫殿、熔断、多工作区、技能系统；移除国外 AI CLI、英文/阿拉伯语语言包、美剧梗、原品牌、遥测、海外集成。
- **品牌**：`Munder Difflin→AgFlow`、`munder-difflin→agflow`；核心角色 GOD 由 Michael 改「败龙」。
- **国产 CLI 优先级**：P0 豆包/通义千问/Kimi Code；P1 DeepSeek/智谱 GLM；P2 Ollama 本地模型。
- **全中文化**：界面 100% 中文（术语：智能体/蜂巢工作区/熔断机制/记忆宫殿/工作区/技能库）、提示词中文化、日志与文档中文化。
- **角色系统**：总控可自定义；6 个中文职位模板（后端/前端/文档/数据/测试/运维）；全链路名称同步。
- **构建打包**：产物统一 AgFlow 命名；Windows 便携版（U 盘即插即用）；默认数据目录 `.agflow`；默认关闭遥测。
- **验收标准**：7 条（全中文、三大国产智能体可用、败龙默认并可改、多智能体协同、核心功能正常、无国外 AI 残留、便携模式）。
- **开发优先级**：P0 品牌替换+移除国外 AI+核心界面中文化+败龙；P0 适配 Top3 国产 CLI+提示词中文化；P1 角色自定义+剩余国产 AI+技能库中文化；P1 记忆/熔断/任务文案中文化；P2 便携优化+本地大模型增强；P2 中文模板库+国内技能。

---

## 二、代码勘察发现（逐条，含位置）

### 2.1 基础事实

1. **基线版本为 v0.4.6**（`package.json`，CHANGELOG 最新 2026-08-27），非需求文档所写的 v0.5.3；工作区不是 git 仓库（无 .git）。
2. **zh-CN 语言包已 100% 完整**：en / zh-CN / ar 三份均为 **1170 键**（叶子键口径），zh-CN 相对 en **零缺失、零多余**；抽查已使用「智能体」等术语（`addAgent.title`＝「添加智能体」）。
3. i18n 现状：默认语言 `en`、`fallbackLng:'en'`（`i18n/index.ts` L92-99、L107-126）；含 Arabic RTL 链路（`useDirection.ts`、`terminal/useArabicTerminalSync.ts`，调用点 `App.tsx` L43/L45、`MarkdownPreview.tsx` L69、`AgentStrip.tsx` L19）。

### 2.2 Provider 体系（改造主轴）

4. provider 预设集中在 `src/shared/agentProvider.ts`：类型联合 L24-37，预设数组 L170-581，共 13 个：`claude / codex / grok / kimi / gemini / antigravity / qwen / opencode / crush / pi / copilot / cursor / custom`。
5. **qwen 已是成熟 provider**：proxy 桥（loopback 反向代理合成 HIVE_SOCK 事件）、`canReceiveInbox:true`、`-i` 初始提示词，多处 `TODO-verify`。
6. **kimi 已有预设但无桥**（`canReceiveInbox:false`，邮件弹回 god）；代码注释明确"Kimi 支持 lifecycle hooks，但尚未安装桥"。
7. **opencode 是完整 hive 公民**：`bridge:{kind:'hooks', shim:'opencode'}`、`canReceiveInbox:true`；插件桥实现 `installOpenCodePlugin`（`hive.ts` L2429，per-agent `.opencode` 目录 + plugin/plugins 双写）；spawn 已支持注入自定义 OpenAI 兼容 provider 配置（`OPENCODE_CONFIG_CONTENT`，`index.ts` L2997-3012）。
8. 桥接分派与协议注入：`hive.ts` L846-975（hooks/proxy 分派、种子投递策略）、L1530-1614（`injectedPrompt` 蜂巢协议提示词全文）、L1369-1455（proxy sidecar）。
9. spawn 主流程含 **Claude 专属逻辑**：`index.ts` L2823-2887（--model/remote-control/max-turns/--resume+transcript 播种）、L2954-2956（权限预接受）、L3019-3021（codex remote）、L2969-3014（BYOK + opencode 配置块，扩展点）。
10. 模型常量：`MODEL_GOD='claude-opus-4-8'`（`config.ts` L746-748）、`godModel` 默认 L431、`modelForRole` L763-776；OnboardingWizard L108 硬编码 `providerPreset('claude')`。

### 2.3 品牌 / 遥测 / 网络 / 场景

11. 品牌串 **src/ 108 串 / 34 文件**（`rg -i "munder|difflin"` 双计匹配 201；含 hive.ts、index.ts、hire.ts、updateState.ts、zh-CN.json、updater.ts 等；另 electron-builder.yml 18、package.json 3、resources/ 5）。
12. **遥测分两部分**：`analytics.ts`＝PostHog 匿名事件上传（契约文件 `TELEMETRY.md`，事件含 first_run/agent_spawned/message_sent 计数等；调用点约 20 处）；`telemetry.ts`＝本机 loopback OTLP 采集器（只收不发，供成本台账与熔断进度信号）。
13. 构建注入：`electron.vite.config.ts` L10-19 `__POSTHOG_KEY__`/`__POSTHOG_HOST__`；`config.telemetryEnabled` 默认 ON（`config.ts` L308-312）。
14. 对外端点清单（部分）：`us.i.posthog.com`、`api.groq.com`（听写）、`api.openai.com`（Realtime 语音）、`raw.githubusercontent.com`（hero/model-catalog 远程拉取）、`github.com`（更新器 feed）、安装脚本 URL（claude.ai/cursor.com/pi.dev/opencode.ai 等）。
15. 场景：《办公室》15 角色（`scene/office/cast.ts` L12-48，含玩梗 blurb；精灵由 `portraitArt.ts` 15 套配方程序化绘制）+《布鲁克林99》彩蛋主题（`themeRegistry.ts` L219-293、`assets/maps/brooklyn99.tmj`）。
16. 硬编码英文重点：主进程直接对话框标题（index.ts L2283/3114/3705/3728）、熔断三级文案（L1264-1275）、`engineAvailability.ts` L61-77 徽标、`AddAgentModal.tsx` 英文角色模板（L54-80）与英文 `HIRE_PROMPT`（L86+，spec=`munder-difflin/hire@1`）。
17. 技能：`resources/skills/` 17 个 SKILL.md（仅 3 个 `md-*` 前缀：md-hive-sync / md-fetch-summarize / md-audit，其余 14 个为时间/能力类；SKILL.md 英文）；投放目录为每 agent 的 `.claude/skills`（`hive.ts` L762）。
18. 打包：`electron-builder.yml` appId `in.munderdiffl.app`、协议 `munderdifflin://`、**win portable target 已配置**（L139-155）；mac 权限文案含 Claude/OpenAI/Groq；数据目录固定 `userData`（`config.ts` L490-492），无便携重定向。
19. 测试：约 40+ 个 `test/*.test.cjs` 引用旧 provider/品牌；`arabic-ui.test.cjs` 为语言包/RTL 测试；`agent-provider.test.cjs` 转译三张命令表做断言。
20. god 身份：`DEFAULT_GOD_NAME='Michael'`（`godIdentity.ts` L3）；改名链路完整（registry 持久化 + `useGodNameSync` + `resolveGodName` + i18n `{{godName}}` 默认变量）；语音别名 `god/michael`（`realtimeActions.ts` L218-223）。

### 2.4 联网核实事实（关键）

21. **豆包无官方编程 Agent CLI**：社区 `doubao-cli`（npm，通过 CDP 控制豆包桌面版会话，macOS 优先）；官方生态路线为**火山方舟 Ark**（OpenAI/Anthropic 兼容端点、ArkCLI 管理工具、Coding Plan 可接 Claude Code/Codex）。
22. **通义千问**：官方 qwen-code CLI 存在（代码已作为 provider 支持）。
23. **Kimi**：官方 kimi CLI 存在（代码已作为 provider 支持）。
24. **DeepSeek 无官方 CLI**（官方文档推荐第三方 Deep Code 等），但**官方开源 DeepSeek Harness（`@deepseek-ai/dsh`，dev-preview 0.1.x，MIT，Cordis 插件内核，含 Standard/PTC/Minimal/Creator 模式）已发布**。
25. **智谱**：官方编程工具 ZCode + GLM Coding Plan（端点 `open.bigmodel.cn`，支持接入多款三方 CLI）。

---

## 三、决策问答记录（原文级）

### 第 1 轮（3 问）

| 问题 | 选项 | Byron 回答 |
|---|---|---|
| 语音功能与海外集成如何处置？ | 按文档全删 / 全删并国产重建 / 只删遥测 | **按文档全删** |
| 豆包、DeepSeek、GLM 无官方 Agent CLI，适配路线？ | 务实路线 / 一产品一社区CLI / 自研 CLI | **"DeepSeek有DeepSeekharness。如果是豆包那些的话呢就同意到opencode吧，可以引入万能的opencode来进行第三方适配"** |
| 方案批准后如何实施？ | 分阶段P0优先 / 一次性全量 / 本轮仅交付方案 | **本轮仅交付方案** |

### 第 2 轮（v1 被退回后，2 问）

| 问题 | Byron 回答 |
|---|---|
| 希望如何改进方案？（多选） | **细化到逐文件步骤 + 调整技术决策** |
| 哪些关键决策需要重新考虑？（多选） | **opencode 壳路线** |

### 第 3 轮（1 问）

| 问题 | 选项 | Byron 回答 |
|---|---|---|
| 通用适配壳改用哪种方案？ | 改用 Qwen Code 当壳 / 自研 AgFlow CLI / 保留 opencode 壳 / 不用统一壳 | **保留 opencode 壳** |

### 第 4 轮（v2 被退回后，2 问）

退回反馈原文：**"我发现去掉国外的CLI不太行，要最大能力适配，所以的话CLI只添加不删除"**

| 问题 | 选项 | Byron 回答 |
|---|---|---|
| "只添加不删除"是否也适用于非 CLI 海外能力？ | 仅CLI保留其余按原计划删 / 能力全保留只删遥测 / 语音留集成删 | **能力全保留，只删遥测** |
| 默认引擎怎么定？ | 智能默认 / 固定国产qwen / 保持现状 | **智能默认（推荐）** |

### 收尾指令

**"把计划保存到项目里面，然后把对话记录（详细的）也保存到项目里面"**（v3 交付后被中断，转入保存动作）

---

## 四、方案版本演变

| 版本 | 性质 | 内容要点 | 结果 |
|---|---|---|---|
| **v1** | 总体可行性方案 | 逐改造项可行性评级 + 分期 + 验收；修正需求文档 6 处路径错误；确认 opencode 通用壳路线 | 被退回（无文字反馈） |
| **v2** | 逐文件实施手册版 | 每个改造项细化到「文件→操作→代码示意→验证」；新增 P0-A/B/C/D 施工表；补齐 Claude 专属 spawn 块、遥测调用点、Arabic 测试口径等事实 | 被退回（反馈：CLI 只增不删） |
| **v3**（当前最新，待评审） | 叠加式改造版 | ① CLI 只添加不删除（13 个现有 provider 全保留，新增豆包/DeepSeek/GLM/Ollama）；② 能力全保留、只删遥测上报（删 analytics.ts + ~20 调用点；保留本地 telemetry.ts）；③ 智能默认引擎（已装国产优先，否则回退 claude）；④ 保留 v2 的逐文件手册体例 | 交付后被中断（用户转入保存指令） |

### v3 最终改造公式

```
AgFlow 改造 = 品牌全局替换（Munder→AgFlow）
            + 全中文化（默认 zh-CN、删 en/ar、提示词/技能/硬编码中文化）
            + 总控默认名「败龙」
            + 新增 4 个国产 provider + Kimi 桥增强 + Qwen 实测增强
            + 智能默认引擎
            + 仅删除遥测上报（PostHog analytics）
            + 便携模式（~/.agflow + U 盘数据目录）
            + 现有 13 个 provider 与全部能力模块保持不动
```

### v3 关键决策表（13 条）

| # | 决策 |
|---|---|
| 1 | CLI 只添加不删除（13 保留 + 4 新增，共 17 个 provider） |
| 2 | 能力全保留（语音/听写/Slack/GitHub 集成/更新器），只删遥测上报 |
| 3 | 遥测边界：删 `analytics.ts`（PostHog 上传）；保留 `telemetry.ts`（本机 loopback，供成本/熔断） |
| 4 | 豆包/GLM 走 opencode 通用壳（插件桥复用 + 配置注入扩展） |
| 5 | DeepSeek 优先官方 Harness（dsh），回退 opencode 壳 |
| 6 | 默认引擎智能选择：qwen→kimi→doubao→opencode（已装优先），否则回退 claude；代码默认常量不动 |
| 7 | 品牌：全局 Munder→AgFlow；hire spec→`agflow/hire@1`；协议→`agflow://` |
| 8 | modelCatalog/hero 远程拉取保留（能力保留），后续可切本地 |
| 9 | 语言包删 en/ar 仅留 zh-CN（zh-CN 已 1170 键零缺失） |
| 10 | 任务状态：P1 仅 4 态中文映射；5 态 P2 可选 |
| 11 | 日志口径：用户可见全中文；开发者 console 保留英文键名 |
| 12 | 场景美术：仅改 key/名称/blurb，绘制逻辑复用 |
| 13 | 本轮仅交付方案 |

---

## 五、当前状态与文件清单

### 5.1 状态

- 代码：**未做任何修改**（全程 Plan 模式只读勘察 + 文档编写）。
- 方案：v3 为当前最新版本，**待评审**；批准后可按 `P0-A→P0-B→P0-C→P0-D` 开工。
- 复核修订（开工前实测校正）：键数为 **1170 叶子键**；品牌 **src/ 108 串/34 文件**（rg 双计 201）；技能仅 **3 个 md-\***；桥接安装函数 **7 个**；文档实际存于项目根目录与 `.trae/documents/`。

### 5.2 本次会话产出的文件

| 文件 | 位置 | 说明 |
|---|---|---|
| AgFlow-二次开发可行性方案.md | 项目根目录（`.trae/documents/` 存一份副本） | v3 逐文件实施手册 |
| AgFlow-开发对话记录.md | 项目根目录（本文件） | 会话详细记录 |

### 5.3 后续可执行项（按 v3）

1. P0-A：品牌替换（src/ 34 文件 + 构建配置）→ 遥测上报删除（analytics 一模块 + 调用点）→ provider 扩展（4 新预设）。
2. P0-B：i18n 切默认 zh-CN、删 en/ar、提示词/技能/硬编码中文化。
3. P0-C：Qwen/Kimi/豆包/DeepSeek 联网实测（C-7 五项，均有兜底）→ 智能默认引擎。
4. P0-D：败龙默认名 + 场景去美剧化 + 6 个中文职位模板。
5. P1/P2：角色设置面板、Ollama 扫描、记忆中文检索、镜像源、便携增强等。

---

## 附录 A：用户原始需求 Prompt（全文）

> 以下为 Byron 提交的《AgFlow 二次开发详细需求 Prompt》原文（用于代码改造、AI 辅助开发或交付开发人员执行）。

**一、项目背景与总体目标**

1.1 核心定位：基于原项目的双平面架构+蜂巢多智能体协同核心能力，重构为面向国内用户的国产多智能体编排桌面工具 AgFlow。
- 本质：本地运行的AI团队协同平台，包装国产主流AI CLI工具，实现多智能体自动分工、任务调度、记忆共享、可视化办公
- 改造原则：保留底层核心架构，全部替换上层AI生态、语言体系、品牌标识、角色系统
- 交付形态：Windows / macOS / Linux 跨平台桌面客户端，全中文界面，支持便携模式

1.2 改造边界：
- ✅ 完整保留：Hive蜂巢文件系统、单提交者Git设计、终端伪进程、事件调度、记忆宫殿、熔断机制、多工作区、技能系统
- ❌ 全部移除：国外AI CLI支持、英文/阿拉伯语语言包、美剧《办公室》相关梗与元素、原品牌标识、遥测模块、海外第三方集成

**二、品牌与命名全局替换**

2.1 程序标识全量替换：
- 正式产品名：AgFlow
- 替换规则：Munder Difflin→AgFlow（窗口标题/UI文案/关于页/系统托盘）；munder-difflin→agflow（配置目录/缓存目录/默认Hive路径/文件名）；MunderDifflin→AgFlow（变量名/类名/注册表项/安装包信息）；md/munder→af/agflow（代码前缀/命令行参数/环境变量）
- 移除所有原项目美剧致敬元素、玩梗文案，替换为中性中文办公语境

2.2 核心角色命名改造：
- 原总控 GOD Agent 名称 Michael 全局默认替换为「败龙」
- 覆盖：系统提示词、UI显示、日志、任务分配、角色头像标签、默认配置
- 硬编码点：src/main/god/constants.ts 中 GOD_AGENT_NAME 默认值修改为「败龙」

**三、AI CLI 生态重构：全部替换为国产主流AI**

3.1 彻底移除原有国外AI支持：Claude Code/Anthropic、Antigravity/Gemini CLI、OpenAI Codex/GPT、xAI Grok、GitHub Copilot CLI、Cursor Agent、所有非国产第三方CLI工具

3.2 新增国产主流AI CLI适配（P0 豆包 doubao、通义千问 qwen、Kimi Code kimi；P1 DeepSeek deepseek、智谱清言 glm；P2 本地大模型 Ollama ollama），要求：支持登录态检测、模型切换、代码模式、多模态等

3.3 Provider 实现规范（复用 node-pty 伪终端层）：进程封装字节级保真；登录检测与终端内引导授权；模型管理一键切换；环境注入（自定义API密钥/代理地址/私有模型端点）；生命周期（启动/重启/优雅终止/异常恢复）；指令兼容原Agent指令格式

3.4 本地大模型增强：深度适配Ollama自动扫描本地模型一键创建智能体；支持vLLM/LM Studio本地推理端点；调度/记忆/技能完全本地运行

**四、全中文化改造**

4.1 界面100%中文化：移除英文/阿拉伯语语言包，默认仅简体中文，删除多语言切换入口；覆盖菜单/右键/按钮/弹窗、侧边栏（任务/收件箱/自动化/记忆/能力/设置）、首启向导、终端标签/提示/告警；术语统一：Agent→智能体、Hive→蜂巢工作区、Circuit Breaker→熔断机制、Memory Palace→记忆宫殿、Floor→工作区、Skills→技能库

4.2 提示词与文案全中文化：重写总控「败龙」全部系统提示词；子智能体默认角色提示词中文化；技能描述/触发词/说明中文化；熔断/审批/告警文案中文正式表达

4.3 日志与文档中文化：控制台/错误日志中文；内置技能说明与帮助文档中文；导出报告/记忆文件/任务台账默认中文标题与格式

**五、角色系统自定义改造**

5.1 总控角色自定义：默认名「败龙」；新增「角色设置」面板（显示名称/性格/工作风格/调度策略提示词/像素形象头像/一键恢复默认）

5.2 子智能体角色模板库：原 Agent Gallery 重构为角色模板库（后端开发工程师/前端开发工程师/文档整理专员/数据处理助手/测试工程师/运维助手）；每模板预置角色名称、默认AI模型、系统提示词、默认技能包、工作目录规则；支持保存自定义模板一键创建

5.3 全链路名称同步：智能体列表/工位/消息气泡/任务分配/日志同步自定义名称；支持单个智能体改名；历史消息与记忆支持批量替换

**六、核心功能保留与适配**

6.1 完整保留：蜂巢工作区（文件系统+Git共享状态、消息邮箱、任务台账、全局黑板）；双平面架构（终端平面+事件平面、真实伪终端）；记忆宫殿（个体+全局语义索引跨会话召回）；三级熔断（引导→约束→停止、死循环检测、Token预算、超支拦截）；人工审批闸门（敏感操作自动暂停）；技能系统（标准技能目录、自定义安装卸载）；多工作区（数据隔离）；实时终端（xterm.js、手动输入干预）

6.2 功能适配优化：审批流程「同意/拒绝/补充说明」三操作；任务看板状态统一为待分配/进行中/待审批/已完成/已终止；记忆搜索支持中文关键词+语义检索；技能库按中文分类排序+中文搜索

**七、代码改造具体指引**

7.1 核心目录改造清单（src/main/agents/providers/ 删旧增新；src/main/god/prompts/ 重写；src/main/config/paths.ts 默认目录改 .agflow；src/main/i18n/ 仅 zh-CN；src/main/telemetry/ 删除；renderer 组件/pixi/store 中文化；shared/branding.ts 与 constants.ts 替换）

7.2 关键硬编码修改点：package.json（name/productName/description）；electron-builder（应用名/安装包名/图标/卸载信息）；src/main/god/constants.ts（GOD_AGENT_NAME→败龙）；src/shared/branding.ts

**八、构建与打包要求**

1. 保留原构建脚本，产物名称统一 AgFlow；2. Windows 便携版（数据/缓存可放程序目录，U盘即插即用）；3. 首启向导全中文，自动扫描已安装国产 CLI 并提示接入；4. 默认关闭所有遥测、数据上传，无任何海外请求；5. 默认数据目录 ~/.agflow，支持自定义路径

**九、验收标准**

1. 所有界面/弹窗/日志/提示均为简体中文，无残留英文；2. 可正常创建基于豆包、通义千问、Kimi 的智能体，终端交互正常；3. 总控默认「败龙」，可设置自定义并全局生效；4. 多智能体正常收发消息/分配任务/共享记忆；5. 原核心功能（任务/熔断审批/记忆/技能）全部正常运行；6. 无任何国外AI相关的代码、文案、依赖残留；7. 支持便携模式，数据可保存在U盘目录，换机无缝迁移

**十、开发优先级**

P0：品牌全局替换+移除国外AI+核心界面中文化+败龙默认命名；P0：适配Top3国产CLI+总控提示词中文化；P1：角色自定义+剩余国产AI适配+技能库中文化；P1：记忆系统/熔断机制/任务系统文案全中文化；P2：便携版优化+本地大模型增强+细节体验；P2：中文角色模板库+新增国内常用自定义技能

> 注：v3 方案按 Byron 后续指示对上述需求做了三处覆盖——①「CLI 只添加不删除」覆盖 3.1 的移除条款；②「能力全保留，只删遥测」覆盖 1.2 与 8.4 中语音/集成的移除条款（遥测仍删）；③「智能默认引擎」细化 8.3 的向导行为。验收标准第 6 条相应调整为"遥测上报清零 + 品牌清零；国外 CLI 作为保留能力不再纳入残留检查"。

---

## 附录 B：参考链接（联网核实来源）

- 豆包 CLI（社区 npm 包）：https://www.npmjs.com/package/doubao-cli
- 火山方舟产品更新公告（Ark CLI / Coding Plan / 兼容 API）：https://docs.volcengine.com/docs/82379/1159177?lang=zh
- 豆包 2.1 Pro 发布（新华网，含 Ark CLI 与 TRAE 接入信息）：http://www.news.cn/tech/20260623/acd6f2f27fc34459a7d1684c03278431/c.html
- DeepSeek Harness 官方页（`@deepseek-ai/dsh`）：https://www.deepseek.com/harness/en/
- DeepSeek Harness 社区站（安装与插件生态）：https://dsharness.io/zh
- DeepSeek 官方集成文档（Deep Code 等第三方 CLI）：https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/deepcode
- 智谱 GLM Coding Plan 工具接入（ZCode/兼容端点）：https://docs.bigmodel.cn/cn/guide/develop/others
- 智谱 GLM-5.3 发布公告（ZCode 官方编程工具）：https://www.zhipuai.cn/zh/research/162
- 智谱 Claude Code 接入指南（ANTHROPIC_BASE_URL 配置方式）：https://docs.bigmodel.cn/cn/guide/develop/claude

---

## 附录 C：关键代码位置索引（实施速查）

| 主题 | 位置 |
|---|---|
| provider 预设 / 类型 / guard | `src/shared/agentProvider.ts` L24-37、L170-581、L583-599、L634-653、L661-666 |
| spawn 命令构造（渲染端） | `src/renderer/src/store/config.ts` L408-435 |
| spawn 主流程（主进程） | `src/main/index.ts` L2643、L2766-2769、L2780-2812、L2823-2887、L2896-2934、L2969-3014、L3019-3024 |
| 协议提示词 | `src/main/hive.ts` L1530-1614（godLine L1585-1588、协议 L1599-1603） |
| 桥接分派 / proxy / 插件桥 | `src/main/hive.ts` L846-975、L1369-1455、L2193、L2429 |
| 技能投放 | `src/main/hive.ts` L762、L1350 |
| 模型常量 | `src/main/config.ts` L746-748、L763-776 |
| 遥测 | `src/main/analytics.ts`（删）、`src/main/telemetry.ts`（留）、`index.ts` L5159/L5387、`electron.vite.config.ts` L10-19 |
| i18n | `src/renderer/src/i18n/index.ts` L35-39、L92-99、L107-126 |
| 场景 | `scene/office/cast.ts` L12-48、`portraitArt.ts`、`themeRegistry.ts` L219-293 |
| 打包 | `electron-builder.yml` L38-43、L62-77、L95-103、L139-155 |
| god 身份 | `src/shared/godIdentity.ts` L3、`realtimeActions.ts` L218-223 |