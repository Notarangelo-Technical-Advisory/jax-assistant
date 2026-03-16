# Skill: Friday Demo Scheduler

Schedule and manage the weekly IHRDC AI demo sessions.

## Trigger

Run weekly (ideally Monday or Tuesday) to prepare for Friday's demo, or when Jack asks about the demo schedule.

## Instructions

1. Check the "Jax" calendar for this Friday to see if the demo is already scheduled:

```bash
osascript -e '
-- Find next Friday
set today to current date
set dow to weekday of today
if dow is Friday then
    set fri to today
else
    set fri to today + ((6 - (dow as integer)) * days)
end if
set friEnd to fri + 1 * days
set output to ""
tell application "Calendar"
    set cal to first calendar whose name is "Jax"
    set evts to (every event of cal whose start date ≥ fri and start date < friEnd)
    repeat with e in evts
        if (summary of e) contains "demo" or (summary of e) contains "Demo" then
            set output to output & (summary of e) & " | " & (start date of e) & linefeed
        end if
    end repeat
end tell
if output is "" then return "No demo found on Friday"
return output
'
```

2. If no demo is scheduled, remind Jack to:
   - Confirm the demo time slot with the IHRDC team
   - Identify who is presenting this week
   - Send a calendar invite

3. If the demo is scheduled, ask Jack:
   - Who is presenting?
   - Any prep needed?
   - Should a reminder be sent to the team?

4. Track demo presenters and topics if Jack provides them.

## Output Format

```
**Friday Demo (March 20, 2026):**
- Time: [time from calendar]
- Presenter: [TBD or name]
- Topic: [TBD or topic]
- Action needed: [schedule it / confirm presenter / none]
```
