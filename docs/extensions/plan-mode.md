# plan-mode

只读的"规划闸门"扩展:先探查、再提交计划、经用户批准后才恢复写入能力。模仿 Claude 的 EnterPlanMode / ExitPlanModeV2 —— 探查 only → 提交 plan → 用户批准 → 恢复完整工具。

## 能力

- **只读规划模式**:进入后把当前活跃工具集收窄为只读集合(移除 `write` / `edit` / `apply_patch`,加入 `exit_plan_mode`),并在运行时拦截会修改文件或系统状态的 bash 命令。`bash` 本身仍保留,只读命令(cat、grep、ls、git status、git diff 等)照常可用。
- **系统提示增强**:进入 plan 模式后,在基础 system prompt 后追加一段规划指令(要求模型只探查、只设计、不改动,准备好后调用 `exit_plan_mode`)。
- **状态展示**:底部 footer 显示 `⏸ plan mode on`。
- **批准闸门**:模型通过调用 `exit_plan_mode` 提交计划,用户在弹窗中确认后才退出、恢复写工具;拒绝则留在 plan 模式继续打磨。
- **状态持久化与恢复**:plan 状态(是否开启 + 进入前的活跃工具集)以自定义会话条目 `plan-mode-state` 持久化,会话启动、会话树导航、上下文压缩后都会自动恢复。

## 命令

- `/plan` —— 切换 plan 模式的开/关。这是最可靠的主入口,不依赖任何快捷键。
- `/plan on` —— 强制进入 plan 模式(已开启时无操作)。
- `/plan off` —— 强制退出 plan 模式(不弹确认框,因为是用户直接要求)。

命令执行后,若有 UI 会 notify 当前状态("Plan mode on (read-only)." / "Plan mode off.")。

## 工具

- `exit_plan_mode`(label "Exit Plan Mode") —— 模型在 plan 模式中调用它提交完成的计划并请求退出。
  - 参数:`plan`(string) —— 完整的实现计划:改哪些文件、改什么、步骤顺序。
  - 行为:
    - 若当前不在 plan 模式,返回 "Not in plan mode; there is no plan to submit."。
    - 有 UI 时弹出确认框(标题 "Exit plan mode?",正文含计划全文)。用户批准 → 退出并恢复写工具,返回批准消息;拒绝 → 保持 plan 模式,返回 isError 结果提示继续打磨。
    - 无 UI(print/RPC 模式)时无法确认,默认直接批准退出。
  - 执行模式:`sequential`。

## 配置

- `--plan`(布尔 flag,默认 `false`) —— 会话启动时直接进入 plan 模式。
- `--plan-mode-toggle-key`(字符串 flag,默认 `alt+p`) —— 切换 plan 模式的快捷键(pi 键位 id,如 `alt+p`、`ctrl+shift+p`、`f4`)。留空或未设置时回退到 `alt+p`。
- 快捷键 **`Alt+P`**(默认) —— 切换 plan 模式,等价于 `/plan`。

关于快捷键选择:默认用 `alt+p` 而非 `shift+tab`,因为 pi 已把 `shift+tab` 绑定到内置的 `app.thinking.cycle`(切换思考等级)。若扩展注册 `shift+tab`,pi 会在启动时报冲突并丢弃该快捷键("conflicts with built-in shortcut. Skipping.")。`alt+p` 未被任何 pi/pi-tui 默认键位占用。若要用 `shift+tab` 触发 plan 模式,需先在 `~/.pi/agent/keybindings.json` 里把 `app.thinking.cycle` 改绑到别的键,再把 toggle 键设回 `shift+tab`。

无独立配置文件;状态通过会话自定义条目 `plan-mode-state` 持久化在会话内。

## 用法示例

```
# 直接以 plan 模式启动一个会话
pi --plan

# 会话中随时切换
/plan            # 切换开/关
/plan on         # 强制进入只读规划
/plan off        # 退出规划,恢复写工具

# 自定义切换快捷键
pi --plan-mode-toggle-key ctrl+shift+p
```

典型流程:`/plan on` → 模型只读探查(读文件、grep、git diff)→ 模型调用 `exit_plan_mode` 提交计划 → 用户在弹窗中批准 → 自动退出并恢复写工具 → 开始实现。

## 说明 / 注意

- **与 approvals(审批)扩展协作**:两者都挂 `tool_call` 事件,任一返回 `{block:true}` 都会拦截该调用,天然可组合。plan-mode 只判断"是否只读",不重复 approvals 的规则。
- **只读 bash 判定是黑名单语义**:命中 `rm`/`rmdir`/`mv`/`cp`/`mkdir`/`touch`/`chmod`/`ln`/`tee`/`truncate`/`dd`、输出重定向 `>`/`>>`、`npm install` 类、`git add|commit|push|...`、`sed -i`、编辑器(vim/nano/emacs/code/...)、`sudo`/`su`、`kill`/`reboot`/`shutdown`/`systemctl start|stop|...` 等模式的命令会被拦截;其余当作只读放行。
- **退出时的工具恢复**:退出会用进入前捕获的活跃工具集恢复,并对照当前已加载工具做 sanitize(过滤掉已不存在的工具名),同时移除 `exit_plan_mode`。
- **恢复行为**:从持久化状态恢复时,进入前工具集会再次对照当前已加载工具做 sanitize;`--plan` 与已持久化的 enabled 取并集。
- 拦截 bash 写命令与写工具时,返回给模型的原因文案为中文,提示改用只读命令探查、完成后调用 `exit_plan_mode`。
