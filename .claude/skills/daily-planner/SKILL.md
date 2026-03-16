# Skill: Daily Planner

Plan Jack's day in advance so he doesn't have to think about it.

## Trigger

Run at the start of each session, or when Jack asks "what should I be doing?"

## Instructions

1. **Check today's calendar** (Jax calendar only):

```bash
osascript -e '
set today to current date
set todayStart to today - (time of today)
set tomorrow to todayStart + 1 * days
set output to ""
tell application "Calendar"
    set cal to first calendar whose name is "Jax"
    set evts to (every event of cal whose start date ≥ todayStart and start date < tomorrow)
    repeat with e in evts
        set output to output & (summary of e) & " | " & (start date of e) & " | " & (end date of e) & linefeed
    end repeat
end tell
if output is "" then return "No events today"
return output
'
```

2. **Check tomorrow's calendar** using the calendar-review skill approach. Flag any early morning events.

3. **Read the task list** from `tasks.md`:
   - What's in "Priority / Today"?
   - What's in "This Week"?
   - Any recurring tasks due?

4. **Check current priorities** from `@context/current-priorities.md`.

5. **Check for Brad Donohue messages** using the brad-alert skill approach.

6. **Synthesize a daily plan:**
   - Fixed time blocks (calendar events)
   - Top tasks to tackle in open time
   - Reminders for recurring items due today
   - Heads up on tomorrow's early events

## Output Format

```
**Your Day — Monday, March 16, 2026**

⚠️ REMINDER: Tomorrow has a 8:30 AM meeting — set an alarm!

**Calendar:**
- 10:00 AM – 11:00 AM: IHRDC standup
- 2:00 PM – 3:00 PM: 1:1 with teammate

**Top Tasks:**
- [ ] Prepare Friday demo schedule
- [ ] Review AI enablement progress notes

**Due Today:**
- Weekly status report to Brad (it's Friday)

**From Brad:**
- No new messages *(or summary if there are)*

**Open time for deep work:** 11 AM – 2 PM, 3 PM onwards
```
