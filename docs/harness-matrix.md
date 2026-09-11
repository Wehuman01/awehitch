# Harness Capability Matrix (M0)

调研日期：2026-09-11。每个 harness 的扩展面实测结论，adapter 据此编写。
所有结论来自本机实际安装（codex-cli 0.154.0 / opencode 1.18.30 / ZCode ADE 桌面版）。

## 汇总

| 能力 | codex | opencode | zcode |
| --- | --- | --- | --- |
| 执行 shell | ✅ | ✅ | ✅ |
| 注册自定义工具 | ❌（只能 MCP / shell） | ✅（plugin `tool:`） | ❌（只能 MCP / shell） |
| 消费远程 MCP（含 OAuth） | ✅（config.toml `mcp_servers`） | ✅（opencode.json `mcp` remote + `opencode mcp auth`） | ✅（~/.zcode/cli/config.json `mcpServers`） |
| 驱动浏览器 | ✅ 内置 iab（Codex 原方案） | ❌ 无内置浏览器 | ✅ 内置 Computer Use / 嵌入式浏览器 |
| 注入系统指令 | ✅ `~/.codex/skills/<name>/SKILL.md` | ✅ `AGENTS.md` + `~/.opencode/skills/<name>/SKILL.md` + plugin | ✅ `~/.zcode/agents/<name>.md` + 插件 skills |
| 会话 / 状态持久化 | `~/.codex/history.jsonl` + 会话文件 | `~/.local/share/opencode/storage/` | `~/.zcode/cli/agents/sess_*` |
| 本地 MCP（stdio） | ✅ config.toml | ✅ opencode.json `mcp` local | ✅ mcpServers |

三个 harness 都能消费 MCP，所以控制面代理统一以 **本地 MCP server（stdio）** 暴露（交接文档推荐方案 A）。
codex 原方案的内置浏览器控制面，被独立代理取代——任何 harness 只需"能调工具"。

## codex

| 项 | 形式 |
| --- | --- |
| 配置 | `~/.codex/config.toml`（TOML） |
| MCP 注册 | `[mcp_servers.<name>]` 表：`command`/`args`（stdio）或 `type="http"` + `url` |
| 指令注入 | `~/.codex/skills/<name>/SKILL.md`（YAML frontmatter: name/description） |
| 沙箱 | `[sandbox_workspace_write].writable_roots` 数组——awemind 状态目录必须写入 |
| 浏览器 | 内置 iab（原方案专用）。awemind 不依赖它，改用控制面代理 |
| 环境变量 | `CODEX_HOME` 可重定向配置目录 |

Adapter 做法：
1. `sandbox-allow`：状态目录写入 `writable_roots`（复用参考实现逻辑）
2. 控制面代理注册：`[mcp_servers.awemind]` stdio 命令
3. Skill 安装到 `~/.codex/skills/awemind/SKILL.md`
4. ChatGPT 数据面不需要注册给 codex（它不消费数据面；ChatGPT 才消费）

## opencode

| 项 | 形式 |
| --- | --- |
| 配置 | `~/.config/opencode/opencode.json`（JSONC）+ 项目 `opencode.json` |
| MCP 注册 | `"mcp": { "<name>": { "type": "remote", "url": "…" } }`（支持 OAuth + RFC 7591 DCR，实测与 bridge 协议兼容）或 `{ "type": "local", "command": […] }` |
| OAuth 触发 | `opencode mcp auth <name>` |
| 插件 | `~/.config/opencode/plugins/*.js`（ESM，`Plugin = async ({…}) => ({…hooks})`，可注册 `tool:`） |
| 指令注入 | `AGENTS.md`（项目根）+ `~/.opencode/skills/<name>/SKILL.md` |
| 沙箱 | permission 配置（`"permission": { "bash": {"*": "allow"} }` 等）；无强制 writable_roots |

**注意（交接文档 4.1 的"第一步实测"）**：opencode remote MCP 原生支持 OAuth 2.1 + PKCE + DCR，
bridge 的 `/oauth/register`、`/oauth/authorize`、`/oauth/token` 与之协议兼容，
`opencode mcp auth awemind` 可直接触发配对流程。这验证了整体方案成立。

Adapter 做法：
1. 项目 `opencode.json` 或全局配置写入 `"mcp": { "awemind": { "type": "local", "command": […] } }`（控制面 stdio）
2. Skill 安装到 `~/.opencode/skills/awemind/SKILL.md`（+ `AGENTS.md` 追加一段触发说明）
3. 无沙箱改写需求

## zcode

| 项 | 形式 |
| --- | --- |
| 配置 | `~/.zcode/cli/config.json`（JSON），app 内置默认 `~/Library/Application Support/…` 之外以实际 `~/.zcode/cli` 为准 |
| MCP 注册 | 顶层 `"mcpServers": { "<name>": { "command": …, "args": […] } }`（当前为空对象，格式与 Claude Desktop 一致） |
| 指令注入 | `~/.zcode/agents/<name>.md`（YAML frontmatter: name/description/model/injectAgentsMd），插件 skills 在 `~/.zcode/cli/plugins/…` |
| 沙箱 | hooks 事件（PermissionRequest / PostToolUse 等）；无 writable_roots 等价物 |
| 浏览器 | 内置 ZCode Computer Use（accessibility 优先 + 截图兜底的 MCP 工具集）——awemind 不依赖它 |

Adapter 做法：
1. `~/.zcode/cli/config.json` 的 `mcpServers` 写入 `awemind` stdio 条目（保留其余键，幂等合并）
2. 指令：`~/.zcode/agents/awemind.md` 或项目内 `AGENTS.md`（zcode 桌面版读取项目根 AGENTS.md）
3. 无沙箱改写需求

## 红线核对（对齐 docs/security.md）

- 三个 adapter 都只做"控制面接入 + 指令注入 + 沙箱参数化"，不碰数据面。
- 数据面 bridge 保持只读 9 工具、workspace 绑定、OAuth 2.1 + PKCE + DCR、敏感文件 deny-by-default。
- adapter 之间不互相 import，只依赖 `src/control-plane/` 公共接口。
