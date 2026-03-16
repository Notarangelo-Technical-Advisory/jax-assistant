import * as admin from "firebase-admin";
import {onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getUnbilledEntries, getLastInvoice, getTimeEntriesForRange} from "./fta-client";
import Anthropic from "@anthropic-ai/sdk";

admin.initializeApp();
const db = admin.firestore();

// ─── Auth helper ───────────────────────────────────────────────
async function verifyAuth(
  req: {headers: {authorization?: string}}
): Promise<admin.auth.DecodedIdToken> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }
  return admin.auth().verifyIdToken(auth.split("Bearer ")[1]);
}

// ─── TTS: ElevenLabs proxy (same pattern as Solomon) ───────────
const ELEVENLABS_VOICE_ID: Record<string, string> = {
  "female-american": "WyFXw4PzMbRnp8iLMJwY",
  "male-american": "ZoiZ8fuDWInAcwPXaVeq",
  "female-british": "kBag1HOZlaVBH7ICPE8x",
  "male-british": "onwK4e9ZLuTAKqWW03F9",
};

export const synthesizeSpeech = onRequest(
  {cors: true, region: "us-central1", memory: "256MiB"},
  async (req, res) => {
    try {
      await verifyAuth(req);
    } catch {
      res.status(401).json({error: "Unauthorized"});
      return;
    }

    const {text, voice} = req.body as {text?: string; voice?: string};
    if (!text) {
      res.status(400).json({error: "text is required"});
      return;
    }

    const voiceId = ELEVENLABS_VOICE_ID[voice || "female-american"]
      || ELEVENLABS_VOICE_ID["female-american"];

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      res.status(500).json({error: "ELEVENLABS_API_KEY not configured"});
      return;
    }

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: {stability: 0.5, similarity_boost: 0.75},
          }),
        }
      );

      if (!response.ok) {
        const errBody = await response.text();
        if (errBody.includes("quota_exceeded")) {
          res.status(429).json({error: "quota_exceeded"});
          return;
        }
        res.status(response.status).json({error: errBody});
        return;
      }

      // Buffer full response for Content-Length (iOS Safari compatibility)
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      res.set("Content-Type", "audio/mpeg");
      res.set("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "TTS failed";
      res.status(500).json({error: message});
    }
  }
);

// ─── Chat: Conversational AI via Anthropic ─────────────────────
export const chat = onRequest(
  {cors: true, region: "us-central1", memory: "256MiB", timeoutSeconds: 60},
  async (req, res) => {
    try {
      await verifyAuth(req);
    } catch {
      res.status(401).json({error: "Unauthorized"});
      return;
    }

    const {message} = req.body as {message?: string};
    if (!message) {
      res.status(400).json({error: "message is required"});
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({error: "ANTHROPIC_API_KEY not configured"});
      return;
    }

    // Gather context from Firestore and fta-time-tracker
    const [unbilledEntries, lastInvoice, todayBriefing, alerts, tasks] =
      await Promise.all([
        getUnbilledEntries().catch(() => []),
        getLastInvoice().catch(() => null),
        db.collection("briefings")
          .orderBy("createdAt", "desc").limit(1).get()
          .then((s) => s.empty ? null : s.docs[0].data())
          .catch(() => null),
        db.collection("alerts")
          .where("dismissed", "==", false)
          .orderBy("createdAt", "desc").limit(10).get()
          .then((s) => s.docs.map((d) => d.data()))
          .catch(() => []),
        db.collection("tasks")
          .where("completed", "==", false)
          .orderBy("createdAt", "desc").get()
          .then((s) => s.docs.map((d) => ({id: d.id, ...d.data()})))
          .catch(() => []),
      ]);

    const totalUnbilled = unbilledEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );
    const unbilledAmount = totalUnbilled * 150;

    const systemPrompt = `You are Maisie, Jack Notarangelo's personal executive assistant. Your name is Maisie. When Jack addresses you by name (e.g., "Maisie, what does my schedule look like?"), treat your name as a natural greeting — do not interpret it as a topic or question. Simply respond to whatever follows your name.

You help Jack manage his time, tasks, and business.

Jack's top priority: Glorify God and Enjoy Him Forever.

Current context:
- Unbilled hours: ${totalUnbilled.toFixed(1)}h ($${unbilledAmount.toFixed(0)}) at $150/hr
- Last invoice: ${lastInvoice ? `${lastInvoice.issueDate} for $${lastInvoice.total}` : "None found"}
- Active tasks: ${tasks.length > 0 ? tasks.map((t: Record<string, unknown>) => `[${t["category"]}] ${t["title"]}`).join("; ") : "None"}
- Active alerts: ${alerts.length > 0 ? alerts.map((a: Record<string, unknown>) => `${a["type"]}: ${a["message"]}`).join("; ") : "None"}
- Today's briefing: ${todayBriefing ? JSON.stringify(todayBriefing) : "Not generated yet"}

Be concise and direct. Use a warm, professional tone — like a trusted assistant who knows Jack well. If Jack asks you to do something (add a task, etc.), confirm the action clearly.
Today is ${new Date().toLocaleDateString("en-US", {weekday: "long", year: "numeric", month: "long", day: "numeric"})}.`;

    try {
      const anthropic = new Anthropic({apiKey});
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{role: "user", content: message}],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => {
          if (b.type === "text") return b.text;
          return "";
        })
        .join("");

      // Store the chat exchange
      await db.collection("chatMessages").add({
        userMessage: message,
        assistantMessage: text,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({response: text});
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : "Chat failed";
      res.status(500).json({error: errMessage});
    }
  }
);

// ─── Callable: Get unbilled summary ────────────────────────────
export const getUnbilledSummary = onRequest(
  {cors: true, region: "us-central1"},
  async (req, res) => {
    try {
      await verifyAuth(req);
    } catch {
      res.status(401).json({error: "Unauthorized"});
      return;
    }

    const entries = await getUnbilledEntries();
    const totalHours = entries.reduce((sum, e) => sum + e.durationHours, 0);
    res.json({
      totalHours: Math.round(totalHours * 100) / 100,
      totalAmount: Math.round(totalHours * 150 * 100) / 100,
      entryCount: entries.length,
      entries: entries.slice(0, 10),
    });
  }
);

// ─── Scheduled: Morning Briefing (weekdays 7am ET) ─────────────
export const morningBriefing = onSchedule(
  {
    schedule: "0 7 * * 1-5",
    timeZone: "America/New_York",
    region: "us-central1",
    memory: "256MiB",
  },
  async () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const dayOfMonth = today.getDate();
    const isFriday = dayOfWeek === 5;
    const isFirstWeek = dayOfMonth <= 7;

    const [unbilledEntries, lastInvoice] = await Promise.all([
      getUnbilledEntries().catch(() => []),
      getLastInvoice().catch(() => null),
    ]);

    const totalUnbilled = unbilledEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );

    // Get this week's time entries for status report
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + 1);
    const weekStartStr = weekStart.toISOString().split("T")[0];
    const todayStr = today.toISOString().split("T")[0];

    const weekEntries = await getTimeEntriesForRange(
      weekStartStr, todayStr
    ).catch(() => []);
    const weekHours = weekEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );

    const alerts: Array<{type: string; message: string}> = [];

    if (isFriday) {
      alerts.push({
        type: "status-report",
        message: `Weekly status report due. This week: ${weekHours.toFixed(1)}h logged.`,
      });
    }

    if (isFirstWeek) {
      const lastMonth = new Date(today);
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const lastMonthName = lastMonth.toLocaleString("en-US", {month: "long"});

      if (!lastInvoice ||
          new Date(lastInvoice.issueDate) < lastMonth) {
        alerts.push({
          type: "invoice",
          message: `${lastMonthName} invoice may be due. Unbilled: ${totalUnbilled.toFixed(1)}h ($${(totalUnbilled * 150).toFixed(0)}).`,
        });
      }
    }

    const briefing = {
      date: todayStr,
      unbilledHours: Math.round(totalUnbilled * 100) / 100,
      unbilledAmount: Math.round(totalUnbilled * 150 * 100) / 100,
      weekHours: Math.round(weekHours * 100) / 100,
      lastInvoiceDate: lastInvoice?.issueDate || null,
      lastInvoiceAmount: lastInvoice?.total || null,
      alerts,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("briefings").doc(todayStr).set(briefing);

    // Write any alerts to the alerts collection
    for (const alert of alerts) {
      await db.collection("alerts").add({
        ...alert,
        dismissed: false,
        briefingDate: todayStr,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);

// ─── Scheduled: Invoice Reminder (first 7 days of month, weekdays 9am ET)
export const invoiceReminder = onSchedule(
  {
    schedule: "0 9 1-7 * 1-5",
    timeZone: "America/New_York",
    region: "us-central1",
  },
  async () => {
    const today = new Date();
    const lastMonth = new Date(today);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const lastInvoice = await getLastInvoice().catch(() => null);

    // Check if we already have an invoice for last month
    if (lastInvoice && new Date(lastInvoice.issueDate) >= lastMonth) {
      return; // Invoice already exists for last month
    }

    // Check if we already sent a reminder today
    const todayStr = today.toISOString().split("T")[0];
    const existing = await db.collection("alerts")
      .where("type", "==", "invoice")
      .where("briefingDate", "==", todayStr)
      .limit(1)
      .get();

    if (!existing.empty) return;

    const unbilledEntries = await getUnbilledEntries().catch(() => []);
    const totalUnbilled = unbilledEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );

    if (totalUnbilled > 0) {
      await db.collection("alerts").add({
        type: "invoice",
        message: `Invoice reminder: ${totalUnbilled.toFixed(1)} unbilled hours ($${(totalUnbilled * 150).toFixed(0)}).`,
        dismissed: false,
        briefingDate: todayStr,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);
