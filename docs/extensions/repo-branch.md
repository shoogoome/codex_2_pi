# 会话仓库分支记录与常驻展示

`extensions/repo-branch` 为当前 Pi 会话提供工具 `record_repo_branch` 与输入框上方的常驻展示框，用于记录并随时查看当前会话涉及的代码仓库及对应 Git 分支。

## 能力

1. **工具 `record_repo_branch`**：供模型在当前会话中记录、更新、移除、清空或查询涉及的仓库与对应分支。
2. **输入框上方常驻小框**：通过 Pi `setWidget(..., { placement: "aboveEditor" })` 在输入框上方靠右对齐展示紧凑型仓库分支小框（宽度按内容自适应，不占满整行）；最多同时展示 6 行，超出时在底边框提示总数并可通过 `/repo-branch list` 查看完整列表。
3. **会话分支持久化**：状态通过 `pi.appendEntry("repo-branch:state", state)` 保存在当前会话分支中，支持 `/reload`、`/resume`、`/fork`、`/tree` 导航和 `/compact` 后自动恢复，并按扩展实例隔离（不影响无 UI 的后台 LocalAgent worker）。

## 工具用法

```json
{
  "action": "record",
  "repo": "/workspace/api-server",
  "branch": "feat/oauth-refresh"
}
```

- `action`（可选，默认 `record`）：
  - `record`：记录或更新仓库分支。省略 `repo` 时默认解析 `ctx.cwd` 所属的 Git 仓库根目录；省略 `branch` 时自动读取目标仓库当前检出的 Git 分支（支持未提交的初始分支与 detached HEAD）；若目标不是磁盘上的 Git 仓库且未传入 `branch` 会明确报错。
  - `remove`：按仓库名、路径或规范化根路径移除单条记录（省略 `repo` 时匹配当前工作目录仓库）。
  - `clear`：清空当前会话的全部仓库分支记录。
  - `list`：返回当前会话记录的全部仓库与分支。
- 若存在多个同名仓库（如 `team-a/service` 与 `team-b/service`），展示框会自动附带父目录名消歧，移除同名仓库时也会提示指定完整路径。

## 命令与开关

- `/repo-branch` 或 `/repo-branch list`：查看当前会话记录的所有仓库及分支
- `/repo-branch on | off | toggle`：开启、隐藏或切换输入框上方常驻小框
- `/repo-branch record [repo] [branch]`：手动记录或更新仓库分支
- `/repo-branch remove [repo]`：移除指定仓库记录
- `/repo-branch clear`：清空当前会话记录
- `--repo-branch=false` 或 `PI_REPO_BRANCH=0`：启动时默认隐藏常驻小框（仍可通过工具或 `/repo-branch on` 使用）
