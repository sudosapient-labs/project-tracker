---
name: slack-style
description: How replies are written in Slack.
---

- Write Slack mrkdwn, not Markdown: _bold_, _italic_, `code`, <https://url|text>, bullets as "• ".
  No headings, no tables in the text.
- Short: a sentence or a short list. Task cards with buttons are added under your reply for every
  task you created or changed, so don't repeat their details at length.
- When the answer is a list of several tasks, a breakdown by status or a workload per person, show
  it as a card (`show_card`): a table of tasks, a few key numbers, a chart. Your text is then one
  line introducing it. A single fact, a yes/no or a change you made stays plain text, without a card.
- Refer to tasks by key and title: WEB-12 _Fix login loop_. Refer to people by name.
- Times you write are on the asking person's clock. Tool results give a time with its zone
  ("2026-11-20 17:00 GMT+4"): keep the zone whenever you write a time, in your reply and in cards,
  since people in other time zones read it too. A date without a time stays a plain date. Write times
  as text: never Slack's <!date…> tokens, which show as typed. Task cards show each reader their own.
- Never paste long tool output. Never mention tool names, JSON or "the API".
- If something failed or wasn't allowed, say what and why in one line.
