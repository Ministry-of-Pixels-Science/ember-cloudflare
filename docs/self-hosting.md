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
workspace's tables bring themselves up to date the first time they open. Closing it instead turns that
release down until the next, whose pull request brings its changes too. Workers Builds builds each
pull request's branch as a Preview, and the pull request shows whether it built; that's all a Preview
is for, since `wrangler.jsonc` gives Previews none of Ember's bindings and no address.

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
Workspace settings, which walks them through it:

1. In Memberful, under Settings, Custom applications, add an app with Include OAuth tokens with
   this application checked, choose Server-side, and give it the OAuth redirect URL
   `https://<Ember's address>/auth/memberful/callback`. Leave Memberful's automatic sign-in off,
   since it skips the check that ties a sign-in to the browser that started it.
2. Give the Worker the app's keys as secrets: `MEMBERFUL_URL`, the site's address, such as
   `https://example.memberful.com`, and the app's OAuth identifier and client secret as
   `MEMBERFUL_CLIENT_ID` and `MEMBERFUL_CLIENT_SECRET`. Each command asks for its value:

   ```sh
   pnpm exec wrangler secret put MEMBERFUL_URL      # add --name <worker> for a Worker not named in wrangler.jsonc
   pnpm exec wrangler secret put MEMBERFUL_CLIENT_ID
   pnpm exec wrangler secret put MEMBERFUL_CLIENT_SECRET
   ```

   Or add them under the Worker's Settings, Variables and Secrets in the Cloudflare dashboard, as the
   type Secret, since a deploy takes away plain text ones. `pnpm run deploy` uploads them too when its
   environment has them, so the Preview workflow passes repository secrets of the same names through.
3. So that a member whose membership lapses is signed out, not only kept from signing in again, add
   a webhook in Memberful under Settings, Webhooks that sends the member, subscription and order
   events to `https://<Ember's address>/webhooks/memberful`, and give the Worker the webhook's secret
   key and the app's API key, as the step above does the others:

   ```sh
   pnpm exec wrangler secret put MEMBERFUL_WEBHOOK_SECRET
   pnpm exec wrangler secret put MEMBERFUL_API_KEY
   ```
4. Turn on Memberful in Workspace settings.

While it's on, the sign-in page offers Member? Sign in with Memberful under its form. Someone with an
active subscription, or the all access pass, signs in as the person their Memberful account is
linked to, or else joins as a new member, in every open room, and everyone else joins and signs in
as before. Accounts are linked by the Memberful site and the member's id there, never by email
address, since Memberful lets anyone register an address without proving it's theirs: someone new
whose Memberful email address someone here has already is turned away, and asked to sign in with
their password. The site is `MEMBERFUL_URL`'s address, so keep it once people have signed in: at
another address, even the same site's, every member would be someone new. Turning Memberful off
stops anyone new joining with it, but whoever signed in with it has no password, so they keep
signing in with it, and the sign-in page keeps offering it, while the Worker has the keys.

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
other way into an account, while someone who joined with Memberful keeps theirs as they set a first
password. Neither disconnects it from someone without an email address, which signing in with a
password takes, so nobody is left with no way to sign in: the section asks them to add one first.
Once disconnected, a member signing in with their password is asked to connect one again.

A member whose membership lapses can't sign in with Memberful again. With the webhook, they're suspended too: their
sessions end, their sockets close and their browsers' push subscriptions are forgotten, but their
rooms, private ones too, messages and role stay, and they're back as they were once it's renewed and
they sign in. Making an open room private leaves them out of it, as it does anyone not chosen. A
webhook only tells Ember whom to ask about: Memberful sends them in no particular order, so the
Workspace asks Memberful's API what that member's membership is now, and asks about everyone linked
once a day too, in case one never came. Administrators, and the people they invite, who need no
membership, are never suspended. Administrators see suspended members dimmed in Workspace settings,
where they can remove them, and everyone else sees them as removed. All of this goes on whether
Memberful is on or not, since its members keep signing in with it once it's off.

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
both from Workers AI's Use REST API in the Cloudflare dashboard, then a model. The account's ID
starts as the one Ember is deployed to, when the deploy gave it, leaving only the token to copy, and
the dialog's links open that account's pages in the dashboard. Ember asks models through the
account's default [AI Gateway](https://developers.cloudflare.com/ai-gateway/), whose
logs, caching and spend limits apply. Workers AI's models come with Cloudflare's free daily
allowance, and other companies', such as Anthropic's, OpenAI's and Google's, are paid for with AI
Gateway's credits, as [What it costs](#what-it-costs) says. The model menu lists the text models in
Cloudflare's [model catalog](https://developers.cloudflare.com/ai/models/), as the Worker reads it with
the token (`GET /accounts/{id}/ai/catalog/models`) as the dialog goes on to the model, so new models
show up as Cloudflare adds them: Workers AI's first, then other companies', with what each
million tokens costs where the catalog says. When the catalog can't be read, the menu has the models
Ember knows and says why, and Another model takes any model by its ID. Add a model and the agents'
pages list the same models from a copy the Worker keeps, since Cloudflare takes a few seconds to list
the whole catalog: the copy answers at once, and once it's ten minutes old, the Worker reads the
catalog again in the background for the next listing. The Worker asks the model a test question before
keeping the setup. @ember then joins every room open to everyone, and turning the
card off takes it and the [AI agents](#ai-agents) out again and forgets the token. Nobody else can take
the name Ember, though anyone who had it keeps it.

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

The Models list on @ember's page has the models people can pick, at most 20, starting with the one
Set up Ember AI chose. Its radio buttons choose which answers everyone who hasn't picked another, Add
a model offers the catalog's text models nobody can pick yet, asking the one chosen a test question
before adding it, and Remove takes one out. Each person picks theirs from the Model menu under Ember
AI on their profile, which shows while there's more than one: Default follows the administrators'
choice, whichever model they choose, and a model picked by name stays theirs, even the one that's the
default. Someone whose model is removed gets the default again, and their pick back if it's added
again. Changing the model in Set up Ember AI puts the one chosen in place of the old default, and
turning Ember AI off forgets the list. When the model someone picked has run out of credits or won't
take the question, @ember's note says they can pick another.

Mention @ember in a room or a thread, or write to it in a DM, and it answers there: in the thread when
it's asked in one, typing while its model answers. It reads the thread, its first message and latest
50 replies, or else the room's latest 20 messages, each after its writer's name, at most about 40,000
characters of them, and sends them through AI Gateway to the model, whose provider reads them. Its
answer is a message of its own, in Markdown: links, bold, lists, quotes, code blocks and tables show as
they do in people's messages, the pictures it links to show in a card under it, and its first web link
gets a preview, as a pasted link does. Both are only of addresses a person wrote in the messages it
read, not a bot or @ember itself, or of the pages it came from, and a preview is never of Ember's own
pages. Any other address shows only as a link, since one the model made up could carry what it read to
whoever runs that address the moment a reader's app or the Worker fetched it. An answer longer than a
message holds is cut to as much as fits, ending with an ellipsis. It reads bots' messages but never
answers one, so that bots can't keep each other talking. When the model can't answer, as when the
token is refused or the credits run out, @ember says why in a short note, and the Worker's log has
Cloudflare's own words. AI Gateway's logs keep each request with the id of whoever asked, as custom
metadata's `user_id`, and of whoever answers, `ember` for @ember or an AI agent's, as `agent_id`, which
a spend limit can be split by. An administrator can also turn on the
gateway's [Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/) or
[Data Loss Prevention](https://developers.cloudflare.com/ai-gateway/features/dlp/) in the Cloudflare
dashboard, to check the questions, with the messages @ember reads, or the answers. When either blocks
one, @ember's note says which, and that an administrator can change what it blocks there.

@ember can also show cards under its answer, as a chat bot's [Slack-compatible webhook](slack-webhooks.md)
does, for a status, a set of fields or buttons that open pages: it writes a Slack message's payload as
JSON in a code block that starts with ```` ```slack ````, and the cards the payload posts show under the
answer, after the card of its pictures, in place of the block. They show as a webhook's do, without
what only a Slack app could answer, such as a menu, and without the payload's `text`, as the answer's
own words are its text. A card's pictures show only at the addresses its Markdown's may, while its
links and buttons, like its Markdown's links, may go anywhere. A block whose payload doesn't parse, or
posts no card Ember keeps, stays the code it's written as, as does one in a list or a quote. An answer
too long for a message keeps as many of its cards as fit, each whole, and as much of its text as fits
beside them, counting the cards' text.

Two dials say how much @ember does for each question. Thinking, Off, Low, Medium or High, is how much
its model thinks before it answers, up to about 4,000, 16,000 or 32,000 tokens, asked for as each API
takes it: a Workers AI or OpenAI model's reasoning effort, or Anthropic's adaptive thinking, at its
lowest effort for Off, since Anthropic's newest models don't turn thinking off. Answer length, Short,
Medium or Long, is about 150, 400 or 1,500 words, which @ember's instructions ask for and its token
limit allows, with room for code and tables. The Limits on @ember's page set the most of each for
anyone's questions, the top of each until an administrator lowers them, and each person picks their
own levels under Ember AI on their profile, up to those, starting at Low thinking and a Medium answer.
An agent's levels are its own, set on its page.

Which thinking levels a model takes is something only asking it says: Cloudflare's catalog can list a
reasoning effort for a model whose provider refuses it, as it did Low and High for xAI's Grok 4.20
Reasoning, which xAI refuses at every level. So when an administrator picks a model, in Set up Ember
AI, Add a model or an agent's page, the Worker also asks it the test question once at each level, all
at once, and keeps the levels it answered at. A level it doesn't take costs nothing, as the provider
refuses it before the model writes anything. The Thinking dial then offers only those, on a person's
profile for their model and on an agent's page, and says which the model can't be set to. A level
chosen before that the model doesn't take asks it for the nearest one it does, below first, so Off
asks a model that can't turn thinking off for Low. A model that takes no level, as Grok 4.20 Reasoning
does, decides how much it thinks, and Thinking still sets how much it may. A model picked before Ember
asked at each level, or one whose provider refuses a level it took then, is asked again without one.

@ember waits for its model as long as the levels may take, 2 minutes at the least and about 13 at High
and Long. An answer its token limit cuts short ends with an ellipsis, and when the model thinks for all
it may before writing anything, @ember says so and suggests less thinking.

Search the web, on @ember's page, lets @ember search the web and read pages with its model's own
tools, which AI Gateway passes on and the model's provider runs
([Cloudflare's guide](https://developers.cloudflare.com/ai-gateway/usage/web-search/)): Anthropic's
[web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) and
[web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) for a model
that takes Messages, and OpenAI's [web search](https://platform.openai.com/docs/guides/tools-web-search)
for one that takes Responses. Chat Completions has no such tools, so a Workers AI or Google model
can't search, which the page says, its switch opening Set up Ember AI to choose another model.
Turning it on asks the model that answers everyone a question it has to search the web for, and keeps
the tools AI Gateway took, reading pages only if it took that tool too, and says what the model found;
a model that answers without searching leaves it off. Choosing another model to answer everyone, under
Models or in Set up Ember AI, or another Cloudflare account there, turns it off, as another model, or
another account's AI Gateway, may not take the same tools, until it's turned on again. A model someone
picks on their profile is given the same tools, of those its format has, so it searches too if it's
Anthropic's or OpenAI's, and any other is told to say it can't, and that they can pick one that can.
While it's on, @ember searches at most 5 times an answer and reads at most 3 pages, each cut to about
10,000 tokens: pages people link to, or that its searches find. Its answer is what it writes after it
last searches, and a line under it links to the pages it cites and the pages it read, by their titles,
at most 10, leaving out those the answer links to itself. A model that stops taking the tools is asked
again without them, told it can't search this time. Its searches are written from the conversation, so
the provider's search sees what the room was asking about. While it's off, @ember is told it can't
search, and that an administrator can turn Search the web on.

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
- **How it answers**: its model, from the catalog's text models, or Another model by its ID, and its
  own Thinking and Answer length, the dials @ember has, which people can't change on their profile as
  they can for @ember. For a model outside Workers AI, the page says the most an answer at those
  levels costs at the model's prices.
- **Search the web**, as @ember's does, for Anthropic's and OpenAI's models. Turned on for another
  model, it says in red that the model can't search, until the model or the switch changes.
- **Rooms**: every room open to everyone, new ones too, as @ember is, or only the open rooms chosen.
  People can still add it to a closed room or DM it, as they can anyone.

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

The Agent badge follows an agent's name wherever it shows, so nobody takes it for a person: on its
messages, deleted agents' too, on a DM with it alone in the sidebar and the room's header, in the
mention prompt and New direct message, and on its profile. The profile shows everyone what the agent
does, the model it answers with, where that runs (Cloudflare's Workers AI, or the company that makes
the model, which AI Gateway sends what it's asked to), and who set it up, but not its instructions.

#### What Ember adds around the instructions

Ember writes the rest of @ember's and each agent's system prompt around their instructions: who they
are, where they're asked, how the chat shows Markdown and pictures, how to show a card, what they may
do on the web, and the date. Under What Ember adds around them, on @ember's page and each agent's, a
box headed Modify with caution keeps it as Ember writes it until Modify is pressed, as a change there
can leave a model unsure who it is, where it's asked or what the chat can show. Modify opens the
template Ember fills in each time it's asked, up to 10,000 characters, with what each placeholder
stands for:

| Placeholder | What Ember fills in |
| --- | --- |
| `{{name}}` | Its name |
| `{{community}}` | The community's name |
| `{{where}}` | The room, thread or direct message it's asked in |
| `{{asker}}` | The name of whoever asked |
| `{{words}}` | About how many words it may answer in, from Answer length |
| `{{cards}}` | How it can show a card under its answer, with a Slack payload |
| `{{web}}` | What it may do on the web, or who could let it |
| `{{today}}` | Today's date, in UTC |
| `{{instructions}}` | The instructions, which it needs once |

The preview above it follows what's typed, and the box says why Ember can't take a template, before
anything's saved: one without `{{instructions}}`, or with it twice, or with a placeholder Ember doesn't
fill in, such as a misspelt one. A template that leaves out a placeholder, such as `{{web}}` or
`{{today}}`, is taken, though the model then isn't told what it would have said. While @ember has no
instructions added, `{{instructions}}` on a line of its own goes with its line, and within a line it
leaves the rest of the line as it's written. An agent's template saves with Save changes, and
@ember's with Save beside it, or Save instructions. Try it asks an agent with the template as the page
has it, saved or not. Use Ember's own puts Ember's back, which Ember keeps as its own, so that it
changes as Ember's does in later releases, where a modified template stays as it was saved. So a
template modified before `{{cards}}` came along doesn't tell its model how to show a card until
`{{cards}}` is added to it, though a card the model writes anyway still shows. While it's modified,
What Ember adds around them is marked Modified.

### Huddles

A huddle is a room's voice call, laid out as Slack's is. The headphones at the top of a room start its
huddle, or join the one going on, and show the rest of the room how many are in it. A preview comes
first, which asks the browser for a microphone and offers a choice of it and, where the browser has
one, of the speaker; without a microphone you join to listen. While you're in a huddle, a bar along
the window's base follows you from page to page, with the microphone's switch and Leave.
Ctrl+Alt+Shift+H (⌘⌥⇧H on a Mac) leaves the huddle you're in, or opens the preview for the room
you're looking at, and Ctrl+Shift+Space (⌘⇧Space) mutes and unmutes. The arrow beside the headphones
copies the huddle's link, which opens the room at the preview. A huddle takes up to 50 people and
ends when the last of them leaves. A tab is in one huddle at a time, and joining a room's huddle from
another tab or device leaves it in the first. DMs have no huddles yet, and there's no video or screen
sharing yet.

An administrator turns huddles on under Huddles in community settings, with the switch on its card.
Huddles run through Cloudflare's [Realtime SFU](https://developers.cloudflare.com/realtime/sfu/),
which carries what each person in a huddle says to the others, by an SFU app in your Cloudflare
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
microphone to the SFU, and hears the others from it, over WebRTC, and finds its way there with
Cloudflare's STUN server (`stun.cloudflare.com:3478`).
What the SFU charges is in [What it costs](#what-it-costs).

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
  password reset, or a new password saved in another session ends it. Its id travels in the
  address's fragment, which no log sees.
- A file's address is signed and never expires: whoever has it can open the file until its message
  is deleted, as with Active Storage's links. A bot is given the addresses of the files in its rooms,
  with the messages its webhook is sent and those the bot API answers, so it can read them.
- A bot's webhook payload carries the bot's key, so point bots only at servers you trust. Webhooks
  go only to https, or to http on localhost, so nobody on the way reads the key; a bot saved with an
  http URL elsewhere before gets no deliveries until its URL is changed, and the Worker's log says
  why.
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
  your current password, so holding someone's session isn't enough to take their account, and a new
  password ends your other sessions and forgets their browsers' push subscriptions. A password reset,
  deactivation or ban ends all of a person's sessions within a minute.
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
  Set up Turnstile, an API token given in Set up Ember AI, and an SFU app's secret given in Set up
  huddles, are kept the same way.
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
  have, and while Memberful is on, add new ones. Administrators keep their passwords, so the site being down never locks
  them out. A webhook whose signature `MEMBERFUL_WEBHOOK_SECRET` doesn't check is refused, and even a
  signed one only has Ember ask Memberful's API about a member, so one forged or sent again changes
  nothing.
- Custom CSS runs on every page for everyone, so it's an administrator's to write, like the rest of
  the workspace, and `EMBER_RECOVERY_TOKEN` can take over any account, so keep it set only while
  resetting a password, as above.
- `/api/health` tells strangers only whether Ember is up; administrators and whoever sends the
  recovery token hear the rest. QR codes (`/qr_code/<id>`) are drawn for people signed in.

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
- **Ember AI**, if it's on: Workers AI's models are free up to 10,000 Neurons a day on either plan, and
  Workers Paid bills past that at $0.011 per 1,000 Neurons. Other companies' models are paid for with
  AI Gateway's credits, at each provider's own per-token prices, plus a 5% fee on the credits bought.
  Thinking counts as output, as the answer does, so the [dials](#ember-ai) bound what one answer
  costs: at most 3,000 tokens out at Off and Short, 6,000 at Low and Medium, and 38,000 at High and Long.
  Picking a model asks it a test question, then again at each Thinking level, each at most 2,000
  tokens out.
  Each person's questions cost what the model they pick does, so add to the Models list only the
  models you're happy to pay for, and each [agent's](#ai-agents) what its own model does at its own
  dials, whose most its page says. While Search the web is on, an answer can also search up to 5 times,
  which Anthropic charges $10 per 1,000 searches for and OpenAI its own price per search, and the
  results and pages it reads count as input, up to about 10,000 tokens a page.
- **Huddles**, if they're on: Cloudflare's Realtime SFU charges for what it sends to the people in a
  huddle, and nothing for what they send it. The first 1,000 GB a month are free, and it's $0.05 per GB
  after that, as its page had it in November 2026. A voice is about 50 kbps to each person who hears
  it, so five people talking for an hour are sent under half a GB between them, and the free 1,000 GB
  carry about 2,000 such hours a month.

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
