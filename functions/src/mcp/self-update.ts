/**
 * Keeps the copy of jax-assistant on Jack's Mac up to date, so the journal job
 * (and the other launchd jobs that run from the same copy) pick up fixes
 * without Jack having to run git pull by hand. collect-journal.ts calls this
 * at the end of each run; the next run, 15 minutes later, uses the new code.
 *
 * It only ever fast-forwards main. It does nothing when the copy is on another
 * branch, has uncommitted changes, or cannot fast-forward, because then Jack
 * is working in it, and the job must never disturb that. When the update
 * changes functions/package-lock.json, it also runs npm install, so a new
 * package is there before the code that needs it runs. A failure is reported
 * and never stops the journal.
 */

import {execFileSync} from "child_process";
import {join} from "path";

export interface UpdateResult {
  updated: boolean;
  /** One line for the job's log. */
  note: string;
}

const run = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, {cwd, encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"]}).trim();

/** Fast-forward `repo` to origin/main, and run npm install in functions/ when its lock file changed. */
export function selfUpdate(repo: string, npmInstall = (dir: string) => void run("npm", ["install", "--no-audit", "--no-fund"], dir)): UpdateResult {
  const git = (...args: string[]) => run("git", args, repo);
  try {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") return {updated: false, note: `on branch ${branch}, not main; left as it is`};
    if (git("status", "--porcelain", "--untracked-files=no")) {
      return {updated: false, note: "has changes not yet committed; left as it is"};
    }
    const before = git("rev-parse", "HEAD");
    git("fetch", "--quiet", "origin", "main");
    const after = git("rev-parse", "origin/main");
    if (after === before) return {updated: false, note: "already up to date"};
    try {
      git("merge", "--ff-only", "--quiet", "origin/main");
    } catch {
      return {updated: false, note: "main has commits that are not on GitHub, so it cannot fast-forward; left as it is"};
    }
    const changed = git("diff", "--name-only", before, after).split("\n").filter(Boolean);
    if (changed.includes("functions/package-lock.json")) npmInstall(join(repo, "functions"));
    return {updated: true, note: `updated ${before.slice(0, 7)} to ${after.slice(0, 7)} (${changed.length} files)`};
  } catch (err) {
    const why = (err as {stderr?: string; message?: string}).stderr || (err as Error).message || String(err);
    return {updated: false, note: `could not update: ${why.trim().split("\n")[0].slice(0, 200)}`};
  }
}
