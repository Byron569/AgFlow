---
name: today
description: |
  把「今天」解析成相对运行时刻的具体 ISO 日期范围——今天。
  返回含首尾的民用日期与精确的 UTC 时刻，让你不用手算日期就有时间上下文。
  只读：不写文件、不联网。任何以今天为范围的任务（今天的日志、指标、「今天发生了什么」）之前使用。
allowed-tools:
  - Bash
---

## /today

运行内置解析器，拿到 **今天** 的具体日期范围：

```bash
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" today
```

它会打印一行人类可读的结果加一条 JSON 记录：

- `start` / `end` —— 含首尾的民用日期（`YYYY-MM-DD`），你的本地时区
- `startUtc` / `endExclusiveUtc` —— 同一窗口表示为精确 UTC 时刻的半开区间 `[start, end)`，适合按时间戳查询
- `days`、`timezone`、`asOf` —— 跨度、你的时区，以及解析发生的时刻

把返回的日期用作任务的时间边界。**不要手算日期**——这个解析器就是唯一事实源。完整窗口列表或任意区间（例如 `last45days`、`last6months`）见 `/temporal` 技能。