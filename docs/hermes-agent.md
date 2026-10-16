# Hermes Agent 图文指南

Hermes Agent 是 ClawPanel 支持的第二个 AI Agent 引擎。它把会话、长期记忆、人格档案、工具调用和消息渠道放在同一个管理面板中，让 Agent 从一次性的聊天窗口，升级为可以持续运营和沉淀上下文的智能体系统。

## 核心价值

- **长期记忆可视化**：通过 Notes、User Profile、Soul 三份 Markdown 文件沉淀事实、偏好和人格。
- **会话可运营**：统一查看会话、消息流、运行状态和工具调用细节。
- **人格可维护**：把 Agent 的表达风格、价值观、用户偏好固化为可编辑资产。
- **渠道可扩展**：面向 QQ、Telegram、Discord 等外部渠道，集中管理连接能力。

## 界面预览

### Hermes Agent 控制台

![Hermes Agent 控制台](./h00.png)

控制台用于查看 Hermes Agent 的整体运行状态、入口能力和主要管理模块，适合作为日常运营的第一屏。

### Agent 长期记忆

![Hermes Agent 长期记忆](./h01.png)

Agent 记忆页围绕三类长期上下文组织：笔记记录事实，用户画像记录偏好，灵魂档案塑造人格。所有内容都以 Markdown 形式保存，便于审计、迁移和版本管理。

### 会话与消息流

![Hermes Agent 会话与消息流](./h02.png)

会话视图用于追踪 Agent 与用户之间的对话过程，帮助你观察消息上下文、响应质量和实际运行表现。

### 工具与运行细节

![Hermes Agent 工具与运行细节](./h03.png)

工具与运行细节用于定位 Agent 执行过程中的关键动作，适合排查问题、优化提示词和调整工具权限。

## 推荐使用流程

### 0.22.2 候选资格范围（尚未完成发布验收）

本资格分支的受管目标为 `0.22.2 / v0.22.2`，固定发行提交 `d923a5eb487a17c0a68801bba9ef0f56c81040a8`；这不代表主线旧推荐已升级，也不会自动升级用户已安装的内核。安装器保持官方原文件及 SHA256 核验，使用原五阶段后执行私有 products completion，保留原 build、maintenance、stamp 和 boot record，不伪造完成状态。

新版 PM 环境按当前 checkout 的真实事实记录选择 Python；损坏、越界、非 current、completion/repair debt 或陈旧 products receipt 会先失败，不回退其他安装。普通 CLI 使用统一私有启动 wrapper，保留 `0.21.5` 的旧源码 venv/launcher 兼容分支。版本探针优先官方本机 metadata（关闭该探针的远程 update check），旧版仍按 `--version` 优先、旧子命令一次 fallback；探针成功不代表 Gateway 在线。

Dashboard 在整个受管进程内保留私有 exposure policy；内部 main 子进程及 named→default Dashboard reroute 会再次走同一 preflight，不能靠外层命令 allowlist 推定内部 API 安全。Profile 创建/重命名/删除仍使用原流程，其便捷 alias 只落受管 HOME 内，不写用户全局 `~/.local/bin`。单一 profile 参数按原解析规范规范化，重复全局 selector 明确失败；`--` 和 MCP 参数透传保留。

Windows 普通入口清单已分别核对 Web/Rust 的实际 argv：Gateway 前台 `run/stop/status`、Dashboard、工具列表、会话查询/改名/删除、profile list/use、日志不因命令名被一概阻断。Dashboard 内部 hub 的三种普通操作已从原阻断中窄修：只接收 `skills install IDENT --yes`、`skills uninstall NAME --yes`、`skills update`，仍经完整私有 preflight；不因此开放技能发布、修复或额外 flags。该清单和隔离契约不代表实际 Windows 入口验收。

**仍未完成的资格门禁：** 同一最终 SHA 的全新 Linux/Alpine 完整安装生命周期、真实 Windows AMD64 五阶段及所有 API/内部子进程/外部 canary（含 hub 三项真实操作）、便携模式和 Tauri GUI。Linux glibc 的结果不替代发行 Alpine；现有 Alpine 诊断不能解读为 musl 不支持。Windows ARM64（含 x64 模拟）及未知/矛盾原生架构在引导系统工具前阻断，这不等于 ARM64 支持。Windows `gateway start/restart/install/uninstall/migrate`、native source updater、open-terminal/setup 和 profile 的系统 service/task 清理仍单列宿主边界，未资格；不能将其阻断计完整 Windows 功能通过。Dashboard status/stop probe 的主线程独立修复尚待按精确 hunk 合入本候选；本候选不因此被视为可发布默认。静态/隔离 canary 结果也不替代上述实测。

1. **先完成模型与 Gateway 配置**：确保 Hermes Agent 可以正常连接模型服务。
2. **初始化长期记忆**：在 Agent 记忆页补充 Notes、User Profile 和 Soul。
3. **进入会话验证效果**：通过对话确认人格、偏好和上下文是否按预期生效。
4. **接入消息渠道**：根据实际场景接入 QQ、Telegram、Discord 等外部渠道。
5. **持续迭代记忆资产**：把真实使用中沉淀下来的事实、偏好和规则整理回长期记忆。

## 与 OpenClaw 的关系

ClawPanel 采用多引擎架构：OpenClaw 适合已有 OpenClaw 生态用户的 Agent 管理和 Gateway 运维；Hermes Agent 则强化会话、记忆、人格和工具执行的长期运营体验。两者可以在同一个面板中统一管理。
