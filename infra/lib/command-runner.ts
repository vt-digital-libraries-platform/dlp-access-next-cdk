import { spawnSync } from "child_process";
import { REPO_ROOT } from "./paths";

/** The command-line tools the deploy tooling drives. */
export type Executable = "aws" | "eb" | "git";

/** One command as the caller issued it, before the runner adds region, profile or output flags. */
export interface Command {
  readonly executable: Executable;
  readonly args: readonly string[];
}

/**
 * Runs a command and returns its stdout. Tests replace it with a fake, so
 * everything outside the process goes through it.
 *
 * Throws `CommandError` when the command exits non-zero; throws the spawn
 * error itself when the executable can't be started at all.
 */
export type CommandRunner = (
  executable: Executable,
  args: readonly string[],
) => string;

/** A command that ran and exited non-zero. The message is its stderr. */
export class CommandError extends Error {
  constructor(
    readonly executable: Executable,
    readonly status: number | null,
    stderr: string,
  ) {
    super(stderr || `${executable} exited with ${status}`);
  }
}

/** Runs an `aws` command and parses its JSON output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the CLI
export function awsJson(run: CommandRunner, args: readonly string[]): any {
  return JSON.parse(run("aws", args));
}

export interface RunnerOptions {
  /** Passed to every `aws` and `eb` command. */
  readonly region: string;
  /** Passed to every `aws` and `eb` command, when set. */
  readonly profile?: string;
}

/**
 * The real runner. `aws` and `eb` get the region and profile, and `aws`
 * prints JSON; `git` runs at the root of the repo, and the others in the
 * current directory.
 */
export function spawnRunner({ region, profile }: RunnerOptions): CommandRunner {
  const regionAndProfile = [
    "--region",
    region,
    ...(profile ? ["--profile", profile] : []),
  ];
  const extraArgs: Record<Executable, string[]> = {
    aws: [...regionAndProfile, "--output", "json"],
    eb: regionAndProfile,
    git: [],
  };
  return (executable, args) => {
    const result = spawnSync(executable, [...args, ...extraArgs[executable]], {
      cwd: executable === "git" ? REPO_ROOT : undefined,
      encoding: "utf8",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new CommandError(executable, result.status, result.stderr);
    }
    return result.stdout;
  };
}
