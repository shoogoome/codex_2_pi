export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandOutput>;
}

export interface GitCommandFailure {
  command: string[];
  code: number;
  stderr: string;
}
