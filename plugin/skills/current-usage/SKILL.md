---
name: current-usage
description: 查看或打开当前 Codex 会话的真实 Token 用量、缓存命中率、模型及子代理统计，自动定位当前会话。
---

# 当前会话用量

用户要查看当前会话用量时，调用本插件的 `open_thread_usage`，默认空参数。
工具使用每次请求的宿主 threadId 自动绑定当前会话。要返回简短统计而不打开面板时，调用 `query_usage_dashboard`，使用 `view: current`。

如果结果的 `binding.source` 是 `unavailable`，且当前聊天可以执行本机命令，仅读取本次执行环境的 `CODEX_THREAD_ID`；存在合法 UUID 时以 `sessionId` 显式传给同一个工具。不要读取完整环境变量，不要把 MCP sessionId、插件进程环境或最近活跃记录当作当前会话。无法取得标识时明确说明，并可打开 `open_usage_dashboard` 浏览全部会话。

`binding.source: conflict` 表示宿主上下文不一致，应报告问题，不用手动 ID 覆盖冲突。日志未找到时保留这个会话的空状态，不切到其他会话。

数字来自本机日志。说明包含子代理的范围；缓存是输入的子集，推理是输出的子集。缺失日志、未知模型、累计快照及索引进行中的状态须保留，不能将已知部分说成完整账单。

打开面板的工具只返回简短摘要，完整界面数据通过 `_meta` 交给面板。聊天内查询 `query_usage_dashboard` 返回限量明细；若 `omittedAgents`、`omittedModels` 或 `omittedSessions` 大于零，说明列表有省略，可打开面板查看，不将摘要当成全部明细。`get_dashboard_view` 仅供面板内部使用。
