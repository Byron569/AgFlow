---
name: capabilities
description: |
  你的能力目录——每次启动都读一遍。列出你作为被生成的工人可用的时间类技能与外部集成
  （通过回环代理接入），以及每个的确切调用方式。只读。当你不确定自己有哪些工具/集成、
  或不知道该怎么调用它们时，查这里。
allowed-tools:
  - Bash
---

# 工人能力目录

你是蜂巢生成出来的自主智能体：完成一个目标，然后汇报。这份目录告诉你**你能做什么、怎么调用**——你的时间类技能和你的外部集成——省得你靠猜。这里的一切调用都是只读的（集成本身可能会执行动作，但对你这一侧全部经过代理，且不接触任何凭据）。

## 1. 你的运行环境

应用会注入这些环境变量（用它们，别硬编码路径）：

- `AGENT_ID`、`AGENT_NAME` —— 你在蜂巢里的身份。
- `AGENT_DIR` —— 你的私有工作目录（`identity.md`、`memory.md`、`inbox/`、`outbox/`，以及 `.claude/skills/`）。内置技能就在 `$AGENT_DIR/.claude/skills/` 下。
- `HIVE_ROOT` —— 共享的蜂巢目录（`PROTOCOL.md`、看板、其他智能体）。

启动时你还有 `identity.md`（你是谁）和 `HIVE_ROOT/PROTOCOL.md`（完整的协作协议）。要给总控或其他智能体发消息，就往 `$AGENT_DIR/outbox/` 写一条消息 JSON（格式见 PROTOCOL.md）。任务完成后，给总控发一条 `"act":"done"` 的出箱消息，附上实质性的结果摘要。

## 2. 时间类技能——相对「现在」的具体日期范围

当任务有明确的时间范围时，把日期解析出来，不要手算。每个技能都会输出含首尾的民用日期（`YYYY-MM-DD`，你的本地时区）**以及**用于时间戳查询的半开区间 `[startUtc, endExclusiveUtc)` 时刻。全部只读（只读时钟、只打印；不写文件、不联网）。

具名快捷方式（直接调用）：

| 技能 | 解析出的范围 |
| --- | --- |
| `/today`、`/yesterday` | 单个自然日 |
| `/thisWeek`、`/lastWeek` | ISO 周（周一起算）；this = 周一→今天，last = 上一个完整周 |
| `/last7Days`、`/last30Days` | 截止今天、向前滚动的 N 天窗口 |
| `/thisMonth`、`/lastMonth` | this = 1 号→今天；last = 上一个完整自然月 |
| `/thisQuarter`、`/lastQuarter` | this = 季度初→今天；last = 上一个完整季度 |
| `/thisYear`、`/lastYear` | this = 1 月 1 日→今天（YTD）；last = 上一个完整自然年 |

**任何**窗口——包括 `last90Days`、`last12Months`，或任意的 `lastNdays` / `lastNweeks` / `lastNmonths`——都用 `/temporal`，或直接调用解析器：

```bash
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" last30Days   # 一个窗口
node "$AGENT_DIR/.claude/skills/temporal/when.mjs"             # 全部窗口
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --json 90d  # 只输出 JSON
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --list      # 关键词
```

约定：`this*` 窗口是**周期起点 → 今天**（至今）；`last*` 具名周期是**上一个完整周期**。

## 3. 外部集成——走回环代理

外部服务通过蜂巢的**回环代理**接入：应用在 `127.0.0.1` 上跑的本地、带认证的端点。你调用代理；凭据由它持有，由它替你发起对外请求。你从不接触、也不保存任何密钥，且只接受回环调用——所以集成访问经过代理、可审计，对你这一侧无需凭据。

集成以何种形式暴露给你**取决于运行环境**——究竟启用了哪些，取决于你被生成的方式与蜂巢配置——所以运行时自己去发现哪些可用，别假设。即便具体集成不断增减，这套代理模式是稳定的；把下面这份清单当作当前能看到的表面，而非固定契约。

你现在可能具备的具体能力（依赖前先确认可用性）：

- **回复来源 Slack 线程。** 如果你的目标来自 Slack，你的派发消息里会带有确切的回环回复命令——`node "<helper>" --channel <C> --thread <T> --text "<mrkdwn>"`。用**那条**命令原样把结果发回线程。要发实质性的回复（一行 `*加粗*` 的结论 + 实际结果/链接），不要只发一句 "done"。
- **蜂巢消息。** 通过给总控或其他智能体写一条出箱消息 JSON（`$AGENT_DIR/outbox/`）来协调或交接。这是你永远可用的通道。
- **语义记忆（记忆宫殿 / MemPalace）。** 如果为你启用：`mempalace search "<query>"` 召回共享知识，`mempalace wake-up` 拿一份摘要。
- **企业知识图谱。** 如果启用：`node "$KG_CLI" search "<query>"` 拿排序后的段落，`node "$KG_CLI" list`、`node "$KG_CLI" get <id>`——公司特定的事实用它，别靠猜。
- **MCP 集成**（文件系统、git 等）在启用时会预先接入你的会话设置；像普通工具一样调用即可。具体启用哪些由蜂巢的授权配置决定。

随着更多代理集成落地（日历、邮件、文档、网页抓取……），形态不变：经代理、无凭据、运行时自行发现。把它们和上面的时间类技能配合使用——先解析出日期窗口，再把具体的 ISO 边界传给集成查询。

## 4. 边界

- 时间类技能是**只读**助手——从不写文件、不触网。所有外部调用都经代理中介；你手上没有任何凭据。
- **不要**向任何远端 push 或打 tag。本地提交；**总控**是唯一的集成者。只有高危动作（远端 push、付费/基础设施变更、删除不是你创建的东西）才停下来请示——其余自主推进。
- 收尾时向总控汇报（`"act":"done"`），附上真实、实质的摘要。