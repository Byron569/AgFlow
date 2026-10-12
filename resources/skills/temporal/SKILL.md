---
name: temporal
description: |
  把任意具名时间窗口——today、yesterday、thisWeek、lastWeek、last7Days、last30Days、
  last90Days、thisMonth、lastMonth、thisQuarter、lastQuarter、thisYear、lastYear、
  last12Months——或任意区间（lastNdays / lastNweeks / lastNmonths）解析成相对你运行时刻的
  具体 ISO 日期范围。只读：不写文件、不联网。凡是任务带时间范围、又需要精确起止日期时使用，
  免得手算。
allowed-tools:
  - Bash
---

## /temporal —— 相对「现在」的具体日期范围

「*<窗口>* 现在到底指哪几天？」的唯一事实源。它把具名窗口解析成**相对你运行时刻的具体 ISO 日期范围**（调用那一刻的 `new Date()`），你永远不用自己再推日期。它只读时钟并打印——不写文件、不联网。

### 运行方式

```bash
# 一次拿到全部窗口（快速的时间上下文转储）
node "$AGENT_DIR/.claude/skills/temporal/when.mjs"

# 指定一个或多个窗口
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" last30Days thisQuarter

# 只输出 JSON（便于机器读取），或列出支持的关键词
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --json last7Days
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --list
```

如果 `$AGENT_DIR` 没有设置，脚本也在 `~/.claude/skills/temporal/when.mjs`。

### 窗口

| 关键词 | 含义 |
| --- | --- |
| `today` / `yesterday` | 单个自然日 |
| `thisWeek` / `lastWeek` | ISO 周（周一起算）；*this* = 周一→今天，*last* = 上一个完整的周一→周日 |
| `last7Days` / `last30Days` / `last90Days` | 截止今天（含）向前滚动的 N 天窗口 |
| `thisMonth` / `lastMonth` | *this* = 1 号→今天；*last* = 上一个完整自然月 |
| `thisQuarter` / `lastQuarter` | *this* = 季度初→今天；*last* = 上一个完整季度 |
| `thisYear` / `lastYear` | *this* = 1 月 1 日→今天（YTD）；*last* = 上一个完整自然年 |
| `last12Months` | 截止今天向前滚动 12 个月 |
| `lastNdays` / `lastNweeks` / `lastNmonths` | 任意滚动窗口，例如 `last45days`、`last2weeks`、`last6months` |

别名：`ytd`、`qtd`、`mtd`、`wtd`、`7d`、`30d`、`90d`、`12m`。

约定：`this*` 窗口是**周期起点 → 今天**（至今）；`last*` 具名周期是**上一个完整周期**。

### 输出

每个窗口打印一行人类可读的结果加一条 JSON 记录：

- `start` / `end` —— 含首尾的民用日期（`YYYY-MM-DD`），你的本地时区
- `startUtc` / `endExclusiveUtc` —— 同一跨度表示为精确 UTC 时刻的半开区间 `[start, end)`，适合时间戳 / `createdAt` 一类的查询
- `days`、`inclusive`、`timezone`、`tzOffsetMinutes`、`asOf` —— 跨度、时区，以及解析发生的时刻

把返回的日期用作任务的时间边界。具名快捷方式 `/today`、`/yesterday`、`/last30Days`、`/lastQuarter`…… 各自都调用同一个解析器，只是窗口不同。