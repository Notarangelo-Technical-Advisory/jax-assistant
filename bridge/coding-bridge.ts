/**
 * Coding Bridge: Watches Firestore for pendingCodingTasks and runs Claude Code locally.
 *
 * Usage:
 *   cd bridge && npx tsx coding-bridge.ts
 *
 * Requires a Firebase service account key at bridge/service-account.json
 * Run via launchd (com.notarangelo.coding-bridge.plist) for automatic execution every 30s.
 */

// SSL bypass for this machine's certificate issues (same as calendar bridge)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

import { execSync } from "child_process";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Firebase init ───────────────────────────────────────────────
const serviceAccountPath = join(__dirname, "service-account.json");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
db.settings({ preferRest: true });

// ─── Configuration ───────────────────────────────────────────────
const REPO_DIR = "/Users/jacknotarangelo/Documents/GitHub/jax-assistant";
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// ─── Helpers ─────────────────────────────────────────────────────
async function writeWithRetry(
  ref: FirebaseFirestore.DocumentReference,
  data: Record<string, unknown>,
  retries = 3,
  delayMs = 2000
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await ref.update(data);
      return;
    } catch (err) {
      if (i < retries - 1) {
        console.warn(`[coding-bridge] Firestore write failed (attempt ${i + 1}/${retries}), retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────
async function run() {
  // Pick up the oldest pending task (process one at a time)
  const snap = await db
    .collection("pendingCodingTasks")
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .limit(1)
    .get();

  if (snap.empty) {
    console.log("[coding-bridge] No pending tasks.");
    return;
  }

  const doc = snap.docs[0];
  const data = doc.data();
  const task: string = data["task"] ?? "";

  console.log(`[coding-bridge] Picked up task ${doc.id}: ${task.substring(0, 80)}...`);

  // Mark as running immediately to prevent double-pickup on next poll.
  // If this write fails, bail out — we can't safely claim the task.
  try {
    await doc.ref.update({ status: "running", startedAt: FieldValue.serverTimestamp() });
  } catch (claimErr) {
    console.error(`[coding-bridge] Failed to claim task ${doc.id} (will retry next poll):`, claimErr);
    return;
  }

  // Generate a short branch name slug from the task
  const branchSlug = `maisie/${Date.now()}`;

  const taskPrompt = `${task}

IMPORTANT WORKFLOW — follow these steps exactly, in order:
1. Create a new git branch: git checkout -b ${branchSlug}
2. Make all code changes on that branch only. Do NOT commit to main.
3. Commit with a descriptive message.
4. Push the branch: git push origin ${branchSlug}
5. Open a pull request targeting main: gh pr create --base main --fill
6. Output the PR URL on the very last line of your response.`;

  try {
    const output = execSync(
      `npx @anthropic-ai/claude-code -p ${JSON.stringify(taskPrompt)} --dangerously-skip-permissions --output-format json`,
      {
        cwd: REPO_DIR,
        timeout: CLAUDE_TIMEOUT_MS,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
    ).toString();

    // Parse the JSON output from Claude Code
    let claudeText = "";
    try {
      const parsed = JSON.parse(output);
      claudeText = parsed?.result ?? parsed?.content ?? output;
    } catch {
      claudeText = output;
    }

    // Extract PR URL from output
    const prMatch = claudeText.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    const prUrl = prMatch?.[0];
    const prNumberMatch = prUrl?.match(/\/pull\/(\d+)$/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]) : undefined;

    console.log(`[coding-bridge] Task ${doc.id} completed. PR: ${prUrl ?? "not found in output"}`);

    try {
      await writeWithRetry(doc.ref, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        result: {
          success: true,
          pr_url: prUrl ?? null,
          pr_number: prNumber ?? null,
          summary: claudeText.substring(0, 500),
        },
        error: null,
      });
    } catch (writeErr) {
      console.error(`[coding-bridge] Failed to write completed status for task ${doc.id}:`, writeErr);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // execSync throws and puts stderr in error.stderr (Buffer)
    const rawStderr = (err as NodeJS.ErrnoException & { stderr?: Buffer })?.stderr?.toString?.() ?? "";
    // Filter out the noisy TLS warning — it's not the real error
    const stderr = rawStderr
      .split("\n")
      .filter((line) => !line.includes("NODE_TLS_REJECT_UNAUTHORIZED") && !line.includes("(Use `node --trace-warnings"))
      .join("\n")
      .trim();
    const fullError = stderr || errorMsg;

    console.error(`[coding-bridge] Task ${doc.id} failed:`, fullError.substring(0, 300));

    try {
      await writeWithRetry(doc.ref, {
        status: "failed",
        completedAt: FieldValue.serverTimestamp(),
        result: {
          success: false,
          error: fullError.substring(0, 500),
          summary: "Coding agent encountered an error.",
        },
        error: fullError.substring(0, 500),
      });
    } catch (writeErr) {
      console.error(`[coding-bridge] Failed to write error status for task ${doc.id}:`, writeErr);
    }
  }
}

run().catch((err) => {
  console.error("[coding-bridge] Fatal error:", err);
  // Don't exit with code 1 — launchd will just restart the process
  // and we may be in a state where the task is stuck as "running"
  process.exit(0);
});
