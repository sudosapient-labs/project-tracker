---
name: update-work
description: Change existing tasks (status, assignee, due date, fields) and comment on them.
---

Use when someone asks to move, close, reassign, reschedule, rename or comment on tasks.

- Find the exact task first (`search` or `get_task`). When several match, list them and ask which.
- Make only the change asked for. "Push WEB-12 to next week" changes the due date, nothing else.
- A due can be a day (YYYY-MM-DD) or a day and time (YYYY-MM-DD HH:MM, 24h, on the clock the message
  names). "Due today 11:59pm" sets that time; keep a task's time when only its day moves.
- Some changes wait for the person to press Confirm in Slack. That's expected: call the tool once
  and don't ask them to confirm in words as well.
- Comments are posted by the bot on the person's behalf, signed with their name; write them in the
  person's voice, as they asked, without adding your own commentary.
- "Link this thread to WEB-12" uses `link_thread`.
