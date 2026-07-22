# profiles

命名配置预设:把「模型 + 激活工具 + thinking 等级 + 审批模式」打包成一个带名字的快照,用 `/profile` 一键保存/切换/删除,或用 `--profile <name>` 在启动时应用。

## 能力

- 将当前运行时的正交设置(model、active tools、thinking level、approvals mode)捕获为一个命名 Profile。
- 通过 `/profile` 命令保存、应用、删除、列出(选择器)预设。
- 支持 `--profile <name>` 启动 flag,在会话开始时自动应用某个预设。
- 应用时逐项隔离:某一项(如模型无 API key)失败不会阻断其余项的应用。
- 预设持久化到会话条目;状态栏显示当前激活的预设名 `profile:<name>`。

## 命令

`/profile [子命令] [name]`

- `/profile save <name>` — 把当前运行时状态(模型、激活工具、thinking 等级)捕获为名为 `<name>` 的预设。无当前模型时给出 warning,仍会保存(不含模型)。同名(不区分大小写)覆盖。
- `/profile apply <name>` — 应用指定预设到当前运行时。未知名字报 error。
- `/profile apply`(无 name)— 弹出选择器,列出所有预设(带一行摘要,标注 `(active)`)供选择应用。
- `/profile delete <name>` — 删除指定预设。若删除的是当前激活预设,则清空状态栏。
- `/profile <name>` — 裸名字等价于 `apply <name>` 的快捷方式。
- `/profile`(空参)— 弹出选择器。

参数自动补全:补全子命令(`save`/`apply`/`delete`)与已存预设名;在 `apply `/`delete ` 后补全预设名并附带一行摘要。

预设名要求:非空字符串(去空格后)。名字匹配、覆盖、删除均不区分大小写。

## 工具

本扩展不注册任何 LLM 可调用工具,仅提供斜杠命令与启动 flag。

## 配置

- 启动 flag:`--profile <name>`(string 类型,描述 "Profile configuration to apply at startup")。会话开始时若该名字匹配到已存预设则自动应用,否则给出 warning。
- 持久化:通过 `appendEntry("profiles", ...)` 写入会话条目(customType = `profiles`)。每次变更后写入完整 ProfileSet;`session_start` 时读取最新的该类型条目恢复预设集合 + 激活名。无独立配置文件、无环境变量。
- 审批模式广播频道:`approvals:mode`(pi.events 事件名)。

一个 Profile 可含字段:`name`、`model`({provider,id})、`tools`(string[])、`thinkingLevel`、`approvalsMode`、`extra`(任意 record)。

thinking 等级取值:`off`、`minimal`、`low`、`medium`、`high`、`xhigh`。

审批模式建议值(仅校验/展示提示,存储时接受任意非空字符串):`untrusted`、`on-request`、`on-failure`、`never`。

## 用法示例

```
# 调好模型/工具/thinking 后保存为 "review" 预设
/profile save review

# 切换到该预设
/profile apply review
# 或裸名字快捷方式
/profile review

# 不带名字弹出选择器挑一个应用
/profile

# 删除预设
/profile delete review

# 启动时应用
pi --profile review
```

## 说明 / 注意

- **应用行为逐项隔离**,任何一项失败只给 warning 不中断:
  - 模型:先按 registry 精确 `provider+id` 查找,找不到再按 id 做模式匹配(id 全等 → id 子串包含 → `provider/id` 匹配);仍找不到报 "model ... not found";找到但无 API key 则保留当前模型并 warning。
  - 工具:先过滤出运行时存在的工具名再 `setActiveTools`,未知工具名列出 warning。
  - thinking / approvals mode:各自 try/catch。
- **恢复语义**:`session_start` 恢复只刷新状态(预设集合 + 激活名 + 状态栏),**不会**重放 model/tools —— 恢复会话不会静默覆盖用户当前状态。批量应用只发生在显式 `/profile apply`、选择器应用、或 `--profile` flag。
- **审批模式无内建 API**:pi 没有内建 approvals API。`approvalsMode` 只被存储并显示在状态行,并通过 `pi.events` 在 `approvals:mode` 频道尽力广播;若没有监听的扩展消费它,则无实际运行时效果。
- 持久化对损坏/版本漂移条目宽容:解析预设集合时跳过畸形条目,不整体失败。
