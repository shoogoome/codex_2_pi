# 思考块透明背景（thinking-style）

默认让思考块沿用终端底色、保留文字颜色，不强制涂黑。除清理思考内容自带的背景与反色，还清理原生渲染器自动添加的斜体，以兼容旧 screen/tmux 终端。

## 白底来源与修复位置

Pi 原生为思考块添加 ANSI 斜体 `ESC[3m`。但 `screen` / `screen-256color` 的旧 terminfo 将 `ESC[3m` 定义为 `smso`（standout，突出显示），可能显示为反色/白底。因此，思考源文本完全没有 ANSI 背景码时也可能出现白底。

本扩展分两层处理：

1. `registerMarkdownTransformer` 只清理 `assistant-thinking` 源文本中的 ANSI 背景/反色。
2. 包裹宿主 `AssistantMessageComponent.updateContent` 生成的原生思考子组件，在其最终 `render()` 输出中重置背景、反色及斜体。第二层能处理原生生成的 `ESC[3m`，仅修改 Markdown 输入无法做到。

当前 Pi 使用 `MouseRegion` 包装思考 Markdown/隐藏标签，旧版直接添加组件；扩展兼容这两种结构，保留原组件及点击事件，不替换折叠逻辑。不包裹全局 Markdown，也不处理普通正文、错误文字或其他工具组件。

## 行为与边界

- 清理普通/亮色背景、256 色背景、RGB 背景、反色及最终思考斜体；保留前景色、粗体、下划线、Markdown 和链接。
- 思考不再显示斜体，包括思考 Markdown 中的斜体强调；正文斜体不变。
- 不改用户消息、普通助手正文、工具结果或 diff 的背景。
- 不改会话历史或模型上下文；流式内容和恢复的历史均在显示时处理。
- 思考文字颜色仍由主题 `thinkingText` 控制；折叠/展开及点击行为保留。
- 与原生、claude-ui 和 compact-ui 共存；不修改终端配置或其他 tmux 窗口。
- 不更改终端本身的底色、鼠标选中高亮，也不能覆盖其他扩展在本扩展之后主动添加的背景。

## 生效与维护

此扩展必须使用 **`index.ts` 源码入口**，由 Pi 的 jiti 映射到真实运行宿主的组件类；不能改成预编译 JS 入口，否则可能补丁打到工作区另一份 SDK 类。`scripts/build-extensions.mjs` 将其列入跳过列表。已经存在的旧 `dist/index.js` 不再是加载入口。

修改后重启 Pi 或 `/reload`；从旧版预编译入口升级时建议重启一次，以确保旧 UI 实例重建。无需修改主题或终端配置。

```bash
npx vitest run extensions/thinking-style
npm run build:extensions
```

没有新增命令、工具或主题字段。要恢复原生样式，可在 Pi 资源配置禁用此扩展后**重启 Pi**，以移除进程内原型补丁。更新 Pi 后若内部思考子组件结构变化，应重新运行真实宿主加载验收，而不是只检查构造的 ANSI 输入样例。
