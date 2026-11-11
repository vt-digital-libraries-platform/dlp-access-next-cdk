import { execFileSync } from "child_process";
import { REPO_ROOT } from "./paths";

/** The commit a Web stack deploys: HEAD of the repo. */
export function sourceCommit(): string {
  return git("rev-parse", "--verify", "HEAD").trim();
}

/** `git status --porcelain` lines for the changes a deploy leaves out. */
export function uncommittedChanges(): string[] {
  return git("status", "--porcelain").split("\n").filter(Boolean);
}

/** Writes `commit`'s files matching `pathspecs` to `output` as a tar archive. */
export function archiveCommit(
  commit: string,
  output: string,
  pathspecs: string[],
): void {
  git(
    "archive",
    "--format=tar",
    `--output=${output}`,
    commit,
    "--",
    ...pathspecs,
  );
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}
