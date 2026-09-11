# awemind 项目交接说明

> 一句话：**让 ChatGPT 网页版成为任意编码 agent 的"外挂大脑"——ChatGPT 负责规划与审查，agent 负责执行。**

---

## 0. 你的任务

把 `codex-with-chatgpt`（一个只支持 Codex 的项目）抽象成支持多 harness 的 `awemind`，
首批适配 **codex / opencode / zcode**。

最终效果：用户对着任意一个编码 agent 说「用 ChatGPT 帮我规划」，该 agent 就能把
ChatGPT 网页版当作规划与审查层，而执行权完整留在本地 agent 手里。

---

## 1. 先读懂参考实现

参考仓库（**只读，不要改**）：

```
/Users/peng/Desktop/Project/product/ref/codex-with-chatgpt
```

GitHub：`mugpeng/codex-with-chatgpt`（fork 自 `XiaoDuoYa/codex-with-chatgpt`）

按顺序必读：

| 顺序 | 文件 | 看什么 |
| --- | --- | --- |
| 1 | `README.md` | 项目定位与整体图景 |
| 2 | `docs/architecture.md` | 组件职责划分 |
| 3 | `docs/protocol.md` | `[C2C]` 协议状态机与消息格式 |
| 4 | `docs/security.md` | 信任边界与威胁模型（**改任何东西都不能破坏这些约束**） |
| 5 | `src/mcp/server.ts` | 9 个只读工具的定义与 scope 校验 |
| 6 | `src/bridge/server.ts` | HTTP 服务组装、回环绑定、admin API |
| 7 | `src/auth/oauth.ts` + `src/pairing/manager.ts` | OAuth 2.1 与配对码 |
| 8 | `src/workspace/manager.ts` + `src/workspace/ignore.ts` | 路径包含检查、敏感文件策略 |
| 9 | `skill/SKILL.md` | Codex 版编排指令（694 行，**这是你要"翻译"的核心资产**） |

---

## 2. 核心抽象（本项目最重要的设计决策）

原项目把能力分成两部分，你要做的关键重构是**把它们解耦**：

| 层 | 内容 | 与 harness 的关系 |
| --- | --- | --- |
| **数据面** | 本地工作区 → 远程只读 MCP（+ OAuth + 隧道） | **完全无关**，直接复用 |
| **控制面** | agent 与 ChatGPT 网页交换 `<1KB` 状态消息 | **必须解耦** |

原实现里，控制面**绑死在 Codex 的内置浏览器**上
（`setupBrowserRuntime()` / `agent.browsers.get("iab")` / `tab.markHandoff()`）。
换一个没有内置浏览器的 agent，这一环就断了。

**你要做的：把控制面从 agent 里摘出来，做成一个独立的「控制面代理」，
对外只暴露工具调用。** 这样 agent 侧的门槛从"必须内置浏览器"降级为"必须能调工具"。

改造后的目标形态：

```
远端大脑（ChatGPT 网页）
      ↕  控制面：状态消息
控制面代理（本地，浏览器自动化 → 工具）   ← 你要新建的一层
      ↕  工具调用（MCP / CLI）
本地 Agent（codex / opencode / zcode）    ← 只要求"能调工具"
      ↕  数据面：只读 MCP
C2C Bridge（本地，工作区只读网关）        ← 不改
```

这样新增一个 harness 只需写 adapter（怎么注册工具 + 怎么注入指令），
不需要碰浏览器逻辑。

---

## 3. 必须守住的红线（源自 `docs/security.md`）

1. **只读不可破**：服务端绝不能新增写文件 / 删文件 / 执行命令 / commit 工具。
   任何 harness 适配都不许绕过这一点。
2. **一个 workspace = 一个 bridge = 一组 token**：token 必须继续绑定 `workspaceId`；
   跨 workspace 必须返回 403。
3. **敏感文件策略原样保留**：`.env*`、密钥、SSH、云凭证等 deny-by-default；
   `.c2cignore` 机制保留。
4. **路径包含检查原样保留**：realpath 规范化 + 包含性检查，不许放宽。
5. **配对码仍是唯一进入浏览器的凭据**；access / refresh token 绝不经过浏览器或第三方。
6. **不改 OAuth 协议**：必须保持 OAuth 2.1 + PKCE S256 + 动态客户端注册（RFC 7591），
   因为 ChatGPT 连接器和 opencode 都按这套来对接。

---

## 4. 已完成的调研结论（直接用，别重复踩坑）

### 4.1 opencode

- **remote MCP 客户端原生支持 OAuth，且支持动态客户端注册（RFC 7591）**，
  与 bridge 的 OAuth 实现协议兼容。也就是说 opencode **可以近乎零改动直接连 bridge**：

  ```jsonc
  {
    "mcp": {
      "c2c": { "type": "remote", "url": "https://<隧道地址>/mcp" }
    }
  }
  ```

  然后 `opencode mcp auth c2c` 触发 OAuth 流程。
  **第一步就先实测这条链路通不通——它决定整个方案是否成立。**

- 插件签名：`Plugin = async ({ project, directory, worktree, client, $ }) => ({ ...hooks })`
- 可注册自定义工具：`tool: { mytool: tool({ description, args: zodSchema, execute }) }`
- 有 `config` 钩子可修改 opencode 配置（可用于自动写入 MCP 配置）
- 可用 hooks：`tool.execute.before` / `tool.execute.after` / `event` / `session.idle` /
  `command.executed` / `shell.env` / `experimental.session.compacting`
- 插件目录：`.opencode/plugins/`（项目级）、`~/.config/opencode/plugins/`（全局）；
  npm 包写进 `opencode.json` 的 `plugin` 数组
- 指令文件：`AGENTS.md`
- **没有内置浏览器自动化** → opencode 侧唯一缺口，需要补（见 5.2）

### 4.2 codex

- 原项目已完整支持，`skill/SKILL.md` 直接可用
- 唯一 Codex 专属代码在 `src/config/sandbox-allow.ts`
  （往 `~/.codex/config.toml` 的 `sandbox_workspace_write.writable_roots` 加 C2C 状态目录）
- 你的任务是把这部分**参数化**（不同 harness 的配置路径不同），而不是删掉

### 4.3 zcode

- `zcode.z.ai`（Z.ai 的 ZCode ADE）——有内置浏览器、有 Skills、

---

## 5. 交付物

### 5.1 第一步：三份 harness 能力矩阵（先交这个，评审通过再写代码）

对 codex / opencode / zcode 各填一张表：

| 能力 | 有/无 | 具体形式（API / 配置路径 / 命令） |
| --- | --- | --- |
| 执行 shell | | |
| 注册自定义工具 | | |
| 消费远程 MCP（含 OAuth） | | |
| 驱动浏览器 | | |
| 注入系统指令 | | |
| 会话 / 状态持久化 | | |

这张表决定每个 adapter 怎么写。

### 5.2 控制面代理（本项目最核心的新代码）

用 Playwright 实现，**把浏览器操作封装成语义化工具**，而不是把裸浏览器暴露给 LLM：

| 工具 | 职责 |
| --- | --- |
| `c2c_open_chat` | 打开或接管 ChatGPT 会话 |
| `c2c_send_state` | 发送一条 `[C2C]` 状态消息 |
| `c2c_wait_reply` | 等待并解析回复（区分"还在生成 / 超时 / 出错"） |
| `c2c_read_reply` | 读取当前回复内容 |

语义要求（抄自 `skill/SKILL.md` 的经验，务必保留）：

- 轮询间隔 20–30 秒，用便宜的 DOM 检查；**不要长等待、不要截图轮询**
- **超时不等于失败**，不许因为超时就重发消息或另开新会话
- 只用一个标签页，切换用 `goto`，不新开

对外暴露方式二选一（**推荐 A**）：

- **A. 本地 MCP server**——任何 agent 都能接，通用性最好
- B. 本地 CLI（全部支持 `--json`），agent 用 shell 调用

### 5.3 三个 adapter

每个 adapter 只做三件事：

1. 把控制面代理接上（MCP 配置或工具注册）
2. 把编排指令注入该 harness 的指令机制
   （codex: skill；opencode: `AGENTS.md` + 插件；zcode: 待确认）
3. 处理该 harness 的沙箱 / 权限差异

**adapter 之间不许互相 import**，只依赖 5.2 的公共接口。

### 5.4 统一 CLI + 文档

- CLI 名：`awemind`
- 至少要能：`awemind setup --harness <codex|opencode|zcode>`、`awemind status`、`awemind doctor`
- 文档按本仓库规范：`README.md`、`README_cn.md`、`README.ai.md`、`docs/`、`logo/`、`LICENSE`
- 所有 CLI 命令都要支持 `--json`

---

## 6. 里程碑与验收

| 阶段 | 交付 | 验收标准 |
| --- | --- | --- |
| M0 | 三份能力矩阵 | 三个 harness 的扩展面都写清楚，含具体 API / 路径 |
| M1 | 抽取通用核心 | bridge 代码抽成可复用模块，原 codex 流程不回归 |
| M2 | 控制面代理 | 能独立跑通"发消息 → 等回复 → 解析出 PLAN" |
| M3 | codex adapter | 端到端跑通一次完整循环 |
| M4 | opencode adapter | 端到端跑通一次完整循环 |
| M5 | zcode adapter | 端到端跑通一次完整循环 |
| M6 | CLI + 文档 | 按仓库规范补齐 |

**"端到端跑通一次完整循环"的定义**：

给一个真实的小任务 →
ChatGPT 出 `PLAN` →
agent 执行 →
agent 报 `EXECUTED` →
ChatGPT 通过 MCP **独立**查看真实 git diff 和测试结果 →
ChatGPT 回 `DONE`。

---

## 7. 明确不做

- 不做任何写操作工具（永远只读）
- 不把 ChatGPT 换成 API key 调用
  （本项目的前提就是"用订阅额度，不烧 API"）
- 不为统一而重写 bridge 协议（必须与现有 ChatGPT 连接器兼容）
- 不在没有能力矩阵的情况下猜着写 adapter

---

## 8. 工程品味（本仓库通用要求）

> Prefer solutions that are simple, clear, decoupled, honest, focused, and durable.
>
> First principles: identify the real problem, hard constraints, and known facts
> before reaching for patterns, abstractions, or prior solutions.

具体到本项目：

- **简单**：adapter 要薄。如果某个 adapter 超过 300 行，说明抽象错了。
- **诚实**：把失败模式写出来（浏览器超时、ChatGPT 改版、登录态失效），
  不要假装能兜住。
- **聚焦**：不要顺手重构参考实现里跟本任务无关的部分。

---

## 9. 建议的第一步动作

1. 读第 1 节列出的文件
2. **实测 opencode 直连 bridge 是否可行**（这决定整体方案成立与否）
4. 交 M0 的能力矩阵，等评审
