/**
 * MAISIE MCP server — exposes MAISIE's task and billing tools to Claude Code
 * in VS Code over stdio.
 *
 * Usage (from functions/):
 *   npx tsx src/mcp/server.ts
 *
 * This file is never deployed. The MCP SDK and tsx are devDependencies, which
 * the Cloud Functions runtime does not install, so the deploy payload is
 * unchanged.
 *
 * Requires a Firebase service account key at bridge/service-account.json
 * (gitignored — download from Firebase Console > Project Settings > Service
 * Accounts). The same key is exported as GOOGLE_APPLICATION_CREDENTIALS so
 * fta-client's applicationDefault() call resolves to it for the cross-project
 * read of the NTA time tracker (fta-invoice-tracking).
 */

// SSL bypass for this machine's certificate issues (same as bridge/calendar-sync.ts).
// Must precede any import that touches the network stack.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

import * as path from "path";
import {readFileSync} from "fs";
import * as admin from "firebase-admin";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {buildTools, MCP_TOOL_NAMES, Category} from "../tools/definitions";
import {executeTool, CustomerInfo} from "../tools/execute";
import {loadMaisieContext, buildSystemPrompt} from "../tools/context";

// Resolves to <repo>/bridge/service-account.json from either src/mcp (tsx) or
// lib/mcp (compiled) — both are two levels below the repo root.
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "..", "..", "bridge", "service-account.json");

// fta-client.ts reaches the NTA time tracker with applicationDefault(); locally
// that resolves via GOOGLE_APPLICATION_CREDENTIALS. The secondary app is built
// lazily on first billing call, by which point this is set.
process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_PATH;

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf-8"));

admin.initializeApp({credential: admin.credential.cert(serviceAccount)});
const db = admin.firestore();
// REST instead of gRPC — gRPC has its own TLS stack that ignores NODE_TLS_REJECT_UNAUTHORIZED
db.settings({preferRest: true});

const server = new Server(
  {name: "maisie", version: "1.0.0"},
  {capabilities: {tools: {listChanged: true}, prompts: {}}}
);

/**
 * Cached context. Categories drive add_task's enum, and the customer map is
 * needed to label billing results, so both are loaded once per process and
 * refreshed when a category changes.
 */
let categories: Category[] = [];
let customerMap = new Map<string, CustomerInfo>();
let contextLoaded = false;

async function ensureContext(): Promise<void> {
  if (contextLoaded) return;
  const ctx = await loadMaisieContext(db);
  categories = ctx.categories;
  customerMap = ctx.customerMap;
  contextLoaded = true;
}

const CONTEXT_TOOL = {
  name: "get_maisie_context",
  description: "Get Jack's current state in one call: latest briefing, open alerts, active tasks with IDs, recently completed tasks, unbilled total, and the next two days of calendar. Call this first when you need situational awareness rather than a specific lookup.",
  inputSchema: {type: "object" as const, properties: {}, required: []},
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await ensureContext();
  const tools = buildTools(categories, MCP_TOOL_NAMES).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.input_schema as Record<string, unknown>,
  }));
  return {tools: [...tools, CONTEXT_TOOL]};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await ensureContext();
  const {name, arguments: args} = request.params;

  try {
    if (name === "get_maisie_context") {
      const ctx = await loadMaisieContext(db);
      categories = ctx.categories;
      customerMap = ctx.customerMap;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            unbilledHours: ctx.totalUnbilled,
            unbilledAmount: ctx.unbilledAmount,
            lastInvoice: ctx.lastInvoice
              ? {issueDate: ctx.lastInvoice.issueDate, total: ctx.lastInvoice.total}
              : null,
            briefing: ctx.todayBriefing,
            alerts: ctx.alerts,
            activeTasks: ctx.tasks,
            recentlyCompletedTasks: ctx.recentCompletedTasks,
            calendar: ctx.calendarEvents.map((e) => ({
              summary: e.summary,
              start: e.startTime.toISOString(),
              end: e.endTime.toISOString(),
              location: e.location ?? null,
            })),
            categories: ctx.categories,
          }, null, 2),
        }],
      };
    }

    if (!MCP_TOOL_NAMES.includes(name)) {
      return {
        content: [{type: "text" as const, text: `Tool "${name}" is not exposed over MCP. Available: ${MCP_TOOL_NAMES.join(", ")}, get_maisie_context.`}],
        isError: true,
      };
    }

    const result = await executeTool(name, args ?? {}, {
      db,
      customerMap,
      categories,
      // No progress channel over stdio — chatThinking is a web-UI concern.
      onStep: undefined,
      onCategoriesChanged: () => {
        // add_task's enum changed, so the advertised schemas are now stale.
        void server.sendToolListChanged();
      },
    });

    return {
      content: [{type: "text" as const, text: JSON.stringify(result, null, 2)}],
      isError: result["success"] === false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{type: "text" as const, text: `Tool "${name}" failed: ${message}`}],
      isError: true,
    };
  }
});

// The Maisie persona plus a live state snapshot, so a VS Code session can adopt
// her voice and context instead of acting as generic Claude Code.
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{
    name: "maisie",
    description: "Adopt the Maisie persona with Jack's current context (tasks, alerts, briefing, calendar, unbilled).",
  }],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "maisie") {
    throw new Error(`Unknown prompt "${request.params.name}"`);
  }
  const ctx = await loadMaisieContext(db);
  categories = ctx.categories;
  customerMap = ctx.customerMap;
  return {
    messages: [{
      role: "user" as const,
      content: {type: "text" as const, text: buildSystemPrompt(ctx)},
    }],
  };
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — log to stderr only.
  console.error("[maisie-mcp] ready");
}

main().catch((err) => {
  console.error("[maisie-mcp] fatal:", err);
  process.exit(1);
});
