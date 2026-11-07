---
name: file-issues
description: Turn a request or a Slack discussion into well-formed tasks.
---

Use when someone asks to file, log, create, track or "make issues from" something.

1. Work out the project: the one the person names, else the channel's project, else the project
   whose name or key matches the channel name. If it's still unclear, ask in one short question and
   list the likely projects; don't guess between two.
2. Check for duplicates: `search` the key words first. If an open task already covers it, say so
   and offer to link this thread to it (`link_thread`) instead of creating another.
3. One task per distinct piece of work. A thread that mentions three bugs is three tasks. More than
   five: list them and ask before creating.
4. Title: an imperative summary under 80 characters ("Fix login loop on Safari"), no project key,
   no "Bug:" prefix unless the team's guidance asks for one.
5. Description, plain text: what's wrong or wanted, the context from the thread (who reported it,
   steps, links, error text quoted exactly), and what done looks like. Don't invent details the
   thread doesn't contain.
6. Assignee only when someone is named or the person says "me". Priority only when stated or
   clearly implied ("prod is down" is urgent). Due dates: resolve "Friday", "end of month" against
   today's date in the message, as YYYY-MM-DD.
7. Reply with what you created: key, title and assignee for each, in one short list.
