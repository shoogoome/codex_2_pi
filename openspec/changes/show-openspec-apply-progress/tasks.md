# Tasks

## 1. Session 回放与任务解析

- [x] 1.1 新增当前 session branch 用户消息扫描器，匹配 `/opsx-apply <change>` 并取最后一次有效 change；用恢复、重复 apply、无 apply 和 malformed 命令测试验证
- [x] 1.2 新增 OpenSpec `tasks.md` 复选项解析器，支持任务编号/分组、`[ ]`、`[x]`/`[X]`、进行中标记和当前任务选择；用标准 Markdown、混合文本和异常行单测验证
- [x] 1.3 增加活动 change、显式绑定和显示开关状态模型，支持 session custom entry 恢复及 `/opsx-progress <change|on|off|toggle>`；用 branch 切换和 compact 恢复测试验证

## 2. 摘要 Widget 与详情 Overlay

- [x] 2.1 实现 above-editor 固定高度摘要，渲染 `OpenSpec: <change> · <completed>/<total>`、进度条、当前任务和 `Alt+O 切换 · Alt+Enter 查看` 提示；用渲染测试验证宽度截断和无任务隐藏
- [x] 2.2 实现固定最大高度的任务详情 overlay，渲染完成/进行中/未完成图标、任务文本、↑/↓ 或 PageUp/PageDown 导航、Esc 关闭和隐藏项数量；用大量任务测试验证不会超出高度
- [x] 2.3 接入 `Alt+O` 显示切换、Alt+Enter 打开详情、Esc 关闭详情及快捷键冲突/空配置降级；验证不覆盖已有快捷键，冲突时命令入口仍可用

## 3. 文件刷新与生命周期接线

- [x] 3.1 接入 session_start、session_tree、session_compact 生命周期，从当前 branch 重新识别 change，并在活动 change 有效时注册 above-editor widget
- [x] 3.2 实现 tasks.md 的 mtime/size 变化检测和有界刷新，在文件变化后只调用 TUI requestRender；用 fake timer/spy 验证不发送消息、不启动 agent、不触发 provider 请求
- [x] 3.3 对缺失、不可读、无法解析或无可识别任务的文件实现隐藏和一次性非阻断诊断，并验证 `/opsx-apply` 未激活时不显示面板
- [x] 3.4 实现详情 overlay 的生命周期、滚动状态和 session 重建清理，验证切换 branch 或关闭摘要后不会残留旧 change 的 UI

## 4. 集成与文档

- [x] 4.1 将新扩展加入包的扩展清单/构建入口，验证 `npm run typecheck` 与对应扩展测试通过
- [x] 4.2 更新 `README.md` 和相关能力文档，说明 above-editor 摘要、Alt+O、Alt+Enter/Esc、`/opsx-progress` 命令、快捷键冲突处理及多任务限制，并验证文档与实现一致
- [ ] 4.3 运行 `npm test`、`npm run typecheck` 和 OpenSpec 校验，确认 session 回放、解析、渲染、交互、刷新和降级场景通过（当前全量测试/类型检查存在仓库既有失败，待单独处理）
