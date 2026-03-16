# Skill: Task Manager

Manage Jack's task list in `tasks.md`.

## Trigger

When Jack mentions a task, asks what's next, or says to add/complete/move a task.

## Instructions

### Adding Tasks

When Jack mentions something he needs to do:
1. Read `tasks.md`
2. Add the task to the appropriate section:
   - **Priority / Today** — needs to happen today
   - **This Week** — needs to happen this week
   - **Upcoming** — future tasks, no immediate deadline
   - **Recurring** — repeating tasks
3. Write the updated file

Format: `- [ ] [Task description] *(added [date])*`

If a deadline is mentioned: `- [ ] [Task description] — due [date] *(added [date])*`

### Completing Tasks

When Jack says a task is done:
1. Change `- [ ]` to `- [x]`
2. Move it to the **Completed** section with the completion date:
   `- [x] [Task description] *(completed [date])*`

### Reviewing Tasks

When Jack asks "what's next?" or "what should I work on?":
1. Read `tasks.md`
2. Present Priority/Today items first
3. Then This Week items
4. Flag any overdue items
5. Check if recurring tasks are due

### Weekly Cleanup

Periodically (or when asked):
1. Move completed tasks to the Completed section
2. Promote "This Week" items to "Priority / Today" if it's late in the week
3. Move expired "Upcoming" items up as their dates approach
4. Archive old completed tasks (move to `archives/` if the list gets long)

## File

All task data lives in `tasks.md` at the repo root.
