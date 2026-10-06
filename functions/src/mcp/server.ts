/**
 * MAISIE MCP server — exposes MAISIE's task, billing and contact tools to
 * Claude Code in VS Code over stdio.
 *
 * Usage (from functions/):
 *   npx tsx src/mcp/server.ts
 *
 * This file is never deployed. The MCP SDK and tsx are devDependencies, which
 * the Cloud Functions runtime does not install, so the deploy payload is
 * unchanged. Firebase setup (and the service-account key it needs) is in
 * ./firebase.ts, shared with the Apple Contacts import command.
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
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
import {importContacts} from "../tools/contacts-import";
import {readAppleContacts} from "./apple-contacts";

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

/**
 * MCP-only: Apple Contacts lives on Jack's Mac, which this local server can
 * read and the cloud chat function cannot. So it is not in buildTools().
 */
const IMPORT_TOOL = {
  name: "import_apple_contacts",
  description: "Copy everyone in Jack's Apple Contacts into MAISIE's contacts. One-way and additive: it never changes Apple Contacts, never removes anything from MAISIE, and never overwrites a field Jack filled in — it fills blanks and adds new email addresses and phone numbers. People are matched by an earlier import, then email, then a unique exact name. Safe to run again. Run with dry_run first and show Jack the counts; import for real only when he says so.",
  inputSchema: {
    type: "object" as const,
    properties: {
      dry_run: {type: "boolean", description: "Report what would change without writing anything. Defaults to true."},
    },
    required: [],
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await ensureContext();
  const tools = buildTools(categories, MCP_TOOL_NAMES).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.input_schema as Record<string, unknown>,
  }));
  return {tools: [...tools, CONTEXT_TOOL, IMPORT_TOOL]};
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

    if (name === "import_apple_contacts") {
      // Defaults to a dry run, so a model cannot import by leaving the flag out.
      const dryRun = (args as {dry_run?: boolean} | undefined)?.dry_run !== false;
      const summary = await importContacts(db, readAppleContacts(), {dryRun});
      return {content: [{type: "text" as const, text: JSON.stringify(summary, null, 2)}]};
    }

    if (!MCP_TOOL_NAMES.includes(name)) {
      return {
        content: [{type: "text" as const, text: `Tool "${name}" is not exposed over MCP. Available: ${MCP_TOOL_NAMES.join(", ")}, get_maisie_context, import_apple_contacts.`}],
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
