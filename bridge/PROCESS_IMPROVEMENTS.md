# Coding Bridge — Process Improvement Notes

Observations from monitoring live task runs. Goal: reduce wasted Anthropic tokens,
eliminate silent failures, and make the bridge reliable without manual intervention.

---

## Issues Observed

### 1. ECONNRESET on Firestore claim write (most common failure)
**What happens:** The bridge picks up a `pending` task and tries to mark it `running`.
The Firestore REST call hits an SSL/TLS error (`ECONNRESET`, `socket hang up`).
The write fails, the task stays `pending`, and the next launchd interval picks it up again.
This loops indefinitely, burning CPU and log space — but no tokens, since Claude Code
never actually runs.

**Root cause:** This machine has persistent TLS certificate issues on outbound HTTPS.
`preferRest: true` helps but doesn't eliminate the problem. The SDK marks ECONNRESET
as non-transient so its built-in retry won't help.

**Fix already applied:** Bail on ECONNRESET during claim write; retry next poll (30s).

**Remaining gap:** If the ECONNRESET happens on the *completion* write (after Claude
Code finishes), the task status isn't saved. A retry loop with 3 attempts + 2s delay
was added, but if all 3 fail, the task stays `running` forever in Firestore and
Maisie's poll loop waits until the 12-minute timeout.

**Improvement needed:**
- Add a `stalledAfterMs` timeout in the poll query: if `status == "running"` and
  `startedAt` is > 12 minutes ago, treat it as failed on the next bridge poll.
- Or: write status to a local file as a backup so the bridge can recover on restart.

---

### 2. Claude Code doesn't open the PR (`gh pr create` fails silently)
**What happens:** The branch is created and pushed successfully, but `gh pr create`
fails with `Resource not accessible by personal access token`. Claude Code exits 0,
the bridge sees "completed", but `pr_url` is null.

**Root cause:** The `gh` CLI token stored in the macOS keychain lacks the
`write:org` scope (org repo requires it for PR creation).

**Fix needed:**
- Run `gh auth refresh --hostname github.com --scopes repo,write:org` interactively
  once to add the scope. This is a one-time fix.
- The bridge should detect a null `pr_url` on `status: completed` and log a warning
  so it's visible without checking Firestore.

---

### 3. Claude Code timeout on investigation/open-ended tasks (10 min still not enough)
**What happens:** Tasks like "Investigate why X is broken" cause Claude Code to spend
most of its time reading files before making any changes. It hits the 10-minute
`execSync` timeout with no output, writing `ETIMEDOUT` to Firestore.

**Root cause:** The task prompt allows unlimited exploration. Claude Code reads
broadly rather than acting quickly.

**Improvement needed — task prompt quality:**
- Maisie should submit *actionable* tasks, not investigative ones. If she's unsure
  where the bug is, she should investigate herself (using her own tools) and only
  submit a coding task once she knows *what file and what change* is needed.
- The system prompt should instruct Maisie: "Before using `code_with_github`, identify
  the specific file(s) and the change needed. Describe the task as: 'In file X, change
  Y to Z because [reason].' Do not submit open-ended investigations."
- Add a note in the `code_with_github` tool description: tasks should be specific
  enough that a developer could complete them in under 5 minutes without exploratory
  reading.

**Improvement needed — bridge side:**
- Pass `--max-turns 20` to Claude Code to cap the number of tool calls and force it
  to commit/push/PR without unlimited exploration time.

---

### 4. PR URL not captured even when `gh pr create` succeeds
**What happens:** On the first successful run, Claude Code committed directly to main
instead of creating a branch, so there was no PR URL.

**Root cause:** The original task prompt said "commit and push" without explicitly
naming a branch first. Claude Code defaulted to the current branch (main).

**Fix already applied:** Task prompt now names a timestamped branch explicitly
(`maisie/<timestamp>`) and instructs Claude Code to `git checkout -b` that branch
before making any changes.

**Remaining gap:** Even when `gh pr create` is called, the PR URL appears somewhere
in Claude Code's output, but the regex `https://github.com/[^\s)]+/pull/\d+` may
miss it if it's embedded in formatted output. The `--output-format json` flag returns
a `result` field with the final text — but Claude Code's last line may not be the
PR URL if it adds trailing commentary.

**Improvement needed:**
- Tell Claude Code to output ONLY the PR URL as the very last line, nothing else after it.
  Current wording: "Output the PR URL on the very last line of your response." Claude
  sometimes adds "The PR is now open for review." after the URL.
- Change to: "The absolute last line of your output must be the PR URL with no text
  after it — not even punctuation."

---

### 5. `gh` token scope must be fixed before bridge is reliable end-to-end
**Immediate action item:** Run this once in a terminal:
```
gh auth refresh --hostname github.com --scopes repo,write:org
```
Until this is done, every coding task will produce a branch but no PR, and Maisie
will report back with no PR URL to review.

---

## Summary of One-Time Actions Needed

| Action | Who | How |
|--------|-----|-----|
| Fix `gh` token scope | Jack | `gh auth refresh --hostname github.com --scopes repo,write:org` |
| Update Maisie system prompt to require specific tasks | Code change | See §3 above |
| Add `--max-turns 20` to Claude Code invocation | Code change | `bridge/coding-bridge.ts` |
| Tighten PR URL output instruction | Code change | `bridge/coding-bridge.ts` task prompt |
| Add stale `running` task recovery | Code change | `bridge/coding-bridge.ts` poll query |
