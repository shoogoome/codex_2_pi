# settings-env

`settings-env` 扩展让 Pi 可以从 `settings.json` 的顶层 `env` 字段读取环境变量。

扩展在 Pi 加载扩展时同步注入 `process.env`，因此变量可用于后续加载的模型配置、其他扩展以及 Pi 启动的 shell 命令。

## 配置位置与优先级

扩展依次读取：

1. 全局设置：`~/.pi/agent/settings.json`（实际路径由 `PI_CODING_AGENT_DIR` 决定）
2. 项目设置：`<cwd>/.pi/settings.json`

项目 `env` 会覆盖同名的全局 `env`。默认情况下，启动 Pi 前已经存在的进程环境变量优先级最高，不会被 `settings.json` 覆盖。

## 示例

```jsonc
{
  "env": {
    "OPENAI_API_KEY": "sk-...",
    "API_BASE_URL": "https://example.com/v1",
    "FEATURE_ENABLED": true,
    "MAX_RETRIES": 3
  }
}
```

字符串、数字和布尔值均受支持；数字和布尔值会转换为字符串。

若确实需要让 `settings.json` 覆盖启动环境，请显式设置：

```jsonc
{
  "envOverride": true,
  "env": {
    "OPENAI_API_KEY": "sk-from-settings"
  }
}
```

项目设置中的 `envOverride` 会覆盖全局设置中的同名选项。

## 注意事项

- 修改配置后需要重启 Pi；扩展不会热更新环境变量。
- `settings.json` 支持 JSONC 注释和尾逗号。
- `env` 中的对象、数组和 `null` 会被忽略并输出警告。
- API Key 等敏感信息建议放在全局设置或其他不提交到 Git 的文件中。若使用项目设置，请确保 `.pi/settings.json` 已加入 `.gitignore`。
- 环境变量注入发生在扩展初始化阶段。Pi 在此之前完成的极早期启动逻辑无法使用这些变量。
