import * as admin from "firebase-admin";

/**
 * Maisie's memory: standing instructions Jack gives her once and expects her
 * to follow in every later conversation, such as how to write invoice
 * descriptions from the work journal.
 *
 * Collection `memories`, one document per topic. The document ID is the topic
 * in lower case with anything but letters and digits turned into dashes, so
 * saving "Invoice descriptions" again replaces the earlier instruction instead
 * of adding a second one that could contradict it.
 *
 * Every memory is loaded into the state block of each chat request (see
 * context.ts), so Maisie applies them without having to look them up. That is
 * why the size limits below exist: they bound what each request carries.
 */

export interface Memory {
  topic: string;
  instruction: string;
}

export const MAX_TOPIC_LENGTH = 80;
export const MAX_INSTRUCTION_LENGTH = 4000;
export const MAX_MEMORIES = 50;

/** The document ID for a topic; empty when the topic has no letters or digits. */
export function memoryId(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** All memories, oldest topic first so the state block stays in a stable order. */
export async function loadMemories(db: admin.firestore.Firestore): Promise<Memory[]> {
  const snap = await db.collection("memories").orderBy("createdAt", "asc").get();
  return snap.docs.map((d) => ({
    topic: d.get("topic") as string,
    instruction: d.get("instruction") as string,
  }));
}

/** Create the instruction for a topic, or replace it when the topic exists. */
export async function saveMemory(
  db: admin.firestore.Firestore,
  input: {topic?: string; instruction?: string}
): Promise<Record<string, unknown>> {
  const topic = (input.topic ?? "").trim();
  const instruction = (input.instruction ?? "").trim();
  const id = memoryId(topic);

  if (!id) {
    return {success: false, error: "Give the memory a topic, such as 'Invoice descriptions'."};
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    return {success: false, error: `The topic is ${topic.length} characters; keep it under ${MAX_TOPIC_LENGTH}.`};
  }
  if (!instruction) {
    return {success: false, error: "The instruction is empty. To remove a memory, use forget_memory."};
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    return {
      success: false,
      error: `The instruction is ${instruction.length} characters; the limit is ${MAX_INSTRUCTION_LENGTH}. Shorten it, or split it into two topics.`,
    };
  }

  const ref = db.collection("memories").doc(id);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const existing = await ref.get();
  if (existing.exists) {
    await ref.update({topic, instruction, updatedAt: now});
    return {
      success: true,
      replaced: true,
      topic,
      previousInstruction: existing.get("instruction") as string,
    };
  }

  const count = (await db.collection("memories").count().get()).data().count;
  if (count >= MAX_MEMORIES) {
    return {
      success: false,
      error: `Maisie already holds ${count} memories, the most she keeps. Forget one, or add this to an existing topic.`,
    };
  }
  await ref.set({topic, instruction, createdAt: now, updatedAt: now});
  return {success: true, replaced: false, topic};
}

/** Remove the memory for a topic. */
export async function forgetMemory(
  db: admin.firestore.Firestore,
  input: {topic?: string}
): Promise<Record<string, unknown>> {
  const id = memoryId(input.topic ?? "");
  const ref = db.collection("memories").doc(id || "-");
  const existing = id ? await ref.get() : null;
  if (!existing?.exists) {
    const topics = (await loadMemories(db)).map((m) => m.topic);
    return {
      success: false,
      error: `No memory has the topic "${input.topic ?? ""}". Saved topics: ${topics.length ? topics.join(", ") : "none"}.`,
    };
  }
  await ref.delete();
  return {success: true, topic: existing.get("topic") as string, forgottenInstruction: existing.get("instruction") as string};
}

/** The memories as the state block shows them, or an empty string when there are none. */
export function formatMemories(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `### ${m.topic}\n${m.instruction}`);
  return `Jack's standing instructions (saved with save_memory; follow them whenever the topic applies, even if he does not mention them):\n\n${lines.join("\n\n")}`;
}
