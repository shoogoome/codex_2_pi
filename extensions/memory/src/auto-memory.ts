import fs from "node:fs";
import path from "node:path";
import { completeSimple, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { buildIndex } from "./index-md.js";
import { parseTopicFrontmatter } from "./frontmatter.js";
import { memoryIndexPath, topicFileName } from "./paths.js";
import type { IndexEntry, MemoryType } from "./types.js";

const MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_EXISTING_CHARS = 16_000;
const MAX_FACT_CHARS = 1_000;

export interface AutoMemoryFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  unlinkSync(path: string): void;
}

export interface MemoryCandidate {
  name: string;
  description: string;
  type: MemoryType;
  facts: string[];
  replaces?: string[];
}

export interface MemoryExtraction {
  memories: MemoryCandidate[];
  delete: string[];
}

export interface AutoMemoryRunInput {
  cwd: string;
  memoryDir: string;
  event: TurnEndEvent;
  messages: readonly unknown[];
  ctx: ExtensionContext;
  fs: AutoMemoryFs;
  model?: Model<any>;
  signal?: AbortSignal;
}

export type AutoMemoryRunner = (input: AutoMemoryRunInput) => Promise<void>;

export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: unknown; content?: unknown };
  const role = typeof value.role === "string" ? value.role : "message";
  if (role !== "user" && role !== "assistant") return "";

  if (typeof value.content === "string") {
    return `${role}: ${value.content}`;
  }
  if (!Array.isArray(value.content)) return "";
  const text = value.content
    .filter((part): part is { type: "text"; text: string } => (
      Boolean(part)
      && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n");
  return text ? `${role}: ${text}` : "";
}

export function buildTurnTranscript(messages: readonly unknown[]): string {
  const conversational = messages
    .map(extractMessageText)
    .filter(Boolean);
  // turn_end fires once per completed user/assistant exchange. Feeding only the
  // trailing exchange avoids repeatedly re-extracting the full session.
  let lastUser = -1;
  for (let index = conversational.length - 1; index >= 0; index -= 1) {
    if (conversational[index].startsWith("user:")) {
      lastUser = index;
      break;
    }
  }
  const latestTurn = lastUser >= 0 ? conversational.slice(lastUser) : conversational.slice(-1);
  return latestTurn.join("\n\n").trim().slice(-MAX_TRANSCRIPT_CHARS);
}

export function hasMemorySignal(transcript: string): boolean {
  if (!transcript.trim()) return false;
  const lower = transcript.toLowerCase();
  const patterns = [
    /\b(?:remember|always|never|prefer|preference|from now on|don['’]?t|must|should|actually|correction|important)\b/i,
    /(?:记住|以后|今后|总是|永远|不要|别再|必须|应该|偏好|习惯|其实|纠正|注意|重要|长期|默认|请用|叫我)/,
    /(?:项目|仓库|代码库|架构|约定|规范|入口|目录|部署|测试命令|构建命令)/,
  ];
  return patterns.some((pattern) => pattern.test(lower));
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((item) => item.slice(0, MAX_FACT_CHARS));
}

export function parseMemoryExtraction(text: string): MemoryExtraction {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(text));
  } catch {
    return { memories: [], delete: [] };
  }
  if (!raw || typeof raw !== "object") return { memories: [], delete: [] };
  const object = raw as { memories?: unknown; delete?: unknown };
  const memories: MemoryCandidate[] = [];
  if (Array.isArray(object.memories)) {
    for (const item of object.memories) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Record<string, unknown>;
      const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 120) : "";
      const description = typeof candidate.description === "string"
        ? candidate.description.trim().slice(0, 240)
        : "";
      const type = candidate.type;
      const facts = normalizeStringArray(candidate.facts);
      if (!name || !description || typeof type !== "string" || !MEMORY_TYPES.has(type as MemoryType) || facts.length === 0) {
        continue;
      }
      memories.push({
        name,
        description,
        type: type as MemoryType,
        facts,
        replaces: normalizeStringArray(candidate.replaces),
      });
    }
  }
  return {
    memories,
    delete: normalizeStringArray(object.delete),
  };
}

function sanitizeFact(fact: string): string | null {
  const normalized = fact.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*\S+/i,
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  return secretPatterns.some((pattern) => pattern.test(normalized)) ? null : normalized;
}

function existingMemoryContext(memoryDir: string, fs: AutoMemoryFs): string {
  if (!fs.existsSync(memoryDir)) return "(none)";
  const chunks: string[] = [];
  for (const file of fs.readdirSync(memoryDir).filter((name) => name.endsWith(".md") && name !== "MEMORY.md").sort()) {
    const fullPath = path.join(memoryDir, file);
    try {
      chunks.push(`## ${file}\n${fs.readFileSync(fullPath, "utf8")}`);
    } catch {
      // A concurrently removed topic is harmless.
    }
  }
  return chunks.join("\n\n").slice(0, MAX_EXISTING_CHARS) || "(none)";
}

function buildPrompt(transcript: string, existing: string): string {
  return `Analyze the latest conversation turn and maintain durable project memory.

Only extract facts that are useful in FUTURE conversations:
- stable user preferences or identity (user)
- explicit corrections and lessons that should prevent repeated mistakes (feedback)
- durable facts about this repository, architecture, commands, or conventions (project)
- durable external knowledge repeatedly useful to this project (reference)

Do NOT save:
- temporary task progress, plans, current status, one-off requests, guesses, assistant claims not confirmed by the user, secrets/credentials, or facts already present unchanged
- generic facts that can be rediscovered cheaply from the repository

Prefer updating an existing topic instead of creating a near-duplicate. Facts must be concise, standalone, and attributable to the conversation. If a new statement supersedes an old fact, include the exact old fact in "replaces". Only include "delete" for entire topic filenames that are explicitly invalidated and have no remaining useful facts.

Return STRICT JSON only, no markdown:
{"memories":[{"name":"short title","description":"one-line recall description","type":"user|feedback|project|reference","facts":["durable fact"],"replaces":["exact old fact"]}],"delete":["obsolete-topic.md"]}
Return {"memories":[],"delete":[]} when nothing qualifies.

Existing memory topics:
${existing}

Latest turn:
${transcript}`;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parseFacts(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function sameFact(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function renderTopic(candidate: MemoryCandidate, facts: string[]): string {
  const yaml = (value: string) => JSON.stringify(value);
  return `---\nname: ${yaml(candidate.name)}\ndescription: ${yaml(candidate.description)}\ntype: ${candidate.type}\n---\n${facts.map((fact) => `- ${fact}`).join("\n")}\n`;
}

function safeDeletePath(memoryDir: string, requested: string): string | null {
  if (requested === "MEMORY.md" || path.basename(requested) !== requested || !requested.endsWith(".md")) return null;
  const fullPath = path.resolve(memoryDir, requested);
  return path.dirname(fullPath) === path.resolve(memoryDir) ? fullPath : null;
}

export function applyMemoryExtraction(
  memoryDir: string,
  extraction: MemoryExtraction,
  fs: AutoMemoryFs,
): { changed: boolean; topics: string[] } {
  let changed = false;
  const touched = new Set<string>();

  for (const requested of extraction.delete) {
    const fullPath = safeDeletePath(memoryDir, requested);
    if (!fullPath || !fs.existsSync(fullPath)) continue;
    fs.unlinkSync(fullPath);
    changed = true;
  }

  for (const candidate of extraction.memories) {
    const filename = topicFileName(candidate.name);
    const fullPath = path.join(memoryDir, filename);
    let existingFacts: string[] = [];
    if (fs.existsSync(fullPath)) {
      try {
        existingFacts = parseFacts(parseTopicFrontmatter(fs.readFileSync(fullPath, "utf8")).body);
      } catch {
        existingFacts = parseFacts(fs.readFileSync(fullPath, "utf8"));
      }
    }

    const replacements = (candidate.replaces ?? []).map((fact) => fact.trim()).filter(Boolean);
    const retained = existingFacts.filter((fact) => !replacements.some((oldFact) => sameFact(fact, oldFact)));
    const safeFacts = candidate.facts.map(sanitizeFact).filter((fact): fact is string => Boolean(fact));
    const merged = [...retained];
    for (const fact of safeFacts) {
      if (!merged.some((existingFact) => sameFact(existingFact, fact))) merged.push(fact);
    }
    if (merged.length === 0) continue;

    const next = renderTopic(candidate, merged);
    const previous = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
    if (next !== previous) {
      fs.writeFileSync(fullPath, next, "utf8");
      changed = true;
      touched.add(filename);
    }
  }

  if (changed) {
    const entries: IndexEntry[] = [];
    for (const file of fs.readdirSync(memoryDir).filter((name) => name.endsWith(".md") && name !== "MEMORY.md").sort()) {
      try {
        const topic = parseTopicFrontmatter(fs.readFileSync(path.join(memoryDir, file), "utf8"));
        if (!topic.meta.name) continue;
        entries.push({
          name: topic.meta.name,
          description: topic.meta.description,
          type: topic.meta.type,
          path: file,
        });
      } catch {
        // Invalid files are intentionally left alone and omitted from the generated index.
      }
    }
    fs.writeFileSync(memoryIndexPath(memoryDir), buildIndex(entries), "utf8");
  }

  return { changed, topics: [...touched] };
}

export const runAutoMemory: AutoMemoryRunner = async (input) => {
  const transcript = buildTurnTranscript(input.messages);
  if (!hasMemorySignal(transcript)) return;
  const model = input.model ?? input.ctx.model;
  if (!model) return;

  const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return;
  const existing = existingMemoryContext(input.memoryDir, input.fs);
  const response = await completeSimple(
    model,
    {
      systemPrompt: "You are a conservative long-term memory curator. Persist only confirmed, durable, future-useful facts.",
      messages: [{ role: "user", content: buildPrompt(transcript, existing), timestamp: Date.now() }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: input.signal,
      maxTokens: 1_200,
      temperature: 0,
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") return;
  const extraction = parseMemoryExtraction(assistantText(response));
  applyMemoryExtraction(input.memoryDir, extraction, input.fs);
};

export const nodeAutoMemoryFs: AutoMemoryFs = {
  existsSync: fs.existsSync,
  readFileSync: (filePath) => fs.readFileSync(filePath, "utf8"),
  readdirSync: fs.readdirSync,
  writeFileSync: (filePath, data) => fs.writeFileSync(filePath, data, "utf8"),
  unlinkSync: fs.unlinkSync,
};
