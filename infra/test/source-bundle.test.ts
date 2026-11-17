import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const repo = path.resolve(__dirname, "../..");

/**
 * The paths `git archive` ships for the working tree as it would be
 * committed, plus `extraPaths` as empty committed files, using the
 * `.gitattributes` of that tree. A temporary index keeps the staging area
 * untouched; the blobs it writes are left in the object store for gc.
 */
function archivedPaths(extraPaths: string[] = []): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlpnext-bundle-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
    git("read-tree", "HEAD");
    git("add", "--all");
    const emptyBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "",
      encoding: "utf8",
    }).trim();
    for (const extra of extraPaths) {
      git(
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${emptyBlob},${extra}`,
      );
    }
    const tree = git("write-tree").trim();
    const archive = path.join(dir, "bundle.tar");
    git("archive", "--format=tar", "-o", archive, tree);
    return execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
      .split("\n")
      .filter((entry) => entry && !entry.endsWith("/"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("source bundle", () => {
  test("the EB CLI uses git archive: there is no .ebignore", () => {
    expect(fs.existsSync(path.join(repo, ".ebignore"))).toBe(false);
  });

  const excluded = [
    ".github/workflows/deploy.yaml",
    ".claude/settings.json",
    ".scratch/notes.txt",
    ".elasticbeanstalk/config.yml",
    "infra/lib/app.ts",
    "docs/infra/eb-frontend-spec.md",
    "README.md",
    "src/app/nested/NOTES.md",
    ".env",
    ".env.production",
    "src/.env.local",
  ];
  const kept = [
    "package.json",
    "package-lock.json",
    "next.config.ts",
    "src/app/page.tsx",
    "public/robots.txt",
    ".platform/hooks/prebuild/01_build.sh",
    ".ebextensions/options.config",
    // Only the root directories are excluded, not same-named ones inside the app.
    "src/app/docs/page.tsx",
    "src/lib/infra/client.ts",
  ];
  const files = archivedPaths([...excluded, ...kept]);

  test.each(excluded)("leaves out %s", (file) => {
    expect(files).not.toContain(file);
  });

  test.each(kept)("ships %s", (file) => {
    expect(files).toContain(file);
  });

  test("ships the committed app and platform hooks", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "src/app/layout.tsx",
        ".platform/hooks/prebuild/01_build.sh",
        ".platform/nginx/conf.d/elasticbeanstalk/https-redirect.conf",
      ]),
    );
    expect(files.some((file) => file.startsWith(".ebextensions/"))).toBe(true);
  });
});
