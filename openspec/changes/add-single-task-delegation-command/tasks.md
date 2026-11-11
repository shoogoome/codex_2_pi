# Tasks

## 1. 单次委派模板与包资源

- [x] 1.1 新增 `prompts/agent.md`，提供 description、argument-hint 和 `$@` 任务区域，明确仅本次默认一个 worker、保留持续模式及既有授权；通过真实模板读取测试确认参数入口和关键边界存在。
- [x] 1.2 在模板中编写主会话结构化契约与 worker assignment 要求，使用 `coordinator_task` 后以 `coordinator_task_id` 绑定 `task_agent`，区分主会话派发与叶子执行指令；通过测试检查目标、上下文、具体路径、非目标、验收和报告要求齐全，且没有要求创建 team 或递归派生。
- [x] 1.3 在模板中补全异常报告、纠偏确认、阻塞交接、证据化交付及异步验收约定，明确 specialHandling、deviations、remaining，派发成功立即结束主回合、禁止轮询和失败后静默代做；通过模板契约测试核对相应字段和安全分支。
- [x] 1.4 更新根 `package.json` 的 `files` 与 `pi.prompts` 声明，只暴露 `prompts/agent.md`，检查 coordinator 子包清单无需变更；通过资源声明测试和 `npm pack --dry-run --ignore-scripts --json` 确认模板会随包分发，未引入重复 `.pi/prompts/agent.md`。

## 2. 回归验证与文档

- [x] 2.1 新增 `extensions/coordinator/agent-prompt.test.ts`，读取真实模板和根清单，覆盖单次范围、契约绑定、非阻塞、事件字段、证据与验收、只读/审批及工具失败约束，不使用整篇文案快照；运行 `npx vitest run extensions/coordinator/agent-prompt.test.ts` 并确认通过。
- [x] 2.2 在 `extensions/coordinator/index.test.ts` 与 `extensions/localagent/tools/taskAgent.test.ts` 补充必要的关闭持续模式时显式契约绑定回归，确认绑定产生有效 worker 报告路径且模式未改变；运行相应测试并复跑现有 communication、runtime.integration 与 notifications 测试，保留底层执行和通知语义。
- [x] 2.3 更新 `README.md`、`docs/extensions/coordinator.md` 和 `skills/pi-capabilities/SKILL.md`，说明 `/agent <任务>`、与 `/coordinator on` 的差异、自动回传、报告字段、验收、工具前置条件及提示词不是硬隔离；人工核对示例与真实工具 schema/模板一致，且不承诺关闭持续模式时开启常驻告警。

## 3. 集成与交付证据

- [x] 3.1 在隔离测试项目的持久 Pi 会话中加载本包并 `/reload`，执行一个已授权的单次任务，记录命令发现/传参、仅一个 worker、主回合及时结束、可继续提问和持续模式不变；记录缺参不明确、工具不可用或写入责任冲突时不派发的检查结果，不改动用户现有未提交文件。
- [x] 3.2 在测试会话中验证 scope/interface 报告、主会话定向纠偏及显式确认、blocked 交接释放、delivered 待验收与主会话证据验收；记录实际事件和最终任务状态，确认无逐条进度打扰、轮询等待、复活终态或无界重派；不可执行的场景明确标为未验证。
- [x] 3.3 运行 `npm test`、`npm run typecheck` 和 `openspec validate add-single-task-delegation-command --strict`，检查变更差异仅涉及本次范围并汇总实际命令结果；已有失败与本次新增失败分开记录，不把静态提示词测试当作真实模型行为通过的证据。

## 4. Skill 折叠入口修订

以上 1–3 节记录已完成的首版模板实现与验收；本节按用户确认的修订替换模板承载方式，原委派协议不变。

- [x] 4.1 将完整指令迁至 `skills/agent/SKILL.md`，仅显式调用，移除旧模板及发布声明；用原生 loader 和发布资源测试确认 Skill 可加载且无全文模板残留。
- [x] 4.2 coordinator 注册轻量 `/agent`，开启原生 Skill 展开、保留参数并以 follow-up 发送；覆盖缺参、多行/引号、Skill 缺失和叶子 worker 禁止再次委派的测试。
- [x] 4.3 同步设计、规格、README、协调文档和能力速查，说明折叠展示不减少模型上下文；检查文档与实际入口及 Skill 一致。
- [x] 4.4 统一运行测试、类型检查、OpenSpec 严格校验和打包检查，并在真实终端 `/reload` 后验收 `[skill] agent` 默认折叠及可展开，记录结果与既有基线失败。
