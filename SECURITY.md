# Security policy

## Reporting a vulnerability

If you've found a security hole in Ember, please tell us privately. Don't put it in an issue or a
pull request: everyone can read those, and every Ember that's running would be open to it until its
owner updates.

Instead, use
[Report a vulnerability](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/security/advisories/new),
GitHub's form for private reports, which only you and Ember's maintainers can read. Say what you
found, which release or commit it's in, how to reproduce it, and what someone could do with it.

We'll answer you on the report, and you're welcome to work on the fix with us there. Once the fix is
out, we publish an advisory that credits you, unless you'd rather not be named. Until then, please
keep it between us.

## Before you report

- Test on an Ember of your own, never on someone else's: deploy one with Deploy to Cloudflare, or
  run one on your computer, as
  [Try it on your computer](https://github.com/NYLLON-SOFTWARE/ember-cloudflare#try-it-on-your-computer)
  says.
- The self-hosting guide's
  [security notes](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/blob/main/docs/self-hosting.md#security-notes)
  describe what Ember does on purpose, such as file addresses that never expire and the sign-in links
  administrators can make for anyone. What they describe isn't a vulnerability, though a way around
  it is.
- A hole in Cloudflare's platform itself, rather than in Ember, goes to
  [Cloudflare](https://www.cloudflare.com/disclosure/).

## Supported versions

Fixes come in a new release of Ember, which a copy takes with the pull request its Update Ember
workflow opens
([Updating](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/blob/main/docs/self-hosting.md#updating)),
so keep yours on the newest release. A copy that runs a beta gets the fix with the next beta or
release.
