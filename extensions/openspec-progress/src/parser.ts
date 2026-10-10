export interface OpenSpecTask {
  index: number;
  text: string;
  completed: boolean;
  inProgress: boolean;
  section?: string;
  marker?: string;
}

export interface OpenSpecTaskSnapshot {
  tasks: OpenSpecTask[];
  completed: number;
  current?: OpenSpecTask;
}

const TASK_RE = /^\s*-\s*\[([ xX~>-])\]\s+(?:\*\*)?((?:\d+(?:\.\d+)+)\s+)?(.+?)\s*\**\s*$/;
const SECTION_RE = /^\s*#{1,6}\s+(.+?)\s*$/;

export function parseTasksMarkdown(source: string): OpenSpecTaskSnapshot {
  const tasks: OpenSpecTask[] = [];
  let section: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(SECTION_RE);
    if (heading) {
      section = heading[1];
      continue;
    }
    const match = line.match(TASK_RE);
    if (!match) continue;
    const marker = match[1];
    const numbered = match[2]?.trim();
    const text = `${numbered ? `${numbered} ` : ""}${match[3]}`.trim();
    if (!text) continue;
    tasks.push({
      index: tasks.length,
      text,
      completed: marker.toLowerCase() === "x",
      inProgress: marker === ">" || marker === "~" || marker === "-",
      ...(section ? { section } : {}),
      marker,
    });
  }
  const completed = tasks.filter((task) => task.completed).length;
  const current = tasks.find((task) => task.inProgress && !task.completed)
    ?? tasks.find((task) => !task.completed);
  return { tasks, completed, current };
}

export function progressFraction(snapshot: OpenSpecTaskSnapshot): number {
  return snapshot.tasks.length === 0 ? 0 : snapshot.completed / snapshot.tasks.length;
}

export function renderProgressBar(snapshot: OpenSpecTaskSnapshot, width = 12): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const filled = Math.round(progressFraction(snapshot) * safeWidth);
  return `${"█".repeat(filled)}${"░".repeat(safeWidth - filled)}`;
}
