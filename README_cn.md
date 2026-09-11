<div align="center">
  <h1>awehitch：把 ChatGPT 网页大脑挂到任意编码 agent 上</h1>
  <p><strong>ChatGPT 负责思考，你的 agent 负责干活。</strong></p>
  <p>用你已付费的 ChatGPT 网页订阅做规划与审查层，任意编码 agent（codex / opencode / zcode）完整保留执行权。</p>
  <p>
    <a href="./README.md">English</a> ·
    <strong>简体中文</strong>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-7C3AED?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%E2%89%A520-0EA5E9?style=flat-square" alt="Node">
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-alpha-c96a3d?style=flat-square" alt="Status">
    <img src="https://img.shields.io/badge/install-npm-22C55E?style=flat-square" alt="npm install">
    <img src="https://img.shields.io/badge/platform-terminal-334155?style=flat-square" alt="Platform">
  </p>
</div>

> ChatGPT 负责思考，你的 agent 负责干活。

awehitch 把 ChatGPT 网页大脑挂（hitch）到任意编码 agent 上：ChatGPT 负责规划与审查，本地 agent 负责执行。你的仓库永远不会被上传——ChatGPT 通过一条安全的、OAuth 保护的**只读** MCP 连接按需读取当前工作区里它真正需要的那几行代码。不用 API Key，不搞逆向代理。

## 安装

```bash
git clone <this repo> awehitch
cd awehitch
corepack pnpm install && corepack pnpm build
```

环境要求：Node.js >= 20、git、Chrome 系浏览器；公网连接需要 `cloudflared`（自动检测）。

## 快速开始

对任意一个编码 agent（codex / opencode / zcode）说：

```text
请帮我完整安装并配置 awehitch，全程自动。
```

或自己跑 CLI：

```bash
awehitch setup -w /path/to/project --harness codex --json
awehitch login -w /path/to/project        # 在打开的窗口里登录一次 ChatGPT
```

`setup --harness` 一次搞定：启动 bridge、建立安全连接、生成配对码、并接入所选 harness 的 adapter（MCP 注册 + skill 安装 + 沙箱处理）。之后正常使用："用 ChatGPT 帮我规划 XXX"。

## 工作原理

```
远端大脑（ChatGPT 网页）
      ↕  控制面：[C2C] 状态消息（<1 KB）
控制面代理（本地，Playwright → 5 个语义化 MCP 工具）
      ↕  工具调用（stdio MCP）
本地 Agent（codex / opencode / zcode）
      ↕  数据面：只读 MCP
awehitch Bridge（本地，工作区只读网关 + OAuth + 隧道）
```

- **控制面** — agent 与 ChatGPT 交换极小的结构化 `[C2C]` 消息（`INIT → PLAN → EXECUTED → REVIEW → DONE`）。本地**控制面代理**用 Playwright（独立浏览器配置目录）把 ChatGPT 会话封装成五个语义化工具：`awehitch_open_chat`、`awehitch_send_state`、`awehitch_send_handoff`、`awehitch_wait_reply`、`awehitch_read_reply`。一个任务一条聊天：新 TASK_ID 自动开新聊天，同一任务的恢复与多轮审查始终复用它绑定的聊天；原聊天丢失时 `awehitch_send_handoff` 从本地检查点自动生成交接简报（绝不包含文件、diff 或日志）。轮询是 20–30 秒的廉价 DOM 检查；超时不等于失败；只用一个标签页；绝不因超时重发。原方案里绑死 Codex 内置浏览器的控制面被彻底解耦——任何 agent 只要"能调工具"就能接入。
- **数据面** — ChatGPT 通过 9 个只读工具自行拉取文件、diff、搜索结果、测试记录，走 OAuth 2.1 + PKCE + 动态客户端注册的隧道。独立审查：EXECUTED 之后 ChatGPT 亲自看真实 git diff，绝不轻信"测试全过"。
- **Adapter** — codex（`~/.codex/skills` + `config.toml` MCP + 沙箱 writable_roots）、opencode（`~/.config/opencode` skill + `opencode.json` MCP）、zcode（`~/.zcode/cli/config.json` mcpServers + skill）。每个 adapter 都很薄，互不 import。

## 配置

工作区 `.c2c.json`：

```jsonc
{
  "name": "my-project",      // 工作区显示名（连接器标题）
  "maxIterations": 12        // 循环上限，达到后询问用户是否继续
}
```

`.c2cignore` 在内置敏感文件策略（`.env*`、密钥、SSH、云凭证默认拒绝）之上追加你自己的规则。

## 命令

```bash
awehitch setup -w <workspace> [--harness codex|opencode|zcode] [--json]
awehitch start | stop | restart -w <workspace>
awehitch status -w <workspace> [--json]
awehitch doctor -w <workspace> [--json]      # 诊断 + 自动修复
awehitch login -w <workspace> [--json]       # 控制面 ChatGPT 登录
awehitch pair | unpair -w <workspace>        # 配对码 / 吊销全部令牌
awehitch session get|set|clear -w <workspace> # 会话 + 检查点
awehitch sandbox-allow [--json]              # codex writable_roots（幂等）
```

所有命令支持 `--json`。内部命令：`serve`、`control-plane`（stdio MCP）、`record`、`update-check`。

## 开发

```bash
corepack pnpm install
corepack pnpm build     # -> dist/，暴露 awehitch 命令
corepack pnpm test      # 196 个测试：路径安全、OAuth、配对、MCP 端到端、adapter
```

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) · [安全](docs/security.md) · [harness 能力矩阵](docs/harness-matrix.md)

## 状态与声明

Alpha。控制面依赖当前 ChatGPT 页面结构；页面改版时 `awehitch_wait_reply` 会诚实地报 `CHATGPT_DOM_CHANGED`——跑 doctor、修选择器。非 OpenAI 官方项目。

## 许可

[MIT](LICENSE)
