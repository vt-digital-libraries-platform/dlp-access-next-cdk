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

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}
