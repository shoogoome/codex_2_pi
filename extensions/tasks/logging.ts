// 轻量 logger — 等价 Claude utils/log.ts 的最小子集。
//
// 当前实现:把错误打到 stderr,生产环境也安全(不会进 LLM 上下文)。
// 后续可接入 Pi 的 logging 体系或 telemetry。

export function logError(err: unknown, context?: string): void {
  const prefix = context ? `[tasks:${context}]` : "[tasks]";
  if (err instanceof Error) {
    // eslint-disable-next-line no-console
    console.error(`${prefix} ${err.message}`, err.stack ?? "");
  } else {
    // eslint-disable-next-line no-console
    console.error(`${prefix} ${String(err)}`);
  }
}
