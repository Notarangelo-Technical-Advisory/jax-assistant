# Skill: Weekly Status Report

Generate and send Brad Donohue a weekly status report for IHRDC work.

## Trigger

Run every Friday, or when Jack asks for a status report.

## Instructions

1. **Data source:** The fta-time-tracker app (repo: `fta-time-tracker`) generates the time data. Until an MCP server or API integration is built, Jack will need to provide the time data or run fta-time-tracker manually.

2. Review the current week's work:
   - Check `decisions/log.md` for any IHRDC-related decisions this week
   - Check `projects/ihrdc-ai-enablement/` for project updates
   - Ask Jack for any highlights or blockers not captured elsewhere

3. Draft the status report in this format:

```
Subject: IHRDC Weekly Status Report — [Date]

Hi Brad,

Here's my weekly update:

**This Week:**
- [Accomplishments, meetings attended, demos led, etc.]

**Next Week:**
- [Planned activities]

**Blockers / Notes:**
- [Any issues or items needing Brad's attention, or "None"]

Best,
Jack
```

4. Present the draft to Jack for review before sending.

## Status

**Partially automated.** Full automation depends on fta-time-tracker MCP/API integration. For now, this skill templates the report and Jack provides the time entries.
