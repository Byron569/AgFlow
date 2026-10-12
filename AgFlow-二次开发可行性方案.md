# AgFlow 二次开发可行性方案（v3 · 逐文件实施手册）

> 基线代码：`/Users/user/AgFlow`（Munder Difflin，package.json v0.4.6）
> 本轮交付：方案 v3（**未修改任何代码**）。
> **v3 核心变更（按你的最新指示）**：① **CLI 只添加不删除**——全部 13 个现有 provider（含 Claude/Codex/Grok/Gemini/Antigravity/Crush/Pi/Copilot/Cursor）完整保留，只新增国产 provider，保证最大适配能力；② **能力全保留，只删遥测上报**——实时语音、听写、Slack/GitHub 集成、更新器等全部保留，仅删除 PostHog 数据上传（analytics）；③ **智能默认引擎**——首启向导优先选用"已安装的国产引擎"，都没有则回退现有默认。
> 已确认决策汇总见 §5。

---

## 目录

- §1 总体结论与基线修正
- §2 关键代码速查
- §3 逐文件实施手册（P0-A 品牌与遥测 / P0-B 中文化 / P0-C 国产 CLI / P0-D 败龙与角色）
- §4 P1 / P2 文件级任务清单
- §5 假设与决策记录
- §6 验证与验收
- §7 风险与缓解

---

## §1 总体结论与基线修正

### 1.1 改造公式（v3 定调：叠加式，不做减法）

```
AgFlow 改造 = 品牌全局替换（Munder→AgFlow）
            + 全中文化（默认 zh-CN、删 en/ar 语言包、提示词/技能/硬编码中文化）
            + 总控默认名「败龙」
            + 新增 4 个国产 provider（豆包 / DeepSeek / GLM / Ollama）+ Kimi 桥增强 + Qwen 实测增强
            + 智能默认引擎（已装国产优先）
            + 仅删除遥测上报（PostHog analytics）
            + 便携模式（~/.agflow + U 盘数据目录）
            + 现有 13 个 provider、全部桥接、全部能力模块（语音/听写/集成/更新）保持不动
```

### 1.2 可行性总评（v3）

| 改造域 | 可行性 | 规模 | 关键依据 |
|---|---|---|---|
| 品牌全局替换 | 高 | M | src/ 品牌串 108 处/34 文件（rg 双计匹配 201），机械替换（不再有"随模块删除"的豁免，全部要替换） |
| 全中文化 | 高 | M-L | zh-CN 已 1170 键零缺失（叶子键口径）；重点在提示词/技能/硬编码 |
| 新增国产 provider | 中高 | L | qwen/kimi 骨架已有；opencode 壳机制（插件桥 + 配置注入）已就绪；DeepSeek Harness 已核实 |
| 遥测上报删除 | 高 | S | 仅 `analytics.ts` 一模块 + 约 20 个调用点 + 配置/构建设置 |
| 败龙与角色体系 | 高 | M | 改名链路完整、场景仅需改名与删彩蛋主题 |
| 便携模式 | 高 | M | win portable target 已存在，补数据目录重定向 |

**风险基调**：v3 无破坏性删除（除遥测），对现有功能零回归；主要不确定性集中在"新增国产引擎的联网实测"与"提示词中文化后的行为验证"。

### 1.3 需求文档路径修正表（实施以本表为准）

| 需求文档所写 | 实际位置 |
|---|---|
| `src/main/god/constants.ts` | `src/shared/godIdentity.ts` L3 `DEFAULT_GOD_NAME` |
| `src/main/agents/providers/` | `src/shared/agentProvider.ts` + `src/main/hive.ts` + `src/main/index.ts` |
| `src/main/config/paths.ts`、`.munder-difflin` | `src/main/config.ts`（configPath L490-492；harnessHome L182-184） |
| `src/main/i18n/` | `src/renderer/src/i18n/` |
| `src/main/telemetry/` | `src/main/telemetry.ts`（本地采集，**保留**）+ `src/main/analytics.ts`（上报，**删除**） |
| `src/shared/branding.ts` / `constants.ts` | 不存在；品牌串分布见 §3-A1 |
| v0.5.3 | 工作区为 v0.4.6 |

### 1.4 五个影响方案走向的代码事实

1. **zh-CN 已 100% 完整**（1170 键，与 en/ar 逐键零缺失）——中文化是"切换 + 清扫 + 重写"，不是翻译工程。
2. **qwen / kimi 已是 provider**：qwen 有 proxy 桥（可收件箱）；kimi 无桥（邮件弹回 god）。属"增强"。
3. **opencode 是完整 hive 公民**：plugin 桥（`installOpenCodePlugin`，hive.ts L2429）+ `canReceiveInbox:true` + spawn 已支持注入自定义 OpenAI 兼容 provider（`OPENCODE_CONFIG_CONTENT`，index.ts L2997-3012）。国产壳路线零新增桥接代码。
4. **现有 provider 全部保留**，所以：三张命令表（claude/codex/grok）、七个桥接安装函数（agy/gemini/codex/pi/opencode/grok + installCrushConfig 特例）、Claude 专属 spawn 块（index.ts L2823-2887）、codex remote、全部现有测试**均不动**——P0-A 的"删除类"工作只剩遥测上报。
5. **"遥测"两部分要区分**：`analytics.ts`（PostHog 匿名事件上传，TELEMETRY.md 为其契约）**删除**；`telemetry.ts`（本机 loopback OTLP 采集器，只收不发，供成本台账与熔断进度信号）**保留**。

---

## §2 关键代码速查（实施时直接跳转）

| 主题 | 位置 |
|---|---|
| provider 预设 / 类型 / guard | `src/shared/agentProvider.ts` L24-37, L170-581, L583-599, L634-653, L661-666 |
| spawn 命令构造（渲染端） | `src/renderer/src/store/config.ts` L408-435 |
| spawn 主流程（主进程） | `src/main/index.ts`：L2643 `claudeProvider`；L2766-2769 端点注入；L2780-2812 ensureAgent；L2823-2887 Claude 专属块（保留）；L2896-2934 通用 resume；L2969-3014 BYOK+opencode 配置（**扩展点**）；L3022-3024 pty spawn |
| 协议提示词 | `src/main/hive.ts` L1530-1614 `injectedPrompt`（godLine L1585-1588、guardrails L1591、slack L1592-1594、HIVE 协议 L1599-1603） |
| 桥接分派 | `src/main/hive.ts` L846-975；proxy L1369-1455；`installCodexHooks` L2193；`installOpenCodePlugin` L2429；shim `cth-hook.cjs`/`hive-proxy.cjs` 写盘 L471-480、L665-666 |
| 技能投放 | `src/main/hive.ts` L762（`copyBundledSkills` → `.claude/skills`） |
| 模型分层常量 | `src/main/config.ts` L746-748、L763-776（**保留不动**，智能默认在 UI 层） |
| 遥测 | `src/main/analytics.ts`（删）；`src/main/telemetry.ts`（留）；初始化 `index.ts` L5159 / L5387；构建注入 `electron.vite.config.ts` L10-19 |
| i18n | `src/renderer/src/i18n/index.ts` L35-39 / L92-99 / L107-126；RTL 调用点：`App.tsx` L43/L45、`MarkdownPreview.tsx` L69、`AgentStrip.tsx` L19 |
| 场景 | `scene/office/cast.ts` L12-48；`portraitArt.ts`（15 套配方）；`themeRegistry.ts` L28-40 / L219-293 |
| 打包 | `electron-builder.yml` L38-43 / L62-77 / L95-103 / L139-155 |
| 语音别名 | `src/main/realtimeActions.ts` L218-223（`god`/`michael` 别名 → 需支持"败龙"） |

---

## §3 逐文件实施手册（P0）

> 执行约定：每完成一小节跑 `npm run typecheck`；每完成一个阶段（P0-A/B/C/D）跑 `npm run test:focused` + `npm run build`。

### P0-A 品牌替换 + 遥测上报删除 + provider 扩展

#### A-1 品牌字符串替换（src/ 108 串/34 文件；另 electron-builder.yml 18、package.json 3、resources/ 5；表内为 rg 双计口径，LICENSE.txt 白名单）

**替换映射**：`Munder Difflin`→`AgFlow`；`munder-difflin`→`agflow`；`munderdifflin`→`agflow`；`munderdiffl.in`→删除/占位；`Munder-Difflin`（产物名）→`AgFlow`。**注意：v2 中"随模块删除"的文件现在全部保留，其品牌命中也必须替换。**

| 文件 | 命中数 | 处理 |
|---|---|---|
| `src/main/hive.ts` | 19 | 全替换（含 L1572 `RUNNING BUILD` 行；提示词内品牌随 B-5 一并重写） |
| `src/main/index.ts` | 14 | 全替换 |
| `src/shared/hire.ts` | 14 | 全替换；spec `munder-difflin/hire@1`→`agflow/hire@1`（同步校验器与测试，见 D-3） |
| `src/shared/updateState.ts` | 14 | 全替换（REPO 常量→占位仓库） |
| `src/renderer/src/i18n/locales/zh-CN.json` | 16 | 全替换（en/ar 删除不计） |
| `src/main/updater.ts` | 8 | 全替换 |
| `src/shared/ossModels.ts` | 6 | 链接删除/占位 + 数据改写（C-5） |
| `src/shared/codexCommands.ts` | 6 | 全替换（文件保留） |
| `src/renderer/src/components/SettingsModal.tsx` | 6 | 全替换 |
| `src/renderer/src/components/ReleaseDrop.tsx` | 5 | 全替换 |
| `src/renderer/src/App.tsx` | 4 | 全替换 |
| `src/renderer/src/realtime/tools.ts` | 4 | 全替换（文件保留） |
| `src/shared/triggers.ts` | 4 | 全替换 |
| `src/renderer/src/components/UpdateToast.tsx` | 4 | 全替换 |
| `src/renderer/src/components/AddAgentModal.tsx` | 4 | 随 D-3 重写 |
| `src/shared/agentProvider.ts` | 4 | 随 A-6 改写 |
| `src/renderer/src/components/SettingsHeroCard.tsx` | 5 | 全替换 |
| `src/shared/mcpCatalog.ts` | 3 | 全替换 |
| `src/preload/index.ts` | 2 | 全替换 |
| `src/main/fetchText.ts` | 2 | UA → `agflow` |
| `src/main/hero.ts` | 2 | 全替换 |
| `src/main/modelCatalog.ts` | 2 | 全替换 + 远程源处理（C-5） |
| `src/main/integrationBroker.ts` | 2 | 全替换 |
| `src/renderer/index.html` | 4 | `<title>`→AgFlow |
| `src/renderer/src/main.tsx` | 2 | 全替换 |
| `src/renderer/src/realtime/session.ts` | 2 | 全替换 |
| `src/shared/releaseDrop.ts` | 2 | 全替换 |
| `src/renderer/src/components/terminalSelection.ts` | 2 | 全替换（注释） |
| `src/renderer/src/ide/IdePanel.tsx` | 2 | 全替换 |
| `src/renderer/src/components/FullscreenTerminal.tsx` | 2 | 全替换 |
| `src/shared/grokCommands.ts` | 1 | 全替换（文件保留） |
| `src/renderer/src/assets/fonts/LICENSE.txt` | 2 | **保留**（第三方许可，白名单） |

> 表中「命中数」为 `rg -i "munder|difflin"` 计数口径（同一串 Munder/Difflin 双计）；src/ 实际品牌串共 108 个。

**验证**：`rg -i "munder|difflin" src/ electron-builder.yml package.json resources/` → 仅 LICENSE.txt。
**范围界定**：仅改 app 本体（`src/`、`electron-builder.yml`、`package.json`、`resources/`、`build/`）；仓库内 `blog/`、`docs/`、`landing-remotion/`、`tools/` 等站点与工具资产另有数百处命中，不属于桌面应用改造范围（可另行处理）。

#### A-2 `package.json`

```jsonc
{
  "name": "agflow",
  "version": "0.6.0",
  "description": "本地运行的国产多智能体编排桌面工具：把 AI CLI（国产优先）组织成一支自动分工、共享记忆的智能体团队。",
  "author": "AgFlow",
  "homepage": "https://example.invalid/agflow",       // 占位，待定
  "repository": { "type": "git", "url": "https://example.invalid/agflow.git" }
}
```
依赖变更：**仅删 `posthog-node`**（A-5）；其余依赖全部保留（含 `@openai/agents-realtime`、`localtunnel`、`tunnelmole`）。改后 `npm install` 重建 `package-lock.json`（顶层 name 同步）。

#### A-3 `electron-builder.yml`

| 行 | 现值 | 改为 |
|---|---|---|
| L1 | `appId: in.munderdiffl.app` | `appId: com.agflow.desktop` |
| L2-3 | productName/copyright | `AgFlow` / `Copyright © 2026 AgFlow` |
| L9-12 | publish github | **保留**（更新能力保留；P1 可配国内源） |
| L41-43 | 协议 `munderdifflin://` | `agflow://`（协议名变更需同步 `shared/hire.ts` 深链解析与文档） |
| L62-64 | `md-slack-reply.cjs` extraResource | **保留**（Slack 能力保留） |
| L95-103 | mac 权限文案（英文，含 Claude/OpenAI/Groq） | 中文重写并如实披露能力，示例：`NSDocumentsFolderUsageDescription: "AgFlow 运行的智能体需要读写你指定的项目文件夹。"`、麦克风条目改为中文并保留"语音功能（仅在开启时使用）"说明 |
| L133/136/151/152/155/163 | artifactName/dmg/shortcut | `AgFlow-${version}-…` |

#### A-4 图标与 build

- 替换 `build/icon.{icns,ico,png,svg}`（需 AgFlow 设计稿；过渡用占位图）。
- `notarize.cjs`、`entitlements.mac.plist`、`release-notes.md` 保留。

#### A-5 遥测上报删除（唯一删除类工作）

| 对象 | 操作 |
|---|---|
| `src/main/analytics.ts` | **删除文件** |
| `src/main/telemetry.ts` | **保留**（本地 loopback 采集，供成本/熔断；在文件头注释注明"仅本机、无出境"） |
| `src/main/index.ts` 调用点 | 删除 L59-60 imports 与全部调用：L619、L629、L1734、L2114、L2234、L2650、L2707、L2712、L2715、L3023-3024、L3073、L3222（`setEnabled`）、L3227、L3511、L3992、L4426、L5387（`init`）。**注意 `isRendererMessageSurface` 与 `SpawnFailReason` 若被其他模块复用，保留其定义（迁至别处或内联）**——以 typecheck 收口 |
| `src/main/config.ts` L308-312 | 删 `telemetryEnabled` 字段 |
| renderer/preload 镜像 | `store/config.ts`、`preload/index.ts`、`SettingsModal`（遥测开关 UI）、`OnboardingWizard`（写入点）同步删除 |
| `electron.vite.config.ts` L10-19 | 删 `__POSTHOG_KEY__`/`__POSTHOG_HOST__` 注入与类型声明 |
| `package.json` | 删 `posthog-node` 依赖 |
| `TELEMETRY.md` | 删除（或改写为"AgFlow 不收集任何遥测数据"声明；建议删文件并在 README 备注） |
| `test/telemetry-funnel.test.cjs` | 删除（如存在邻接断言，按红名单修） |

**验证**：`rg -i "posthog|telemetryEnabled|__POSTHOG" src/ electron.vite.config.ts package.json` 零命中；应用启动无外发请求（断网启动正常）。

#### A-6 provider 扩展（只增不删）

1. `AgentProvider` 联合（L24-37）→ 追加 `'doubao' | 'deepseek' | 'glm' | 'ollama'`（17 个成员，现有 13 个全部保留）。
2. `isAgentProvider`（L583-599）追加 4 值；`inferAgentProvider`（L634-653）追加映射：`dsh`→`deepseek`；命令为 opencode 但显式 provider 参数优先（现有逻辑已支持 explicit 覆盖）；**现有映射与默认回退（claude）不动**。
3. 新增 4 个预设（追加到 `AGENT_PROVIDER_PRESETS`，示意见 C-2）；现有 13 个预设**逐字保留**（包括其 TODO-verify 注释）。
4. `ProviderLogo.tsx`：**新增** `doubao/deepseek/glm/ollama` 单色 glyph（能取 Simple Icons 的用之，取不到自绘；现有 5 个品牌路径不动）。
5. 模型目录（`modelCatalog.json` 等）：**追加**国产分组，现有条目保留（C-5）。

#### A-7 `src/main/hive.ts`（只增加，不删）

| 位置 | 操作 |
|---|---|
| L846-975 分派块 | **新增** `shim === 'kimi'` 分支（C-4）；`opencode` 分支与 proxy 分支已可承载壳 provider，无需改 |
| L1592-1594 slackLine | 保留（Slack 能力保留）；仅随 B-5 注入语言中文化 |
| L927 proxy 默认上游 | 保留现状（仅用户选择 qwen/crush 时触及） |
| 其余 | 不动（含全部现有桥函数） |

#### A-8 `src/main/index.ts`（扩展 + 遥测摘除）

| 位置 | 操作 |
|---|---|
| L2969 BYOK/opencode 块 | provider 白名单 `opencode|crush|pi|qwen` → 追加 `doubao|glm|deepseek|ollama`；`PREFIX_BACKEND`（L2979-2981）追加国产 key 映射（C-3） |
| L2997-3012 opencode 配置块 | 泛化为按 provider 生成（C-3 示意） |
| analytics 调用 | 随 A-5 删除 |
| L2766-2769 / L2823-2887 / L2896-2934 / L2954-2956 / L3019-3021 | **全部保留**（现有能力不动） |

#### A-9 `src/main/config.ts`

| 位置 | 操作 |
|---|---|
| L308-312 `telemetryEnabled` | 删除 |
| L746-748 `MODEL_*` | **保留现状**（智能默认在 UI 层，见 A-11） |
| L204 `defaultCommand` | 保留现状 |
| L321 `providerBaseUrls` | 注释扩展为"任意 provider"（功能已支持） |

#### A-10 测试变更（v3 大幅缩减）

| 测试文件 | 处置 |
|---|---|
| `telemetry-funnel.test.cjs` | 删除/改写 |
| `agent-provider.test.cjs`、`provider-config.test.cjs`、`engine-availability.test.cjs` | **追加**国产 provider 断言（现有 claude/codex/copilot 断言保留） |
| `hire-import.test.cjs`、`hire-validator-parity.test.cjs` | 随 spec 改名与 allowlist 扩展更新（D-3） |
| 其余（含 codex/pi/arabic 相关） | **全部保留**；`arabic-ui.test.cjs` 随 en/ar 语言包删除改为"仅 zh-CN 存在性"断言（B-1） |

#### A-11 智能默认引擎（试点体验）

```ts
// 建议放 src/shared/engineAvailability.ts 内（已有 ToolStatus 依赖）
const DOMESTIC_PREFERENCE = ['qwen', 'kimi', 'doubao', 'opencode'] as const;
export function pickDefaultEngine(
  statuses: readonly ToolStatus[] | undefined,
  fallback: string = 'claude'
): string {
  for (const p of DOMESTIC_PREFERENCE) {
    if (statuses?.find((s) => s.id === `engine:${p}`)?.found) return p;
  }
  return fallback;
}
```

- `OnboardingWizard.tsx` L120-128 拿到 `toolsStatus()` 后：若用户未手动改过引擎，则 `setEngine(pickDefaultEngine(statuses))`，模型随 `providerPreset(p).recommendedOrchestratorModel`。
- `AddAgentModal.tsx` / `AiEnginesSettings.tsx`：引擎列表**国产置顶**（排序权重，不隐藏国外项）；首启"推荐"徽标给已安装的国产引擎。
- 单元测试：新增 `pickDefaultEngine` 的 case（已装 qwen→qwen；都未装→claude）。

---

### P0-B 全中文化

（与 v2 一致，此处保留完整步骤）

#### B-1 `src/renderer/src/i18n/index.ts`

```ts
export const LANGUAGES = [{ code: 'zh-CN', label: '简体中文', dir: 'ltr' }] as const;
// 删 en/ar import（L21-23）；detectLanguage 默认 'zh-CN'，旧值 en/ar 迁移为 zh-CN（L92-99）
// init：resources 仅 zh-CN；fallbackLng: 'zh-CN'；supportedLngs: ['zh-CN']（L107-126）
```
删除 `locales/en.json`、`locales/ar.json`。**注意**：`test/arabic-ui.test.cjs` 改为断言"仅 zh-CN 存在 + 无 en/ar 文件"。

#### B-2 RTL 链路清理

| 位置 | 操作 |
|---|---|
| `App.tsx` L43/L45 | `useDirectionSync()` 保留或删；`useArabicTerminalSync()` 删 import+调用 |
| `terminal/useArabicTerminalSync.ts` | 删除 |
| `MarkdownPreview.tsx` L23/L69、`AgentStrip.tsx` L9/L19 | 删 `useRtl` 引用与 rtl 分支 |
| `i18n/useDirection.ts` | 引用收口后删除（或保留恒 ltr 空实现） |
| `SettingsModal.tsx` L1072-1088 | 语言选择器删除，可留只读"界面语言：简体中文" |

#### B-3 术语全量审计

对 zh-CN 1170 键跑术语表（智能体/蜂巢工作区/熔断机制/记忆宫殿/工作区/技能库/总控智能体），脚本列出value 含 `Agent|Hive|Floor|Skills|Palace` 等英文词的条目逐个修。

#### B-4 硬编码英文清扫（文件级）

| 文件 | 位置 | 操作 |
|---|---|---|
| `shared/engineAvailability.ts` | L61-77 | 徽标与引导语中文化 |
| `src/main/index.ts` | L2283/3114/3705/3728 | 原生对话框 title 中文 |
| `src/main/index.ts` | L1264-1275 | 熔断三级文案中文（示意：steer→`自动化护栏：${reason}。请检查方法——若在循环或卡住，立即停止重复，总结已尝试内容并向总控请求方向。`；constrain→`护栏升级：${reason}。立即停止推进：切换为只读/规划，写出下一步计划并先交总控确认。`；toast 同步） |
| `src/main/hive.ts` | L956 | 降级提示中文 |
| `shared/toolCatalog.ts` | 各 desc | 中文 |
| 其余 | — | 实施期 `rg` 收口 `pty.ts`/`fs.ts`/通知/托盘 |

#### B-5 提示词与生成文档中文重写（行为关键）

| 位置 | 操作 |
|---|---|
| `hive.ts` `injectedPrompt` L1530-1614 | 全文中文重写（角色句 L1596、协议四则 L1599-1603、护栏 L1591、记忆/知识行、godLine L1585-1588 按中文调度逻辑重写、runtimeLine L1572 含 AgFlow 版本行、Slack 行 L1592-1594 保留但中文化）。**只换语言与产品名，不动 board.md/tasks.json/status 等机器契约** |
| `hive.ts` L2959 | 协议文档生成段中文重写 |
| 生成文档 PROTOCOL.md / COMMANDS.md | 改为中文；COMMANDS.md 增补国产引擎常用命令（现有 Claude 内容保留亦可，作为兼容参考） |
| 影响提示 | 中文化后需对现有引擎（Claude 等）做一次行为冒烟（§6.3 #5） |

#### B-6 技能实体与技能库

| 对象 | 操作 |
|---|---|
| `resources/skills/*/SKILL.md`（17 个：3 个 `md-*` + 14 个时间/能力类） | name/description 中文重写；3 个 `md-*` 前缀→`af-*`（md-hive-sync / md-fetch-summarize / md-audit），同步 `hire.ts` 的 `BUNDLED_SKILL_IDS` 白名单与 hire 相关测试；其余 14 个直接中文化 |
| `SkillsTab.tsx` | 中文分类 + 中文关键词搜索（P1 亦可） |
| 投放目录 | 现有引擎保持 `.claude/skills`；新增引擎的适配见 C-6 |

#### B-7 日志口径（决策）

用户可见日志/通知/横幅全中文；开发者 `console.*` 保留英文键名 + 中文叙述（白名单）。

---

### P0-C 国产 CLI 落地（新增，不影响现有）

#### C-1 新增 `src/shared/domesticEngines.ts`（注册表）

```ts
export interface DomesticEngine {
  id: 'doubao' | 'glm' | 'deepseek' | 'ollama';
  label: string;                 // 豆包 · 火山方舟
  shell: 'opencode' | 'dsh';     // 承载引擎（deepseek 可切壳）
  baseUrl: string;               // https://ark.cn-beijing.volces.com/api/v3
  keyEnv: string;                // ARK_API_KEY（映射到壳引擎读取的变量）
  keyRef: string;                // 本地密钥仓库引用（复用现有 providerKeyRef 机制）
  models: { id: string; label: string }[];
}
export const DOMESTIC_ENGINES: DomesticEngine[] = [/* 4 条，全部默认值可配置 */];
```
默认值：豆包 `doubao-seed-2.1-pro / doubao-seed-2.1-lite`；GLM `glm-5.3 / glm-5.3-flash`；DeepSeek `deepseek-v4-pro / deepseek-v4-flash`；Ollama 先内置国产 picks（qwen3/deepseek-r1/glm），P1 起扫描本机 `/api/tags`。

#### C-2 `agentProvider.ts` 新预设（示意：豆包；glm 同构）

```ts
{
  id: 'doubao',
  label: '豆包 · 火山方舟',
  defaultCommand: 'opencode',
  commandGroups: [],
  autoModeFlag: '',
  supportsModel: true, modelFlag: '--model',       // slug: doubao/<model>
  hiveAware: false,
  bridge: { kind: 'hooks', shim: 'opencode' },     // 复用插件桥：状态/收件箱/成本
  canReceiveInbox: true,
  initialPromptFlag: '--prompt',
  recommendedOrchestratorModel: 'doubao-seed-2.1-pro',
  resumeFlag: undefined
}
```
- `deepseek`：`defaultCommand: 'dsh'`（DeepSeek Harness，实验）+ `shell` 可切 opencode 回退；实测项见 C-7。
- `ollama`：模型 slug `local/<tag>`（沿用 `localSlugFor`）。
- 4 个新预设全部 `hookBridge`/`bridge` 与现有 opencode 机制对齐 → 开箱即得完整 hive 公民能力。

#### C-3 `index.ts` 端点/密钥/壳配置扩展（施工点 L2969-3014）

1. provider 白名单追加 4 个国产项。
2. BYOK：`BACKEND_KEY_ENV` / `PREFIX_BACKEND`（L2979-2990）追加：`ark`→`ARK_API_KEY`、`glm`→`GLM_API_KEY`、`deepseek`→`DEEPSEEK_API_KEY`（密钥存取复用现有 `integrations.getSecret` + `providerKeyRef`，**因集成模块保留，无需迁移**）。
3. opencode 配置块泛化：

```ts
const eng = DOMESTIC_ENGINES.find(e => e.id === provider);
if (provider === 'opencode' || eng) {
  const oc: Record<string, unknown> = { autoupdate: false };
  if (cfg.autoMode) oc.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow' };
  const baseUrl = eng?.baseUrl ?? cfg.providerBaseUrls?.[provider];
  if (baseUrl) {
    const modelId = prefix /* slug 前缀 */ === provider ? modelSlug.split('/')[1] : 'default';
    oc.provider = { [provider]: { npm: '@ai-sdk/openai-compatible', name: eng?.label ?? 'Custom',
      options: { baseURL: baseUrl, apiKey: `{env:${eng?.keyEnv}}` },
      models: { [modelId]: { name: modelId } } } };
  }
  extra.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
}
```
（apiKey 的实际注入点：把用户保存的密钥写入 `extra[eng.keyEnv]` 或壳引擎可读的对应变量；以实测选定。）

#### C-4 Kimi 桥（新增）

- 新增 `installKimiHooks(dir, agentId)`：模板参照 `installCodexHooks`（L2193：per-agent 配置目录 + 环境变量指向 + 复用 `cth-hook` shim）。
- `hive.ts` 分派块加 `shim === 'kimi'` 分支；`kimi` preset 增加 `bridge`，通过后 `canReceiveInbox:true`。
- 实测三问：hook 事件面与形状、载荷字段、Stop 等价事件能否 drain；不通过则保持现状（桥不启用，kimi 仍可用），不阻塞 P0。

#### C-5 模型目录与远程内容

| 文件 | 操作 |
|---|---|
| `src/shared/modelCatalog.json` | **追加**国产分组（qwen/kimi/doubao/deepseek/glm/ollama），现有条目保留 |
| `src/main/modelCatalog.ts` | 远程源（raw.githubusercontent）**保留或改为可配置**（默认保留现状；如验收要求"无自发海外请求"再切换本地。列为可选决策 §5-8） |
| `src/shared/ossModels.ts` | 追加国产 quick-picks；现有条目保留；博客链接随品牌替换改占位 |
| `test/model-catalog.test.cjs` | 追加国产断言 |

#### C-6 UI 与检测/安装

| 文件 | 操作 |
|---|---|
| `ProviderLogo.tsx` | 新增 4 glyph（A-6） |
| `AiEnginesSettings.tsx` | 追加国产引擎卡片/端点表单；**国产置顶** |
| `AddAgentModal.tsx` | picker 追加国产项并置顶；模板区随 D-3 重写 |
| `OnboardingWizard.tsx` | 智能默认（A-11）；引擎扫描自动包含国产项 |
| `shared/toolCatalog.ts` | engine 行追加国产引擎 + install 命令（npm，支持镜像） |
| `src/main/cliInstall.ts` | npm 命令增加 `--registry`（读配置，默认官方；P1 提供国内镜像开关） |
| `preload/index.ts` | 新增 IPC 随上述模块（引擎/密钥表单）同步 |
| 技能投放（新增引擎） | P0：提示词中列出技能清单兜底；P1：按各引擎技能目录实测适配 |

#### C-7 实测清单（阻断项）

| 项 | 验证 | 回退 |
|---|---|---|
| Qwen proxy 桥 | 建 qwen 智能体→跑任务→fleet/状态/收件箱更新 | 渲染层空闲唤醒兜底 |
| Kimi 桥 | 同上 | 不启用桥，kimi 基础可用 |
| 豆包壳 | opencode + Ark 端点全流程（含 `--model doubao/<id>` 解析） | 查 Key/端点/模型名；日志溯源 |
| DeepSeek dsh | 交互 TUI 能否被 node-pty 拉起、种子投递、hook 面 | 切 opencode 壳（api.deepseek.com） |
| opencode 插件桥 | session.idle 触发（现有代码注明 UNVERIFIED） | 渲染层空闲唤醒（已有兜底） |

---

### P0-D 败龙与角色体系

#### D-1 「败龙」改名

| 位置 | 操作 |
|---|---|
| `src/shared/godIdentity.ts` L3 | `DEFAULT_GOD_NAME = '败龙'` |
| `src/main/config.ts` 注释 L193-213 | 注释更新（非功能） |
| `src/main/realtimeActions.ts` L218-223 | 语音别名追加"败龙"（保留 god/michael 别名） |
| `MichaelBooting.tsx` | 改名 `GodBooting.tsx`（可选，建议） |
| 提示词/文档 | 随 B-5 统一使用 god 实际名（`meta.name`） |
| `OnboardingWizard.tsx` L108 | 随 A-11 改为智能默认 |
| 全局 | `rg -i "michael" src/ test/ resources/` 收口；`test/i18n-god-name.test.cjs` 断言改"败龙" |

#### D-2 场景去美剧化

1. `cast.ts`：15 角色改中性中文办公角色（映射表实施时定稿，示例）：

| 现 key | 新 key（示例） | displayName / blurb |
|---|---|---|
| michael | lead | 项目负责人 / 统筹与决策 |
| jim | dev | 后端工程师 / 写代码修缺陷 |
| pam | designer | 设计师 / 界面与体验 |
| dwight | qa | 测试工程师 / 质量把关 |
| kevin | data | 数据分析 / 报表与指标 |
| angela | finance | 财务 / 预算与核对 |
| oscar | architect | 架构师 / 技术方案 |
| …（其余 8 个同法） | | |

2. `portraitArt.ts`：仅改 15 套配方的 key 引用与注释（绘制逻辑不动）。
3. `themeRegistry.ts`：删 `BROOKLYN99_THEME`（L219-293）与注册项；删除 `assets/maps/brooklyn99.tmj`；`OfficeThemePicker.tsx` 选项同步；`ATTRIBUTION.md` 复核。**保留 office 主题**。

#### D-3 角色模板库

1. 新增 `src/shared/agentTemplates.ts`：6 个中文职位模板（后端开发工程师/前端开发工程师/文档整理专员/数据处理助手/测试工程师/运维助手），字段 `{ id, name, provider, model, description, goal, skills[], cwdRule }`；默认引擎按建议：后端 qwen、前端 豆包、文档 kimi、数据 glm/deepseek、测试 qwen、运维 deepseek/glm。
2. `AddAgentModal.tsx`：删英文 `DESCRIPTION_TEMPLATES`（L54-80）与英文 `HIRE_PROMPT`（L86+），改读 `agentTemplates.ts`；模板选择器（L1035-1039）中文渲染。
3. `HIRE_PROMPT` 重写为中文，spec `agflow/hire@1`，provider allowlist **追加**国产项（保留 claude/codex/antigravity/cursor）。
4. `src/shared/hire.ts` 校验器同步（spec + allowlist 扩展）。
5. 测试 `hire-import`、`hire-validator-parity` 对齐。
6. 自定义模板保存（P1）：`harnessHome/templates.json`。

---

## §4 P1 / P2 文件级任务清单

### P1

| 任务 | 涉及文件 | 要点 |
|---|---|---|
| 角色设置面板 | `SettingsModal.tsx`、`store/config.ts`、`preload/index.ts`、`main/config.ts`、`hive.ts`（godLine 注入） | `godPersona{displayName,style,strategy,avatar}` + 一键恢复默认 |
| 自定义角色模板 | `agentTemplates.ts`、`AddAgentModal.tsx`、`config.ts` | 保存/删除到 `harnessHome/templates.json` |
| 历史名称替换工具 | hive.ts + 设置入口 | 扫描 memory/inbox/board/tasks，二次确认 + 备份 |
| GLM / Ollama 完整化 | `domesticEngines.ts`、`index.ts`、AddAgentModal | Ollama 扫描 `/api/tags` + 一键创建 |
| 记忆中文检索 | `memory.ts`/`db.ts`、`config.ts` | 默认 `embeddinggemma`；FTS 中文回退（LIKE/trigram） |
| 任务/审批文案 | `TasksKanban.tsx`、`BlockedBanner.tsx`、`AskMeTab.tsx`、主进程动作发出点 | 4 态中文映射；审批「同意/拒绝/补充说明」 |
| 技能库与引擎适配 | `SkillsTab.tsx`、`skills.ts`、投放目录 | 中文分类/搜索；新增引擎技能目录实测 |
| 国内镜像源 | `config.ts`、`cliInstall.ts`、`UpdatesSection` | npm registry 默认可配；更新源可换 |
| 技能包扩充 | `resources/skills/` | 周报生成、代码审计、接口文档等 af-* 技能 |

### P2

| 任务 | 要点 |
|---|---|
| 便携增强 | 引擎随行目录（`<数据目录>/engines` + PATH 前缀）、迁移向导完善 |
| vLLM / LM Studio | 自定义端点表单（复用 domesticEngines 机制） |
| 任务 5 态（可选） | `tasks.json` schema 扩展 + 全部消费点 + god 提示词（单独评估） |
| 更新源国产化 | 自建更新 feed（electron-builder publish 改指向） |
| 首启体验细节 | 向导文案/错误提示打磨 |

---

## §5 假设与决策记录（v3 全量）

| # | 项 | 决策 | 来源 |
|---|---|---|---|
| 1 | CLI 策略 | **只添加不删除**：全部 13 个现有 provider 保留，新增 4 个国产 | 用户（本轮） |
| 2 | 能力策略 | 能力全保留（语音/听写/Slack/GitHub 集成/更新器），**只删遥测上报** | 用户（本轮） |
| 3 | 遥测边界 | 删 `analytics.ts`（PostHog 上传）；保留 `telemetry.ts`（本机 loopback 采集，供成本/熔断） | 本方案（基于代码核实） |
| 4 | 豆包/GLM 壳 | opencode 通用壳（插件桥复用，配置注入扩展） | 用户（二次确认） |
| 5 | DeepSeek | 优先官方 Harness（dsh），回退 opencode 壳 | 用户 + 联网核实 |
| 6 | 默认引擎 | 智能默认：已装国产优先（qwen→kimi→doubao→opencode），否则现有默认（claude）；代码默认常量不动 | 用户（本轮） |
| 7 | 品牌 | 全局 Munder→AgFlow；hire spec→`agflow/hire@1`；协议→`agflow://` | 需求 + 本方案 |
| 8 | 远程内容 | `modelCatalog`/`hero` 远程拉取保留（能力保留）；如后续要求"零自发外呼"再切本地 | 本方案（可调整） |
| 9 | 语言包 | 删 en/ar，仅 zh-CN（需求四.1）；zh-CN 已 1170 键零缺失 | 需求 |
| 10 | 任务状态 | P1 仅 4 态中文映射；5 态 P2 可选 | 需求与代码差异 |
| 11 | 日志口径 | 用户可见全中文；开发者 console 保留英文键名 | 防范围失控 |
| 12 | 场景美术 | 仅改 key/名称/blurb，绘制逻辑复用 | 成本控制 |
| 13 | 本轮范围 | 仅交付方案 | 用户 |

---

## §6 验证与验收

### 6.1 阶段门禁

```
npm run typecheck && npm run test:focused && npm run build
npm run dist:win    # 产物名 AgFlow-*-portable.exe
```

### 6.2 残留机械检查（v3 重定义）

```
# 品牌清零（唯一需要清零的字符串类）
rg -i "munder|difflin" src/ electron-builder.yml package.json resources/   # 仅白名单：LICENSE.txt

# 遥测上报清零
rg -i "posthog|telemetryEnabled|__POSTHOG" src/ electron.vite.config.ts package.json   # 零命中

# 国外 CLI 属"保留能力"，不纳入残留检查（v3 决策 1/2）
```

### 6.3 冒烟清单（验收标准 v3 映射）

| # | 标准 | 步骤 |
|---|---|---|
| 1 | 全中文 | 遍历向导→主界面→设置全页→右键菜单→终端→任务/记忆/技能→错误提示 |
| 2 | 国产引擎可用 | 建 qwen/kimi/豆包智能体各 1 个→终端交互→发任务有产出；Kimi 桥通过后验证收件箱 |
| 3 | 败龙 | 默认"败龙"；改名全局同步；重启不回落；语音别名可用 |
| 4 | 多智能体协同 | 互发消息、god 派单、board/tasks 更新、记忆召回 |
| 5 | 核心功能 + 现有引擎回归 | 熔断、审批、技能、任务正常；**Claude/Codex 各跑一次冒烟**（提示词中文化后行为验证） |
| 6 | 合规 | 断网启动无异常；对 `src/` 无任何上报代码；设置中无遥测开关 |
| 7 | 便携 | U 盘 portable 包：数据在程序目录、换机完整、缺引擎中文提示 |

### 6.4 联网实测清单（C-7 汇总）

Qwen proxy 桥、Kimi hooks 桥、豆包 opencode 壳、DeepSeek dsh、opencode 插件桥——五项全部有兜底路径。

---

## §7 风险与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | 新增国产引擎的桥接/hook 面未实测（5 项） | 高 | C-7 前置实测；全部有兜底（空闲唤醒/弹回/基础可用） |
| 2 | 提示词中文化影响现有引擎行为 | 中 | 保留结构契约只换语言；Claude/Codex 回归冒烟（§6.3 #5）；必要时保留语言切换开关为后备 |
| 3 | 新增 provider 与现有默认回退逻辑耦合（infer/preset 兜底） | 中 | A-6 只追加测试；`provider-preset` 兜底与 `infer` 默认保持 claude |
| 4 | analytics 调用点遗漏（20 处） | 中 | A-5 清单 + typecheck 收口（删 import 后未删调用即编译失败） |
| 5 | 技能目录对新增引擎不兼容 | 中 | 提示词清单兜底；P1 实测 |
| 6 | DeepSeek Harness dev-preview 不稳定 | 中 | 版本锁定 + 壳回退 |
| 7 | 便携 vs npm 全局引擎矛盾 | 中 | 产品说明 + P2 引擎随行 |
| 8 | en/ar 删除影响外部贡献者 | 低 | 需求明确要求；zh-CN 全覆盖已核实 |
| 9 | 品牌替换遗漏（108 串） | 低 | §3-A1 表 + §6.2 grep 收口 |

---

## 附：版本勘误（v1 → v2 → v3）

- **v1/v2 的方案基调是"移除国外 CLI 生态"**（删除 9 个 provider、实时语音、听写、Slack/GitHub 集成、遥测、隧道等）。
- **v3 逆转**（用户最新指示）：CLI 只增不删、能力全保留、只删遥测上报；原 v2 的 A-5~A-10"删除清单"整体作废，替换为"追加式扩展"（§3-A6~A-9）；新增"智能默认引擎"（§3-A11）。
- 保留的 v2 结论：逐文件实施手册体例、§3-B 中文化全部步骤、§3-C 国产 CLI 落地细节、§3-D 败龙与角色、便携模式（§4/§6）。

### v3 复核修订（2026-10-10，开工前实测校正）

- zh-CN 键数口径：**1170 叶子键**（非 1203）；三份语言包逐键比对零缺失、零多余。
- 品牌命中实测：`src/` **108 串 / 34 文件**（`rg -i "munder|difflin"` 双计匹配 201）；另 electron-builder.yml 18、package.json 3、resources/ 5；应用本体范围外（blog/docs/landing 等）另有数百处不纳入。
- 技能实体：17 个 SKILL.md 中仅 3 个为 `md-*`（md-hive-sync/md-fetch-summarize/md-audit），其余 14 个为时间/能力类；`md-*` 改名须同步 `hire.ts` 的 `BUNDLED_SKILL_IDS`。
- 桥接安装函数为 **7 个**（agy/gemini/codex/pi/opencode/grok + installCrushConfig 特例）。
- 文档存放：方案 = 项目根目录 + `.trae/documents/` 副本；对话记录 = 项目根目录（`docs/agflow/` 不存在）。

### P0-A 实施偏差记录（2026-10-11）

实施期发现两处与 v3 方案的偏差，均已在代码注释中标注；此处为正式记录（不改动方案正文）。

| # | 偏差 | 方案原文 | 实际实现 | 原因 / 备注 |
|---|---|---|---|---|
| 1 | DeepSeek 预设未接 opencode 桥 | C-2：「4 个新预设全部 `hookBridge`/`bridge` 与现有 opencode 机制对齐」 | deepseek（dsh）预设**不声明 bridge**：邮件回弹总控（同 kimi 未接桥时的姿态）；`domesticEngines.ts` 的 OpenCode 回退壳自带 opencode 桥，切壳即恢复完整公民能力 | dsh 的扩展面是 Cordis 内核、非 OpenCode 插件 API，opencode shim 无法承载。代码注释：`agentProvider.ts` deepseek 预设。实测项见 C-7 |
| 2 | 智能默认引擎运行时跳过 kimi | A-11 / §5 决策 6：「已装国产优先（qwen→kimi→doubao→opencode）」 | `DOMESTIC_PREFERENCE` 列表保留原顺序，但 `pickDefaultEngine` 只对 god-eligible（`supportsModel && canReceiveInbox`）生效；kimi 桥未落地（C-4）前被跳过 → 实际顺序 **qwen→doubao→opencode**；都未装回退 `claude` | kimi 未接桥即不能收蜂巢邮件、不能当总控。代码注释：`engineAvailability.ts`。kimi 桥通过后无需改列表自动生效 |

其余 P0-A 项（遥测上报清理、品牌替换、国产注册表、spawn 侧泛化、向导智能默认对接）与方案一致，无偏差。

### P0-D 实施记录（2026-10-12）

D-1~D-3 已全部实施并验证（`typecheck` 通过；`test:focused` 888 项 = 887 过 / 0 失败 / 1 跳过；`build` 成功）。以下为实施定稿与方案未尽事项的正式记录（不改动方案正文）。

**D-1 败龙改名**：`DEFAULT_GOD_NAME='败龙'`、`MichaelBooting.tsx`→`GodBooting.tsx`（App.tsx 同步）、i18n 断言补「默认名 = 败龙」。按方案保留 `michael-voice`（actor / 邮件目录 / 日志戳）与语音别名 `god/michael`——属机器契约，重命名会孤立存量数据；内部标识符（`useRealtimeMichael`、`RealtimeMichaelToggle` 等）与英文注释保留（与 actor 可 grep 互证）。用户可见文案中的 Michael 已清零（含 releaseDrop 发布页 2 处）。

**D-2 角色映射定稿**（方案仅示例 7 个，其余 8 个实施期补齐；绘制配方与 look 复用，仅改 key / 名 / 简介）：

| 旧 key | 新 key | displayName / blurb |
|---|---|---|
| michael | lead | 项目负责人 / 统筹与决策 |
| jim | dev | 后端工程师 / 写代码、修缺陷（DEFAULT_CHARACTER） |
| pam | designer | 设计师 / 界面与体验 |
| dwight | qa | 测试工程师 / 质量把关 |
| kevin | data | 数据分析师 / 报表与指标 |
| angela | finance | 财务 / 预算与核对 |
| oscar | architect | 架构师 / 技术方案 |
| stanley | sales | 销售 / 客户与签约 |
| phyllis | support | 客户支持 / 答疑与安抚 |
| andy | ops | 运维 / 部署与稳定性 |
| kelly | marketing | 市场运营 / 推广与活动 |
| ryan | intern | 实习生 / 杂活与成长 |
| toby | hr | 人力资源 / 招聘与关系 |
| creed | security | 安全 / 审计与合规 |
| meredith | admin | 行政 / 后勤与采购 |

- 高耦合点同步：god 默认形象 `useHive.ts character:'michael'→'lead'`、OnboardingWizard 头像 2 处、hive 协议 spawn-request 示例 `character:'meredith'→'dev'`。
- **cafeteriaLines.ts 整体中文重写**（方案 D-2 未显式列出）：场景气泡是用户可见文案，原文案为纯美剧梗并含 TWSS 池；改写为中性办公闲聊并删除 `TWSS_EXCHANGES`，保留单人/同桌结构与导出签名。
- brooklyn99 删除连带清理：themeRegistry（import / ThemeId / BROOKLYN99_THEME / THEMES）、OfficeThemePicker 选项、main+renderer+preload 三处 config 类型 union、realtimeActions SETTING_POLICY values、删除 `assets/maps/brooklyn99.tmj`、ATTRIBUTION.md 地图段改写。存量 `officeTheme:"brooklyn99"` 经 `getTheme()` 安全回落 office。
- 画廊清单收口（后续追加执行）：`docs/hires/manifests/*.hire.json` 的 `character` 值已按上表映射更新（`erin` 无对应旧 key，按岗位归入 `support`）；`scripts/build-data.py` 的 PROVIDERS 与运行时对齐为 9 项并重跑，`manifests-data.js` 与 `manifests/variants/`（20 角色 × 9 引擎 = 180 份）重生成；`test/fixtures/bug-14.renderer.js` 角色值同步。**事后收口（2026-10-12）**：20 个角色的 `name`（旧美剧名 → 中文岗位名）与文件名（旧名-岗位 → 纯岗位 slug）已去美剧化，见 P1 记录行 6。

**D-3 角色模板库**：新增 `src/shared/agentTemplates.ts` 6 模板（后端 qwen/qwen3-coder-plus、前端 doubao/doubao-seed-2.1-pro、文档 kimi/kimi-for-coding、数据 deepseek/deepseek-v4-pro、测试 qwen/qwen3-coder-plus、运维 glm/glm-5.3；skills 取自 BUNDLED_SKILL_IDS）。AddAgentModal 删内联模板表、改读共享模板（一键预填简介/目标/引擎/模型，cwdRule 作提示）；`HIRE_PROMPT` 引擎清单追加 5 个国产项、示例名去 Office 化；表单默认名 `'Jim'→'小助手'`；随模板表移除，`zh-CN.json` 的孤儿键 `addAgent.templatesHint.*` 一并删除。hire allowlist 扩展：`hire.ts` PROVIDERS 与 `HireProvider` 追加 qwen/doubao/kimi/deepseek/glm（保留 claude/codex/antigravity/cursor，`custom` 仍禁用）；同步 `docs/hires/validator.js`、`spec/hire.schema.json`、`spec/HIRE_SPEC.md` 与 `test/hire-validator-parity.test.cjs`。

### P1 实施记录（2026-10-12 起）

按 §4-P1 清单推进；每项完成后在此追加。

| # | P1 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 自定义角色模板 | ✅ 已实施 | 新增 `src/main/agentTemplateStore.ts`：读/存/删 `harnessHome/templates.json`（逐条消毒、非法即丢、tmp+rename 原子写、40 条上限）；IPC `templates:list/save/delete` + preload 三方法（`CthApi` 自 `typeof api` 派生，无需改 d.ts）；AddAgentModal 简报区：内置+自定义 chip 合并渲染、「存为模板…」内联表单、自定义 chip 两击 ✕ 删除；新增 5 个 i18n 键；`test/agent-templates.test.cjs` 8 用例。验证：typecheck / test:focused 896（895 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 2 | 任务/审批文案 | ✅ 已核实（无需实施） | kanban 4 态（待办 / 进行中 / 已阻塞 / 已完成）与 AskMe 问答文案在 P0-B 已全中文，renderer 无遗留英文审批文案；「同意/拒绝」按钮若指新增交互形态，属功能项，另行评估 |
| 3 | 历史名称替换工具 | ✅ 已实施 | 新增 `src/shared/legacyNames.ts`（LEGACY_GOD_NAME / LEGACY_CHARACTER_KEYS / 结果类型）与 `src/main/nameMigration.ts`（扫描 board / tasks / memory / inbox+outbox；**只替换「旧总控默认名 → 目标名」这一条映射**——其他旧名是用户自己的智能体名，没有新名可替；命中文件先整份备份到 `backups/name-migration-<ts>/` + manifest，再 tmp+rename 原子替换）。IPC `legacyNames:scan/apply`：apply 要求**无终端在运行**（pty 守卫），总控仍是旧默认名时经既有 `hive.renameAgent` 改名（registry/fleet/log/commit 同步）再替换文本；设置 → 通用新增 `NameMigrationSection`（扫描 → 计划 → 确认）。兼容项：`character` 不落盘、渲染端按名推断，故保留旧名映射（`LEGACY_CHARACTER_KEYS`，存量叫 "Meredith"/"Jim" 的智能体不丢外观）。`test/name-migration.test.cjs` 6 用例。验证：typecheck / test:focused 902（901 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 4 | 角色设置面板 | ✅ 已实施 | 新增 `src/shared/godPersona.ts`（GOD_STYLES / GOD_STRATEGIES / 注入文本 / `buildGodPersonaPrompt`）与 `src/renderer/src/components/GodPersonaSection.tsx`（设置 → 自主性与预算：显示名 + 沟通风格 + 编排策略 + 楼层形象 + 一键恢复默认）。**与方案的一处偏差**：`displayName` 不落 config——名称真相源唯一（registry 改名通道，面板经 `store.renameAgent` 编辑），避免双源漂移；其余字段（style/strategy/avatar）按方案落 `config.godPersona`。注入：hive 新增 `setGodPersona` 镜像（bootstrap + 每次配置写入同步）与 `personaLine`（仅 god；默认值 = 空行，提示词与旧版逐字相同）；工人回退行与预处理助手人设补上总控实际名。形象：`useHive` 的 god 生成读 `godPersona.avatar`（cast key，未知值回落 'lead'）。`test/god-persona.test.cjs` 4 用例。验证：typecheck / test:focused 906（905 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 5 | GLM / Ollama 完整化 | ✅ 已实施 | 三个缺口补齐：① **密钥与端点 UI**：`AiEnginesSettings` 的 BACKENDS（原 5 项）与 CLIS（原 4 项）改为从 `DOMESTIC_ENGINES` 派生——豆包/GLM/DeepSeek 密钥表单按 `keyRef` 自动出现（后台 `BACKEND_KEY_ENV` 早已接受 `ark/glm/deepseek`，缺的只是表单），端点行提示注册表默认值、Ollama 无密钥不进密钥表；② **Ollama `/api/tags` 扫描**：新增 `src/shared/ollamaScan.ts`（纯函数 + fetch：`parseOllamaTags` / `ollamaRootFromBaseUrl` / `listOllamaModels`，3s 超时、非 200 与连接失败均收敛为 `ok:false` 不抛）→ main `ollama:listModels` IPC（渲染进程直连会撞 CORS/CSP）→ preload → AddAgentModal 在 ollama 引擎下新增「本机已装的 Ollama 模型」组（扫描按钮 → 结果 chips，带参数量/体积提示）；**「一键创建」语义 = 点击 chip 预填 provider+model，不自动 spawn**（沿用"导入永不自动生成"）。③ **slug 断链修复**：注入侧 `blockIds = eng.id === 'ollama' ? ['local','ollama'] : [eng.id]` 双 provider 块同端点声明——catalog 的 `local/<tag>` 与本地快选 `ollama/<tag>` 都能被 OpenCode 壳解析；`hasOssQuickPicks` 纳入 `'ollama'`。新增 5 个 i18n 键；`test/ollama-scan.test.cjs` 7 用例（含本地 http 服务器走真实 fetch 路径）。验证：typecheck / test:focused 913（912 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 6 | 画廊角色去美剧化（name + 文件名） | ✅ 已实施 | `docs/hires` 静态画廊 20 个角色：文件名 slug 由「旧名-岗位」改纯岗位（`jim-pr-reviewer`→`pr-reviewer`、`pam-docs`→`docs-writer`），`name` 字段由美剧英文名改中文岗位名（Jim→代码评审员、Pam→文档专员）；index.json 同步 + `build-data.py` 重跑（180 份 variants + manifests-data.js 重生成，旧 variants 已删）；spec 示例 2 处、index.html 占位与空态文案 2 处同步；goal 散文里的 2 处原文彩蛋（Meredith / Creed Bratton）按用户要求保留原样（曾试改，已精确还原并重生成）。文件名与 name 字段残留扫描 0 命中。验证：parity 18/18（覆盖全部 200 份 manifest 双校验器）、typecheck / test:focused 913（912 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 7 | 开发文档旧名清理（README 等） | ✅ 已实施 | 用户确认边界：当前文档清、历史存档不动。替换规则：总控旧名 Michael → 新默认名「败龙」。README.md 10 处（含 ASCII 架构图内单元格，宽度按 CJK 双列对齐）；HIVE.md 3 处（含技术修正 `character: michael` → `character: lead`）；MEMORY_GRAPH_SPEC.md / docs/ARCHITECTURE.md / `src/renderer/src/realtime/VOICE-MESSAGE-ACCESS.md` 各 1 处。**署名类旧名已中性化清理**（人名→无主引用，13 处）：MEMORY_GRAPH_SPEC `author: Jim`、docs/design/knowledge-graph.md（Author: Stanley、Jim ×2）、hive/docs/integration-templates.md（Jim ×7、Ryan ×2）；4 份文件复扫 0。**站点/博客评估完成（2026-10-12）**：约 150 文件、约 900 处，全部位于生成管线或历史内容——`docs/blog`（81 文件 501 处）是 `blog/` Eleventy 构建产物（`rimraf` 重建，勿手改）；`docs/index.html` 由 `tools/landing-halloween` 模板生成、`docs/pro/index.html` 由 `tools/landing-story` 生成（勿手改产物）；`docs/llms.txt` 手写头部+博客段由 postbuild 生成；博客源 57 文件 257 处（12 篇发布文=历史存档）；站头 5 文件 58 处、落地页模板 25 处、SEO 规划 8 处、历史材料 20 处、媒体演示 36 处。页面为"story cut"（角色名叙事 + `pt-*` 精灵类 + Munder Difflin 品牌字样深绑）→ 用户选定 **方案 A（全站，含品牌一轮）**，品牌新名 = **AgFlow**（P0-A 既定映射），**2026-10-12 已执行**：HOSTS/BRAND/CAST 三层映射机械替换 253+9+9 文件（跨行拆词、JSON 字面粘连、URL 编码另补三遍）；~60 项品牌文件名重命名（blog 资源 / docs/hires / tools / seo）；漫画梗文 `the-office-parody-behind-munder-difflin` 整篇删除（连带 assets 与引用）；上游专属外链元素清理（README 徽章 4 行、落地页荣誉墙/星标/Discord、页脚 GitHub、pro 同款）；当前文档（README/HIVE/MEMORY_GRAPH_SPEC/ARCHITECTURE/VOICE-MESSAGE-ACCESS）Michael→败龙。收尾：星标锚点×3 与 updateStars JS 块、MD 字体代号→AG（落地页 + pro）、`docs/CNAME`（旧域名残留）删除。终端复扫：现行/其它 0 残留（仅历史存档 + 白名单 Kevin Liao/Kevin Tsai + 用户保留彩蛋）。历史存档 CHANGELOG.md / RELEASE.md 与记录类（本方案文档、开发对话记录）不动。验证：parity 18/18；落地页/画廊重建断言全过。 |
| 8 | 博客整体删除（用户决定） | ✅ 已实施 | 用户评估后决定"不影响产品即删、之后重做"。结论：博客是站点内容板块，桌面应用无功能依赖；应用侧仅 `src/shared/ossModels.ts` 的 `OSS_BLOG_LINKS` 两个"指南"外链指向博客文章（已是占位域名死链），**保留不动**（待新博客重指）。执行：删除 `blog/`（Eleventy 源 + 57 帖 + media-src）与 `docs/blog/`（353 文件产物）；`docs/CNAME`（旧域名）一并删除；引用清理 = 落地页模板（导航/抽屉/页脚 Blog + 页脚 GitHub）、`docs/pro`（同款，就地编辑）、`docs/wall.html`（导航/页脚）、`docs/preview.html`（First-run 引导句）、README（Blog 徽章 + BYOK 指南链接）、`docs/llms.txt`（Key guides/Comparisons/BLOG 生成块，211 处）、`docs/llms-full.txt`（28 处）、`docs/sitemap.xml`（209 博客 URL → 仅存 5 个根 URL）、`tools/landing-story/body.html`。备份：`/tmp/agflow-blog-removal-20261012-195602.tgz`（123M / 2835 项，含全部待改文件）。保留：`seo/BLOG_IDEAS.md`、`seo/SEO_METADATA.md`（重做规划参考）、`docs/r/*.json`（Reddit 归档，历史存档政策）。验证：落地页重建断言全过（docs/index.html 373,596 字符）；站点复扫 starct / blog 链接 / 字体代号全 0；残留仅上述保留项。**顺带发现（范围外工程件，已报用户待定）**：`.github/` 模板与 workflow（upstream discussions 链接）、根 `DESIGN.md`/`SPEC.md` 标题、`build/icon.svg` 与 `entitlements.mac.plist` 注释、`build/SIGNING.md` 示例命令、`scripts/generate-contributors.mjs`（默认仓库 + 文案）、`landing-remotion/`（视频工程）、`docs/banner.svg`+`banner.png` 旧字标（未被引用）、`prototypes/vde/index.html`、`.gitignore` 旧规则、`.claude/skills/ian-xiaohei-illustrations` 旧品牌引；历史存档（CHANGELOG/RELEASE/drops/research/deck）与测试固定件（release-notes/terminal-selection 等）按政策保留 |
| 9 | 官网页面整体删除（用户决定） | ✅ 已实施 | 用户明确「只要软件，不要宣传官网」；经两轮收窄后范围 = 公开网站页面本体（27 文件）：`docs/index.html`、`docs/pro/`、`wall.html`+`wall-data.json`、`download/terms/privacy.html`、`preview.html`+`preview.css`+`pam-tokens.css`、`harness-engineering-deck.html`、Google 验证页、`robots.txt`、`sitemap.xml`、`llms.txt`、`llms-full.txt`、`banner.*`、`badge-github-trending.*`、`favicon-{32,48,192}`、`favicon.ico`、`apple-touch-icon.png`、`logo-light.png`、`logo-mark.svg`。**用户指定未动**：`docs/media/`、`screenshots/`、`hires/`、`model-catalog.json`、`hero.json`、工程文档（ARCHITECTURE/DESIGN/message-queue/design）、历史材料（research/drops/r/evidence/pr-evidence/release-drops）、`tools/`、`landing-remotion/`、`seo/`、`.github/`（含 blog.yml）。保留 `logo.png`+`logo.svg`（README 头图 + make-logo 图形源）。备份：`/tmp/agflow-site-removal-20261012-202410.tgz`（63M / 371 项）。验证：test:focused 913（912 过 / 0 失败 / 1 跳过）、build 全绿——软件本体零影响。遗留（只服务官网、未清，已报用户）：media 站点专属视频图（约 45M）、hires 画廊页（与测试基线同目录未拆）；陈旧文案：RELEASE-CHECKLIST L11-12、docs/ARCHITECTURE.md L74、docs/DESIGN.md、tools/check-release-links.cjs（existsSync 守卫不报错）、blog.yml（死 CI） |
| 10 | 记忆中文检索 | ✅ 已实施 | 两条通道：① 默认嵌入模型 `minilm`→`embeddinggemma`（多语言，中文语义可检索；`config.ts` 默认值 + `index.ts` 兜底值 + MemoryPanel 文案「所有语言（含中文）」+ HIVE.md 同步）；② **全文回退**：MemoryPanel 搜索接入 `hive:textSearch` 子串扫描（indexOf 无分词，对 CJK 天然可靠）——含 CJK 的查询或语义失败/零结果时自动追加「全文匹配」段；搜索框不再要求 mempalace 已安装（未装/未启用也可搜全文）。新增 `src/shared/memoryFallback.ts`（`wantsTextFallback` CJK 判定 + `formatTextHits`）+ `test/memory-fallback.test.cjs` 4 用例；zh-CN 新键 `memoryPanel.textMatches`。验证：typecheck / test:focused 917（916 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 11 | 国内镜像源 | ✅ 已实施 | ① **npm 镜像源**（引擎 CLI 安装提速）：新配置键 `npmRegistry`（main/preload/store 三处类型 + 默认值，缺省 = 官方源）；新增 `src/shared/mirrors.ts`（`sanitizeMirrorUrl` 仅收 https + 保守字符集——URL 会写进 shell 脚本，`&`/引号/`$` 一律作废；`withNpmRegistry` 只给 `npm install…` 追加 `--registry`）；注入点 = `cliInstall.buildMissingCliScript`（新增第 6 参：缺 CLI 自动安装脚本 + 手动提示行）与 `tools:status`（Prerequisites 展示/复制、交给败龙执行的 prompt 一并带上）；UI：前置条件页新增 npm 镜像源输入（立即保存——与 API key 同类例外，已注释说明）。② **更新源可换**：新配置键 `updateFeedUrl`；`updater.runCheck` 在检查前 `setFeedURL({provider:'generic'})`（仅 https；notify-only 兜底仍走 GitHub）；UI：设置→通用→更新区新增自定义更新源输入。i18n 新增 8 键。测试：`test/mirrors.test.cjs` 6 用例（拒绝 http/元字符、npm 注入、win 单行无引号、缺省逐字兼容）。验证：typecheck / test:focused 923（922 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 12 | 技能库与引擎适配 | ✅ 已实施 | ① **中文分类/搜索**（前序已落地，本轮补口）：`SkillsTab.tsx` 的分类映射（`CATEGORY_ZH`）、中文搜索别名（`ZH_SEARCH_ALIASES`）、插件描述均已中文；本轮补作用域徽标映射（user/project/bundled → 全局/项目/内置）。② **按各引擎技能目录投放**：新增 `src/shared/skillTargets.ts`——按官方文档核实各引擎约定（2026-10）：Claude Code `.claude/skills`（不变）；**OpenCode 家族（opencode/豆包/GLM/Ollama）官方文档确认会扫描「全局配置目录 `$OPENCODE_CONFIG_DIR/skills`」**，而 spawn 早已把 OPENCODE_CONFIG_DIR 指向 `<agentDir>/.opencode`（plugin 桥），故新增投 `<agentDir>/.opencode/skills`，Claude 兼容路径一并保留；DeepSeek 同投两路（dsh 官方技能目录未见公开约定，切回 OpenCode 壳即生效）；Qwen Code（`~/.qwen/skills` / `<项目>/.qwen/skills`）与 Kimi（`~/.kimi/skills`、项目 `.kimi/skills`、`--skills-dir` 且该参数会「替代」自动发现）无 per-agent 配置通道——写用户家目录/用户仓库都不可接受，故不投放：Qwen 由提示词兜底，Kimi 记为遗留（待其桥/配置隔离落地）。③ **提示词兜底行**（方案 P0 承诺、此前未落地）：`hive.injectedPrompt` 新增 `skillsLine`——非 Claude 且有种子通道的引擎（codex/grok/pi/agy/gemini/qwen/dsh/crush/opencode 家族）注入「内置技能清单 + 目录 + 先读 SKILL.md + 只读约束」，清单来自 `bundledSkillIds`（resources/skills 下含 SKILL.md 的目录）；Claude 保持原生发现不加行。`test/skill-targets.test.cjs` 4 用例。验证：typecheck / test:focused 927（926 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 13 | 技能包扩充 | ✅ 已实施 | 新增 `resources/skills/af-weekly-report`（周报生成：git 历史 + board.md/tasks.json + memory.md 汇总，只读输出不落盘）与 `af-api-docs`（接口文档：扫路由面 → 结构化 API 文档，只读）；`BUNDLED_SKILL_IDS` 扩至 5 项，三处 allowlist 同步（`docs/hires/validator.js`、`docs/hires/spec/hire.schema.json`、`docs/hires/spec/HIRE_SPEC.md`；af-audit 已在库，代码审计无需重做）。投放与提示词清单零改动自动覆盖（copyBundledSkills 整目录复制；bundledSkillIds 磁盘扫描）。新增 `test/bundled-skills.test.cjs` 3 用例（allowlist ↔ 落盘一一对应、frontmatter name 与目录 id 一致、新技能可被 hire 校验器引用）。验证：typecheck / test:focused 930（929 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 14 | 国产新引擎适配（TraeCLI / CodeBuddy / ZCode） | ✅ 已实施 | 用户指定「国内主流也要适配」。官方文档侦察（2026-10）：字节 **TraeCode CLI**（`traecli`，curl 脚本安装；`traecli "<prompt>"` 位置参数首提示；`-m/--model`、`--permission-mode`、`--resume`；技能目录 `~/.traecli/skills` + `<项目>/.traecli/skills`）；腾讯 **WorkBuddy / CodeBuddy 产品系**（桌面工作站、VS Code 插件、**CLI** 三形态；其 CLI 形态 = `codebuddy`，npm `@tencent-ai/codebuddy-code`，工作区/企业文档的 CLI 命令参考即它——**用户口中的 WorkBuddy 就是同一产品系，已按此适配**；引擎 label 记「CodeBuddy · 腾讯（WorkBuddy）」便于检索；`codebuddy "query"` 位置参数；`--model`、`--dangerously-skip-permissions`、`--resume`；技能目录 `.codebuddy/skills`，`CODEBUDDY_CONFIG_DIR` 可做配置隔离——但会连账号登录态一起隔离，刻意不做，技能由提示词清单兜底）。**GLM ZCode**：初查官网表层曾误判「GUI、无 CLI」，回查官方仓库 `zai-org/ZCode`（Apache-2.0 一方源码，README 更新至 v3.15.1 / 2026-10-10）后纠正——ZCode 有官方「命令行版」：`zcode` **无参数进入 TUI**（命令行发行包含 TUI/Web/Agent，统一 `zcode` 启动；二进制亦随桌面安装包附带，app bundle / PATH / ZCODE_BIN 三路可寻；运行时要求 Node ≥ 22）。已注册为独立引擎 `zcode`（seed 打字投递、无桥、不做 --model 注入、npm 无官方包故不提供脚本安装、docsUrl 指向官方安装页）。另保留 `domesticEngines.glm.hint`：GLM Coding Plan（ZCode 同款套餐）订阅用户的端点提示（`https://open.bigmodel.cn/api/coding/paas/v4`）。实现：`AgentProvider` 追加 `traecli`/`codebuddy`/`zcode`（isAgentProvider / inferAgentProvider / 三组 preset：traecli+codebuddy 位置参数引导、zcode 种子打字投递；均无桥（邮件退回总控，kimi 姿态）；安装命令：traecli 原生脚本 / codebuddy npm+原生双梯级 / zcode 不提供脚本安装；auto 旗标与 resume 按已核实文档给值，未知一律留空）；ProviderLogo 三枚占位 glyph；modelCatalog（baked + docs 远端各一份）加 traecli/codebuddy「CLI default」与 zcode 空数组；hire 允许清单（hire.ts / validator.js / schema / parity 测试）与 HIRE_PROMPT 文案同步；CONTEXT_COMMANDS 三条「宁可 null 不猜」条目；提示词技能清单兜底（P1-3 机制）自动覆盖三者。测试：agent-provider 3 用例新增（自测运行器直接通过），provider-config / model-catalog / hire-parity / skill-targets 期望值同步。验证：typecheck / test:focused 930（929 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 15 | P2 便携增强（引擎随行目录 + 数据目录重定向 + 迁移向导） | ✅ 已实施 | ① **数据目录重定向**：新增 `src/shared/portable.ts`（纯函数、不 import node:，平台走参数）：`resolvePortableDataDir` 三档优先级 = 环境变量 `AGFLOW_DATA_DIR`（仅收绝对路径，相对路径会随 CWD 漂移故拒绝）→ Windows portable 包注入的 `PORTABLE_EXECUTABLE_DIR` → 程序目录标记文件 `agflow-portable.marker`（macOS 查 exe 同级与 `.app` 同级两处，映射为 `<程序目录>/data`）；main 顶部（ready 之前、任何 userData 消费者之前）捕获 `DEFAULT_USER_DATA_DIR` 后 `app.setPath('userData'/'sessionData')` + mkdir；`test/portable.test.cjs` 11 用例。② **引擎随行目录**：`<数据目录>/engines` 启动时创建并 `ptyManager.setEnginesDir` 注入（清解析缓存）；`PtyManager.resolveCommandUncached` 先查 engines 候选（win 按 `.exe/.cmd/.bat` + 裸名）、`spawn` 时 `withEnginesPath` 置顶子进程 PATH（去重、win 大小写不敏感——`withHiveRuntimeFallback` 外再包一层）；`tools:status` 探测同一优先级（与 spawn 解析一致，面板所见即启动所用）；用户把 CLI 丢进该目录即随包优先，删掉即回落系统版本。③ **迁移向导**：新增 `src/main/portableData.ts`（纯 fs、不 import electron）：扫描 config.json（数据目录根）+ roster.json/templates.json（源目录本身 → 旧 config.json 记录的 harnessHome → `<源>/hive` 三候选）；导入**绝不覆盖**（复制前一刻二次判定 + tmp+rename，失败记 errors 不留半成品）。IPC `portable:status/scan/pickSource/import/relaunch`（import 由主进程重新扫描，不信任渲染端传来的 from/to）+ preload 5 方法；设置 → 通用新增 `PortableDataSection`（模式/来源/数据目录/引擎目录与计数/hive 根 → 扫描 → 迁移计划 → 不覆盖导入 → 重启生效）；zh-CN `portable` 键组 30 键。便携首启 hive 默认 `<数据目录>/hive`；**换机重指向**：config 里旧的绝对路径失效而 `<数据目录>/hive` 在盘时改指当前路径（磁盘盘符/挂载点变化后自动恢复，自定义离线路径不误伤）。④ 验收对齐（§6 行 540 / §7 行 558）：数据在程序目录 ✓、换机完整（数据+配置+hive 重指向）✓、缺引擎中文提示（沿用 P0 中文安装提示 + 分区内 `engines/` 说明）✓；npm 全局 vs 便携引擎矛盾 → 随行目录优先 + 分区说明。`test/portable-data.test.cjs` 5 用例。验证：typecheck / test:focused 946（945 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 16 | 真机实测扩展与 opencode 双发行线自适应 | ✅ 已实施 | 用本机实际可用产物把实测从 agy/gemini 扩到 **opencode（桌面内置 CLI 2.0.27）** 与 **zcode（桌面内置 cjs 0.16.9）**。① **opencode v1/v2 差异修复**（真机实测引出，非猜测）：新增 `src/main/opencodeCli.ts`（纯逻辑、无 electron 依赖）——`parseOpencodeHelp` 从 `--help` 识别发行线（v2 TUI 无 `--model` 旗标、需 `--standalone`），`probeOpencodeCli` 按二进制缓存探测，`adaptOpencodeArgs` 把 v2 的 `--model` 从 argv 摘出改注 per-agent config（`OPENCODE_CONFIG_CONTENT.model`）并补 `--standalone`（不带它 v2 会连共享后台服务，per-agent 配置/插件全失效）；`index.ts` spawn 链按探测结果自适应，`hive.ensureAgent` 新增 `opencodeV2` 选项：v2 只建 per-agent 隔离配置目录（theme），**跳过 v1 插件投放**（真机实测：v2 会扫 `plugin/`+`plugins/` 但插件契约不认 v1 事件名，投放即报 "plugins failed"；该发行线的实时状态/收件箱唤醒走渲染端空闲 nudge 兜底）。② 实测脚本 `tools/live-engine-check.cjs` 扩至四引擎（agy/gemini/opencode/zcode）并按发行线分支断言（opencode 世代分支、zcode headless+环境变量直通、manager 拉起补退出检测）。真机结果：**opencode 全链路通过**——世代探测 `tuiModelFlag=false / needsStandalone=true`、`--model` 摘除+`--standalone` 补上、随行目录解析拉起（`session.command=<数据目录>/engines/opencode`）、TUI 真实会话「Build · DeepSeek V4.1 Flash」回答 HIVE-OK、无 plugins failed 警告；插件 payload 0 为 v2 契约差异（信息性，不阻塞）。**zcode**：AgFlow 侧链路全通过（打字投递契约 ✔ / 随行目录拉起 ✔），CLI 启动链路 ✔（须注入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，否则报「无法定位 CLI ZCode Built-in Provider Config」；TUI 运行时 `@zcode/tui` 仅随 SEA/agent bundle 分发，raw cjs 开不了 TUI），模型回合被 CLI 自身交互态拦住（需先在 TUI 内 /model 选模型）——环境限制，非 AgFlow 侧。`test/opencode-cli.test.cjs` 7 用例。验证：typecheck / test:focused 953（952 过 / 0 失败 / 1 跳过）/ build 全绿 |
| 17 | DeepSeek 真机实测与默认壳切换（dsh → OpenCode 壳） | ✅ 已实施 | 用户指定「本地的 deepseek 可以试一下」→ 用本机 `DeepSeek Harness.app`（桌面内置 dsh 0.2.0-rc.2）实测。**发现**：① 裸 `dsh` 直接退出（`error: --profile <name> is required`）——原预设（`defaultCommand: 'dsh'` + 打字投递）在真机上无法启动工人；② 该发行线只有 web/desktop/headless 三种 profile，**没有可交互终端 profile**（npm 与桌面包均无 `dsh-tui` bundle，`dsh tui` 报 profile 不存在；`dsh headless` 必须带 argv 任务、一轮即退）——按 C-7 验证结论把 deepseek 默认壳切回 OpenCode（`--model deepseek/<id>` + 生成的 provider 块指向 api.deepseek.com）；dsh 仍可手动使用（命令框 `dsh <profile>`，`inferAgentProvider` 映射保留）。**实现**：`domesticEngines.ts` deepseek.shell `'dsh'→'opencode'`；preset 对齐 opencode 壳（defaultCommand / modelFlag / supportsModel / bridge / canReceiveInbox / initialPromptFlag / installCommand 全部同步，deepseek 由此进入 god-eligible 与收件箱通道）；`realtimeActions.PROVIDER_COMMAND`、`providerAutomation` 斜杠表（/compact、/new）同步；**顺带抽取** `domesticOpencodeProviderBlocks()` 共享生成器（index.ts spawn 与实测脚本共用同一份 provider 块生成，保证「实测跑的配置 = 产品生成的配置」，源码断言随迁）。**真机结果（opencode 壳 + DeepSeek 后端）全链路通过**：世代探测 `tuiModelFlag=false` ✔、HIVE_SOCK + per-agent 隔离配置目录 ✔、种子 argv `--model deepseek/deepseek-v4-flash` ✔、v2 自适应（摘 `--model` 改注 config + 补 `--standalone`）✔、随行目录解析拉起（`session.command=<数据目录>/engines/opencode`）✔、TUI 显示「Build · DeepSeek-V4 Flash」并回答 HIVE-OK ✔、无 plugins failed ✔；插件 payload 0 = v2 插件契约差异（信息性，渲染端 nudge 兜底）。另记：dsh headless 单发实跑真实作答（`dsh headless "只回复：DSH-OK"` → DSH-OK），证明本机 DeepSeek 账号与模型可用，问题只在「无交互 profile」。测试更新：agent-provider、provider-config（workersOnly 移除 deepseek）、model-catalog（注释）、ollama-scan（源码断言改指共享生成器）。验证：typecheck / test:focused 953（952 过 / 0 失败 / 1 跳过）/ build 全绿 |

### 真机实测记录（P2 收口，2026-10-12）

新增可复用实测脚本 `tools/live-engine-check.cjs`：`node tools/live-engine-check.cjs <agy|gemini|opencode|deepseek|zcode> [--short] [--shim-only] [--keep] [--timeout=ms]`（退出码 0 全绿 / 1 断言失败 / 2 拉起成功但 CLI 侧未闭环）。流程：临时 harnessHome 真实调用 `hive.ensureAgent` → 断言桥面文件 / 注册表 / 种子 argv → node-pty 真拉起 CLI + 裸 socket 服务收 HIVE_SOCK 回报 → CLI 拉不起来时自动降级 **shim 级实测**（喂真实生成的 shim、真实 stdin 形状）→ 跑完还原（agy 的全局 `~/.gemini/**/hooks.json` 先备份后还原，已复核零残留）并清理临时目录。

本机结果（macOS，agy 1.2.6 / gemini 0.60.0；本机仅装这两个引擎）：

| 引擎 | 桥面安装 | 种子 argv | 真实拉起 | CLI 触发 hook | shim → socket |
|---|---|---|---|---|---|
| agy | ✔ 两份全局 hooks.json 注入正确 | ✔ `[-i, prompt]` | ✔ TUI 正常启动 | ✘ 未登录（停在 Google OAuth 登录界面） | ✔ PreToolUse / Stop |
| gemini | ✔ per-agent system-settings.json | ✔ `[-i, prompt]` | ✔ 进程启动（无输出） | ✘ 后端网络不通（`generativelanguage.googleapis.com` 连接超时，curl 复核） | ✔ BeforeTool→PreToolUse / AfterAgent→Stop |

结论：AgFlow 侧全部链路（桥面安装、种子投递、shim↔socket 契约）真机通过；两个引擎都是 Google 后端，本机网络不通 + agy 未登录，故「CLI 自身触发 hook」那一跳无法在本机完成——换到可登录/可联网环境后一条命令复跑即可闭环。首轮复核（当时口径）：本机无其他引擎 CLI（claude/codex/qwen/kimi/opencode/crush/dsh/pi/traecli/codebuddy/zcode 均不在 PATH）、Ollama 未运行。

### 真机实测扩展（同日稍后：本机桌面内置的 opencode / deepseek / zcode）

首轮之后发现本机三个桌面应用自带可用 CLI 产物（opencode / DeepSeek Harness / ZCode），实测据此扩展（脚本已按发行线自适应，见 P1 记录行 16、行 17）：

| 引擎（本机产物） | 桥面 | 种子投递 | 真实拉起 | 随行目录解析 | 模型回合 | 结论 |
|---|---|---|---|---|---|---|
| opencode（`/Applications/OpenCode.app/.../opencode-cli`，v2.0.27，DeepSeek 后端可达） | ✔ v2 世代探测 + 跳过 v1 插件投放（TUI 无 plugins failed） | ✔ argv：`--standalone --prompt …`（`--model` 摘除、改注 config） | ✔ TUI 正常启动 | ✔ `engines/opencode` | ✔ 真实会话「Build · DeepSeek V4.1 Flash」回答 HIVE-OK | **全链路通过**（唯一保留项：插件 payload 0 = v2 插件契约差异，信息性不阻塞；该发行线走渲染端 nudge 兜底） |
| deepseek（产品路径 = OpenCode 壳 + api.deepseek.com；本机 OpenCode.app 内置 v2 CLI + `DEEPSEEK_API_KEY`） | ✔ v2 世代探测 + 跳过 v1 插件投放 | ✔ argv：`--model deepseek/deepseek-v4-flash` → v2 摘除改注 config + `--standalone --prompt …` | ✔ TUI 正常启动 | ✔ `engines/opencode` | ✔ 真实会话「Build · DeepSeek-V4 Flash」回答 HIVE-OK | **全链路通过**（默认壳已由 dsh 切至该壳，见 P1 记录行 17） |
| zcode（`/Applications/ZCode.app/.../glm/zcode.cjs`，0.16.9） | ✔ 无桥契约（不注入 HIVE_SOCK） | ✔ 打字投递契约 + headless `--prompt` 实测 | ✔ CLI 会话初始化（session / MCP 启动） | ✔ `engines/zcode` | ✘ 被 CLI 自身交互态拦住（需先在 TUI 内 /model 选模型；raw cjs 无 TUI 运行时） | **AgFlow 侧全通过**；模型回合属 CLI 侧环境限制 |

三条结论均已回写产品代码（真机实测引出，非猜测）：① **opencode v2 桌面内置 CLI**：TUI 无 `--model` 旗标（只有 run 子命令有）、不带 `--standalone` 会连共享后台服务（per-agent 配置/插件全失效）、v1 插件契约在 v2 上不生效（投放即报 plugins failed）→ 产品侧自适应 argv + v2 跳过 v1 插件投放。② **zcode 桌面内置 cjs**：必须 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 直通内置 provider 配置（否则报「无法定位 CLI ZCode Built-in Provider Config」），且 `@zcode/tui` 仅随 SEA / agent bundle 分发、raw cjs 开不了 TUI——用户装的是独立命令行版时不受此限；TUI 内首次 /model 选模型是 CLI 自带 onboarding。③ **dsh（DeepSeek Harness CLI）**：0.2.0-rc.2 只有 web/desktop/headless 三种 profile、**没有可交互终端 profile**——裸 `dsh` 报 `error: --profile <name> is required` 后退出（原预设的启动方式在真机上必然失败），`dsh tui` 报 profile 不存在（npm 与桌面包均无 tui bundle），`dsh headless "<task>"` 可单发真实作答（→ DSH-OK，证明账号/模型可用）但一轮即退；故 deepseek 默认壳按 C-7 结论切回 OpenCode（真机全链路通过），dsh 保留手动可达。