# 给 AI 的安装指南

在运行 Codex 的机器上，将本仓库构建并安装为本地插件。下列命令均从项目根目录执行。

## 1. 获取源码并检查环境

如果用户提供了本地项目，直接使用该目录。如果只提供了 GitHub 链接，用 `git clone` 将用户指定的仓库克隆到可长期保留的位置，再进入项目根目录。注册本地插件市场时会用到这个位置。

确认根目录包含 `package-lock.json` 和 `.agents/plugins/marketplace.json`。检查工具：

```sh
node --version
npm --version
codex plugin add --help
```

需要 Node.js 24 或更高版本、npm，以及支持 `codex plugin` 的 Codex CLI。缺少 CLI 时，参考 [Codex CLI 安装说明](https://learn.chatgpt.com/docs/cli)。启动桌面应用的环境也需要能找到 `node` 命令。

## 2. 先构建，再注册本地插件市场

GitHub 源码不包含构建产物。运行：

```sh
npm ci
npm run build
```

确认生成 `plugin/dist/server.mjs` 和 `plugin/dist/dashboard.html` 后，注册**当前目录**并安装插件。不要把远程仓库地址或 `plugin/` 子目录代入下面的 `.`：

```sh
codex plugin marketplace add . --json
codex plugin add codex-token-inspector@codex-token-inspector-local --json
codex plugin list --marketplace codex-token-inspector-local --json
```

如果这个市场已注册到同一目录，复用现有注册即可。若同名市场指向不同目录，先核对来源，再决定使用哪个副本。

## 3. 验证结果

1. 在列表中找到 `codex-token-inspector@codex-token-inspector-local`，确认已安装、已启用，且版本与 `plugin/plugin.json` 一致。若已安装但未启用，在插件设置中启用“Token 用量”。
2. 在支持面板的 Codex 桌面聊天中打开“本会话用量”，确认面板能打开并刷新。如果聊天尚未加载插件，重新加载插件后再试。没有本机会话日志时，面板可能正常打开但没有数据。
3. 向用户报告安装版本和实际验证结果。如果只能验证 CLI 安装状态，给出最后一步：“在 Codex 中说‘打开本会话用量’。”

后续更新时，在同一源码目录获取新版本，重新构建、安装并加载插件。无需手动编辑安装缓存。
