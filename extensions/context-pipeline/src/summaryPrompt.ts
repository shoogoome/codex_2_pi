// extensions/context-pipeline/src/summaryPrompt.ts
//
// ⑤ Structured 9-section compaction summary instructions + analysis stripping.
//
// generateSummary appends these as an "Additional focus" section on top of pi's
// built-in summarization prompt (it cannot fully replace the base prompt), so
// the 9-section structure is additive. The model is asked to draft inside
// <analysis> first, then emit the formal <summary>; stripAnalysis() removes the
// scratch <analysis> before the summary is stored.

export const NINE_SECTION_INSTRUCTIONS = `Produce a comprehensive, structured handoff summary.

First, think inside an <analysis> block: review the conversation chronologically
and draft what belongs in each section below. This scratch work MUST be wrapped
in <analysis>...</analysis> and will be discarded.

Then emit the final summary wrapped in <summary>...</summary> using EXACTLY these
nine numbered sections, in order:

1. Primary Request and Intent: capture all of the user's explicit requests and
   goals in detail.
2. Key Concepts: list the important technical concepts, frameworks, and
   conventions that came up.
3. Files and Code: enumerate the specific files examined, created, or modified,
   including the most important code snippets and why they matter.
4. Errors and Fixes: record every error encountered and how it was resolved,
   including user feedback on fixes.
5. Problem Solving: describe problems solved and any ongoing troubleshooting.
6. All User Messages: list every non-tool user message verbatim or closely
   paraphrased, preserving intent and order.
7. Pending Tasks: list tasks explicitly requested that are not yet complete.
8. Current Work: describe precisely what was being worked on immediately before
   this summary.
9. Next Step: state the single most logical next step, tied directly to the
   current work and the user's latest request.

Be exhaustive on technical detail; do not invent facts. Wrap the final answer in
<summary>...</summary>.`;

/**
 * Remove the model's <analysis> scratch block and unwrap the formal <summary>.
 *
 * - If a <summary>...</summary> block is present, its inner text is returned.
 * - Otherwise closed <analysis>...</analysis> blocks are removed; a trailing
 *   unclosed <analysis> (to end of text) is tolerated and dropped.
 * - Matching is case-insensitive and spans newlines (dotall-equivalent).
 */
export function stripAnalysis(text: string): string {
  if (text == null) return "";
  let t = String(text);

  const summaryMatch = t.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    return summaryMatch[1].trim();
  }

  // Remove closed analysis blocks.
  t = t.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "");
  // Tolerate an unclosed trailing analysis block.
  t = t.replace(/<analysis>[\s\S]*$/i, "");

  return t.trim();
}
