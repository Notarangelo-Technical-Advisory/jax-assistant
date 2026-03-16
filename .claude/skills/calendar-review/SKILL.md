# Skill: Calendar Review

Review Jack's upcoming calendar and flag important items.

## Trigger

Run daily, or when Jack asks about his schedule.

## Instructions

1. Use AppleScript to read events from the **"Jax"** calendar only:

```bash
osascript -e '
set targetDate to (current date) + 1 * days
set endDate to targetDate + 1 * days
set output to ""
tell application "Calendar"
    set cal to first calendar whose name is "Jax"
    set evts to (every event of cal whose start date ≥ targetDate and start date < endDate)
    repeat with e in evts
        set output to output & (summary of e) & " | " & (start date of e) & " | " & (end date of e) & linefeed
    end repeat
end tell
return output
'
```

2. To check today's remaining events, adjust the date range to start from `(current date)` and end at midnight tonight.

3. To check a multi-day range (e.g., the week), adjust `endDate` accordingly.

4. Present results as bullet points with time and event name.

5. **Early morning alert:** If any event is at **9:00 AM or earlier**, flag it prominently at the top of the summary with a warning that Jack needs advance notice for these.

6. If no events are found, say so.

## Output Format

```
**Tomorrow (March 17, 2026):**

⚠️ EARLY MORNING: 8:30 AM — Client standup (you need to be ready for this!)

- 11:30 AM – 12:30 PM: Example event
- 2:00 PM – 3:00 PM: Another event
```
