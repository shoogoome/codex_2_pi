# 临时追踪 settings.json 写入

用于定位 `compaction.enabled` / `retry.enabled` 被改动的实际写入进程。它不是修复开关的工具，也不会主动启用/关闭开关。**目前尚未定位本次问题的真实写入者。**

## 启用

在本仓库目录，给你平时的启动命令加一个前缀：

```sh
bash scripts/with-settings-trace.sh pi
# 若平时经 Happy 启动，保留你原来的 Happy 参数：
bash scripts/with-settings-trace.sh happy
```

无参数时默认启动 `pi`。后面的命令及参数原样传递，已有 `NODE_OPTIONS` 被保留。仅计算 preload 文件 URL 的辅助 Node 命令临时清空自己的 `NODE_OPTIONS`，避免多跑用户已有 preload 或把其 stdout banner 混入 URL；正式命令仍完整保留原选项。启动器仅为这次命令的环境增加 Node `--import` preload 和追踪开关；不会修改全局 shell 配置、SDK 文件或 `settings.json`。不需要 `pi install` 或重新构建扩展。

**必须用此前缀新启动进程。** 已运行的 Pi/Happy 不能自动接入；不要为此直接终止正在工作的会话。保存工作后按平时方式退出，再带此前缀重新启动。

默认目标为当前用户的 `~/.pi/agent/settings.json`，不跟随子进程的临时 `PI_CODING_AGENT_DIR` 改变。追踪会规范化路径，支持 `/root` 与 `/data/root-home` 这类指向同一文件的别名。

默认日志：

```text
<仓库>/.pi/tmp/settings-write-trace/events.jsonl
```

可显式选择目标及输出文件（建议使用绝对路径）：

```sh
PI_SETTINGS_TRACE_TARGET=/absolute/path/settings.json \
PI_SETTINGS_TRACE_LOG=/absolute/private-directory/events.jsonl \
bash scripts/with-settings-trace.sh pi
```

新建日志目录/文件分别使用 `0700` / `0600`。**不会 chmod 既有目录**，尤其不会改变 `/tmp` 权限。已有日志目录必须是当前用户拥有的私有目录；日志文件必须为当前用户拥有的私有普通文件。拒绝最终目录软链、日志软链和多硬链接文件，输出不得与目标配置是同一个文件。输出不可用时仅打印固定诊断警告，正常配置写入仍继续。

## 复现后看什么

每个 JSONL 事件仅记录：

- `timestamp`、`pid`、`ppid`；
- 写入操作名和规范化的目标路径；
- `changedFields`：两个被观察字段中发生变化的**字段名**，不记录值；
- 实际文件操作发起时捕获的 `stack`。

不记录配置原文、字段值、凭据、环境变量、进程命令行或 RPC 消息。只在内存中比较两个布尔开关；配置不可读、不是合法 JSON 或超过 1 MiB 时，`changedFields` 为 `null`，表示未知，不代表开关已被关闭。空数组表示此次成功写入未改变两个字段。所有成功的目标文件写入均可留下事件，所以普通设置保存也可能出现空数组。

栈只序列化结构化 V8 帧的文件位置，使用固定消息，移除 URL query/fragment，并丢弃含 `data:` 源码 URI 的帧。不会调用应用自定义的栈格式器来生成可能包含源码片段的文本；同步捕获期间暂时替换 `Error.prepareStackTrace`，随后恢复其原始属性描述符。JSON 解析异常和原始写入异常的消息不写入日志，避免包含配置片段。

**这是文件写入栈，不是完整的上层操作因果链。** `SettingsManager.save()` 会经异步队列执行，栈可能只到 `persistScopedSettings` / `enqueueWrite`，不一定保留最初的 RPC、按钮或工具调用。PID 可以帮助定位写入进程，但不能承诺一次就找到高层原因。没有复现事件前，不应据此断言 LocalAgent、某个扩展或测试就是根因。

复现后保留相应时间段的日志供分析；日志虽不包含配置内容，仍包含本地源文件路径和调用栈，不要公开整份日志。

## 覆盖和边界

- 覆盖被 preload 的 Node 进程，以及继承相同环境、未清除 `NODE_OPTIONS` 的 Node 子进程。
- 覆盖 `fs.writeFileSync`、callback `fs.writeFile`、`fs.promises.writeFile`，以及 `renameSync` / callback `rename` / Promise `rename` 到目标文件的原子替换。ESM 内建模块绑定通过 `syncBuiltinESMExports()` 同步。
- 在 Linux 上可识别上述写入 API 的数字文件描述符；其他平台的数字 FD 不保证捕获。若文件已被提前截断，旧内容可能不可读，字段变化会标为未知。
- 不覆盖未带 preload 的既有进程、非 Node 进程、移除环境变量的子进程、原生 addon、`FileHandle.writeFile` / `write` / streams 等其他写入方式。追踪安装前已缓存原始 fs 方法的模块，或更早执行的用户 preload，也不保证捕获。不能把没有日志当作没有其他写入者的证据。
- 并发写入时前后快照只提供尽力观察，不是文件锁或事务。它不会阻止写入，也不是完整审计系统。
- 写入本身的返回、错误和回调保留；追踪/输出失败不应阻断应用写入。

## 停用

退出带追踪的进程后，用原来的命令启动，去掉脚本前缀即可。启动器不会修改父 shell 环境；若曾手工 export `PI_SETTINGS_TRACE_ENABLED` 或给 `NODE_OPTIONS` 添加本 preload，也需移除相应项。日志可自行保留或删除；SDK 与用户配置无需恢复。

## 源码检查与隔离用例

`trace-settings-writes.test.mjs` 使用独立临时目录和 Node 子进程，不读取真实 Pi 设置或凭据、不启动 Pi/Happy。它是单独的 `node:test` 用例，不属于当前 `npm test` 的 Vitest 匹配范围。

本次交付仅做语法和静态差异检查，不执行用例：

```sh
node --check scripts/trace-settings-writes.mjs
node --check scripts/trace-settings-writes.test.mjs
bash -n scripts/with-settings-trace.sh
git diff --check
```

若以后明确允许执行隔离用例，可单独运行 `node --test scripts/trace-settings-writes.test.mjs`。
