/**
 * The models behind every MAISIE call. Kept in one place so the next migration
 * is a one-line change.
 *
 * MODEL does the work where a wrong answer changes data or costs Jack time to
 * fix: the chat (about 35 tools) and the LinkedIn drafts. LIGHT_MODEL does the
 * short, tool-free jobs: the briefing narrative, the headlines choice and both
 * SMS calls. See decisions/log.md, 2026-10-12.
 */
export const MODEL = "claude-sonnet-5-5";
export const LIGHT_MODEL = "claude-haiku-5-5";
