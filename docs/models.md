# The models file

`models.json`, at the root of Ember's repository, lists the models [Ember AI](self-hosting.md#ember-ai)
offers besides Workers AI's: Anthropic's Claude and OpenAI's GPT, each asked through AI Gateway's
endpoint for its provider, in the provider's own API, and xAI's Grok, asked through Cloudflare's REST
API through the same gateway, as AI Gateway's credits don't pay for it at the xAI endpoint. Every copy of Ember reads it from the
main branch once a day, at

```
https://raw.githubusercontent.com/NYLLON-SOFTWARE/ember-cloudflare/main/models.json
```

so that a model can be offered, or stop being, without anyone updating their copy. Until a copy has
read the file, and whenever it can't, it offers the one its release shipped with, the file as it was
when the release was made. A file that can't be read, as when GitHub doesn't answer, or isn't one the
copy reads, leaves it offering what it offered before, and it tries again an hour later.

The file can say only which models are offered: what each is called, what it costs, what it may do on
the web, and the day its maker stops running it. It names no address. A model's ID starts with its
provider's, `anthropic/`, `openai/` or `xai/`, which says where Ember asks it, and a model whose ID
starts with anything else is left out, as is any field Ember doesn't know. Ember reads at most 64 KB of
the file, and 50 models.

## What it says

```json
{
  "about": "What the file is, for whoever opens it.",
  "version": 1,
  "suggested": "anthropic/claude-haiku-5.5",
  "models": [
    { "id": "anthropic/claude-haiku-5.5", "name": "Claude Haiku 5.5", "price": { "input": 0.1, "output": 0.5 }, "web": ["search", "read"] },
    { "id": "openai/gpt-6-luna", "name": "GPT-6 Luna", "price": { "input": 0.1, "output": 0.5 }, "web": ["search"], "until": "2027-01-15" }
  ]
}
```

- `version` is 1, the only version this Ember reads.
- `suggested` is the model Set up Ember AI starts at, while the file lists it, or else the first one.
- `models` lists each model on a line of its own, in the order the menus show each maker's:
  - `id` is the model's ID as AI Gateway lists it, its provider's name and then the model's, such as
    `anthropic/claude-sonnet-5.5`. Ember asks Anthropic's endpoint for `claude-sonnet-5-5`, with the
    dots turned into dashes, as Anthropic names its models, OpenAI's for the part after the slash as
    it is, and the REST API for Grok by the whole ID.
  - `name` is what the menus call it, at most 100 characters.
  - `price` is what a million tokens read, `input`, and a million written, `output`, cost in US dollars
    at the provider's prices, which AI Gateway's credits pay: from 0 to 1,000 each.
  - `web` is what the model may do on the web while Search the web is on, of what its provider's API
    has tools for: `"search"`, and for Claude `"read"` too, for reading pages. Grok searches with Ember's
    own tool, which Cloudflare's Web Search API runs, so `"search"` is all it can take. Leave one out for a
    model that doesn't take it through AI Gateway, or write `[]` for one that can't search at all.
  - `until`, which can be left out, is the day the model's maker stops running it, as YYYY-MM-DD. The
    menus say so beforehand, and Ember offers it until the day before.

A model missing any of those, or with one Ember can't read, is left out, and a file that isn't version
1, or lists no model Ember can offer, isn't read at all. A model the file stops offering stays wherever
it was chosen, marked "no longer offered", and answers as it did until someone chooses another, so
taking one out of the file never leaves @ember or an agent without a model.

## Changing it

Change it in a pull request, as any other file: once the change merges to main, every copy offers
what the file lists within a day. Keep each model on one line, as the weekly check writes them.

- **To offer a model**, add its line. Try it first in a copy of your own that reads the branch's file:
  set `EMBER_MODELS_URL` to the file's raw address on the branch, such as
  `https://raw.githubusercontent.com/NYLLON-SOFTWARE/ember-cloudflare/<branch>/models.json`, in
  `.dev.vars` for `pnpm dev`, and choose the model in Set up Ember AI. Ember asks it a test question,
  then the same question at each Thinking level, and turning on Search the web asks it a question it
  has to search the web for, which shows whether AI Gateway takes the tools its `web` lists. A copy
  reads the file at a new address at once.
- **To stop offering one**, take out its line, or give it the `until` its maker announced, so that the
  menus say when it goes.
- **To change what one costs**, change its `price`. The weekly check does this when models.dev and
  LiteLLM agree.

Never change `version` in place. A copy reads only the version it knows, so a file of another version
would leave every older copy offering the models its release shipped with, without saying why. Add
what a later Ember needs as fields an older one can leave out, or, for a change it can't, in a new file
beside this one, such as `models-2.json`, which the releases that know it read, while this one stays
version 1 for the copies already deployed. For the same reason, never rename or move the file: copies
read it at this address for good.

## The weekly check

The Check models workflow, `.github/workflows/check-models.yml`, runs
`apps/worker/scripts/check-models.ts` in Ember's own repository every Monday, and whenever it's run
from the Actions tab. It compares the file with two lists that follow the providers' models,
[models.dev](https://models.dev)'s and [LiteLLM](https://github.com/BerriAI/litellm)'s:

- A price both say has changed is changed, and the day LiteLLM says a model is deprecated becomes its
  `until`.
- A price only one of them says has changed, a price they disagree on, a model neither lists, and one
  that models.dev calls deprecated without a day are listed for whoever reviews the change to look at.
- So are the makers' models released after the newest one in the file that take tools and read and
  write text. None is added: a model is added by hand, with what it may do on the web, once it's been
  tried through AI Gateway.

With something to change, the check pushes a branch, `check-models/` and the start of a hash of the
new file, unless an earlier week pushed it already, and opens a pull request with the change and what to look at, closing the ones earlier weeks
left open. With nothing to change but something to look at, it opens an issue, or edits the one it
opened before, and with nothing at all it closes them. Each change is read as every copy would read
it first, so the check never opens a pull request with a file Ember wouldn't read. GitHub doesn't run
checks on a pull request a workflow opens, so CI runs on the change once it reaches main. If the
repository doesn't let workflows open pull requests, under Settings, Actions and General, the check
opens an issue with a link that opens the pull request instead.

`node apps/worker/scripts/check-models.ts`, without `--publish`, changes `models.json` in place and
says what it found, without pushing anything.

## Workers AI's models

Workers AI's models aren't in the file. Each copy lists them with Cloudflare's model search,
`GET /accounts/{account_id}/ai/models/search`, in OpenRouter's format, once a day for the account Ember
AI asks through, and again whenever Set up Ember AI is given a token. It offers the text models that
take tools, as Ember's own for searching the web is, and read and write text, but for experimental
ones, at most 200, with the names, prices, Thinking levels and retirement days the search lists, and
asks them through Cloudflare's REST API, in Chat Completions. The search and the REST API take the
Workers AI Read permission on Ember AI's API token. While the token can't list them, the menus say why,
and don't mark a Workers AI model chosen before as no longer offered, as Ember may offer it still.

## Where a copy reads it

`EMBER_MODELS_URL` changes where a copy reads the file: an https address, such as a branch's file, or
blank, to offer only the file its release shipped with, as the Worker's tests do. The browser tests
point it at their stand-in for Cloudflare, at a loopback address.
