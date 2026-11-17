# Self-hosting Ember

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NYLLON-SOFTWARE/ember-cloudflare)

Everything about running your own Ember: deploying it, the settings an administrator turns on, what it
costs, and where it keeps messages. The [README](../README.md) has the short version, and
[Development](development.md) covers working on the code.

The button copies this repository to your GitHub or GitLab account and deploys it to your Cloudflare
account, as [Deploying](#deploying) describes.

- [Deploying](#deploying)
  - [Updating](#updating)
  - [Betas](#betas)
  - [The build's token](#the-builds-token)
  - [A custom domain](#a-custom-domain)
  - [Who can join](#who-can-join)
  - [Memberful sign-in](#memberful-sign-in)
  - [Sending email](#sending-email)
  - [Inviting people by email](#inviting-people-by-email)
  - [Push notifications](#push-notifications)
  - [Files](#files)
  - [Ember AI](#ember-ai)
  - [AI agents](#ai-agents)
  - [Apps](#apps)
  - [Outside AI](#outside-ai)
  - [Huddles](#huddles)
  - [A preview from GitHub Actions](#a-preview-from-github-actions)
  - [A demo from GitHub Actions](#a-demo-from-github-actions)
  - [Resetting a password](#resetting-a-password)
  - [Security notes](#security-notes)
- [What it costs](#what-it-costs)
- [Storage: Durable Object SQLite or D1](#storage-durable-object-sqlite-or-d1)

## Deploying

The Deploy to Cloudflare button at the top asks you to name the repository, the Worker, the R2
bucket for files (turn R2 on for your account first) and a D1 database, to choose where messages
live, as [Storage](#storage-durable-object-sqlite-or-d1) says, and to make up a setup password,
`EMBER_SETUP_PASSWORD`, then Cloudflare's Workers Builds builds and deploys it, and again after
every push to the copy. Connecting GitHub or GitLab to Cloudflare the
first time leaves you on Cloudflare's page for deploying one of your own repositories, so click the
button again afterwards. If your account already has a bucket named `ember`, the form picks it, so
pick a new one there for this Ember's files, and choose Create new for the database if it picks one
another Ember uses. The copy has all of Ember but its `.github` folder, so
add the Update Ember workflow to it, as [Updating](#updating) says, for it to be offered Ember's
releases.

Cloudflare can build the copy before it has finished copying Ember into it. That first build then
stops at `pnpm run build` with `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`, `No package.json ... was found`,
because the commit it built holds only Cloudflare's `wrangler.jsonc`, and that commit isn't in the
copy's history afterwards. Push any commit to the copy, such as an edit to its README in GitHub's
editor, and Workers Builds builds and deploys the copy as it is.

To deploy from your machine instead, after `pnpm exec wrangler login`:

```sh
pnpm build
pnpm run deploy        # not `pnpm deploy`, which is pnpm's own command
```

Either way, `pnpm run deploy` (`apps/worker/scripts/deploy.ts`) makes the Worker's `SESSION_SECRET`
and a VAPID key pair for push notifications on its first deploy, and later deploys keep them, since
a new secret would sign everyone out and a new pair would end every push subscription. They go up
with the code and never appear in the deploy's output. So does the ID of the Cloudflare account the
Worker goes to, as `CLOUDFLARE_ACCOUNT_ID`, which a Worker can't find out by itself, for
[Set up Ember AI](#ember-ai) to fill in: the account the `CLOUDFLARE_ACCOUNT_ID` environment
variable names, if it's set, or else the only one your login reaches, as a Deploy to Cloudflare
build's token does. A login that reaches several gives none, unless you set the variable, and the
field starts blank. Where git's origin is a copy of Ember on GitHub, as a Deploy to Cloudflare build's
is, the deploy tells the Worker about it in three variables, for General's release card to link to
its Update Ember workflow ([Updating](#updating)): `GITHUB_REPOSITORY`, the copy's `owner/name`;
`GIT_BRANCH`, the branch that deploys, Workers Builds' or else `main`; and `UPDATE_WORKFLOW`, `true`
where the copy has the workflow. A `--var` of the same name keeps its own value.

Whoever deployed Ember sets it up, and nobody else. After Deploy to Cloudflare, open the Worker's
address and type the setup password you gave the form: `/first_run` asks for it before the
administrator's account, so nobody who merely finds the address can make themselves the
administrator, and it allows 10 tries at the password every 10 minutes, from anywhere, so guessing
it is slow. Once Ember is set up, setup closes for good, as in Campfire. If the password is
forgotten, give `EMBER_SETUP_PASSWORD` a new value in the Worker's **Settings**, under **Variables and
Secrets**, or from a terminal, and type that one:

```sh
pnpm exec wrangler secret put EMBER_SETUP_PASSWORD   # asks for it; add --name <worker> for a Worker not named in wrangler.jsonc
```

A first deploy from a terminal, for a Worker with no setup password, makes the Worker a setup token,
`EMBER_SETUP_TOKEN`, instead, and once it has deployed, prints the setup link that carries it,
`https://<your Worker>/first_run#token=<the token>`, which opens the form without asking for a
password. The token rides in the link's fragment, which no request or log sees, and the link is
spent once Ember is set up. If it's lost, give the Worker a setup password as above, or make a new
token, give it to the Worker, and open the link with that one:

```sh
openssl rand -hex 32                              # the new token: keep it
pnpm exec wrangler secret put EMBER_SETUP_TOKEN   # asks for it; add --name <worker> for a Worker not named in wrangler.jsonc
```

A deploy whose environment sets `EMBER_SETUP_PASSWORD` gives a Worker without one that password, and
makes it no token. A setup password of any length opens setup, as the deploy form can't ask for a
longer one; a setup token set to anything but 64 lowercase hex characters counts as a setup
password. Spaces and line breaks around either, which pasting can bring along, don't count. On
localhost, where `wrangler dev` serves, setup is open to whoever's there unless `.dev.vars` sets a
setup password or token.

The setup form suggests Kevin Rose and kevin@kevinrose.com for the administrator. To suggest your
own, set the Worker's `EMBER_SETUP_NAME_PLACEHOLDER` and `EMBER_SETUP_EMAIL_PLACEHOLDER` variables,
in `vars` in `wrangler.jsonc` for instance.

The administrator then signs in at `/session/new` with the email address and password they set up
with, and invites people with the join link on general's welcome card.

Ember insists on HTTPS, as Campfire does: plain HTTP is redirected to the same address over HTTPS,
and every answer from the Worker carries HSTS, except on `localhost` and loopback addresses, where
`wrangler dev` serves. Unlike Campfire's, it holds only the address it's given at to HTTPS, not the
names under it, which would be every name on a domain whose apex is Ember's custom domain. To serve
plain HTTP anywhere else, such as `wrangler dev --ip 0.0.0.0` for a phone on your network, set the
`DISABLE_SSL` variable to any value. `/up` answers 200 for uptime checks, as Rails' does, without
touching storage.

### Updating

Ember publishes [releases](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases), and a copy
made with Deploy to Cloudflare comes up to each with a pull request from its Update Ember workflow,
`.github/workflows/update-ember.yml`, once you add it. Cloudflare's copy leaves out Ember's `.github`
folder, so every deploy without the workflow ends its build log by saying so, and where git tells the
build which GitHub repository it's from, with a link that opens GitHub's editor on your copy with
Ember's workflow filled in: commit it there. Or create the file in your copy, on GitHub with **Add
file**, then **Create new file**, with what
[Ember's](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/blob/main/.github/workflows/update-ember.yml)
has.

The workflow looks for a newer release every Monday, or when you run it from the Actions tab (Update
Ember, then Run workflow), and opens a pull request, "Update Ember to v1.2.3", that links to what's
new. It brings releases alone, never a beta unless you ask for one, as [Betas](#betas) says. Merging
it deploys the update, as every push to `main` does, and that's all: each room's and the
workspace's tables bring themselves up to date the first time they open. A page left open goes on
running the Ember it loaded, so within a minute of the deploy while it's shown, or as it's shown
again, it says **Ember has been updated**, with **Reload** to load the update. Closing the pull request
instead turns that release down until the next, whose pull request brings its changes too. Workers
Builds builds each pull request's branch as a Preview, and the pull request shows whether it built;
that's all a Preview is for, since `wrangler.jsonc` gives Previews none of Ember's bindings and no
address.

Ember tells its administrators too: while a newer release is out, Admin on the rail has a dot, and
General, in Community settings, names the release, with its notes and how to update. For a copy the
deploy told the Worker about, **Open GitHub action to update** opens the copy's Update Ember workflow
on GitHub, where **Run workflow** opens the pull request now, or, while the copy has no workflow,
**Add GitHub action to update** opens GitHub's editor with it filled in, as the build log's link does.
To know, the Worker asks GitHub for the page of Ember's latest release once an administrator has Ember
open, telling it nothing but the version it is, and keeps the answer for six hours, but asks again
each time an administrator opens Admin, or presses **Check for updates** on General's Ember card, at
most once a minute. Under the button, the card says when GitHub last named the newest release.

A new GitHub repository doesn't let workflows open pull requests, so until yours does, the workflow
opens an issue instead, with a link that opens the pull request for you to merge. To have it open them
itself, tick **Allow GitHub Actions to create and approve pull requests** in your repository's
**Settings**, under **Actions**, **General**, **Workflow permissions**, and save.

Your copy shares no history with Ember's repository, so an update brings only what Ember changed
since the commit your copy was made from, or the release its last update brought, and keeps whatever
you changed, such as the names Deploy to Cloudflare gave your Worker and bucket in `wrangler.jsonc`.
Where one of Ember's changes meets one of yours, the pull request is a draft that names the files: edit
them on its branch to keep what both need, then merge it. Most have conflict markers around both
versions, yours after `<<<<<<< HEAD` and Ember's after `=======` up to `>>>>>>> ember/v1.2.3`; for a
file one side deleted, one that isn't text, or one in a folder Ember moved, it gives git's note on
what it did. GitHub doesn't let a workflow change workflows either, so an update leaves your copy's as
they are. Ember's others run only in its own repository, and when Update Ember's has a new version,
the pull request says so, for you to copy it over yours.

A release's migrations add to Ember's tables rather than take anything away, so reverting an update's
merge, which deploys the release before it, leaves tables that release still works with. The next
release's pull request brings the reverted one's changes again, with its own. To stop updates, disable
the workflow in the Actions tab.

`apps/worker/scripts/update-ember.ts` makes the update, wherever git 2.40 or newer runs. For a copy on
GitLab, which doesn't run GitHub's workflows, or to update by hand, run it in a clone of your copy, and
it leaves the update on a branch for you to push and merge:

```sh
node apps/worker/scripts/update-ember.ts    # makes update-ember/<the release>
git push -u origin update-ember/v1.2.3      # then merge it into main
```

A clone of Ember's own repository shares its history, so `git pull` brings it up to date too, or the
script, which merges from where yours and Ember's part.

### Betas

Before a release with big changes, Ember may publish betas of it, such as `v0.5.0-beta.1`, on its
[releases page](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases), marked as
pre-releases, for trying what's coming. Nobody gets one without asking: Update Ember brings a copy
releases alone, and a copy whose update script predates betas, as Ember 0.4.2's and earlier do,
doesn't see them at all. While a beta is out ahead of the newest release, General offers it to an
Ember on the newest release, in a reddish box of its own under the Ember card, since a beta is
experimental: **Ember 0.6 beta 1 is out to try**, with its notes and how to try it. Admin on the rail
has no dot for it. To know, the Worker asks GitHub for Ember's tags as `git ls-remote` does, with its
check for the latest release, telling it nothing but the version it is.

To try a beta:

- As a new Ember: the Deploy to Cloudflare button at the top of the beta's notes deploys it as
  [Deploying](#deploying) describes, with a Worker, bucket and database of its own, so it's a new
  community, apart from any you run.
- On your computer: in a clone of Ember, `git checkout v0.5.0-beta.1`, then `pnpm install`,
  `pnpm build`, which `pnpm dev` serves the app from, `pnpm dev`, and `pnpm seed` for a community
  to try it in, as [Development](development.md#getting-started) says.
- On a copy you have: run its beta workflow, **Update Ember to its newest beta**, from the Actions
  tab, and merge the pull request it opens. For a copy the deploy told the Worker about, General's
  **Open GitHub action to try it** opens the workflow on GitHub, where **Run workflow** runs it, or,
  while the copy hasn't the workflow, **Add GitHub action to try betas** opens GitHub's editor with
  Ember's filled in, `apps/worker/scripts/update-ember-beta.yml`, for you to commit. It runs the update
  script from Ember's newest release or beta rather than the copy's own, so it works however old the
  copy is. Update Ember's **Take Ember's newest beta** box, in the workflow Ember has had since 0.5
  beta 1, does the same with the copy's own script. Elsewhere, as on GitLab, run the beta's script in a
  clone of the copy, and push the branch it makes:

  ```sh
  git fetch https://github.com/NYLLON-SOFTWARE/ember-cloudflare.git refs/tags/v0.5.0-beta.1
  mkdir ../ember-beta && git archive FETCH_HEAD apps/worker/scripts | tar -x -C ../ember-beta
  node ../ember-beta/apps/worker/scripts/update-ember.ts --beta   # makes update-ember/v0.5.0-beta.1
  git push -u origin update-ember/v0.5.0-beta.1                   # then merge it into main
  ```

  Run by hand, it brings Ember's workflows too, so in a copy Deploy to Cloudflare made, which has no
  `.github` folder, it names those the beta changed as conflicts: on the branch, keep
  `.github/workflows/update-ember.yml`, which brings the betas after it and the release, remove the
  rest, which run only in Ember's own repository, and commit before you push.

A copy that runs a beta is offered the betas after it, then the release, each as a pull request like
any update's, and from then on releases alone, until it asks for a beta again. A pull request for a
beta it asked for stays open until a release passes it. Its General says it's a beta, ahead of the
newest release, and the newest beta until a later one is out, which it says is available, then the
release, as Admin's dot does. General learned of betas in 0.5 beta 2, so 0.5 beta 1's says nothing of
the betas after it, though Update Ember and the beta workflow bring them. A beta's migrations count as
released ones, so a copy goes from beta to beta to release as it does from release to release, and
reverting a beta's update leaves tables the release before it still works with.

### The build's token

Workers Builds deploys a Deploy to Cloudflare copy with an API token it made for the copy's Worker,
`<your Worker> build token`. It holds far more than the seven permissions Cloudflare's docs list for
it: it may edit every Worker, R2 bucket, KV namespace, D1 database and queue in the account, its AI
and containers among much else, and the Workers Routes, certificates and Email Routing rules of every
zone in every account you belong to. That's why R2's **Manage API tokens** page lists it as Admin
Read & Write for all buckets. Ember's builds need four of those permissions: Workers Scripts, to
deploy the Worker, and Account Settings, User Details and Memberships, with which `pnpm run deploy`
finds the account's ID. On `d1` they need D1 as well, to make and migrate the database messages live
in ([Storage](#storage-durable-object-sqlite-or-d1)); on `do-sqlite` the deploy leaves the form's
database unbound and never touches D1. The Worker reaches its bucket through its binding, which takes
no token, the deploy form makes the bucket before the first build, and `wrangler.jsonc` binds no
namespace or queue and lists no routes. So once your copy has deployed, trim the token. In **My
Profile**, under **API Tokens**, choose **Edit** on it, remove every permission but Workers Scripts,
Account Settings, User Details and Memberships, and D1 on `d1`, and choose **Update token**. Edit
keeps the token's value, which the builds hold, where Roll would give it a new one and fail every
build until the Worker's **Settings**, under **Build**, name a token again.

Every build runs with that token, those of Update Ember's pull requests included, so the less it may
do, the less a dependency gone bad could. The Worker's **Settings**, under **Build**, name the token
it builds with, and deleting the Worker leaves the token as it was: delete it too, under **API
Tokens**, unless another Worker builds with it.

Trimmed, the token can still deploy Workers, and a Worker may be bound to any bucket, database or
namespace in its account, whatever its deployer's token may do with them. So keep what Ember's
deploys shouldn't reach, such as another project's files, in a Cloudflare account of its own.

### A custom domain

Ember answers at its workers.dev address until an administrator gives it one of your own, under
Domain settings in Workspace settings, at the workers.dev address, and at any other with Move to another
domain. They type the address, `chat.example.com` say, and choose Set up, which first checks whether
the address already reaches Ember, as one added to the Worker before does, and then offers just Save.
Otherwise it asks Cloudflare's resolver for the zone the address is in, `example.com`, and whose
nameservers serve it, and picks that provider in the DNS provider menu, or Cloudflare when it can't
tell. Ember holds no Cloudflare token to
add the address itself, since a token that can add a domain to the Worker can also deploy new code to
it, so the steps open the dashboard, copying what to paste there. With Cloudflare chosen:

1. If DNS found the domain at another provider, move its DNS to Cloudflare, which is free and copies
   its records, since a Worker's Custom Domain must be on a domain whose DNS Cloudflare runs, in the
   account that runs the Worker. Open Cloudflare copies `example.com` and opens the dashboard's
   Domains, where Onboard a domain takes it and names two nameservers, and the next step says where
   that provider takes them.
2. Once the domain is active on Cloudflare, add the address as a Custom Domain of Ember's Worker: Open
   Cloudflare copies `chat.example.com` and opens the Worker's Domains tab, from the workers.dev address
   Ember remembers being opened at, where Add Domain takes it. Cloudflare makes the DNS record and the
   certificate.
3. Use chat.example.com, which asks the address from the Worker for a one-time probe only this Ember
   answers, makes it Ember's address once it does, and opens Workspace settings there. Until then it
   says nothing answers there yet, or that something else does, so Ember is never sent to an address
   that doesn't reach it.

With any other provider chosen, the domain's DNS stays there, and the steps are those of
[When the domain's DNS is elsewhere](#when-the-domains-dns-is-elsewhere), ending with the same Use.

From then on, a page opened at any other address moves to the same page at the new one, and the bot
API's links name it. Everyone signs in once more there, since a session belongs to its address, and
turns notifications on again, which replaces their browser's subscription at the old address. Bots
and webhooks go on posting to the addresses they were given.

Moving to another domain takes the same steps, and Go back to the workers.dev address makes it
Ember's address once more, once the Worker finds Ember still answers there. Either way, every other
address sends people to Ember's, the domain it left included: that domain reaches Ember until it's
removed on the Worker's Domains tab, which only the dashboard does. So Custom domain names the domains
Ember moved away from, links to that tab, and checks each until it's gone. Workspace settings stay
wherever they're opened, so if Ember's domain ever stops reaching it, open Domain settings at the
workers.dev address and go back there. Deploys leave the domain alone as long as `wrangler.jsonc` lists no
`routes`, and keep the workers.dev address on (`workers_dev`), for going back.

#### When the domain's DNS is elsewhere

Cloudflare gives a Worker a Custom Domain only on a domain whose DNS it runs. To leave the DNS where
it is, Ember takes the address through Cloudflare for SaaS instead, as Set up's steps say once
another provider is chosen in the DNS provider menu. That takes another domain already on Cloudflare
in the account that runs Ember, `example.net` say, which the steps ask for, and a payment method,
though the first 100 addresses are free. In the Cloudflare dashboard, on example.net:

1. Under DNS, Records, add a proxied `AAAA` record, `ember-saas`, for `100::`, an address that goes
   nowhere.
2. Under SSL/TLS, Custom Hostnames, enable Cloudflare for SaaS, make `ember-saas.example.net` the
   Fallback Origin unless example.net has one already, and add `chat.example.com` with HTTP
   validation. Keep a Fallback Origin that's there: replacing it would send example.net's other custom
   hostnames to `100::`, and the route below takes chat.example.com to Ember whatever it is.
3. Under Workers Routes, route `chat.example.com/*` to Ember's Worker, and
   `chat.example.com/.well-known/*` to no Worker, so that Cloudflare itself answers the certificate
   authority when it issues and renews the address's certificate. A route for `*/*`, as Cloudflare's
   guide suggests, would send all of example.net to Ember.

Then, at example.com's DNS provider, add a `CNAME` record named `chat` for `ember-saas.example.net`,
which the steps say where each provider adds. That record is why the address must be a name under
the domain, such as chat.example.com: example.com itself can't be a CNAME. Once Custom Hostnames shows
the address and its certificate active, Use chat.example.com makes it Ember's address.

### Who can join

New people join with the join link until an administrator changes how under Who can join, in
Workspace settings' Membership, where each way has a switch:

- Open, off until it's turned on, lets anyone create an account at `https://<Ember's address>/join`,
  which the sign-in page links to as Create an account. Nobody checks that an email address is the
  owner's. Until Ember has Turnstile's keys, below, each network can sign up 5 people an hour, and
  once 50 people have joined in an hour, however they joined, signing up waits, so a flood can't use
  up the rows Workers Free writes in a day.
- Join link, on until it's turned off, lets in anyone with the link. Off, the link sends people to
  sign in, and on again, it's the same link.
- Email domain, off until it's turned on, lets in people with an email address at the domains an
  administrator lists, such as their company's. They ask for a link at
  `https://<Ember's address>/join/email`, which the sign-in page offers as "Have an address at
  example.com? Join with it", and Ember emails them one that joins with that address, once, within
  an hour, so turning it on before Ember can send email sets that up first, below. Ember emails an
  address at most 3 times an hour, whoever asks, links and the codes that [reset a forgotten
  password](#resetting-a-password) together, so nobody can fill someone's inbox with them, counting
  only the emails the provider takes, and until Ember has Turnstile's keys, each network can ask for
  10 links an hour. Each link is an email, so the provider's limits apply.
- Memberful, below, lets in the members of a Memberful site, who sign in with their Memberful
  accounts while everyone else keeps a password. Its Members only switch keeps signing in to them
  and administrators.

While Open is on, Join link, Email domain and Memberful are set aside, keeping their settings, and
while Memberful is members only, Open, Join link and Email domain are, so Open and Members only can't
both be on. With all four off, only the people administrators invite by email, below, can join.

To have open sign-up, Email domain's page and the page for a forgotten password check that whoever
uses them is a person, an administrator sets up [Turnstile](https://developers.cloudflare.com/turnstile/),
which is free, by turning on the switch on Membership's Turnstile card, or with Set up Turnstile, under
the limits Open and Email domain say. It links to Turnstile in the Cloudflare dashboard, where they add a widget for
Ember's hostname in Managed mode, then takes the widget's site key and secret key and draws its check.
Once the check passes, Ember asks Cloudflare whether the secret key is the same widget's, and keeps
both, the secret key encrypted. Turning the card's switch off takes them away.

The sign-up page, Email domain's and the forgotten password page then show Turnstile's check, and the
Worker asks Turnstile about each form before it makes the account or emails the link or code, in place
of the limits on a network, which a room full of people on one network, or a launch, would soon reach.
Signing in has no check, so that one that doesn't load never locks anyone out; it has its own limit.

A deployment can give the Worker a widget's keys as secrets instead, which take the place of any given
in Membership, whose card then names them:

```sh
pnpm exec wrangler turnstile widget create Ember --domain chat.example.com --mode managed
pnpm exec wrangler secret put TURNSTILE_SITE_KEY     # add --name <worker> for a Worker not named in wrangler.jsonc
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
```

`pnpm run deploy` uploads the two when its environment has them, as it does Memberful's keys, so the
Preview workflow passes repository secrets of the same names through.

### Memberful sign-in

The members of a [Memberful](https://memberful.com) site can join and sign in with their Memberful
accounts instead of passwords. It's off until an administrator turns it on under Memberful in
Membership, which the first time opens Set up Memberful, with three steps:

1. The site's address, the one in the browser while you're signed in to Memberful's admin, such as
   `yoursite.memberful.com`, or the site's name alone, `yoursite`. Either way Ember keeps it as
   `https://yoursite.memberful.com`, the site a `MEMBERFUL_URL` of that address names, so members
   linked at one are linked at the other.
2. A custom app, a new one for Ember, since its redirect URL must point at Ember. Once an address at
   memberful.com is given, the step links to Memberful's form for one, since Settings in Memberful's
   sidebar opens the account's profile. Name it Ember, check Include OAuth tokens with this
   application, choose Server-side Application, even for a site with a mobile app, since Ember's
   server handles the sign-in, and give it the OAuth Redirect URL the step shows,
   `https://<Ember's address>/auth/memberful/callback`, with a button that copies it. Saving it opens
   the app's page, whose API Key, OAuth Identifier and OAuth Secret go into the step in that order.
   Leave Memberful's automatic sign-in off, since it skips the check that ties a sign-in to the
   browser that started it.
3. A webhook, which is separate from the app: under Settings → Webhooks → Create webhook, which the
   step links to as well, name it Ember, give it `https://<Ember's address>/webhooks/memberful` as the
   Endpoint URL, which the step copies too, and select every event under Member, Order, Subscription
   and Plan. Download isn't needed. Then copy the secret key Memberful gives it into the step. With
   it, a member whose membership ends is signed out at once, rather than at Ember's daily check.

Ember tries the API Key on Memberful's admin API, and asks its token endpoint whether it knows the app
by its OAuth Identifier and Secret, before it keeps them, saying on the field what Memberful didn't
take, then turns Memberful on. It keeps the three secrets in the workspace's settings, encrypted as a
Resend API key is, never shows them again, and can't read them once `SESSION_SECRET` changes, until
an administrator gives them again. Change keys, under Memberful while it's on, asks for them all again.
Nothing needs a Worker secret or a deploy.

A Worker can have the keys as secrets instead, which take the place of any given in Set up Memberful,
all of them together, and Membership's card then says so: `MEMBERFUL_URL`, the site's address,
`MEMBERFUL_CLIENT_ID` and `MEMBERFUL_CLIENT_SECRET`, the app's OAuth identifier and secret, and for
the webhook, `MEMBERFUL_WEBHOOK_SECRET` and `MEMBERFUL_API_KEY`. Each command asks for its value:

```sh
pnpm exec wrangler secret put MEMBERFUL_URL      # add --name <worker> for a Worker not named in wrangler.jsonc
pnpm exec wrangler secret put MEMBERFUL_CLIENT_ID
pnpm exec wrangler secret put MEMBERFUL_CLIENT_SECRET
pnpm exec wrangler secret put MEMBERFUL_WEBHOOK_SECRET
pnpm exec wrangler secret put MEMBERFUL_API_KEY
```

Or add them under the Worker's Settings, Variables and Secrets in the Cloudflare dashboard, as the type
Secret, since a deploy takes away plain text ones. `pnpm run deploy` uploads them too when its
environment has them, so the Preview workflow passes repository secrets of the same names through.

While it's on, the sign-in page offers Member? Sign in with Memberful under its form. Someone with an
active subscription, or the all access pass, signs in as the person their Memberful account is
linked to, or else joins as a new member, in every open room, and everyone else joins and signs in
as before. Accounts are linked by the Memberful site and the member's id there, never by email
address, since Memberful lets anyone register an address without proving it's theirs: someone new
whose Memberful email address someone here has already is turned away, and asked to sign in with
their password. At another address, even the same site's, every member would be someone new, so
once anyone has signed in with Memberful, Set up Memberful keeps the site, asking only for its keys,
and a `MEMBERFUL_URL` should keep it too. Turning Memberful off stops anyone new joining with it, but
whoever signed in with it has no password, so they keep signing in with it, and the sign-in page
keeps offering it, while Ember has the keys.

Members only, under Memberful, keeps Ember to the site's members: the sign-in page offers Sign in
with Memberful in place of its form, Open, the join link and signing in with just a name are off,
and only administrators and the people they invite sign in with a password, who need no membership.
Sessions people have go on, and turning it off brings the other ways and passwords back.

While Memberful is members only, someone with an account from before connects their Memberful
account to it with their password: from the Memberful section of their profile, or as they sign in
with their password, which asks them to connect one until they have. Memberful sends them back
signed in as themselves, and from then on they sign in with Memberful, and their membership counts
as anyone's. A connection is good for one try within ten minutes, and a new password, theirs or a
reset, forgets the ones the old one started. Administrators, and the people they invite, can connect
one too, and sign in either way.

The Memberful section of a profile names the account that's connected, as Memberful describes it,
and Disconnect Memberful, with their password, unlinks it and ends their other sessions, as a new
password does. A new password that replaces one they had disconnects it too, so a reset ends every
other way into an account. Neither disconnects it from someone without an email address, which
signing in with a password takes, so nobody is left with no way to sign in: the section asks them to
add one first. Once disconnected, a member signing in with their password is asked to connect one
again.

Someone who joined with Memberful has no password, and while Memberful signs them in, as it does
while Ember has the keys to the site they're linked at, they aren't given one: their profile
offers none, and the Worker refuses one. Memberful is their way in, and a password would be another
that holding their session was enough to make. Their Memberful account stays connected, since
they'd have no other way in. Should Ember lose the keys, or `MEMBERFUL_URL` change, Memberful no
longer signs them in: an administrator's sign-in link lets them in, and their profile offers a
first password then, which keeps their Memberful account connected for when it signs them in again.

A member whose membership lapses can't sign in with Memberful again. With the webhook, they're suspended too: their
sessions end, their sockets close and their browsers' push subscriptions are forgotten, but their
rooms, private ones too, messages and role stay, and they're back as they were once it's renewed and
they sign in. Making an open room private leaves them out of it, as it does anyone not chosen. A
webhook only tells Ember whom to ask about: Memberful sends them in no particular order, so the
Workspace asks Memberful's API what that member's membership is now, and asks about everyone linked
once a day too, in case one never came. Ember answers every event it's sent with 200 once its
signature checks out, one about a plan, a download or nothing it knows of too, since Memberful tries
again for a day whatever fails, then deletes the webhook if it's still failing three days later.
Administrators, and the people they invite, who need no membership, are never suspended.
Administrators see suspended members dimmed in Workspace settings, where they can remove them, and
everyone else sees them as removed. All of this goes on whether Memberful is on or not, since its
members keep signing in with it once it's off.

### Sending email

Ember sends email with [Resend](https://resend.com), with an API key an administrator gives it, or
with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/), which wrangler.jsonc
binds as `EMAIL`. Under Email, in Workspace settings' Membership, Set up email walks an administrator
through either, then the From address Ember's email comes from, under the community's name unless it
names another, and sends them a test email as it finishes, so that it checks itself. Turning
on Email domain, or Invite by email's Set up email, opens it too while Ember can't send email. Stop
sending email, beside it, takes the From address away, after which Ember emails nothing until email is
set up again.

With Resend, which sends 3,000 emails a month, at most 100 a day, for free, on Workers Free too:

1. Under Domains in Resend, add the domain to send from, and the DNS records it gives, until Resend
   says it's verified.
2. Under API Keys, create a key with Sending access, and paste it into Set up email. Ember asks Resend
   whether it takes the key, then keeps it in the workspace's settings encrypted with AES-GCM under a
   key derived from `SESSION_SECRET`, so a copy of the database alone doesn't give it away. A new
   `SESSION_SECRET` leaves it unreadable until an administrator pastes it again.

A Worker can have the key as a secret instead, which takes the place of one pasted in, leaving Set up
email only the From address to ask for:

```sh
pnpm exec wrangler secret put RESEND_API_KEY     # add --name <worker> for a Worker not named in wrangler.jsonc
```

`pnpm run deploy` uploads it when its environment has it, so the Preview workflow passes a
repository secret of the same name through.

With Cloudflare Email Service, in beta since April 2026:

1. Put the Cloudflare account that runs Ember on the Workers Paid plan, which includes 3,000 emails a
   month. On Workers Free it sends only to the account's own verified addresses.
2. In the Cloudflare dashboard, under Email Service, Email Sending, choose Onboard Domain and pick a
   domain on Cloudflare DNS, such as the one Ember's custom domain is on. Cloudflare adds the records
   sending takes.

Choosing Cloudflare Email Service in Set up email forgets a pasted Resend key. Once the From address
is typed, Set up email looks its domain up for the records Onboard Domain adds, the MX records on
`cf-bounce.<domain>` and the DKIM key at `cf-bounce._domainkey.<domain>`, and says whether it's
onboarded, with no Cloudflare API token, which Ember never holds. The records can't say whether the
account is on Workers Paid; the test email does. When the provider refuses it, Membership says why,
such as a domain that isn't onboarded or a day's quota used up. `wrangler dev` sends nothing with Cloudflare's binding: it logs each email and saves it to a
file.

### Inviting people by email

Under Invite by email, in Workspace settings' Membership, an administrator gives the email addresses
of the people to invite, and Ember emails each a link that joins with that address, once, within 7
days, whichever ways to join are on, Members only included. Until Ember can send email, the card
makes the links for the administrator to copy and send. The invitations nobody has accepted are
listed there, each to send again, which replaces its link, or revoke, and joining with an invited
address, however someone joins, spends its invitation. A link keeps its secret in the address's
fragment, which never reaches a server, and Ember keeps only its digest. Each invitation is an email,
so the provider's limits apply, such as Resend's 100 a day for free.

### Push notifications

Push notifications need a VAPID key pair, which the first deploy makes. `pnpm vapid:keys` prints a
new one as the Worker's two settings, for `.dev.vars` or to replace a deployment's:

```sh
pnpm vapid:keys
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
pnpm exec wrangler secret put VAPID_PRIVATE_KEY
```

Without them push is off, and `/api/health` tells an administrator why. Keep the pair once people
use it: browsers subscribe with its public key, so a new pair leaves everyone to turn notifications
on again. A pair from Campfire's `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` works as it is.

A new message is pushed from its room's Durable Object as the room tells the Workspace of it, to the
subscriptions of the members who aren't viewing the room and want to hear of it: each person keeps
one for each browser they turned notifications on in, which saves it again each time Ember opens
there, and only the 10 saved most recently. Push services may contact whoever `VAPID_SUBJECT` names,
a `mailto:` or `https:` address, about your pushes; without it they see this project's address. Each
push is an outgoing request, of which the Workers Free plan allows 50 per invocation, so there the
pushes past that, for a message with more subscribers or a run of messages sent together, fail and
are logged; the Paid plan allows 10,000.

An invitation into a huddle is pushed too, from the huddle's room, to the subscriptions of the
people it reaches who have Ember in view nowhere, as [Huddles](#huddles) describes. Its pushes
count toward the same 50, so on the Free plan those past that, for an invitation to many people at
once, fail and are logged.

### Files

The files people upload go to an R2 bucket, bound as `FILES` in `wrangler.jsonc` and
named `ember`. Turn R2 on for your Cloudflare account, then deploy: Wrangler binds the account's
bucket of that name, and creates it if there's none and its token may, or make it yourself first
with `pnpm exec wrangler r2 bucket create ember`. Change `bucket_name` to use
another. `wrangler dev` keeps files on your machine. Without the binding Ember keeps no files, and
`/api/health` tells an administrator so.

A file goes up in parts of 10 MiB, since a Worker takes at most 100 MB a request, and R2 puts them
back together. R2 deletes the parts of an upload nobody finishes after a week.

A picture's message shows its preview, a WebP, JPEG or PNG within 1200×800 that the uploader's browser
makes and sends before the last part, or the picture itself if every browser shows it and it's at most
5 MiB. Where neither would show it, as for a bot's picture, a HEIC from a browser that can't read one,
or a picture a browser couldn't make a preview of in 5 seconds, the Worker has
[Cloudflare Images](https://developers.cloudflare.com/images/optimization/binding/), bound as `IMAGES`,
make the preview. There's nothing to set up, and its free plan makes 5,000 a month. Past those, the
Worker's log says why it made none, and the message shows the picture as a file to download, as it
does a picture over 20 MB, 100 megapixels or 12,000 pixels a side. An account still on Cloudflare's
legacy Image Resizing subscription has to move to the Images one first. `wrangler dev` makes previews
on your machine.

### Ember AI

An administrator adds @ember, an AI assistant, on the AI assistant tab of community settings. Turning
on its Ember AI card opens Set up Ember AI, which takes a Cloudflare account's ID and an API token,
then a model. Its steps make the token under Account API tokens in the Cloudflare dashboard, as a
custom token with three of the account's permissions: AI Gateway Run, which asking Claude and GPT
takes, Workers AI Read, which listing and asking Workers AI's models and Grok takes, and AI Gateway
Read, which searching the web for Grok and Workers AI's models takes as well. The account's ID starts as the one Ember is deployed to, when
the deploy gave it, leaving only the token to make, and the dialog's links open that account's pages in
the dashboard. Ember asks models through the account's default
[AI Gateway](https://developers.cloudflare.com/ai-gateway/), whose logs, caching and spend limits
apply: Claude and GPT at the gateway's endpoint for the model's provider,
[Anthropic's](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/) or
[OpenAI's](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/), in the provider's own
API, which has all the model's features, and Grok and Workers AI's through Cloudflare's
[REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/), in Chat Completions, as AI
Gateway's credits don't pay for Grok at the gateway's
[xAI endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/grok/), where xAI answers
"No credentials presented". Every model and every search goes through the gateway. Its logs keep
what each request asked and was answered, but for a question asked in a DM or a private room, which
they keep only the model, tokens, cost and time of, with `cf-aig-collect-log-payload: false`, so that
nobody reading them reads what only that conversation's people do;
[Logpush](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/), if you turn it
on, still exports everything. Ember tells OpenAI and xAI not to keep the conversations, as each
otherwise does for 30 days. AI Gateway Run lets the token send requests through every gateway on the
account, with any provider keys stored on them, so keep it as safe as those keys.

The model menu lists the models Ember offers, by their makers, then Workers AI's, each with what a
million tokens read and a million written cost, as [What it costs](#what-it-costs) says. Claude, GPT
and Grok come from [the models file](models.md), `models.json` on Ember's main branch, which every copy
reads once a day, so that a model can be offered, or stop being, without an update: now Anthropic's
Claude Fable 5.2, Claude Opus 5.5, Claude Sonnet 5.5 and Claude Haiku 5.5, OpenAI's GPT-6 Astra,
GPT-6.1 Sol, GPT-6.1 Terra and GPT-6 Luna, and xAI's Grok 4.7, at their providers' prices, which AI
Gateway's credits pay. The file lists only models whose tools for the web Ember knows, where it can turn
them on, and can change nothing but which models are offered.
Until a copy has read it, and whenever it can't, the copy offers the file its release shipped with.
Workers AI's models come from Cloudflare's model search, which the Worker reads once a day for the
account: the text models that take tools, as Ember's own for searching the web is, at the prices and
Thinking levels the search lists. While the token lacks Workers AI Read, the menu lists the others and
says why it can't list those. A model whose maker, or Cloudflare for Workers AI's, plans to stop
running it says on which day, and Ember stops offering it then. The menu starts at Ember AI's model, if
Ember offers it, or else at the one the file suggests, Claude Haiku 5.5. The Worker asks the model a
test question before keeping the setup. @ember then joins every room open to everyone, and turning the
card off takes it and the [AI agents](#ai-agents) out again and forgets the token. Nobody else can take
the name Ember, though anyone who had it keeps it.

Ember AI set up before Ember offered only these keeps what it saved, and its models answer as they did:
the one that answers everyone, the others people can pick, and the agents'. One that Ember doesn't
offer, such as one the models file no longer lists, or a Workers AI model the model search doesn't list
for the account, is marked "no longer offered" on @ember's Models list and in its agent's model menu,
and Ember goes on asking it as it did, through Cloudflare's REST API or its provider's endpoint, until
it's removed from the list, or its agent is saved with another model, after which nothing offers it
again. While Workers AI's models can't be listed, one of theirs isn't marked, as Ember may offer it
still. Claude and GPT models that Ember asked through the REST API move at the first answers
after the update: in the background, Ember asks each, the agents' too, its test question through its
provider's endpoint, at most 8 at an answer, and asks those that answer there from then on, at the
levels of thinking they take there. The rest stay where they are, as they all do while the token lacks
AI Gateway Run, until Ember AI is set up again, which has Ember ask them again.

While Ember AI is on, the Agents card under it lists @ember, marked Built in, then the agents, each
linking to its page. @ember's page, headed Ember, has the settings below: its avatar, its instructions,
the models people can pick, Search the web and the limits.

@ember's avatar is Ember's flame until an administrator picks a picture in the Avatar section of
@ember's page, which R2 keeps as it does people's avatars, and Use Ember's flame brings the flame back.
The picture stays while Ember AI is off, as @ember's messages do. Each change gives the avatar a new
address, even two changes in the same second, and every open page hears of it at once, so nobody's
browser goes on showing the old picture it keeps for half an hour.

@ember follows Ember's own instructions, and Instructions, on its page, adds an administrator's to
them, up to 10,000 characters, such as how the team likes answers written or what to leave to people.
What Ember adds around them shows the whole prompt @ember is given, from the Worker's own code, and
administrators can [modify it with caution](#what-ember-adds-around-the-instructions). They're kept
while Ember AI is off.

The Models list on @ember's page has the models people can pick, at most 20, starting with the one Set
up Ember AI chose. Its radio buttons choose which answers everyone who hasn't picked another, Add a
model offers the models Ember offers that nobody can pick yet, asking the one chosen a test question
before adding it, and Remove takes one out. Each person picks theirs from the Model menu under Ember AI
on their profile, which shows while there's more than one: Default follows the administrators' choice,
whichever model they choose, and a model picked by name stays theirs, even the one that's the default.
Someone whose model is removed gets the default again, and their pick back if it's added again.
Changing the model in Set up Ember AI puts the one chosen in place of the old default, and turning
Ember AI off forgets the list. When the model someone picked has run out of credits or won't take the
question, @ember's note says they can pick another.

Mention @ember in a room or a thread, or write to it in a DM, and it answers there: in the thread when
it's asked in one, typing while its model answers. It reads the thread, its first message and latest 50
replies, or else the room's latest 20 messages, each after its writer's name, at most about 40,000
characters of them, and sends them through AI Gateway to the model, whose provider reads them. Its
answer is a message of its own, in Markdown: links, bold, strikethrough, lists, quotes, code blocks and
tables show as they do in people's messages, as do emoji, which it's told to write as themselves rather
than by names such as :tada:, the pictures it links to show in a card under it, and its first web link
gets a preview, as a pasted link does. Both are only of addresses a person wrote in the messages it
read, not a bot or @ember itself, or of the pages it came from, and a preview is never of Ember's own
pages. Any other address shows only as a link, since one the model made up could carry what it read to
whoever runs that address the moment a reader's app or the Worker fetched it. An answer longer than a
message holds is cut to as much as fits, ending with an ellipsis. It reads bots' messages but never
answers one, so that bots can't keep each other talking. When the model can't answer, as when the token
is refused, the credits run out, or Workers AI won't run the model, as it runs some models only for
accounts on Workers Paid, retires others, and runs them free only for 10,000 Neurons a day, @ember says
why in a short note, and the Worker's log has Cloudflare's own words. AI Gateway's logs keep each
request with the id of whoever asked, as custom metadata's `user_id`, and of whoever answers, `ember`
for @ember or an AI agent's, as `agent_id`, which a spend limit can be split by. An administrator can
also turn on the gateway's
[Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/) or
[Data Loss Prevention](https://developers.cloudflare.com/ai-gateway/features/dlp/) in the Cloudflare
dashboard, to check the questions, with the messages @ember reads, or the answers. When either blocks
one, @ember's note says which, and that an administrator can change what it blocks there.

For what was written before the messages it reads, @ember can search the room it's asked in, a tool
Ember runs for it: its model answers with a call of the tool in place of an answer, Ember runs the
search and asks the model again with what it found, and the model answers, or searches again. A search
finds the room's messages that have every word the model gives, its threads' too, as Ember's search
does for someone in the room, and never another room's, so an answer holds nothing its readers couldn't
find themselves. It answers the newest 10 but those @ember was given with the question, which would
only crowd out what's older, each with when it was written,
who wrote it and at most 600 characters of what it says, which the model's provider reads as it does
the conversation. An answer makes at most 5 such calls, then the model is told to answer with what it
has, and they share the answer's limit of tokens, so a model that spends them all searching is cut
short as any other answer is. Claude, GPT and Grok, the models the models file lists, are given the
search, with nothing to turn on; Workers AI's models aren't, nor is a model kept from before Ember
offered its own, or a test question, and a model that stops taking the tool is asked
again without it: one refused only once it has searched answers without it, told what its searches
found, in the tokens, and with the web searches and pages, the answer has left. Each call has the model read the conversation again, so an answer that searches costs
that many more tokens read. A picture or a link that only a search found shows as a link, as the rule
above has it, since the card and the preview are only of addresses in the messages @ember read with
the question.

@ember can also show cards under its answer, as a chat bot's [Slack-compatible
webhook](slack-webhooks.md) does, for where something stands, a report, options to compare, a table or
buttons that open pages: it writes a Slack message's payload as JSON in a code block that starts
with ```` ```slack ````, and the cards the payload posts show under the answer, after the card of its
pictures, in place of the block, with all of the answer's words above them. They show as a webhook's do,
without what only a Slack app could answer, such as a menu, and without the payload's `text`, as the
answer's own words are its text. A card's pictures show only at the addresses its Markdown's may, while
its links and buttons, like its Markdown's links, may go anywhere. A block whose payload doesn't parse,
or posts no card Ember keeps, stays the code it's written as, as does one in a list or a quote. An
answer too long for a message keeps as many of its cards as fit, each whole, and as much of its text as
fits beside them, counting the cards' text.

What Ember tells @ember and every agent teaches them to make cards: when a card helps, as whenever
someone asks for one, or for where something stands, and when to leave one out, as from a
conversational reply; that one asked for is made even when the model couldn't find all it should show,
showing what it found and saying in it what it couldn't; each block a card shows, with how it shows
and what it's for; Slack's markup, which isn't Markdown; what doesn't show; and an
example of a focused card. That's about 1,800 tokens of each question on Claude's models. It comes with
the rest of what's the same from question to question, ahead of the date and where the question's asked,
so that a provider that caches the start of a prompt on its own, as OpenAI's does, can reuse it.

Two dials say how much @ember does for each question. Thinking, Off, Low, Medium or High, is how much
its model thinks before it answers, up to about 4,000, 16,000 or 32,000 tokens, asked for as each API
takes it: OpenAI's and xAI's reasoning effort, which Chat Completions takes too, or Anthropic's
adaptive thinking, at its lowest effort for Off, since Anthropic's newest models don't turn thinking
off. Answer length, Short, Medium or Long, is about 150, 400 or 1,500 words, which @ember's
instructions ask for and its token limit allows, with room for code and tables. The Limits on @ember's
page set the most of each for anyone's questions, the top of each until an administrator lowers them,
and each person picks their own levels under Ember AI on their profile, up to those, starting at Low
thinking and a Medium answer. An agent's levels are its own, set on its page.

Which thinking levels a model takes is something only asking it says: a provider can refuse a level for
one of its models that it takes for another, and a list of a model's settings can be wrong, as
Cloudflare's catalog was in listing Low and High for xAI's Grok 4.20 Reasoning, which xAI refuses at
every level. So when an administrator picks a model, in Set up Ember AI, Add a model or an agent's
page, the Worker also asks it the test question once at each level, all at once, and keeps the levels
it answered at. A level it doesn't take costs nothing, as the provider refuses it before the model
writes anything. Workers AI's models are the exception: Cloudflare runs them itself, and its model
search lists the reasoning efforts each takes, and those it turns into others, which asking can't tell,
so Ember keeps those as its levels, and asks at each only a model the search doesn't say them for. The
Thinking dial then offers only those, on a person's profile for their model and on an agent's page, and
says which the model can't be set to. A level chosen before that the model doesn't take asks it for the
nearest one it does, below first, so Off asks a model that can't turn thinking off for Low. A model
that takes no level decides how much it thinks, and Thinking still sets how much it may. A model picked
before Ember asked at each level, or one whose provider refuses a level it took then, is asked again
without one.

@ember waits for its model as long as the levels may take, 2 minutes at the least and about 13 at High
and Long. An answer its token limit cuts short ends with an ellipsis, and when the model thinks for all
it may before writing anything, @ember says so and suggests less thinking.

Search the web, on @ember's page, lets @ember search the web and read pages with its model's own tools,
which AI Gateway passes on and the model's provider runs
([Cloudflare's guide](https://developers.cloudflare.com/ai-gateway/usage/web-search/)): Anthropic's
[web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) and
[web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) for Claude,
and OpenAI's [web search](https://platform.openai.com/docs/guides/tools-web-search) for GPT. Grok and
Workers AI's models search with a tool of Ember's own, which the Worker runs with Cloudflare's
[Web Search API](https://developers.cloudflare.com/web-search/) through the same gateway: each search
finds 5 pages, and the model reads what the search says of each, up to 2,000 characters, though not the
pages themselves. Grok's searches count among the 5 calls an answer makes of Ember's tools, with its
searches of the room. A model kept from before in Chat Completions,
as Google's are, has no such tools, which the page says, its switch opening Set up Ember AI to choose
another model. Turning it on asks the model that answers everyone a question it has to search the web
for, and keeps the tools AI Gateway took, reading pages only if it took that tool too, and says what
the model found; a model that answers without searching leaves it off. A Grok saved before in xAI's
own Responses, at the gateway's xAI endpoint, moves to Chat Completions then, where AI Gateway's credits
pay for its searches, and is asked again at each level of thinking, as the levels it takes there
needn't be the ones it took before. One that already searched there, with an xAI key on the gateway, searches there
still until the switch is turned off and on again. While the token lacks AI Gateway Read, which Ember's tool takes, the
switch says to add it. Choosing another model to answer everyone, under Models or in Set up Ember AI,
or another Cloudflare account there, turns it off, as another model, or another account's AI Gateway,
may not take the same tools, until it's turned on again. A model someone picks on their profile is
given the same tools, of those its format has, so the models Ember offers search too, and any other
is told to say it can't, and that they can pick one that can. While it's on, @ember searches at most 5
times an answer and reads at most 3 pages, each cut to about 10,000 tokens: pages people link to, or
that its searches find. Its answer is what it writes after it last searches, and a line under it links
to the pages it cites and the pages it read, by their titles, at most 10, leaving out those the answer
links to itself. Grok's and Workers AI's APIs have no citations of their own, so Ember numbers the pages
their searches find, counting on across an answer's searches, and asks the model to cite a page by its
number in brackets, as [2], after what it takes from it. Ember takes those numbers out of the answer,
but in code, and its line links to the pages they cite, in the order the answer first cites them, with
any whose address the answer writes; one that cites none has no line, and still counts as searching
when the switch is turned on. A model that stops taking the tools is asked again without them, told
it can't search this time. Its searches are written from the conversation, so the provider's search
sees what the room was asking about. While it's off, @ember is told it can't search, and that an
administrator can turn Search the web on.

### AI agents

Beside @ember, administrators can make AI agents of their own, each a bot that answers with its own
instructions and model, for a task such as summing up threads or drafting replies in a support room.
While Ember AI is on, New agent, on the Agents card, makes one, up to 20, and the card links to each
agent's page, which changes it. The page sets up:

- **Name and avatar.** An agent's name is unique among everyone, in any capitals, so no person or bot
  can pose as it, nor take its name while it exists, whether Ember AI is on or off. Its avatar is the
  one chat bots start with until an administrator uploads a picture.
- **What it does**, in a line of at most 100 characters, which the Agents card and the agent's profile
  show, so people know when to ask it.
- **Instructions**, its system prompt, up to 10,000 characters: its task, how to go about it, and what to
  leave alone. What Ember adds around them shows the prompt the Worker writes around them, from the
  same code, which administrators can [modify with caution](#what-ember-adds-around-the-instructions).
  They aren't secret, as anyone who can ask the agent could get it to repeat them, so leave out keys,
  passwords and private links. Nor are they a boundary: someone in the conversation can talk an agent
  out of them, so what an agent reads and does is up to Ember's code, as it is for @ember.
- **How it answers**: its model, of those Ember offers, and its own Thinking and Answer length, the
  dials @ember has, which people can't change on their profile as they can for @ember. The page says
  the most an answer at those levels costs at the model's prices. An agent saved on a model Ember no
  longer offers keeps it, marked so in the menu, until it's saved with another.
- **Search the web**, as @ember's does, for every model Ember offers. Turned on for a model kept from
  before that can't search, it says in red that the model can't, until the model or the switch changes.
- **Rooms**: Every room, which is every room open to everyone, new ones too, as @ember is, or only the
  open rooms chosen. People can still add it to a closed room or DM it, as they can anyone.
- **Admin access**, two switches, both off for an agent anyone can ask:
  - **Admins only** leaves the agent in its rooms, where everyone reads what it answers, but it answers
    administrators alone. A mention or a DM from anyone else gets no answer, the mention prompt and New
    direct message don't offer it to them, and its profile tells them that only administrators can ask
    it.
  - **Only available in admin DMs** takes the agent out of every room, private ones too, keeps it out
    of them, and holds Admins only on. Nobody else can see it: their people directory, mention prompt
    and Available Agents don't list it, and its profile and avatar aren't there for them. Only an
    administrator can start a DM with it, and it answers there while everyone else in the DM is an
    administrator. A DM started with it and anyone else, a member, a bot, whose key reads the rooms
    it's in, or another agent, is started without it.

  Whoever becomes an administrator can ask these agents from then on, and no longer once they aren't
  one. A DM someone had with an agent before it was kept for administrators stays theirs to read, and
  the agent answers nothing more in it.

Try it asks the agent a question as the page sets it up, before anyone saves, and shows the answer as
the agent's message would, with how long it took, to nobody else. Create agent, and Save changes when
the model changes or Search the web goes on, first ask the model a test question, or one it has to
search the web for, as Set up Ember AI does. The page says who last changed the agent, and when, and
Delete agent, which asks first, takes it out of every room for good and frees its name, while its
answers stay.

An agent answers as @ember does: when it's mentioned in a room or a thread it's in, or written to in a
DM, it reads the same conversation and sends it through AI Gateway to its own model, whose provider
reads it, with its own instructions, and its answer shows the pictures, cards and preview @ember's
would. Like @ember, it never answers a bot, so agents and @ember don't answer each other. AI Gateway's
logs and spend limits tell the agents apart by `agent_id`, as [Ember AI](#ember-ai) says. Turning Ember
AI off takes every agent out of its rooms, as it does @ember, and keeps them, to come back as they were
when it's on again, in the open rooms there are then.

What an agent, or @ember, reads stays in the conversation it's asked in, by Ember's code rather than
its instructions. It's asked only in a room or DM it's in, and reads that one alone: the conversation
it's given, and what the room's search finds, which searches no other room. So nothing said in a DM or
a private room reaches another room through it, or anyone who isn't there, even someone who is in both
asking elsewhere. Agents join the rooms open to everyone; a private room or a DM has one only when its
people add it, and a DM's people never change, so nobody can put an agent in someone else's. An agent
keeps nothing from one question to the next but what the room keeps. In a DM or a private room, every
call of an app's tool asks first, even [one always allowed](#apps), and AI Gateway's logs keep nothing
of what's said. The model's provider still reads what it's asked, and a chat bot in the same room reads
it all by its key, as anyone in the room can.

The Agent badge follows an agent's name wherever it shows, so nobody takes it for a person: on its
messages, deleted agents' too, on a DM with it alone in the sidebar and the room's header, in the
mention prompt and New direct message, and on its profile. The profile shows everyone what the agent
does, the model it answers with, where that runs (Cloudflare's Workers AI, or the company that makes
the model, which AI Gateway sends what it's asked to), and who set it up, but not its instructions.

Available Agents, under the DMs in everyone's sidebar while Ember AI is on, says how many agents they
can ask, @ember among them, and opens the list of them: each agent's picture, the @name that summons
it, which a click copies, what it does, the rooms it shares with whoever is looking, each a link to the
room, and a button that starts a DM with it. People who aren't administrators are listed only the
agents anyone can ask. Administrators are listed the ones kept for them too, marked Admins only or
Admin DMs only, with a link to each agent's page and to New agent.

#### What Ember adds around the instructions

Ember writes the rest of @ember's and each agent's system prompt around their instructions: who they are
before them, and after them how the chat shows Markdown and pictures, how to show cards, what they may
do on the web, the date and time, and where they're asked, last, as it changes from question to
question most. The time is in UTC, as Ember doesn't know where each person asking is, so the model is
told that for them it may still be the day before, or already the next.
Under What Ember adds around them, on @ember's page and each agent's, a box headed Modify with caution
keeps it as Ember writes it until Modify is pressed, as a change there can leave a model unsure who it
is, where it's asked or what the chat can show. Modify opens the template Ember fills in each time it's
asked, up to 10,000 characters, with what each placeholder stands for:

| Placeholder | What Ember fills in |
| --- | --- |
| `{{name}}` | Its name |
| `{{community}}` | The community's name |
| `{{where}}` | The room, thread or direct message it's asked in |
| `{{asker}}` | The name of whoever asked |
| `{{words}}` | About how many words it may answer in, from Answer length |
| `{{cards}}` | How it can show cards under its answer with Slack payloads: when they help, what they can hold, and an example |
| `{{web}}` | What it may do on the web, or who could let it |
| `{{today}}` | Today's date and the time, in UTC, as Tuesday, November 17, 2026 at 01:54 |
| `{{instructions}}` | The instructions, which it needs once |

The preview above it follows what's typed, and the box says why Ember can't take a template, before
anything's saved: one without `{{instructions}}`, or with it twice, or with a placeholder Ember doesn't
fill in, such as a misspelt one. A template that leaves out a placeholder, such as `{{web}}` or
`{{today}}`, is taken, though the model then isn't told what it would have said. While @ember has no
instructions added, `{{instructions}}` on a line of its own goes with its line, and within a line it
leaves the rest of the line as it's written. An agent's template saves with Save changes, and @ember's
with Save beside it, or Save instructions. Try it asks an agent with the template as the page has it,
saved or not. Use Ember's own puts Ember's back, which Ember keeps as its own, so that it changes as
Ember's does in later releases, where a modified template stays as it was saved. So a template modified
before `{{cards}}` came along doesn't tell its model how to show a card until `{{cards}}` is added to
it, though a card the model writes anyway still shows, while one with `{{cards}}` in it gets what Ember
says of cards in the release it runs. While it's modified, What Ember adds around them is marked
Modified.

### Apps

An app is another service's [MCP](https://modelcontextprotocol.io) server: the tools it offers, at an
address. On the AI assistant tab, under Agents, an administrator connects one with **Connect an app**,
while Ember AI is on: a name, the server's address, which the service's documentation gives and which
often ends in `/mcp`, and a token, if the server takes one. Ember asks the server for its tools then,
over Streamable HTTP, and connects the app only once it has answered, so a wrong address or token is
said on its field, in words about what the server did: it asked for a sign-in, didn't take the token,
has no MCP server there, sent the address on to another, took longer than 20 seconds, or answered
with more than 4 MB. A server that asks for a sign-in is connected by [signing in to it](#signing-in-to-an-app).

An administrator picks the tools each agent may use, and an agent calls one only once someone allows
that call, on a card in the room, unless the administrator has that agent's calls of the tool always
allowed, which counts in open rooms alone: in a DM or a private room every call asks first, so that
nothing said there goes to an app unless someone in it allows it.

- **The address** is an `https` one, or `http` on `localhost`, for a server you're developing, with no
  name and password in it. Ember asks only that address: it follows no redirect, and it looks the name
  up first and refuses one that resolves to a private address, as [link previews](#security-notes) do,
  so a server can't send Ember, or the token, anywhere else. Ember's own address is refused too, the
  one you're using and any other it knows reaches it, at any port: its MCP server, for
  [outside AI](#outside-ai), would have the agents read what your sign-in to it reads, DMs and private
  rooms too, for whoever asks them. An app connected at one before isn't called.
- **The token** goes to the server with every request, as `Authorization: Bearer`. Ember keeps it
  encrypted, as it keeps Ember AI's API token, and never shows it again: the app's page says only that
  it has one. Type another to replace it, or check **Send no token** to stop sending one. Either has
  Ember ask the server again before it saves, as another address does.
- **The tools** show on the app's page, each by its name there, with its title and what the server
  says it does, which is the server's word and not Ember's. Ember keeps up to 100, each with a name of
  letters, digits, `_`, `-` and `.`, a description up to 1,500 characters and a schema of what it takes
  up to 8,000, and the page says how many more the server has. **Read its tools again** asks the
  server again, and leaves the app as it was if the server doesn't answer.
- **Remove app** forgets the app, its token or sign-in, and its tools. Up to 10 apps can be connected,
  and they're kept while Ember AI is off.
- **An agent's tools** are picked on its page, and @ember's on its own, in the **Tools** card: every
  connected app's tools, by app, each with a checkbox, up to 20 an agent. A pick is saved as it's made.
  An agent is given nothing that isn't picked for it, and anyone who can ask the agent could have it
  use what is, with the token its app was connected with, so pick for the rooms the agent is in. Ember
  keeps each pick with the tool as its server described it then: when Ember reads the app's tools again
  and the server describes one another way, in its name, title, description or what it takes, that
  tool is set aside for every agent that had it, and its page says so, until an administrator picks it
  again. One its server describes as it did again, before that agent's picks are next saved, comes
  back by itself, as it's the tool that was picked. A pick is of the tool as the page showed it, so one made on a page that loaded before the
  tool changed is refused, and the page shows the tools as they are now. Removing an app takes its
  tools from every agent.
- **A tool set aside** is flagged where an administrator looks: the Apps card says on the app's row
  how many of its picked tools are set aside, and the app's page names each, with the agents that had
  it, linked to their pages, and whether the server changed it or no longer has it. Ember also finds
  a change as it goes to call a tool: it then reads the app's tools again, so the tool is set aside
  from that call on, without waiting for an administrator to read them. An app whose server has
  come to have no tools Ember can use keeps none, which its page and the agents' say.
- **A call** is the model's to ask for and a person's to allow. Claude, GPT and Grok, which can
  search their room, are given an agent's picked tools beside that search, each named for its app and
  described in the app's own words, marked as the app's; Workers AI's models aren't given them. It never has an app's address or token: it names a tool
  and what to call it with, and Ember posts a card in the room, where the answer would go, saying
  which agent wants to use which app, the tool, and everything it would be called with, as JSON.
  **Allow once** runs that call and no other, and **Deny** tells the model it wasn't allowed; either
  is for whoever asked the agent or an administrator, and the card then says who answered. The answer
  goes on from there, and waits again at the next call, up to five calls an answer. A model whose
  provider then won't go on from a call is asked once more without the tools, told what each call came
  to, so that its answer still says what a call did. A call nobody
  answers in 15 minutes isn't run: its card says so in place of its buttons, and Ember forgets the
  answer that waited. A call with more than 3,000 characters to show is never asked for,
  so nobody allows what they couldn't read. As it runs a call, Ember asks the server for the tool
  again, and doesn't call one that's no longer picked for the agent or that the server describes
  another way than when it was picked. What the tool answers goes to the model as text, cut at 8,000
  characters, and is the app's word: Ember passes on no pictures or files from it.
- **A tool's card** is the app's own. A server built for Slack's assistant can answer a call with
  [Block Kit](https://docs.slack.dev/ai/slackbot-mcp-client/returning-rich-responses) beside its
  text, in `_meta.slack.blocks`, and Ember tells every server it takes that, by the name Slack's
  client gives it (`io.slack/block-kit`). The room is shown those blocks as a card from the agent,
  before its answer, ending in a line that says which app and tool it's from, and the model is told
  the room has seen it. Ember shows such a card whole or not at all, as Slack does: one with more
  than 50 blocks, or with a block Ember doesn't draw (a field to type in, a menu, a data table, a
  chart, a container, a file), isn't shown, and the agent answers from the tool's text, as it does for
  a server that sends no card. Its pictures are fetched by each reader's app from the addresses the
  server gave, as a bot's card's are.
- **A button on a tool's card** calls a tool when its `action_id` is `tool:` and the tool's name, with
  the JSON object its `value` writes, as Slack has it. Ember keeps such a button only for a tool of
  the same app that's picked for the agent, and drops any other button that isn't a link. Anyone in
  the room can click it, and the click is its own leave: nobody is asked first, as the call is the
  one the app's card offered, not one a model wrote, and it goes to no model. The card the tool
  answers with takes the clicked one's place, saying who clicked which button, and what a tool only
  says is posted beside the card. A call that fails tells whoever clicked why, in the server's words,
  cut short. One click is answered at a time on a card. Agents' own answers still get no buttons
  that act.
- **Always allow** is an administrator's, for one agent and one tool: a box under each picked tool in
  the agent's Tools card. That agent's calls of that tool in rooms open to everyone are then made at
  once, with nobody asked, for anyone who can ask the agent, so keep it for tools that only read, or
  whose every use you'd allow. In a DM or a private room each call asks first all the same, and one
  the agent was about to make when its room was made private isn't made. The room still sees each
  call: Ember posts a card saying which agent used which app, the tool, and what it was called with,
  before it makes the call, and makes none it can't show, whether the room wouldn't take the card or
  there are more than 3,000 characters to show. A call that then
  isn't made after all, as Ember finds its server has changed the tool or can't get through to it, has its card changed to say so. Uncheck the box
  and the tool asks first again, from the next call. It ends by itself when the tool is taken from
  the agent, or when Ember finds its server has changed it: from then on the tool asks first, even
  once the server describes it as it did, until you check the box again.

Reading an app's tools and calling one run in a Durable Object of its own, `AppConnector`, apart from the rooms and
the workspace, with the protocol's own client, pinned to one version. Only JSON comes back, and none
of a server's code runs in Ember.

#### Signing in to an app

Many services' MCP servers take no token you could paste: they sign you in, with OAuth, as the
protocol has it. When a server answers Connect an app by asking for a sign-in, the token's field says
so and offers **Sign in to** its host. Ember then finds where the server signs people in, sends your
browser there, and connects the app once you've allowed it and the service has sent you back. The
app's page says who signed in, and when, in place of a token.

- **It's one sign-in for the app**, made by an administrator and used for every agent given the
  app's tools, as a token is. So what an agent can do there is what the administrator who signed in
  can, for anyone who can ask the agent: sign in as an account made for Ember where the service lets
  you, and pick tools with that in mind. Each person can add [their own](#each-persons-own-sign-in),
  for their direct conversation with an agent.
- **Ember finds the sign-in from the server**, as the protocol says to: the server names its
  authorization server, which describes itself. Ember says who it is with a document it serves at
  `/oauth/client.json` where the authorization server reads one, and otherwise registers itself
  there. It asks for the access the server says it needs, proves each sign-in with PKCE, and names
  the server's address as what the tokens are for, so they're no good anywhere else.
- **A service that does neither wants Ember registered there by you.** The form then says so, and
  asks for a **Client ID** and a **Client secret**. Register Ember with the service as an OAuth app
  (a "connected app" or "integration", by some services' names), giving it the **Redirect address**
  the form shows, `https://<your Ember>/account/apps/signed-in`, as where it sends people back, and
  type the client ID it gives you, with its secret if it gives one. Ember signs in as that client,
  shows its ID on the app's page from then on, and keeps what the service knows it by encrypted,
  for that app alone, never showing the secret again. Signing in again uses the same client without
  asking, even after the sign-in has ended; type another ID, or another secret, to change it, or
  clear the ID to have the service come to know Ember by itself. A secret the service doesn't take
  is said once your browser is back, and changes nothing.
- **An app that has a token can be signed in to instead.** When its server takes the token no
  longer, saving it or reading its tools again says so and offers **Sign in to** its host. The
  sign-in then takes the token's place. Ember signs in at the address the app is connected at, so
  nothing is offered while the form has another: to sign in to an app somewhere else, remove it
  and connect it there.
- **Every address in it is checked** as the server's own is: `https` only, unless the server is one
  you're developing on `localhost`, each looked up first and refused where it resolves to a private
  address, with no redirect followed. An authorization server that says it's another service's, or
  describes a sign-in for another address than the server's, is refused.
- **You come back to Ember signed in**, at `/account/apps/signed-in`, which takes the code out of the
  address at once. A sign-in is finished only by the administrator who began it, once, within ten
  minutes; Ember keeps what it needs to finish it encrypted until then.
- **The tokens are kept encrypted**, for that app alone, and never shown. An access token that's
  about to end is replaced first, with the token the service gave for that, one request at a time,
  so a token that's replaced as it's used is never sent twice.
- **A sign-in ends** when the service won't give another token: it was taken back there, or the
  service gave none to renew with. Ember then asks the server nothing: a call of its tools tells the
  model so, the app's page and its row on the AI assistant tab say so, and **Sign in again** on the
  app's page restores it, keeping the app and every agent's picks. A service that couldn't be reached
  for a new token ends nothing: Ember goes on with the token it has.
- **A server can ask for more than the sign-in allows.** When it refuses a call, or a read of its
  tools, and names the access that would allow it (OAuth's `insufficient_scope`), the call isn't
  run, the model is told that an administrator has to sign in again, and the app's page and its row
  say what the server asked for. **Sign in again** then asks the service for that as well as for
  what the sign-in had, which the service shows you before you allow it. Nothing is asked for on
  Ember's own: more access is only ever given by an administrator, at the service.
- **A signed-in app keeps its address** and takes no token, since its sign-in is to the server there.
  To move it, remove it and connect it again.
- **Removing a signed-in app takes the sign-in back at the service**, where the service says how
  (a revocation endpoint, as RFC 7009 has it): Ember sends back the token that renews the sign-in
  and the access token, as the client it signed in as, once the app is gone, waiting at most ten
  seconds. The tab then says whether the service took them back. Where it didn't, couldn't be
  reached, or doesn't say how, remove Ember's access at the service yourself. A sign-in replaced
  by signing in again isn't taken back: the service decides what becomes of the last one.

#### Each person's own sign-in

Anyone but a guest can sign in themselves to an app Ember signs in to, under **Apps** on their
profile, which lists those apps while Ember AI is on. It's the same sign-in at the same service, as
the same client, made as them, and kept beside Ember's, sealed for that app and that person alone.

- **It's used in one place:** their direct conversation with @ember or an agent, the two of them
  alone. A call the agent makes of that app's tools there goes as them, with their sign-in.
  Everywhere else, and for everyone who hasn't signed in themselves, calls go with the sign-in the
  administrator made, as before.
- **Every call as a person asks them first**, on a card that says the call goes as them. What an
  administrator always allows an agent was said of Ember's sign-in, and doesn't cover theirs.
- **Which tools an agent has is still the administrator's pick.** A person's sign-in changes whose
  account a call acts as, not what the agent may call.
- **Their sign-in ends, or wants more, for them alone.** Once it has ended, the call isn't made with
  Ember's instead: the model says they have to sign in again, and their profile says so, with
  **Sign in again**, or **Sign out** to go back to the shared one. When the app's server asks for
  more access than their sign-in has, their profile says so, and signing in again asks for it.
- **Sign out forgets it and takes it back at the service**, where the service says how, as removing
  an app does. Removing the app forgets everyone's sign-in to it and takes back up to 20 of them
  there too, saying it couldn't take everything back when there were more. Removing or banning
  someone forgets theirs, without asking the service.

### Outside AI

An AI app, such as Claude or ChatGPT, can connect to Ember and read it as one of the people in it,
and send messages as them if they let it, in the rooms open to everyone, and in their direct messages
and private rooms only if they let it into those too. Ember is an
[MCP](https://modelcontextprotocol.io) server for that, at `/mcp` on its own address, the other way
round from [Apps](#apps), where Ember's agents call other services' servers. It's off until an
administrator turns on **Outside AI** on the AI assistant tab, which is there whether or not Ember AI
is on, and until then nothing about it answers: `/mcp`, and the addresses below, answer 404.

To connect an app, someone gives it Ember's address ending in `/mcp`, which the card and their profile
show, as a custom connector or MCP server. The app sends their browser to a page of Ember's, which
they sign in to if they aren't, and which asks whether to connect it: it names the app, says what it
could do as them, and says which site the browser goes back to, which is what tells whose app it is,
since the name is only what the app calls itself. **Allow** connects it. **Don't allow** goes back
with nothing.

- **What a connected app can do** is read the rooms open to everyone that the person who connected
  it is in: list them, read a room's messages 40 at a time and a thread's, and search for words
  across those rooms, the ones they've hidden too, as their own search does. It sees nothing they
  don't. Its tools are `list_rooms`, `read_room`, `read_thread` and `search_messages`, each marked as
  only reading.
- **It can send messages as them, if they let it.** The page that asks has a box for that, ticked
  unless they clear it, and their profile says which apps can. `send_message` posts Markdown to a room
  of theirs it reaches, or as a reply in a thread, and everyone there sees it as theirs: nothing marks
  it as sent by an app. It mentions nobody and goes to no bot, so it calls neither @ember, an agent
  nor a bot's webhook, even in a direct message with one, and one person's apps send at most 20
  messages a minute between them. An app that asks for nothing by name only reads.
- **Their direct messages and private rooms are theirs to let it into.** The page that asks has a
  box for them, left clear unless they tick it, as Slack's scopes keep direct messages and private
  channels apart from channels. Ticked, the app lists, reads, searches and, if it may send, sends in
  those too. Clear, it can do none of that there, and a room that's made private is out of its reach
  from then on, though they're still in it. Ember gives them only to an answer that says the box was
  ticked, so a page that doesn't show the box never gives them. Apps connected before Ember asked
  are kept out of them until they're connected again, and the profile says which apps can use them.
- **Your profile lists the apps connected as you**, under **AI apps**, with when each was connected
  and last asked Ember anything, and **Disconnect**, which ends what that app was given at once. One
  person has at most 20.
- **Guests can't connect one**, as they have no account of their own to act as. Removing or banning
  someone ends every connection of theirs.
- **Turning Outside AI off disconnects every app**, and forgets the apps that registered, after
  asking the administrator first. Turning it on again starts afresh.

How an app signs in is OAuth 2.1, as MCP's
[authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) has it,
with Ember as the authorization server:

- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` say
  where, and a request to `/mcp` without a token answers 401 pointing at the first.
- The scopes are `read`, `write`, for sending, and `private`, for direct messages and private rooms,
  which gives no tools of its own. A request without a token names all three, and the page that asks
  gives `write` unless it's cleared and `private` only if it's ticked. An app that asks for `private`
  alone is asked to read with it.
- An app names itself by the address of a Client ID Metadata Document, which Ember reads from a
  public address only, or registers itself at `/oauth/register`, 10 times an hour from one address at
  most. Either way it's a public client, with no secret, and proves itself with PKCE (S256).
- The browser goes back only to an `https` address the app gave, or to `http` on the person's own
  computer, at any port, for an app that runs there. An app that's opened by a scheme of its own,
  such as `cursor://`, can't connect yet.
- An access token lasts an hour, and a refresh token is replaced each time it's used and lasts 90 days
  unused. Using a refresh token that was replaced, however long ago, or a code twice, ends that
  connection, as either means it was copied. Ember keeps only a keyed digest of each, made with
  `SESSION_SECRET`, so its database holds nothing an app could sign in with.
- A token works only at the address the app said it was for, when it asked to connect or when it
  exchanged its code, so one given for another Ember, or for this one at another address, is
  refused. An app that never says is bound to none: its tokens are still only this Ember's.

Requests to `/mcp` are answered in a Durable Object of their own, `OutsideAi`, apart from the rooms and
the workspace, as an app's tools are read in `AppConnector`: reading a request and checking it takes
more CPU time than a Worker's request gets on Workers Free. It keeps nothing, and each request has a
new one.

### Huddles

A huddle is a room's call, by voice, by camera and by the screens people share, laid out as Slack's
is. The headphones at the top of a room start its huddle, or join the one going on, and show the rest
of the room how many are in it. So does the room's row in the sidebar, which ends with the faces of
the first two people in the huddle, the headphones and how many are in it, and says who they are
under a pointer. Starting or joining goes by a preview, which asks the browser for a microphone and
offers a choice of it and, where the browser has one, of the speaker; without a microphone you join
to listen. The preview's camera switch turns your camera on, which asks the browser for one only
then, shows you its picture and offers a choice of camera.

The huddle opens as you join it, over the page beside the sidebar, or over all of a phone's: a tile
for each person, with their camera's picture, or their avatar while it's off, their name, and a mark
while they're muted, as large as shows everyone in the window, and the microphone, the camera, the
screen and Leave along its base. Where the huddle is beside the sidebar, as on a computer, an arrow
beside the microphone opens a menu of the microphones to speak through and, where the browser can
choose one, the speakers to play the huddle through, and an arrow beside the camera a menu of the
cameras. The huddle changes to the one chosen without leaving, as muted as it was, and this
browser's next huddle starts with it. Someone who joined to listen can take up a microphone there,
and choosing a camera while yours is off turns it on. Minimizing it, or going to any page, leaves a
bar along the window's base, which follows you from page to page with the microphone, the camera,
the screen, the button that opens the huddle again, and Leave; a phone's bar has the microphone and
Leave, and opens the huddle at its name. Whoever is speaking has a green ring round their tile, and
round their face on the bar. Your browser tells who by how loud each voice it plays is, and your own
by your microphone, so nothing more is sent for it, and nobody muted shows as speaking. Cameras are
640 by 360 at up to 500 kbps, and up to 25 can be on in a huddle at once. Chrome, Edge and the other
browsers built on Chromium send a camera in a second size as well, 320 by 180 at up to 150 kbps, and
a browser whose tiles are no taller than that, as with many people in the huddle, or beside a
shared screen, is sent that size in place of the larger. Safari and Firefox send a camera in the one
size, which everyone is sent. Your browser is sent the others' cameras only while you have the
huddle open, and a camera's picture isn't kept in step with its person's voice, which travels apart
from it.

Share screen, beside the camera, has your browser ask which screen, window or tab to share, and
shares it until you stop it there or in your browser. Two people can share at once, as in Slack's
huddles, and a third is told so before their browser asks them anything. Everyone else sees a shared
screen large, all of it, in its own shape, under whose it is, with the huddle's tiles small beside
it, or under it, as on a phone held upright, whichever shows the screen larger. The tiles scroll by
themselves once there are more than fit there. A second screen shows among the tiles, first of them,
and a click on it shows it large in place of the other. Your own shows among your tiles, as the
others see it. A screen is sent as large as 1920 by 1080, at up to 15 frames a second and 1.5 Mbps,
without its sound, and only to those who have the huddle open: once it's minimized, its bar says
who's sharing. A phone's browser has no screen to share, so phones watch.

On a phone, where the huddle is over all of the page and has no arrows, a button beside the camera,
Switch camera, is there while your camera is on and the browser has another. It shows the camera
that faces the other way, as a phone's back camera does from its front one, or the next the browser
lists where it doesn't say which way its cameras face, and this browser's next huddle starts with
it. A phone opens one of its cameras at a time, so a huddle lets go of the camera that's on before
it opens another, on a computer too, and opens it again when the browser won't open the other, which
you're told. Your own picture shows as a mirror would, unless your camera faces away from you. A
phone's browser stops a page once its screen locks, and the huddle with it, so a huddle keeps the
screen of a phone or a tablet awake for as long as its page shows, where the browser can, which one
may refuse while the phone saves its battery. Whatever the browser stopped while you were in another
app, the others' voices, their pictures or the telling of who's speaking, starts again as you come
back to the page, and a tab that lost the room meanwhile joins the huddle again by itself.

A sound plays as someone joins the huddle, yourself included, and another as someone leaves it. While
you're the only one in it, quiet music plays on a loop, as Slack's does, from five seconds after you
find yourself alone until someone joins you. The two sounds, and an invitation's ring, were written
for Ember and the music was generated for it by Google's AI, so nothing is owed for playing them, and
`apps/web/src/lib/huddle-sounds/` says where each came from and how to change them.
Ctrl+Alt+Shift+H (⌘⌥⇧H on a Mac) leaves the huddle you're in, or opens the preview for the room
you're looking at, and Ctrl+Shift+Space (⌘⇧Space) mutes and unmutes. The arrow beside the headphones
copies the huddle's link, which opens the room at the preview, or the huddle once you're in it. A
huddle takes up to 50 people and ends when the last of them leaves. A tab is in one huddle at a time,
and joining a room's huddle from another tab or device leaves it in the first.

A huddle has a message in its room, as Slack's does, which Ember writes as the huddle starts, in the
name of whoever started it. Where a message has its author's face and name, it has the headphones
on green and "A huddle is happening", with LIVE beside it, and under that the faces and names of
whoever is in the huddle, and Join, which opens the preview, in any tab that isn't in it. Once the
last of them has left it reads "A huddle happened", and says who was in it and for how long: "Sam
and Priya were in the huddle for 24 minutes". It's a message in what else it has: its time and its
link, reactions, and a thread, where what a huddle settled can be written down, and search finds it
by "A huddle started", which it has for its text. But it marks nothing unread, notifies nobody and
is sent to no webhook, since the sidebar already shows a huddle and an invitation rings whoever is
wanted in it, and nobody can edit it. Whoever started the huddle can delete it, as can an
administrator, which leaves the huddle going with no message. Someone who was in a huddle and joins
the room's again within half a minute of its end goes on with that huddle, under the same message,
so the last person's lost connection doesn't leave the room two of them. Anyone else starts another.

The huddle shows that thread itself, beside the people in it, where Slack's huddle window has it:
under Thread, it says what a huddle's thread is for, then what's been written in it, over a composer
to reply in, with files and links as in any thread. What you send there, everyone in the huddle
reads as it comes, and it stays in the room, under the huddle's message, once the huddle is over.
A reply begun in the thread beside the room is there in the huddle to go on with, and the room's has
it as the huddle's left it. Close thread takes it away, as does Thread, among the huddle's buttons
after the screen's, which shows it again with the cursor in its composer: closed, it leaves its
space to the people in the huddle, or to a screen someone shares. The thread is there as a huddle
opens, in a window at least 1180px wide. A narrower one, or a phone, has the thread in the room,
from the huddle's message. It comes to the huddle over a connection of its own to the huddle's room,
whatever page the huddle is open over, and having it there is neither being in the room, which
doesn't show you among who's here for it, nor reading it: what's said in the room meanwhile still
marks the room unread, unless it's a reply sent there from the thread too, which you've seen. A
huddle whose message has been deleted has no thread, and says so.

A direct message has a huddle too, with the headphones at its top and its mark on its row in the
sidebar, when there's someone in it to huddle with, which a bot or an AI agent isn't, nor anyone who
can no longer sign in. Starting one there invites the others in it. Wherever they have Ember open,
an invitation shows in the window's corner, under the header, whatever page they're on: who invites
them, over Decline and Join. It rings for half a minute, in one of a browser's tabs at a time, and
without a sound for someone who's in a huddle already. Join opens the huddle's preview, so nobody is
in a huddle before they've said how they join it, and answering an invitation, either way, takes it
down in their other tabs and on their other devices. Whoever started the huddle isn't told of a
Decline. It stops ringing by itself once the huddle is over, or once they're in it. An invitation
reaches the people in the direct message who hear its @mentions or more, so nobody who has turned
its notifications off. Nothing is kept of an invitation, so a tab whose connection is down when one
comes never shows it.

Anyone in a huddle can invite more of its room's people into it. Invite people, the first button
along the huddle's base, or in the menu of More, the last before Leave, on a phone, lists the people
in the room who aren't in the huddle and could join it, by name, 20 at a time under a search once
there are more. Tick one or more, up to 50, and Send Invite has the room invite them as it does for
a direct message's huddle, and an invitation into a shared room says which: "Priya Patel invites you
to a huddle in Launch". Here too, it rings only those who hear the room's @mentions or more, and
whoever sent it is told who they invited, not who it reached, nor of a Decline.

Whoever an invitation reaches who has Ember in view nowhere is sent it as a push notification too,
on each browser and phone where they turned notifications on: someone with no tab of Ember open,
with every one in the background, or with none heard from in the last minute, as on a laptop gone
to sleep. A tab says whether it's shown as it connects, and each time it's hidden or shown again.
The notification is titled with who invites them and reads "Invites you to a huddle", and in which
room for a shared room's, and opening it opens the room, where the huddle is to join. A push
service keeps it for a minute for a device it can't reach, where it keeps a message's for four
weeks, so a phone that was off isn't told of a huddle long over. Once shown, it stays until it's
opened or dismissed: answering the invitation somewhere else, or the huddle ending, doesn't take it
down. A tab in the background still shows the invitation, and rings if its browser lets it, so
someone with Ember behind another tab may get both. So may someone looking at a tab left open
since before Ember was updated to do this: such a tab doesn't say whether it's shown, so it
doesn't count until it's reloaded.

An administrator turns huddles on under Huddles in community settings, with the switch on its card.
Huddles run through Cloudflare's [Realtime SFU](https://developers.cloudflare.com/realtime/sfu/),
which carries what each person in a huddle says and shows to the others, by an SFU app in your Cloudflare
account. Turning the card on opens Set up huddles, which has two steps: create the app under
Realtime, Serverless SFU in the Cloudflare dashboard, which the dialog's button opens, in the
account Ember is deployed to when the deploy gave it, then copy the app's App ID and App Secret into
the dialog, where the secret shows as dots. Before it keeps the keys, the Worker asks the SFU to
start a session with them (`POST /apps/{appId}/sessions/new`), which nobody connects to, so an app
Cloudflare doesn't know, or a secret that isn't the app's, is refused on its field. Cloudflare can
take a minute to know a new app everywhere. Change keys takes another app's, and turning the card
off forgets them, which ends any huddle going on within half a minute. Setting Ember up asks about
huddles too: once it has made the administrator's account, Set up Ember asks whether to turn them
on, and takes the same two steps before it opens Ember, or Not now, which leaves them to community
settings. The secret stays in the Worker, which alone asks the SFU's API: a browser sends its
microphone, its camera and the screen it shares to the SFU, and hears and sees the others from it,
over WebRTC, and finds its way there with Cloudflare's STUN server (`stun.cloudflare.com:3478`).
What the SFU charges is in [What it costs](#what-it-costs).

While huddles are on, the tab has a second card under the first, with a switch for each thing people
may do in a huddle, Cameras and Screen sharing, each on until an administrator turns it off. With
Cameras off, the preview has no camera switch and the huddle no camera button, a camera that's on
goes off, which its person is told, and the room refuses any camera it's asked to show. With Screen
sharing off, the huddle has no button to share a screen, a screen that's shared stops being, which
its person is told, and the room refuses any it's asked to show. With both off, huddles are voices
only. The room takes down whichever cameras and screens a tab left on, eight every half minute.
Turning a switch on again gives its buttons back, and nobody's camera comes on, or screen is shared,
by itself.

Some networks, like an office's or a hotel's, block the way a browser reaches the SFU, and nobody on
one can connect to a huddle. A third card, Relay for strict networks, gives huddles a relay for them:
Cloudflare's [TURN service](https://developers.cloudflare.com/realtime/turn/), by a TURN key in your
Cloudflare account. Turning the card on opens Set up the relay, which has two steps: create a TURN
key under Realtime in the Cloudflare dashboard, which the dialog's button opens, then copy the key's
TURN Token ID and API Token into the dialog, where the token shows as dots. Before it keeps the key,
the Worker has Cloudflare make a relay's servers with it, which nobody is given, so a key Cloudflare
doesn't know, or a token that isn't the key's, is refused on its field. Change key takes another's,
and turning the card off forgets it, as turning huddles off does, while another SFU app's keys leave
it as it is. The token is kept encrypted and stays in the Worker. As each tab joins a huddle, the
Worker asks Cloudflare for the servers its connections go by, the relay's among them, with a name and
a credential made for that tab, which last a day. A browser still reaches the SFU directly where it
can, and through the relay only where its network blocks the way. Cloudflare has four seconds to
answer, and a tab it doesn't answer for joins without the relay, which the Worker's log says. A tab
whose connection fails once its day is over joins again, for new ones. Cloudflare doesn't charge for
the TURN service when it's used with the Realtime SFU.

### A preview from GitHub Actions

The Preview workflow (`.github/workflows/preview.yml`) deploys `main` to a Worker named
`ember-production` on your workers.dev subdomain when run by hand from the Actions tab. It needs two
repository secrets, and skips without them:

- `CLOUDFLARE_API_TOKEN`: a token made from the "Edit Cloudflare Workers" template.
- `CLOUDFLARE_ACCOUNT_ID`: under Account details on the Workers & Pages overview.

The first deploy makes the Worker's `SESSION_SECRET` and VAPID key pair, and later ones keep them;
they go up with the deploy, never in its logs, as the account's ID does, for Set up Ember AI to fill
in. A public repository's Actions logs are public too, so
the workflow prints no setup link and makes no setup token: the Worker takes its token from an
`EMBER_SETUP_TOKEN` repository secret, if you add one (`openssl rand -hex 32`) before the first
deploy, and the run's log then says to open `<the preview>/first_run#token=<your token>` to set
Ember up. Without the secret, the deploy check says nobody can set the preview up until you give it
a setup password with `wrangler secret put EMBER_SETUP_PASSWORD --name ember-production`, which asks
for it, or deploy it from a terminal with `pnpm run deploy --name ember-production`, which makes a
token and prints the link.

Repository variables named `EMBER_SETUP_NAME_PLACEHOLDER` and `EMBER_SETUP_EMAIL_PLACEHOLDER`, if
you add them, become the preview's setup form placeholders.

The preview is a private workspace, which its administrator invites people to with the join link.
Its version, under the sign-in page's card, is the commit it deployed. After each deploy,
`node apps/worker/scripts/check-deploy.ts <url>` checks, without signing in, that `/api/health`
answers (which needs `SESSION_SECRET`, and the Workspace and a room's Durable Object reading their
storage), that the page loads through the Worker with its headers, that the API asks for sign-in,
and whether Ember is set up yet, or waits for its setup password or link. `/api/health` tells
strangers only whether Ember is up; with the Worker's `EMBER_RECOVERY_TOKEN` in its environment, the
check hears which storage it uses too, and why when it's down. It sends the token only to an `https://` address,
or an `http://` one on this machine, and follows no redirect with it. The preview's link is on the
run's summary and under the repository's Deployments.

### A demo from GitHub Actions

The Demo workflow (`.github/workflows/demo.yml`), run by hand from the Actions tab, deploys `main` to
a Worker of its own, `ember-demo`, with its own R2 bucket, and has `pnpm seed`'s made-up team set it
up and talk, for people to try Ember without touching the preview. It takes the same two repository
secrets, and the bucket has to exist first: `pnpm exec wrangler r2 bucket create ember-demo`. Its
first run takes a setup token (`openssl rand -hex 32`) and everyone's password, which the run masks
in its log. Sign in as Maya Chen, its administrator, to find its join link in Membership, and pass that
on to whoever's trying it. A run without them brings the demo up to `main`'s code.

### Resetting a password

While Ember can send email, above, someone who forgot their password resets it themselves: the
sign-in page's "Forgot your password? Reset it" opens `https://<Ember's address>/passwords/new`,
where they give their email address, and Ember emails them an 8-digit code. The code works for 15
minutes, 5 tries and only until a newer one is sent, and with it they choose a new password, which
signs them in and ends their other sessions. The page says the same whether or not the address has an
account. Ember emails an address at most 3 times an hour, counting Email domain's links, and until
Ember has Turnstile's keys, each network can ask for 10 codes an hour. Each try of a code counts
against sign-in's limit, 10 tries from a network in 3 minutes.

Otherwise, someone who can't sign in gets a new password from `apps/worker/scripts/reset-password.ts`.
The Worker takes recovery requests only while its `EMBER_RECOVERY_TOKEN` secret is set, and the
script sends the same token from your shell's environment, so set one up just for the reset (add
`--name ember-production` to each `wrangler` command for the preview):

```sh
export EMBER_RECOVERY_TOKEN=$(openssl rand -hex 32)
printf %s "$EMBER_RECOVERY_TOKEN" | pnpm exec wrangler secret put EMBER_RECOVERY_TOKEN
node apps/worker/scripts/reset-password.ts https://<your Worker> ada@example.com
pnpm exec wrangler secret delete EMBER_RECOVERY_TOKEN
```

The script asks for the new password twice without showing it, or reads one line from stdin. All
the person's sessions end, with the sign-in links they showed, and their open tabs go to sign in.
Their browsers get no pushes until they sign in again. Their role and status stay as they
were, so someone deactivated or banned still can't sign in. Whoever has the token can take over any
account, so delete the secret once you're done; without it, the endpoint answers 404, as any
address the API doesn't have does.

### Security notes

What a self-hoster should know, beyond keeping the setup password and link to themselves:

- The API token Deploy to Cloudflare's builds run with may edit nearly everything in your account,
  every R2 bucket included, so trim it, as [The build's token](#the-builds-token) says.
- Every answer carries a `Content-Security-Policy` beside Rails' headers: scripts only from your
  Worker and from Cloudflare Web Analytics' beacon, images from any HTTPS site, since link previews
  show their page's image, and no page of Ember's in a frame elsewhere. Cloudflare adds the beacon to
  Ember's pages when Ember has a custom domain in a zone with
  [Web Analytics](https://developers.cloudflare.com/web-analytics/) on, and it measures how fast pages
  load and respond for the people who open them. When the policy gets in the way of something in a browser, the
  browser reports it to `/csp-report` and the Worker logs it, so look there if a page misbehaves.
- Link previews and bot cards show images from other sites, which load without a referrer: a site
  sees the reader's IP address, but not which Ember shows its image.
- An administrator can make a sign-in link for anyone, administrators included, which signs in as
  that person for 4 hours, more than once, while the session that showed it is still signed in as an
  administrator. Your own link works only while the session that showed it does, so signing out, a
  password reset, or a new password saved in another session ends it. A new password saved in the
  session that showed it, or Disconnect Memberful there, ends every link that session had shown until
  then, those an administrator showed of other people included, and the ones it shows from then on
  work. Its id travels in the address's fragment, which no log sees.
- A file's address is signed and never expires: whoever has it can open the file until its message
  is deleted, as with Active Storage's links. A bot is given the addresses of the files in its rooms,
  with the messages its webhook is sent and those the bot API answers, so it can read them.
- A bot's webhook payload carries a key of the webhook's own, never the bot's. It posts and reads as
  the bot in the message's room alone, and stops working once the webhook's URL changes or it's
  removed, or the bot's key is reset, so a server Ember no longer delivers to can't go on posting as
  the bot. Point bots only at servers you trust all the same. Webhooks go only to https, or to http
  on localhost, so nobody on the way reads the key; a bot saved with an http URL elsewhere before
  gets no deliveries until its URL is changed, and the Worker's log says why.
- Anyone in a room can click a [button that acts](slack-webhooks.md#buttons-that-act) on a bot's
  card there, and the bot is told who clicked, so a bot that should act only for some people has to
  check that itself. The room sends the button as the bot posted it, never what a browser says of it.
- Workers Logs record each request's address, which for Campfire's bot API and the Slack-compatible
  webhooks holds the bot's key and for the join link its code; Reset key and Regenerate join link are
  the remedies if a log is shared, and
  `"logs": { "invocation_logs": false }` under `observability` in `wrangler.jsonc` drops the
  per-request record.
- A new password takes at least 8 characters, at setup, on joining, in a profile or in a reset,
  though a shorter one set before keeps working. Passwords are kept as scrypt digests at OWASP's
  cost, which takes about a quarter of a second of CPU in a Durable Object of its own; digests from
  before scrypt are replaced as their passwords sign in.
- A session lasts until it goes 400 days unused. Changing your email address or password takes
  your current password, so holding someone's session isn't enough to take their account, and
  someone Memberful signs in without a password isn't given one, so it isn't enough to make another
  way in either. A new password ends your other sessions and forgets their browsers' push
  subscriptions. A password reset, deactivation or ban ends all of a person's sessions within a
  minute.
- Until Ember is set up, only the setup password, or the setup link a deploy printed, opens the form,
  so finding a new deployment's address isn't enough to become its administrator. Tries at the
  password count against one limit for the whole deployment, 10 every 10 minutes, kept in its
  storage, so neither another address nor a restarted Worker starts the count over; past it, the
  right password waits too, though the link doesn't, since its token is too long to guess. Ember
  takes a setup password of any length, so make yours one nobody would guess in a few tries. On
  localhost, and on a Worker with neither, setup is open or closed as [Deploying](#deploying) says.
- `EMBER_GUEST_SIGN_IN=true` lets anyone with the address in with just a name, so keep it to
  `wrangler dev`, as `.dev.vars.example` says.
- With Open on, anyone who finds the address can make an account, with any email address, and
  create rooms unless Must be admin to create new rooms is on. Turnstile, given its keys, keeps most
  bots out, and until then its limits keep a flood from filling the free plan. The join link has no
  limits, since its secrecy is the gate: regenerate it if it gets out.
- A Resend API key pasted into Set up email is kept encrypted, and never shown again, even to
  administrators: Membership says only that Ember has one. Make it a key with Sending access, as Resend
  suggests, so that one that got out could do no more than send email. A Turnstile secret key given in
  Set up Turnstile, an API token given in Set up Ember AI, an SFU app's secret given in Set up
  huddles, and a Memberful app's secret and API key and its webhook's secret key given in Set up
  Memberful, are kept the same way.
- A code to reset a password goes to the account's email address, so whoever reads mail there can
  take the account over, as on most sites. Nobody checks an address is its owner's when someone
  joins, unless they join with an invitation or Email domain, so someone could join with another
  person's address, whose owner could then reset its password. A code is kept only as its digest,
  and at 3 codes an hour and 5 tries each, guessing one would take centuries. The page answers before
  Ember emails anything, so neither what it says nor how soon tells who has an account.
- Email domain lets in whoever can read mail at its domains, so list only domains whose addresses
  your organization hands out: Membership warns of ones anyone can have an address at, such as
  gmail.com. Its page answers the same whether or not an address has an account, emailing someone
  who has one a way to sign in instead, so it tells strangers nothing of who's here.
- The Memberful site vouches for its members, so whoever runs it can sign in here as any of them who
  have, and while Memberful is on, add new ones. Administrators keep their passwords, so the site
  being down never locks them out, though one who joined with Memberful has none, as no member does,
  and signs in with it alone. A webhook whose signature the webhook's secret key doesn't check is
  refused, and even a signed one only has Ember ask Memberful's API about a member, so one forged or
  sent again changes nothing.
- Custom CSS runs on every page for everyone, so it's an administrator's to write, like the rest of
  the workspace, and `EMBER_RECOVERY_TOKEN` can take over any account, so keep it set only while
  resetting a password, as above.
- While [Outside AI](#outside-ai) is on, an AI app someone connects sees the open rooms they're in,
  and their direct messages and private rooms only if they tick those, and writes as them if they
  let it send, until they disconnect it on their profile, and whoever runs that app can read it too.
  The page that asks them names the site their browser goes back to, since anyone can register an app
  under any name.
- `/api/health` tells strangers only whether Ember is up; administrators and whoever sends the
  recovery token hear the rest. QR codes (`/qr_code/<id>`) are drawn for people signed in.

If you find a hole in Ember itself, report it privately with GitHub's form rather than in an issue,
as [SECURITY.md](../SECURITY.md) says.

## What it costs

Ember is free, under the MIT license. What it runs on is Cloudflare's, at Cloudflare's prices, as its
pages had them in October 2026:

- **Workers Free** costs nothing, and Ember is built to fit it: its Durable Objects keep their data in
  SQLite, it needs no cron triggers, queues or KV, and it hashes passwords and fetches link previews in
  Durable Objects of their own, since a Worker's request gets only 10 ms of CPU there. The plan's
  allowances are daily, and reset at midnight UTC. The one Ember reaches first is the 100,000 rows a day
  that Durable Objects may write: as measured in October 2026, a message writes about 20 (13 in its
  room, 5 in the search index and 2 in the Workspace), opening a room about 5, a reaction 5, and signing
  in with a password 26. That's 3,000 to 5,000 messages a day, depending on what else people do: about
  100 people a day sending 30 messages each, 500 who send a few, or 30 who chat all day. Once a day's
  rows are written, Ember can't save anything new until midnight UTC. Durable Objects may keep 5 GB in
  all, and pushes past 50 at a time fail, as [Push notifications](#push-notifications) says.
- **Workers Paid** costs $5 a month for the whole Cloudflare account, not per person. Its allowances
  are monthly and far larger, such as 50 million rows written a month, and use past them is billed at
  Cloudflare's rates.
- **Files** go to R2, which stores 10 GB a month free, then charges $0.015 per GB a month, and never
  charges for downloads. Cloudflare Images makes the previews of 5,000 pictures a month free, where
  uploaders' browsers sent none, and on its Paid plan charges $0.50 per 1,000 after that, as
  [Files](#files) says.
- **Email**, if Ember sends it: Resend's free plan sends 3,000 emails a month, at most 100 a day, and
  Cloudflare Email Service includes 3,000 a month on Workers Paid, as [Sending email](#sending-email)
  says.
- **Ember AI**, if it's on: its models are paid for with AI Gateway's credits, at each provider's own
  per-token prices, plus a 5% fee on the credits bought: for a million tokens read and a million
  written, from $0.10 and $0.50 on Claude Haiku 5.5 or GPT-6 Luna to $10 and $50 on GPT-6 Astra, as the
  model menu says. Workers AI's models are free up to 10,000 Neurons a day on either plan, and Workers
  Paid bills past that at each model's own prices, which the menu says too, in Neurons at $0.011 per
  1,000. AI Gateway's credits pay for them instead once Unified billing is chosen under Workers AI
  Billing in the default gateway's settings, which also opens the models Cloudflare otherwise runs only
  on Workers Paid. Thinking counts as output, as the answer does, so the [dials](#ember-ai) bound what
  one answer costs: at most 3,000 tokens out at Off and Short, 6,000 at Low and Medium, and 38,000 at
  High and Long. Picking a model asks it a test question, then again at each Thinking level, each at
  most 2,000 tokens out. Each person's questions cost what the model they pick does, so add to the
  Models list only the models you're happy to pay for, and each [agent's](#ai-agents) what its own
  model does at its own dials, whose most its page says. While Search the web is on, an answer can also
  search up to 5 times, which Anthropic charges $10 per 1,000 searches for and OpenAI
  its own price per search, and Cloudflare's Web Search API, for Grok and Workers AI's models, $0.25 per 1,000
  with its default provider, Ceramic.ai, paid with AI Gateway's credits. The results and pages it reads
  count as input, up to about 10,000 tokens a page. An answer that searches its room, which Claude,
  GPT and Grok can, up to 5 times, has its model read the conversation again after each round of
  searches, with what they found.
- **Huddles**, if they're on: Cloudflare's Realtime SFU charges for what it sends to the people in a
  huddle, and nothing for what they send it. The first 1,000 GB a month are free, and it's $0.05 per GB
  after that, as its page had it in November 2026. A voice is about 50 kbps to each person who hears
  it, so five people talking for an hour are sent under half a GB between them, and the free 1,000 GB
  carry about 2,000 such hours a month. A camera is up to 500 kbps to each person who has the huddle
  open, so the same five with their cameras on throughout are sent up to 4.5 GB more in the hour, and
  the free 1,000 GB carry about 200 such hours a month. A camera from a browser that sends it in two
  sizes is up to 150 kbps to each person whose tiles show it small, so twenty people with their
  cameras on throughout, each in a window that shows the others small, are sent up to 26 GB in the
  hour, where the larger size would come to 86. A shared screen is up to 1.5 Mbps to each person who
  has the huddle open, so one shared with the other four throughout is up to 2.7 GB more in the
  hour. Turning Cameras and Screen sharing off under Huddles keeps huddles to voices. A relay for
  strict networks adds nothing to it: Cloudflare's TURN service is free of charge used with the SFU.

Cloudflare's pages have the details: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[AI Gateway's Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) and
[Realtime SFU pricing](https://developers.cloudflare.com/realtime/sfu/pricing/).

## Storage: Durable Object SQLite or D1

`STORAGE_BACKEND` picks where messages live, and with them the rooms, the people and the rest of what
Ember keeps: type it in Deploy to Cloudflare's form, or set it in `wrangler.jsonc`'s `vars`.

- **`do-sqlite`** (the default): each room's Durable Object keeps its messages in its own SQLite
  storage, and the Workspace object keeps what the rooms share in its own. There's nothing to set up,
  reads and writes never leave the object, and no room waits on another, so it scales furthest:
  Durable Objects may keep 5 GB in all on Workers Free, and 10 GB for each room on Workers Paid.
- **`d1`**: everything goes to one D1 database, which you can query in the dashboard or with
  `wrangler d1 execute`, export with `wrangler d1 export`, and restore to any minute of the last 7 days
  (30 on Workers Paid) with Time Travel. It's one database for the whole Ember, which runs one query at
  a time, each a trip from the room's object to the database, and holds at most 500 MB on Workers Free
  and 10 GB on Workers Paid, which Cloudflare can't raise.

Neither choice changes much how many people Ember carries: on Workers Free, D1 has a daily allowance
of rows written of its own beside Durable Objects', which lifts the estimate in
[What it costs](#what-it-costs) from about 100 people a day to about 125. Past that, move to Workers
Paid, whichever you chose. Choose before you set Ember up: nothing moves messages from one to the
other, so switching later starts an empty Ember, to be set up again, and leaves the messages where
they were.

The form makes the D1 database bound as `DB` whatever you type, since it can't make one only for D1;
on `do-sqlite`, the deploy leaves it unbound and empty. From a terminal, set `STORAGE_BACKEND` to
`"d1"` and run `pnpm run deploy`, which makes the database that `d1_databases` names, `ember`, if your
account has none of that name. Each Ember needs a database of its own, so give a second one another
`database_name`.

On `d1`, `pnpm run deploy` applies `apps/worker/migrations/` to the database before the Worker deploys,
which takes a Cloudflare API token that may edit D1. The token Workers Builds makes for a build may
not: if a Deploy to Cloudflare build stops at `wrangler d1`, give its token D1 Edit in the dashboard,
under **My Profile**, **API Tokens**, and retry the build. The deploy also stops, saying why, where
`STORAGE_BACKEND` is anything but `do-sqlite` or `d1`, which the Worker would take for `do-sqlite`, and
where the database holds a set-up Ember that the Worker isn't bound to, as another Ember's would. If
that database is this Ember's own, from before it was on DO SQLite or before its Worker was made again,
set `EMBER_ADOPT_D1_DATABASE` to the database's name in the deploy's environment, a build variable
under the Worker's **Settings**, **Build** for a Deploy to Cloudflare copy, and deploy again. A dry run
(`--dry-run`) leaves the database as it is. For `wrangler dev`, apply the migrations to the database on
your machine with `pnpm --filter @ember/worker d1:migrate:local`.

Both use the same schema (`apps/worker/migrations/`) and the same queries
(`apps/worker/src/store.ts`); only the driver (`apps/worker/src/db.ts`) differs. The Workspace
object's tables follow the same setting. The search index's don't: it keeps every room's messages in
one FTS5 table in the `SearchIndex` object's own storage, since D1 can't export a database that holds
one. [`docs/database.md`](database.md) compares them with Campfire's.
