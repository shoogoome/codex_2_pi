export function buildInitPrompt(): string {
  return `Inspect this project and create an AGENTS.md file in the current directory.

The file should help future coding agents work effectively in this repository. Include concise project-specific guidance such as:

- how the repository is organized;
- commands for installing dependencies, running tests, typechecking, and linting;
- coding conventions visible in the project;
- important safety notes or files to avoid changing;
- any workflow tips that are useful for future agent runs.

Keep the file focused and factual. Do not overwrite an existing AGENTS.md file.`;
}
