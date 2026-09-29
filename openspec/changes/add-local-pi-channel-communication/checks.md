# 实施自动化检查记录

## 本变更

- Channel 独立严格类型检查通过：`npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --types node,vitest/globals extensions/channel/*.ts extensions/channel/src/*.ts extensions/channel/src/fixtures/*.ts`。
- `npx vitest run extensions/channel`：22 个测试文件，131 项通过（包含真实 Unix socket、多独立子进程、owner 强杀、部分送达、身份、TUI 与入口生命周期）。
- skill 的 `quick_validate.py` 校验通过；Pi 原生 skill 发现校验识别 1 个技能、无 diagnostics。四场景审阅见 `skills/pi-channel-collaboration/references/acceptance.md`。
- `git diff --check` 对本变更涉及文件通过。
- 扩展构建通过，43 个扩展 bundle 成功，pets 按原脚本跳过，重复内联检查通过；未把生成的 dist 产物列入提交。

## 收尾复审

只读复审发现的三项问题已修复并添加回归测试：运行中用户 steer 不再解除 Pi 自动回复隔离；新加入房间的 ID 同样检查与已有路由名冲突；已关闭频道仍可通过 TUI 退出/销毁本地记录。另补充重叠 session_start 的 generation 防护和回执丢失时保留消息 ID、显式标记目标集合未知。

真实 tmux TUI 验收脚本再次运行通过，覆盖中文两行职责、成员查看、取消、重开和窄屏。使用 Pi 内置 editor 的焦点契约；没有测试物理 OS 输入法候选窗。

## 全仓检查的非 Channel 失败

`npm test`：279 个测试文件通过、3 个失败、1 个跳过；2806 个测试通过、2 个测试失败、5 个跳过。失败均在本变更未编辑的模块：

1. `extensions/web/src/smoke-fast.test.ts`：硬编码的 `/root/.nvm/versions/node/v22.22.2/.../dist/rpc-entry.js` 在本机不存在，套件无法启动。
2. `extensions/resume-picker/index.test.ts:293`：会话 fixture 排序预期不一致。
3. `extensions/side/side-overlay.tui.test.ts:63`：`TUI is not a constructor`。

`npm run typecheck`：本变更自身错误已修复；全仓仍有以下接口兼容问题，未越界修改：

- context-pipeline / imagegen：`ProviderHeaders` 的可空 header 值与 `Record<string, string>` 不兼容。
- memory / session-summary / side：当前 pi-ai 不导出 `completeSimple`。
- side-overlay 测试：`TUI` 仅为类型。
- tasks / teammate / ultra：`SessionHandleHost` 所要求的 events 索引签名与 `EventBus` 不兼容。
- web：flag 的联合类型不符合当前 Pi 注册签名。

这些失败不能表述为“全仓验证通过”。工作区同时存在其他任务的未提交修改，本变更保留这些文件，不通过改依赖版本或屏蔽测试掩盖失败。

## 真实交互验收

`verification.md` 记录真实 Pi/TUI 结果。使用用户指定的 `dgx-spark / deepseek-v4-flash-0731` 完成三个真实 Pi 进程协作验收（exit 0，72 秒）：自然语言创建/加入、身份更新不唤醒、空闲唤醒、忙时 steer 不打断工具、部分投递 unknown、撤销邀请拒绝加入、创建者退出均通过。真实 tmux 中文输入/面板验收也已通过；仍不声称验证了物理 OS 输入法候选窗。
