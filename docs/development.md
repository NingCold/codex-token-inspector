# 开发指南

使用 Node.js 24+ 和 npm。以下命令在项目根目录执行。

## 修改代码，在浏览器查看效果

面板在 `web/`，布局、数值和交互遵循[用量面板设计约定](../DESIGN.md)；日志解析、统计和 MCP 服务在 `src/`。首次开发先安装依赖，再构建并启动预览：

```sh
npm ci
npm run build
npm run preview
```

在本机浏览器打开 `.cache/preview.json` 中的 `url`。这个地址含临时访问凭据，仅用于本机预览。独立预览没有当前聊天上下文时，可以切到“全部会话”查看数据。修改代码后，停止预览，重新构建并启动。

## 运行测试

[GitHub Actions](https://github.com/NingCold/codex-token-inspector/actions/workflows/ci.yml) 会在推送到 `main` 或向它提交 PR 时，用 Windows 和 Node.js 24 运行类型检查、构建、单元与集成测试，最后运行 Chromium 界面测试。

```sh
npm run build
npm run typecheck
npm test
```

集成测试会启动刚构建的服务。用 `await using data = await fixture()` 创建合成日志和独立索引；测试退出后会清理自己的临时目录。排查失败时，可在重跑前设置 `CTI_KEEP_TEST_FILES=1`，终端会打印保留的目录位置。

修改面板后，再运行界面测试。首次运行需安装 Playwright 使用的 Chromium：

```sh
npx playwright install chromium --only-shell
npm run test:ui
```

界面测试覆盖本地网页和模拟 MCP 宿主。需要对照布局时，运行 `npm run test:ui -- --screenshots`，截图保存在 `docs/screenshots/`。要验证真实聊天的会话绑定或面板入口，安装当前构建后，在桌面聊天中打开“本会话用量”。

## 接入自定义数据目录

在启动预览或插件宿主**之前**设置环境变量：

| 变量 | 用途 |
| --- | --- |
| `CODEX_HOME` | 指定要读取的 Codex 数据目录，默认是当前用户的 `~/.codex`。 |
| `CTI_DATA_DIR` | 指定插件自己的 SQLite 索引目录。测试不同数据源时，为每个数据源使用独立目录。 |

Token 用量来自 `sessions/` 和 `archived_sessions/` 中的 JSONL 日志；会话标题和代理关系还会从 Codex 的 `state_*.sqlite` 只读获取。插件在自己的数据目录中维护 `usage-v1.sqlite`，保存请求记录和日志读取进度。它使用 Node.js 内置的 SQLite，无需安装数据库服务。

## 在 Codex 中加载构建

`npm run build` 将服务和面板写入 `plugin/dist/`。`plugin/mcp.json` 指定运行入口，`plugin/plugin.json` 声明插件信息，`.agents/plugins/marketplace.json` 将本地市场条目指向 `plugin/`。构建成功后，从项目根目录按[安装指南](installation.md)安装或更新插件。
