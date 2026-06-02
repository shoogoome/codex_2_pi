// Truncate disk output to <= MAX_OUTPUT_BYTES bytes for inline tool result.
//
// 等同于 Pi 内置 bash tool 的 truncation 行为:`getTaskOutput(taskId, maxBytes)`
// 内部已实现"超出时前缀 [N KB of earlier output omitted] + 尾部"。本期 30000
// bytes 上限对齐 spec §2.4。

import { getTaskOutput } from "../tasks/diskOutput.js";

export const MAX_OUTPUT_BYTES = 30_000;

export async function readTruncatedOutput(taskId: string, max = MAX_OUTPUT_BYTES): Promise<string> {
  return await getTaskOutput(taskId, max);
}
