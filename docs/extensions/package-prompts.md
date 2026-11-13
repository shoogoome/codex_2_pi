# 包级提示词（package-prompts）

`extensions/package-prompts` 是本包统一的提示词维护入口。跨工具调用编排以及后续新增的包级约定集中放在这里，不向独立工具的描述中添加相互依赖。

## 当前规则

### 优先使用 codemode

工作时尽量用 codemode 批量调用工具、串联依赖步骤和过滤输出，减少顶层工具往返。独立调用用 `Promise.allSettled` 并行处理并检查各项结果；存在数据依赖或写入冲突时顺序执行。简单的一次调用不必强行包装，codemode 不可用时回退独立工具，不绕过权限与审批。

### 非阻塞 LocalAgent 委派

边界清晰、偏独立且较长的工作可通过 `task_agent` 交给后台 LocalAgent。明确目标、输入、范围、验收条件和共享文件边界，避免重复工作或并发改同一文件，保留审批、只读规划与叶子 worker 限制。

派发后主会话继续做其他独立工作或回应用户，不立即轮询或同步等待；没有其他工作时说明后台任务并结束当前回合，等自动完成通知。结果返回后检查产物与验证证据，再整合汇报，不把“已启动”当“已完成”。

### 批量命名

需要设置任务标题/会话名时，将实际可用且符合各自使用条件的 `change_title`、`set_session_name`、`mcp__tmux_title__set_title` 合并到**一次 codemode** 调用，在脚本中用 `Promise.allSettled` 并行执行并输出每项结果。一项失败不影响其他项。

这条规则统一调用方式，优先于单工具描述中“直接调用 / 不经 codemode”的调用方式说明；不改变工具参数、权限、适用条件或作用范围。未安装的工具不调用，后台 worker 仍跳过 tmux 命名。只有 codemode 不可用时才回退到分开调用。普通进度变化不重复命名。

此扩展只提供系统提示词指引，不注册/执行命名工具、不添加新工具依赖，也不保证模型必定遵守。

## 如何添加后续提示词

编辑 `extensions/package-prompts/src/prompt.ts` 中的 `PACKAGE_PROMPT_RULES` 列表，添加独立的 `id`、`title`、`body` 条目，并更新就近测试。不要把包级编排约定散落到各工具描述里。

`index.ts` 只负责在 `before_agent_start` 追加合成后的 `# Package instructions` 区块，保留其他扩展已生成的系统提示词；同一完整区块不会重复追加。用户和 custom 触发的运行均适用，不添加对话消息、额外模型请求或定时器。

该扩展与 `behavior` 分工不同：behavior 放通用工程准则，此处放本包的具体约定与跨工具使用策略。

## 生效与验证

根包的 `pi.extensions: ["./extensions"]` 自动发现此扩展。构建后重启 Pi 或 `/reload`：

```bash
npx vitest run extensions/package-prompts
npm run build:extensions
```

包入口使用 `dist/index.js`，修改源码后需重建。若不需要这些包级约定，可在 Pi 的资源配置中禁用此扩展，无需禁用独立工具。
