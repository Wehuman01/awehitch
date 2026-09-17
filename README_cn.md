<div align="center">
  <h1>awehitch：把 ChatGPT 网页大脑挂到任意编码 agent 上</h1>
  <p><strong>ChatGPT 负责思考，你的 agent 负责干活。</strong></p>
  <p>用你已付费的 ChatGPT 网页订阅做规划与审查层，任意编码 agent（codex / opencode / zcode）完整保留执行权。</p>
  <p>
    <a href="./README.md">English</a> ·
    <strong>简体中文</strong>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.2.1-7C3AED?style=flat-square" alt="Version">
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
npm install -g awehitch
```

或从源码安装：

```bash
git clone https://github.com/wehuman01/awehitch.git awehitch
cd awehitch
corepack pnpm install && corepack pnpm build
```

环境要求：Node.js >= 20、git、Chrome 系浏览器；公网连接需要 `cloudflared`（自动检测）。

## 快速开始

对任意一个编码 agent（codex / opencode / zcode）说：

```text
请帮我运行 awehitch 并自动完成配置。
```

或自己跑 CLI：

```bash
awehitch up -w /path/to/project
```

配对与连接器创建全自动。唯一可能需要你动手的，是在弹出的窗口里登录一次 ChatGPT。装好后日常零命令。

之后正常使用："用 ChatGPT 帮我规划 XXX"。

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

`.c2cignore` 在内置敏感文件策略（`.env*`、`.envrc`、密钥、SSH、云凭证以及整个 `.git/` 目录默认拒绝）之上追加你自己的规则。

## 命令

```bash
awehitch up [-w <路径>]    # 幂等的"确保已连接"（裸 `awehitch` 也可以）
awehitch off               # 断开（吊销访问 + 停止本地服务；ChatGPT 插件页可选手动删除）
```

`awehitch up [-w <路径>]` 会自动识别项目、建立安全公网连接、自动探测已安装的编码 agent（codex / opencode / zcode）并接入、需要时打开浏览器自动创建 ChatGPT 连接器。全流程唯一需要你动手的，是在弹出的窗口里登录一次 ChatGPT。`--json` 供 agent 使用。

内部/高级命令（start / stop / status / doctor / pair / tunnel / session / …）仍可用，`awehitch <命令> --help` 查看。

## 开发

```bash
corepack pnpm install
corepack pnpm build     # -> dist/，暴露 awehitch 命令
corepack pnpm test      # 路径安全、OAuth、配对、MCP 端到端、adapter、连接器配置
```

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) · [安全](docs/security.md) · [连接器配置](docs/connector-setup.md) · [harness 能力矩阵](docs/harness-matrix.md)

## 状态与声明

Alpha。控制面依赖当前 ChatGPT 页面结构；页面改时 `awehitch_wait_reply` 会诚实地报 `CHATGPT_DOM_CHANGED`——跑 `awehitch doctor --control-plane` 定位失效选择器，或通过状态目录的选择器覆盖文件修复。连接器页面共用同一套选择器包：`awehitch connector-setup --dry-run` 会报告每一项定位到了什么，定位不到的部分自动退回"手动教学配置"，不会把你卡死。非 OpenAI 官方项目。

数据面改造自 [codex-with-chatgpt](https://github.com/mugpeng/codex-with-chatgpt)（fork 自 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)）—— MIT。

## 许可

[MIT](LICENSE)
