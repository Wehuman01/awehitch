<div align="center">
  <h1>awehitch：把 ChatGPT 网页大脑挂到任意编码 agent 上</h1>
  <p><strong>ChatGPT 负责思考，你的 agent 负责干活。</strong></p>
  <p>用你已付费的 ChatGPT 网页订阅做规划与审查层，任意编码 agent（codex / opencode / zcode）完整保留执行权。</p>
  <p>
    <a href="./README.md">English</a> ·
    <strong>简体中文</strong>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.2.2-7C3AED?style=flat-square" alt="Version">
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
git clone https://github.com/Wehuman01/awehitch.git awehitch
cd awehitch
corepack pnpm install && corepack pnpm build
```

环境要求：Node.js >= 20、git、Chrome 系浏览器；公网连接需要 `cloudflared`（自动检测）。

## 快速开始

推荐做法：在**家目录挂一个** awehitch，它下面的所有项目直接可用，无需按项目配置。

```bash
cd ~
awehitch up
```

`up` 默认**前台**运行：服务日志直接打在终端里，`Ctrl+C` 停掉 awehitch。想挂在后台？`awehitch up -d`——日志写入 `~/Library/Application Support/awehitch/logs/`（`awehitch logs` 可读）。

一个连接器覆盖家目录下的一切。敏感文件策略照常生效——`.env*`、密钥、SSH、云凭证一律拒绝；更多拒绝规则写在 `~/.c2cignore`。本身是 git 仓库的项目自动获得独立 diff 审查——ChatGPT 会把 git 工具定位到项目目录。想收紧边界？用 `awehitch up -w /path/to/project` 只连一个目录。

或让编码 agent（codex / opencode / zcode）代劳：

```text
请帮我运行 awehitch 并自动完成配置。
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
                           # 默认前台（Ctrl+C 停止）；-d/--daemon 转后台
awehitch off               # 断开（吊销访问并停掉本地服务；ChatGPT 里的连接器按需手动删）
awehitch doctor            # 诊断并自动修复（--no-fix 只读检查）
awehitch tunnel            # 查看或选择公网连接（临时地址 / 稳定域名）
```

`awehitch up [-w <路径>]` 会自动识别项目、建立安全公网连接、自动探测已安装的编码 agent（codex / opencode / zcode）并接入、需要时打开浏览器自动创建 ChatGPT 连接器。全流程唯一需要你动手的，是在弹出的窗口里登录一次 ChatGPT。服务默认前台运行（日志在终端，Ctrl+C 停止）；`-d/--daemon` 转后台，日志在状态目录里。一台机器只跑一个 bridge：换个目录 `up` 会自动替换上一个工作区的服务。`--json` 供 agent 使用——它固定后台运行，机器调用方不会被打断。

Agent/高级命令（session / record / login / connector-setup / stop / pair / logs / …）仍可用，`awehitch <命令> --help` 查看。

## 安全

- 全机同时只有一个 bridge，只服务一个工作区：对另一个目录跑 `up` 会停掉旧的并切换。所有 token 都绑定当前工作区。bridge 只监听 127.0.0.1——唯一的公网面是走隧道的 HTTPS，由 OAuth 2.1 + PKCE + 动态客户端注册保护。
- ChatGPT 只拿到只读 scope（`workspace.read`、`workspace.search`、`git.read`、`execution.read`、`offline_access`）。访问令牌 1 小时失效，刷新令牌每次使用即轮换，落盘只存 SHA-256 哈希。
- 敏感文件（`.env*`、`.envrc`、密钥、SSH、云凭证、整个 `.git/` 目录…）在所有关口被拒绝——读、列目录、搜索、diff 一视同仁。`.env.example` 放行；自己的规则写在 `.c2cignore`。
- 配对码：约 40 位强度、5 次尝试、一次性、5 分钟有效期、按 IP 限流。
- ChatGPT 永远不能写文件、删文件、跑 shell、提交、装包——服务端根本不存在这些工具。

## 故障排查

第一步永远是 `awehitch doctor`（能修的自动修；加 `--no-fix` 则严格只读）。

- **Bridge 没在跑** — 跑 `awehitch up` 即可，doctor 也会自动起；日志看 `awehitch logs --verbose`。doctor 说状态*不确定*时等一等再跑——不要起第二个 bridge。
- **地址过期 / 连接器坏了** — doctor 会标记 `chatgptRepair.needed`：**删除**本工作区的连接器、用新地址重建。绝不点 Reconnect——旧 URL 已死。
- **连接器自动配置失败（`CONNECTOR_DOM_CHANGED`）** — ChatGPT 页面结构变了。此时 `awehitch up` 会打印确切的手动步骤（开发者模式、删除旧连接器、创建表单的名称和服务器地址、配对码）：在浏览器里照做，然后重跑 `awehitch up`。想每次都走引导：`awehitch prefs set --setup-mode manual`。先看哪一步定位失效：`awehitch connector-setup --dry-run`。
- **connector-setup 时 `plugins/list` 返回 5xx** — ChatGPT 后端偶发抖动；清理步骤会自动重试，仍失败就跳过清理继续创建。若之后残留了同名旧连接器，重跑一次即可清掉。
- **配对码无效** — 一次性、约 5 分钟过期：`awehitch pair` 换新码。
- **每次工具调用都 401** — 令牌过期且刷新失败：在 ChatGPT 里用新配对码重新授权。
- **缺 cloudflared** — `brew install cloudflared`（macOS）/ `winget install Cloudflare.cloudflared`（Windows）；自定义路径设 `AWEHITCH_CLOUDFLARED_PATH`。
- **ACCESS_DENIED_SENSITIVE_FILE** — 符合预期的拒绝（见上节）。
- **彻底卡死** — `awehitch stop -w <路径>` 再 `awehitch up -w <路径>` 从头重建 bridge、隧道和配对。只有要完全断开时才用 `awehitch off`——它还会吊销 ChatGPT 的令牌。

## Awesome 软件生态

awehitch 是一个不断壮大的 "awesome" 工具家族中的一员 — 围绕 AI 编程 agent 打造，local-first、可被 agent 直接操作。

### CLI 工具

- **[aweskill](https://aweskill.wehuman.top/)** — CLI 优先的技能包管理器，支持 48+ AI 编程 agent。
- **[aweswitch](https://github.com/wehuman01/aweswitch)** — Claude Code、Codex、OpenCode 的 agent 配置切换器。
- **[awerouter](https://github.com/wehuman01/awerouter)** — 智能路由器，用结构信号把请求分给 Flash 或 Pro 模型，减少不必要的模型开销。
- **[awecompress](https://github.com/wehuman01/awecompress)** — 面向编程 agent 的透明上下文压缩代理：长会话冻结摘要，可与 awerouter 叠加使用。
- **[aweshelf](https://github.com/wehuman01/aweshelf)** — 收藏、分类、恢复 AI 编程会话，还能搭配 aweswitch 实现保存配置，一键启动。
- **[aweshare](https://github.com/wehuman01/aweshare)** — 通过自建 Hub 共享本地 Ollama/vLLM，或国产厂商 coding plan，或已授权的 OpenAI/Anthropic 帐号订阅，实现 token 的共享经济。
- **[awewarm](https://github.com/wehuman01/awewarm)** — 订阅窗口保持器，让 AI 编程套餐的窗口持续激活，无论是本地设置，还是通过远程连接的服务器。
- **[awewarm-hub](https://github.com/wehuman01/awewarm-hub)** — awewarm 的多租户 Hub 服务器：邀请码、租户容量上限、共享保温窗口。
- **[awescholar](https://github.com/wehuman01/awescholar)** — AI agent 可自主执行的科学文献发现与策展，搜索、标注、筛选和报告学术论文。
- **[awecontrib](https://github.com/wehuman01/awecontrib)** — 每个仓库一条 verify 入口：写入一个小的 verify 脚本和最小 CI，本地和 CI 跑的是同一条命令。

### 桌面应用

- **[awefork](https://github.com/wehuman01/awefork)** — 把 AI 编程 agent 的会话变成一棵树的桌面工作台：任意一轮，随时分叉，每条分支都留着；搭配 aweswitch 用更顺手 — 用 profile 启动会话，再回来分叉它的历史。
- **[awedot](https://awedot.wehuman.top/)** — 悬浮球驻留屏幕边缘，实时追踪当前 AI 会话；一键收藏、随时恢复，并可搭配 aweswitch 固定 agent 配置（比如用 GLM 模型启动）。

### Project Collections

- **[Awesome AI Meets Biology](https://github.com/Webioinfo01/Awesome-AI-Meets-Biology)** — AI 在生物学、生物信息学和生物医学研究中应用的精选综述。由 awescholar 驱动。
- **[Awesome AI Virtual Tumor](https://github.com/Webioinfo01/Awesome-AI-Virtual-Tumor)** — 面向虚拟肿瘤建模与仿真的前沿 AI 系统精选合集：静态模型、动态模型、agent、基准与综述。
- **[AgentX](https://github.com/Webioinfo01/agentx-hub)** — 科研 AI agent 社区目录：Verified Run 评审、实时 GitHub 指标和月度报告，由 awescholar 校验流水线策展。

```bash
corepack pnpm install
corepack pnpm build     # -> dist/，暴露 awehitch 命令
corepack pnpm test      # 路径安全、OAuth、配对、MCP 端到端、adapter、连接器配置
```

架构、[C2C] 协议、harness 适配器、连接器自动化与完整安全模型见 [CONTRIBUTING.md](docs/CONTRIBUTING.md)。

## 状态与声明

Alpha。控制面依赖当前 ChatGPT 页面结构；页面改时 `awehitch_wait_reply` 会诚实地报 `CHATGPT_DOM_CHANGED`——跑 `awehitch doctor --control-plane` 定位失效选择器，或通过状态目录的选择器覆盖文件修复。连接器页面共用同一套选择器包：`awehitch connector-setup --dry-run` 会报告每一项定位到了什么，定位不到的部分自动退回"手动教学配置"，不会把你卡死。非 OpenAI 官方项目。

数据面改造自 [codex-with-chatgpt](https://github.com/mugpeng/codex-with-chatgpt)（fork 自 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)）—— MIT。

## 许可

[MIT](LICENSE)
