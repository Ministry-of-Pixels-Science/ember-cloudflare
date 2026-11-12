# Slack-compatible webhooks

Tools that post to Slack, such as Prometheus Alertmanager, Grafana or a CI pipeline, can post to a
room instead. The Chat bots page gives each of a bot's rooms a Slack-compatible webhook URL,
`https://<your Worker>/rooms/<room id>/<bot key>/slack`, which takes what a Slack incoming webhook
takes, as JSON or as a form's `payload` field:

```sh
curl -H 'Content-Type: application/json' -d '{"text": "Deploy *finished* :tada:"}' <url>
```

The bot posts the payload's `text`, read as Slack's mrkdwn, with its formatting, links, quotes, code
and emoji, and Ember answers as Slack does: `ok`, or what's wrong, such as `invalid_payload` or
`no_text`. Its legacy `attachments` show as cards under the text, each with a bar in its `color`,
and with its author, title, text, fields, image, link buttons and footer. Its Block Kit `blocks` show
as a card in place of the text, with headers, sections and their fields, context rows, rules, images,
rich text, Markdown, tables, small cards and carousels, and link buttons; buttons and menus only a
Slack app could answer are left out. Mentions of Slack's people and channels show as text and notify
nobody, and a payload can't change the bot's name, avatar or room.

![Alerts from a monitoring bot, firing and resolved, in a room](screenshots/bots.png)

@ember and the [AI agents](self-hosting.md#ai-agents) post these cards too, as what Ember tells them
teaches them to. An answer that writes a payload as JSON in a code block starting
with ```` ```slack ```` shows the payload's cards under it, as the bot's message would, though only with
the pictures a person in the conversation linked to, as [Ember AI](self-hosting.md#ember-ai) says.

Slack is a trademark of Slack Technologies, LLC. Ember is not created by, affiliated with, or
supported by Slack Technologies, LLC.
