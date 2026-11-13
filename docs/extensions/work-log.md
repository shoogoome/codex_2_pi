# 全局工作进度日志

`extensions/work-log` 提供模型工具 `record_work`：开始任务、每完成一项有意义的工作、阶段进度变化、阻塞/失败及最终完成时记录进度。不会运行总结模型、创建定时任务或上传日志，你可以自行定时汇总。

## 启用与指定目录

本包的根 `pi.extensions: ["./extensions"]` 自动发现此扩展，无需修改扩展列表。全局安装本包后，重启 Pi 或 `/reload` 生效：

```bash
pi install /绝对路径/coding_2_pi
```

默认写入 `~/.pi/agent/work-log/`，所有项目/会话共享同一根目录。可在启动环境指定：

```bash
export PI_WORK_LOG_DIR=/data/work-logs
pi
```

或在已有全局 `~/.pi/agent/settings.json` 中合并以下环境变量配置（需要本包的 settings-env 扩展，不要覆盖已有设置）：

```json
{
  "env": {
    "PI_WORK_LOG_DIR": "/data/work-logs"
  }
}
```

单次启动覆盖：`pi --work-log-dir=/data/work-logs`。优先级：CLI flag > 环境变量 > 默认目录。目录只接受绝对路径或 `~/` 路径，避免不同项目意外写到不同位置；空路径报错，不静默回退。若要真正全局统一，不要在项目配置中覆盖此变量。默认目录固定在用户 home 下，不跟随 cwd 或自定义 agentDir。

## 工具参数

```json
{
  "task": "修复登录超时",
  "status": "in_progress",
  "progress": "已定位连接池耗尽，修复完成；回归测试正在运行",
  "percent": 70,
  "next_step": "等待回归结果并检查类型",
  "files": ["src/auth.ts", "src/auth.test.ts"]
}
```

- 必填：`task`、`status`、`progress`。
- `status`：`started` / `in_progress` / `completed` / `blocked` / `failed`。
- 选填：`percent`（0–100，无法估计时省略）、`next_step`、`files`。
- 同一任务沿用相同 task，便于结合 sessionId/cwd 聚合；状态是记录时的快照，不修改旧记录。
- 日期、时间、项目目录和会话信息由工具自动填充，模型不能回填日期。

## 磁盘格式与汇总

```text
<日志根目录>/
  2026/06/02/
    2026-06-02T08-30-00-000Z-<uuid>.json
    2026-06-02T08-35-00-000Z-<uuid>.json
```

每条记录为独立 UTF-8 JSON 文件，字段：

| 字段 | 含义 |
|---|---|
| schemaVersion | 当前为 1 |
| id | UUID，每条记录唯一 |
| timestamp | 工具执行时的 UTC ISO 8601 时间 |
| date | 本机时区的日历日期，YYYY-MM-DD，决定分目录 |
| utcOffsetMinutes | 当时本机相对 UTC 的偏移分钟数（东八区为 480） |
| cwd | 执行工具时的项目绝对路径 |
| sessionId / sessionName | 当前会话 ID / 名称；未命名时省略 sessionName |
| task / status / progress | 任务、状态和进展正文 |
| percent / next_step / files | 调用方提供时才存在 |

定时任务递归读取 `YYYY/MM/DD/*.json`，按 timestamp 排序，以 id 作为增量消费游标/去重键，结合 cwd + sessionId + task 聚合。目录日期按本机时区而非 UTC；需固定日期边界时，给所有 Pi 进程设置相同的 `TZ`。

每条记录先写唯一的 `.json.tmp` 再在同目录原子 rename 为 `.json`，不共享追加文件、不覆盖其他记录；多个 Pi 进程同时记录不会发生读改写竞争。汇总器只读 `*.json`、忽略 `*.tmp`；进程被强杀时可能残留临时文件。新建目录使用 0700、文件使用 0600（已有目录权限不修改）。这不是断电事务/fsync 保证；建议使用本地文件系统。

## 行为与边界

- 工具描述和静态 promptGuidelines 引导模型按工作里程碑调用，不是强制审计或每次工具调用的自动抓取；模型仍可能漏记。不会自动插入无限续跑或阻塞主任务来补记。
- 记录动作不再次记录；纯读取、无进展的轮询不刷屏。结束前记录真实结果，不能把计划、已启动测试当成已完成验证。
- 不保存完整对话、思考过程、工具原始输出或自动扫描的文件正文。模型填写的正文可能包含敏感内容，因此仍应避免密码、token、个人隐私和机密数据；没有自动脱敏保证。
- 取消或写入失败时工具报错，不返回伪成功；模型应告知失败并继续主任务，不无限重试。失败重试可能生成相似记录，没有业务级幂等保证。
- 全局记录覆盖所有加载且实际调用此工具的 Pi 会话；不会追踪其他应用或未加载扩展的会话。子 agent 是否可调用仍由其运行时工具集和审批/规划限制决定，不绕过权限。
- 不自带删除、清理、保留期或总结功能；这些交由你的外部任务管理。
