# Skill: Brad Donohue Alert

Flag communications from Brad Donohue (IHRDC CEO).

## Trigger

When Jack asks to check messages, or as part of a daily review.

## Instructions

1. **Email (Apple Mail):** Check for recent emails from Brad Donohue:

```bash
osascript -e '
set output to ""
tell application "Mail"
    set msgs to (every message of inbox whose sender contains "Donohue" and date received > ((current date) - 1 * days))
    repeat with m in msgs
        set output to output & (subject of m) & " | " & (date received of m) & " | From: " & (sender of m) & linefeed
    end repeat
end tell
if output is "" then return "No recent emails from Brad Donohue"
return output
'
```

2. **Microsoft Teams:** Teams on Mac has limited AppleScript support. For now, remind Jack to check Teams manually for messages from Brad. Flag this as a candidate for future automation (Teams MCP server or webhook).

3. If emails from Brad are found, summarize them prominently:
   - Subject line
   - When received
   - First few lines of content (if readable)
   - Whether a response seems needed

## Limitations

- Teams messages cannot be read programmatically on Mac yet. This is a future enhancement.
- Email reading requires Mail.app to be running and configured.

## Output Format

```
**Messages from Brad Donohue:**

📧 Email: "[Subject]" — received [time]
   Preview: [first line or two]
   Action: [Needs reply / FYI only]

💬 Teams: Check manually — no automation available yet
```
