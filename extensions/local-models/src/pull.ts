/**
 * Pure parsing of Ollama's `POST /api/pull` NDJSON progress stream.
 *
 * Each line is a JSON object like:
 *   { "status": "pulling manifest" }
 *   { "status": "downloading ...", "total": 4600000, "completed": 1200000 }
 *   { "status": "success" }
 * Progress% = completed/total*100 when both present. Terminal line is
 * status === "success".
 */

export interface PullProgress {
	status: string;
	completed?: number;
	total?: number;
	/** 0-100 integer when total/completed present, else undefined. */
	percent?: number;
}

/** Parse a single NDJSON line; returns null for blank/invalid JSON lines. */
export function parsePullLine(line: string): PullProgress | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof obj !== "object" || obj === null) return null;
	const rec = obj as Record<string, unknown>;
	const status = typeof rec.status === "string" ? rec.status : typeof rec.error === "string" ? `error: ${rec.error}` : "";
	if (!status) return null;
	const total = typeof rec.total === "number" ? rec.total : undefined;
	const completed = typeof rec.completed === "number" ? rec.completed : undefined;
	let percent: number | undefined;
	if (typeof total === "number" && total > 0 && typeof completed === "number") {
		percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
	}
	return { status, completed, total, percent };
}

/**
 * Reassemble NDJSON lines across streaming chunk boundaries.
 *
 * Pass the previous `carry` back in on each call. Returns any complete lines
 * plus the new trailing partial line to carry forward.
 */
export function splitNdjson(chunk: string, carry = ""): { lines: string[]; carry: string } {
	const combined = carry + chunk;
	const parts = combined.split("\n");
	const nextCarry = parts.pop() ?? "";
	return { lines: parts, carry: nextCarry };
}

/** Human-readable status line for ctx.ui.setStatus. */
export function formatProgress(model: string, p: PullProgress): string {
	const pct = typeof p.percent === "number" ? ` ${p.percent}%` : "";
	return `pull ${model}: ${p.status}${pct}`;
}

/** Whether this progress line marks a completed pull. */
export function isPullDone(p: PullProgress): boolean {
	return p.status === "success";
}
