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
  {key: "cox", label: "Cox Engineering"},
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
 * The four omitted tools are deliberate:
 *   get_calendar, create_calendar_event, move_calendar_event
 *     — the desktop MCP server reads and writes Apple Calendar directly via
 *       AppleScript, which is fresher than the Firestore mirror and applies
 *       instantly instead of queueing.
 *   code_with_github
 *     — in VS Code you are already in the repo with Claude Code.
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
  "find_contacts",
  "get_contact",
  "get_company",
  "save_contact",
  "save_company",
  "add_contact_note",
  "link_to_contact",
  "remove_contact_link",
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
      description: "Delete a custom task category. Cannot delete built-in categories (ihrdc, solomon, dial, ppk, church, embassy, cox, general). Will fail if there are active tasks under that category — those must be completed or reassigned first.",
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
      name: "find_contacts",
      description: "Search Jack's contacts and companies (his CRM / address book). Matches name, title, company, email, phone and tags, case-insensitively. Omit query to list everyone. Returns IDs to use with get_contact, get_company, save_contact and add_contact_note.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {type: "string", description: "Text to match, e.g. 'Donohue', 'ihrdc.com', 'IHRDC'"},
          tag: {type: "string", description: "Optional: only return contacts and companies with this tag"},
          limit: {type: "number", description: "Maximum contacts to return. Defaults to 25."},
        },
        required: [],
      },
    },
    {
      name: "get_contact",
      description: "Get one contact's full record, their notes and their linked emails, meetings and web pages: the 100 newest dated links plus every web page. Emails and meetings on Jack's Jax and IHRDC calendars are linked automatically (automatic: true).",
      input_schema: {
        type: "object" as const,
        properties: {
          contact_id: {type: "string", description: "The contact ID from find_contacts"},
        },
        required: ["contact_id"],
      },
    },
    {
      name: "get_company",
      description: "Get one company, the contacts who work there, its notes and its linked emails, meetings and web pages, newest first.",
      input_schema: {
        type: "object" as const,
        properties: {
          company_id: {type: "string", description: "The company ID from find_contacts or get_contact"},
        },
        required: ["company_id"],
      },
    },
    {
      name: "save_contact",
      description: "Create a contact, or update one when contact_id is given. On update, only the fields you pass change; list fields (emails, phones, tags) are replaced, so pass the full list. A contact from iCloud (fromICloud: true) takes only tags here: its name, title, company, emails and phones are changed in iCloud, and MAISIE picks them up in the morning import. Search with find_contacts first to avoid duplicates — creating a contact whose email already exists is refused.",
      input_schema: {
        type: "object" as const,
        properties: {
          contact_id: {type: "string", description: "Omit to create. Pass to update that contact."},
          first_name: {type: "string"},
          last_name: {type: "string"},
          emails: {type: "array", items: {type: "string"}, description: "All email addresses for this person"},
          phones: {type: "array", items: {type: "string"}, description: "All phone numbers for this person"},
          title: {type: "string", description: "Job title, e.g. 'President & CEO'"},
          company: {type: "string", description: "Company name. Matched to an existing company case-insensitively, or created. Pass an empty string to remove the company."},
          tags: {type: "array", items: {type: "string"}, description: "Labels such as 'client', 'church', 'prospect'"},
        },
        required: [],
      },
    },
    {
      name: "save_company",
      description: "Create a company, or update one when company_id is given. Creating a company whose name already exists is refused.",
      input_schema: {
        type: "object" as const,
        properties: {
          company_id: {type: "string", description: "Omit to create. Pass to update that company."},
          name: {type: "string"},
          website: {type: "string"},
          tags: {type: "array", items: {type: "string"}, description: "Replaces the full tag list"},
        },
        required: [],
      },
    },
    {
      name: "add_contact_note",
      description: "Add a dated note to a contact or a company — what was discussed, a commitment, a preference, anything Jack wants to remember. Pass exactly one of contact_id or company_id.",
      input_schema: {
        type: "object" as const,
        properties: {
          contact_id: {type: "string"},
          company_id: {type: "string"},
          body: {type: "string", description: "The note text"},
        },
        required: ["body"],
      },
    },
    {
      name: "link_to_contact",
      description: "Tie an email, a meeting or a web page to a contact or company, so it shows on their record. Pass exactly one of contact_id or company_id. For an email, find it first with mail_search and pass its message_id as source_id, the subject as title, the sender as detail and its date. For a meeting, pass its title, its date and, if known, the calendar name as detail and the join link as url. For a web page, pass a title and the url. Linking the same item twice is refused.",
      input_schema: {
        type: "object" as const,
        properties: {
          contact_id: {type: "string"},
          company_id: {type: "string"},
          type: {type: "string", enum: ["email", "meeting", "url"]},
          title: {type: "string", description: "Email subject, meeting title or page name"},
          source_id: {type: "string", description: "Email: the message_id from mail_search (required). Meeting: the calendar event's uid, if known."},
          url: {type: "string", description: "http(s) link. Required for a web page; a meeting's join link otherwise."},
          date: {type: "string", description: "YYYY-MM-DD or an ISO timestamp. Required for a meeting."},
          detail: {type: "string", description: "Email: the sender. Meeting: the calendar name."},
          note: {type: "string", description: "Optional: why this matters"},
        },
        required: ["type", "title"],
      },
    },
    {
      name: "remove_contact_link",
      description: "Remove one link from a contact or company. Only the link is removed; the email, meeting or page itself is untouched. A link made by automatic linking (automatic: true in get_contact) is not linked again.",
      input_schema: {
        type: "object" as const,
        properties: {
          link_id: {type: "string", description: "The link id from get_contact or get_company"},
        },
        required: ["link_id"],
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
      name: "get_linkedin_week",
      description: "Get the coming Tuesday's LinkedIn post from Jack's queue: its status, the post text, the first comment and the image idea. Use when Jack asks about his LinkedIn post, what he posts this week, or the queue.",
      input_schema: {type: "object" as const, properties: {}, required: []},
    },
    {
      name: "approve_linkedin_post",
      description: "Mark a drafted LinkedIn post as approved. Use ONLY when Jack has said, in his own words in this conversation, that he approves that specific post. Never approve on his behalf or because it looks ready. Refused if the post still has a [PLACEHOLDER].",
      input_schema: {
        type: "object" as const,
        properties: {date: {type: "string", description: "The post's Tuesday, YYYY-MM-DD"}},
        required: ["date"],
      },
    },
    {
      name: "mark_linkedin_posted",
      description: "Mark an approved LinkedIn post as posted, after Jack says he has published it. Include the post's link if he gives one.",
      input_schema: {
        type: "object" as const,
        properties: {
          date: {type: "string", description: "The post's Tuesday, YYYY-MM-DD"},
          url: {type: "string", description: "Optional link to the live LinkedIn post"},
        },
        required: ["date"],
      },
    },
    {
      name: "write_linkedin_draft",
      description: "Write the draft for a Tuesday that is still an idea, or revise an existing draft as Jack asks, using his marketing-linkedin skill. The draft is saved to GitHub with status 'drafted'. Revising an approved post sets it back to 'drafted', so Jack must approve it again. Show Jack the result and ask him to approve it.",
      input_schema: {
        type: "object" as const,
        properties: {
          date: {type: "string", description: "The post's Tuesday, YYYY-MM-DD"},
          instructions: {type: "string", description: "What Jack wants changed. Required to revise an existing draft."},
        },
        required: ["date"],
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
  ];

  if (!only) return all;
  return all.filter((t) => only.includes(t.name));
};
