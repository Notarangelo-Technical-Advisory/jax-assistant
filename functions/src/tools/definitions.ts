import Anthropic from "@anthropic-ai/sdk";

export interface Category {
  key: string;
  label: string;
}

/** Categories that ship with the app and cannot be created or deleted. */
export const DEFAULT_CATEGORIES: Category[] = [
  {key: "ihrdc", label: "IHRDC"},
  {key: "solomon", label: "Solomon"},
  {key: "dial", label: "DIAL"},
  {key: "ppk", label: "PPK"},
  {key: "church", label: "Church"},
  {key: "embassy", label: "Embassy Series"},
  {key: "general", label: "General"},
];

export const DEFAULT_CATEGORY_KEYS = DEFAULT_CATEGORIES.map((c) => c.key);

/**
 * Anthropic's server-side web tools. These execute on Anthropic's
 * infrastructure — there is no entry for them in execute.ts and no API key to
 * hold. They arrive back as `server_tool_use` / `web_search_tool_result` content
 * blocks in the same response, so the chat function's tool loop (which matches
 * on `tool_use`) correctly ignores them.
 *
 * Deliberately kept out of buildTools: the `_20260209` variants run code
 * execution internally for dynamic filtering, so declaring `code_execution`
 * alongside them gives the model two execution environments and confuses it.
 * Also absent from MCP_TOOL_NAMES — Claude Code already has WebSearch/WebFetch.
 *
 * Appended after the custom tools and never rebuilt, so the cached tool prefix
 * stays byte-identical across requests. See the caching note in index.ts.
 */
export const WEB_TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 8,
    // Only what the persona already asserts — Jack is on Eastern Time. No city
    // or region: nothing in context/ states one, and a wrong guess biases results.
    user_location: {
      type: "approximate",
      country: "US",
      timezone: "America/New_York",
    },
  },
  {
    type: "web_fetch_20260209",
    name: "web_fetch",
    max_uses: 5,
    citations: {enabled: true},
    max_content_tokens: 30000,
  },
];

/**
 * Tool names exposed to the MAISIE MCP server (VS Code).
 *
 * The six omitted tools are deliberate:
 *   get_calendar, create_calendar_event, move_calendar_event
 *     — the desktop MCP server reads and writes Apple Calendar directly via
 *       AppleScript, which is fresher than the Firestore mirror and applies
 *       instantly instead of queueing.
 *   code_with_github
 *     — in VS Code you are already in the repo with Claude Code.
 *   search_place, get_directions
 *     — phone-shaped, not desk-shaped.
 */
export const MCP_TOOL_NAMES = [
  "add_task",
  "complete_task",
  "reopen_task",
  "update_task",
  "create_task_category",
  "delete_task_category",
  "get_unbilled_detail",
  "get_time_entries",
  "get_invoice_status",
];

/**
 * Build the tool schemas. Category enums are rebuilt from `cats` on every call,
 * so callers must rebuild after create_task_category / delete_task_category.
 *
 * @param cats  Categories available for add_task's enum.
 * @param only  Restrict to these tool names (order preserved from the full list).
 */
export const buildTools = (
  cats: Category[],
  only?: string[]
): Anthropic.Messages.Tool[] => {
  const all: Anthropic.Messages.Tool[] = [
    {
      name: "get_calendar",
      description: "Get Jack's calendar events for a date range. Use this when Jack asks about his schedule, meetings, or availability.",
      input_schema: {
        type: "object" as const,
        properties: {
          days_ahead: {
            type: "number",
            description: "Number of days ahead to look (default 1 = today only, 2 = today + tomorrow, 7 = this week)",
          },
        },
        required: [],
      },
    },
    {
      name: "add_task",
      description: "Add a new task to Jack's task list",
      input_schema: {
        type: "object" as const,
        properties: {
          title: {type: "string", description: "The task description"},
          category: {
            type: "string",
            enum: cats.map((c) => c.key),
            description: `Task category. Available: ${cats.map((c) => `${c.key} (${c.label})`).join(", ")}. Use 'church' for Grace Pres church tasks. If a suitable category doesn't exist, create it first with create_task_category.`,
          },
          dueDate: {
            type: "string",
            description: "Optional due date in YYYY-MM-DD format",
          },
        },
        required: ["title", "category"],
      },
    },
    {
      name: "complete_task",
      description: "Mark a task as completed. Use the task ID from the active tasks list.",
      input_schema: {
        type: "object" as const,
        properties: {
          taskId: {
            type: "string",
            description: "The Firestore document ID of the task to complete",
          },
        },
        required: ["taskId"],
      },
    },
    {
      name: "reopen_task",
      description: "Mark a completed task as incomplete/active again. Use the task ID from the recently completed tasks list.",
      input_schema: {
        type: "object" as const,
        properties: {
          taskId: {
            type: "string",
            description: "The Firestore document ID of the completed task to reopen",
          },
        },
        required: ["taskId"],
      },
    },
    {
      name: "update_task",
      description: "Update an existing task's due date, title, or category. Use the task ID from the active tasks list. Use this when Jack asks to change or set a due date on an existing task.",
      input_schema: {
        type: "object" as const,
        properties: {
          taskId: {
            type: "string",
            description: "The Firestore document ID of the task to update",
          },
          dueDate: {
            type: "string",
            description: "New due date in YYYY-MM-DD format. Omit to leave unchanged. Pass null to clear the due date.",
          },
          title: {
            type: "string",
            description: "New title for the task. Omit to leave unchanged.",
          },
        },
        required: ["taskId"],
      },
    },
    {
      name: "create_task_category",
      description: "Create a new task category. Use this when Jack wants to organize tasks under a new project or area that doesn't have a category yet.",
      input_schema: {
        type: "object" as const,
        properties: {
          key: {
            type: "string",
            description: "A short lowercase identifier for the category (e.g. 'acme', 'fitness'). No spaces or special characters.",
          },
          label: {
            type: "string",
            description: "The human-readable display name for the category (e.g. 'Acme Corp', 'Fitness').",
          },
        },
        required: ["key", "label"],
      },
    },
    {
      name: "delete_task_category",
      description: "Delete a custom task category. Cannot delete built-in categories (ihrdc, solomon, dial, ppk, church, embassy, general). Will fail if there are active tasks under that category — those must be completed or reassigned first.",
      input_schema: {
        type: "object" as const,
        properties: {
          key: {
            type: "string",
            description: "The category key to delete (e.g. 'acme'). Must be a custom category, not a built-in one.",
          },
        },
        required: ["key"],
      },
    },
    {
      name: "get_unbilled_detail",
      description: "Get detailed breakdown of all unbilled time entries, grouped by customer and project, with descriptions and amounts. Use when Jack asks what unbilled work he has, what he owes a client an invoice for, or needs detail beyond the total summary.",
      input_schema: {
        type: "object" as const,
        properties: {
          customer_id: {
            type: "string",
            description: "Optional: filter to a specific customer (e.g. 'ihrdc'). Omit to get all customers.",
          },
        },
        required: [],
      },
    },
    {
      name: "get_time_entries",
      description: "Get time entries for a date range (all statuses: unbilled, billed, paid). Use when Jack asks what he worked on this week/month, needs context on project work, or wants a time log for a period.",
      input_schema: {
        type: "object" as const,
        properties: {
          days_back: {
            type: "number",
            description: "Number of days back from today (default 7). Ignored if start_date is provided.",
          },
          start_date: {
            type: "string",
            description: "Start date in YYYY-MM-DD format.",
          },
          end_date: {
            type: "string",
            description: "End date in YYYY-MM-DD format. Defaults to today if omitted.",
          },
          customer_id: {
            type: "string",
            description: "Optional: filter to a specific customer.",
          },
        },
        required: [],
      },
    },
    {
      name: "get_invoice_status",
      description: "Get recent invoices with status, and show which customers have unbilled hours ready to invoice. Use when Jack asks about outstanding invoices, payment status, or whether a client needs to be invoiced.",
      input_schema: {
        type: "object" as const,
        properties: {
          customer_id: {
            type: "string",
            description: "Optional: filter to a specific customer.",
          },
          status_filter: {
            type: "string",
            enum: ["all", "unpaid", "paid"],
            description: "'unpaid' = sent+overdue, 'paid' = paid only, 'all' = everything. Defaults to 'all'.",
          },
        },
        required: [],
      },
    },
    {
      name: "create_calendar_event",
      description: "Create a new event on Jack's calendar. Always confirm the title, date, and time before calling this tool. Warn Jack that the event will appear within ~1 minute (bridge sync). If the calendar sync is stale (>30 min), warn that the bridge may need to be run.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: {type: "string", description: "Event title/summary"},
          date: {type: "string", description: "Date in YYYY-MM-DD format"},
          start_time: {type: "string", description: "Start time in HH:MM format (24-hour, ET), e.g. '14:00'"},
          end_time: {type: "string", description: "End time in HH:MM format (24-hour, ET), e.g. '15:00'"},
          location: {type: "string", description: "Optional location"},
          notes: {type: "string", description: "Optional notes or description"},
        },
        required: ["title", "date", "start_time", "end_time"],
      },
    },
    {
      name: "move_calendar_event",
      description: "Reschedule an existing calendar event to a new date/time. Always confirm the event title, original date, and new time before calling. Warn Jack that changes will appear within ~1 minute (bridge sync).",
      input_schema: {
        type: "object" as const,
        properties: {
          event_title: {type: "string", description: "Title of the event to move (must match exactly or closely)"},
          original_date: {type: "string", description: "Original date of the event in YYYY-MM-DD format"},
          new_date: {type: "string", description: "New date in YYYY-MM-DD format"},
          new_start_time: {type: "string", description: "New start time in HH:MM format (24-hour, ET)"},
          new_end_time: {type: "string", description: "New end time in HH:MM format (24-hour, ET)"},
        },
        required: ["event_title", "original_date", "new_date", "new_start_time", "new_end_time"],
      },
    },
    {
      name: "mail_search",
      description: "Search Jack's Apple Mail on his Mac. Runs through the local desktop bridge, so it only works when his Mac is awake and the bridge is running — expect a few seconds' delay, and report a pending result honestly rather than as a failure. Returns subjects, senders, dates and message IDs, not bodies; use mail_read for a body.",
      input_schema: {
        type: "object" as const,
        properties: {
          sender: {
            type: "string",
            description: "Substring matched against the sender name or address, e.g. 'Donohue'",
          },
          subject: {
            type: "string",
            description: "Substring matched against the subject line",
          },
          days_back: {
            type: "number",
            description: "How many days back to search. Defaults to 7.",
          },
          limit: {
            type: "number",
            description: "Maximum messages to return. Defaults to 15.",
          },
        },
        required: [],
      },
    },
    {
      name: "mail_read",
      description: "Read the body of one email, using a message_id from mail_search. Goes through the local desktop bridge. Long bodies are truncated.",
      input_schema: {
        type: "object" as const,
        properties: {
          message_id: {
            type: "string",
            description: "The message_id returned by mail_search",
          },
        },
        required: ["message_id"],
      },
    },
    {
      name: "mail_draft",
      description: "Compose an UNSENT draft in Jack's Mail app for him to review and send himself. Nothing is transmitted. You cannot send email — if Jack asks you to send something, draft it and tell him it is waiting in Mail.",
      input_schema: {
        type: "object" as const,
        properties: {
          to: {
            type: "array",
            items: {type: "string"},
            description: "Recipient email addresses",
          },
          subject: {type: "string", description: "Subject line"},
          body: {type: "string", description: "Message body, plain text"},
          cc: {
            type: "array",
            items: {type: "string"},
            description: "Optional CC addresses",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "code_with_github",
      description: "Delegate ANY coding task — bug fix, feature, refactor, or file change — to the cloud coding agent. Use this whenever Jack asks to fix a bug, add a feature, or change any code. The agent creates a branch, makes the changes, and opens a PR. Returns the GitHub issue URL immediately; Jack gets a notification when the PR is ready.",
      input_schema: {
        type: "object" as const,
        properties: {
          task: {
            type: "string",
            description: "Complete description of what needs to be done. Include: the bug/feature, expected behavior, and all relevant context Jack provided.",
          },
        },
        required: ["task"],
      },
    },
    {
      name: "search_place",
      description: "Search for a business or place by name and optional location context. Returns the name, address, hours, and whether it's open right now. Use when Jack asks 'is [place] open?', wants to find a restaurant or hotel, or needs to resolve a business name to an address (e.g. before calling get_directions).",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Business name and optional location context, e.g. 'Nobu restaurant Chicago' or 'Marriott Marquis Times Square NYC'",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_directions",
      description: "Get walking and driving distance/time between two locations. Use when Jack asks 'how far is [place] from [another place]' or needs travel time estimates. Can accept addresses, business names, or coordinates.",
      input_schema: {
        type: "object" as const,
        properties: {
          origin: {
            type: "string",
            description: "Starting location — address, business name, or lat/lng coordinates (e.g. 'Times Square NYC', '123 Main St Chicago', '40.7580,-73.9855')",
          },
          destination: {
            type: "string",
            description: "Ending location — address, business name, or lat/lng coordinates",
          },
        },
        required: ["origin", "destination"],
      },
    },
  ];

  if (!only) return all;
  return all.filter((t) => only.includes(t.name));
};
