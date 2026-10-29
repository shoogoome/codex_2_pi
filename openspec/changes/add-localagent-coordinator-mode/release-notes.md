# 本机更新记录

## 发布范围

- 用户要求停止新增测试，直接更新本机 Pi；不执行 npm 远端发布、Git 提交或推送。
- 本机已安装此仓库的本地路径包，过滤规则仅排除 teammate/session-summary，不排除 coordinator；安装更新保留用户资源选择。
- 功能入口：`/coordinator on|off|status`、`--coordinator` / `--coordinator=false`、`PI_COORDINATOR_MODE`。共享容量默认总驻留/总并发各 9（包含主会话，即 8 个 child）。

## 最后修正

- Plan 判断改用 `getAgentMutationPause().paused`，不再因为 `exit_plan_mode` 已注册而误判为规划状态；保留原只读/审批门禁。
- 执行报告绑定 `reportVersion`，交接记录携带目标版本与尝试来源；确认新目标不等于提交新目标的交付，旧版交付不能冒充当前目标结果。
- 空验证字符串、空数组/对象或无详情状态不算已有验证证据；未验证结果保持 evidenceMissing 标记。
- 最后修改后的测试按用户要求未重新运行，现有测试 fixture 仅同步真实 Plan 状态接口。

## 已有验证记录（最后修正之前）

- 只读验证 agent：66 个针对性测试文件、638 项测试通过；活动 SDK 集成 2/2 通过。
- 类型检查仍有六处既有错误：context-pipeline/imagegen 的 ProviderHeaders、memory/session-summary 的 completeSimple、side 的 TUI、web 的 registerFlag；该快照无新增类型错误。
- 较早全库测试存在 resume-picker 排序与 side TUI 两项失败；最后一次全库运行另受到根分区 `/tmp` 满盘 ENOSPC 干扰，不能当作全库通过。
- 实际 Pi CLI 1.4.0 + 隔离 synthetic 本地 provider 验证过环境/命令/CLI 开关、reload 保留选择、8 个实际 LocalAgent 并发、显式纠偏确认、worker 执行身份与全部容量释放。synthetic fixture 不进行外部模型请求、不改业务文件，不等于真实模型行为质量保证。
- 实际压缩步骤曾因 synthetic 会话过小得到 Nothing to compact；最终压缩验收尚未完成。
- 临时证据和日志已迁至 `.pi/tmp/coordinator-validation-UkHOuf/`，该目录被忽略，不属于发布内容。

## 发布状态

- `npm run build:extensions` 成功，生成 42 个扩展 bundle；tasks/localagent/coordinator 保持源码入口。
- `pi install .` 成功，输出 `Installed .`；完成本机本地路径包更新，未执行远端发布或 Git 推送。
- 构建日志：`.pi/tmp/coordinator-validation-UkHOuf/logs/release-build.log`；安装日志：同目录 `release-install.log`。
- 需重启 Pi 以载入全部最新 bundle，再用 `/coordinator on` 开启模式。
- OpenSpec 8.3/8.4 未全量验收，保持未勾选，不宣称 33/33 完成；最后修正后的测试按用户要求未运行。
