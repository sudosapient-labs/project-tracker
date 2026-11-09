---
name: file-issues
description: Turn a request or a Slack discussion into well-formed tasks.
---

Use when someone asks to file, log, create, track or "make issues from" something.

1. Work out the project: the one the person names, else the channel's linked project. Without
   either, file straight away only when exactly one project's name plainly covers the request;
   otherwise ask in one short question listing the likely projects, and file nothing until they
   answer. Never pick between two plausible projects yourself.
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
   today's date in the message, as YYYY-MM-DD. When a time is given ("by 11:59pm today", "Friday
   5pm"), add it as YYYY-MM-DD HH:MM (24h), on the clock the message names; dues can hold a time.
7. Reply with what you created: key, title and assignee for each, in one short list.
