import { useState, type ReactNode } from "react";
import { TRYING_BETAS, UPDATING_EMBER, type CopyOnGitHub, type ReleaseCheck } from "@ember/protocol";
// Ember's beta workflow, which the card offers a copy without one.
import BETA_WORKFLOW from "../../../../worker/scripts/update-ember-beta.yml?raw";
// Ember's Update Ember workflow, as the deploy offers it to a copy without one (apps/worker/scripts/deploy.ts).
import UPDATE_WORKFLOW from "../../../../worker/scripts/update-ember.yml?raw";
import { useMounted } from "@/hooks/use-mounted";
import { isSignedOut } from "@/lib/api";
import { lastReplyLabel } from "@/lib/messages";
import { betaToTryOf, updateOf, type NamedRelease } from "@/lib/release-check";
import { cn } from "@/lib/utils";
import { BUTTON } from "./email-settings";

// The Ember version card at the top of General, for administrators: the release this Ember is, and once
// GitHub names a newer one, that it's out, with its notes and how to update, as the project's owner
// asked (2026-10-31), while the rail's Admin has a dot. A copy made with Deploy to Cloudflare gets a pull
// request for each release once it has the Update Ember workflow, which Cloudflare's copy leaves out
// (docs/self-hosting.md#updating), and the docs say how anything else updates. Where the deploy told the
// Worker which copy on GitHub this is, the card links straight to running its workflow, as the project's
// owner asked (2026-11-05), or to adding it. A beta says it's one, ahead of the newest release, until its
// release is out, and is told of the beta after it as of an update (docs/self-hosting.md#betas). A release
// with nothing newer to update to is offered the newest beta to try, while one is out ahead of it, which it
// takes only when asked: a box of its own under the card links to running the copy's beta workflow, Update
// Ember to its newest beta, or to adding it, as the project's owner chose (2026-11-10), and the rail's Admin
// has no dot for it. The box is a little red, as he asked the same day, so the beta reads as experimental.
// Check for updates, which he asked for (2026-11-11), has the Worker ask GitHub again, as opening Admin
// does, and under it the card says when GitHub last named the newest release. He moved the card from the
// end of General to its top (2026-11-17), so that it isn't missed.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** How a copy made with Deploy to Cloudflare updates, which the card says while a newer release is out. */
export const HOW_COPIES_UPDATE =
  "A copy made with Deploy to Cloudflare gets a pull request for each release from its Update Ember workflow, every Monday or when it's run from the repository's Actions tab, once the workflow is added to the copy, as How to update says. Merging it updates Ember.";
/** Where the workflow's update goes instead of a pull request, as update-ember.ts files it. */
const UNLESS_IT_CANT =
  "Where GitHub doesn't yet let it open pull requests, as in a new repository, it opens an issue instead, with a link that opens the pull request for you to merge.";
/** And how this copy updates, where the Worker knows it has the workflow, or that it hasn't. */
export const HOW_THIS_COPY_UPDATES = `This copy gets a pull request for each release from its Update Ember workflow every Monday. To update now, open the workflow on GitHub, choose Run workflow, and merge the pull request it opens. ${UNLESS_IT_CANT}`;
export const HOW_TO_ADD_THE_WORKFLOW = `This copy has no Update Ember workflow yet, which brings each release as a pull request. Add it on GitHub, where it's filled in for you to commit, then run it from the repository's Actions tab and merge the pull request it opens. ${UNLESS_IT_CANT}`;

/** How a copy made with Deploy to Cloudflare tries a beta, which the card says while one's out to try. */
export const HOW_COPIES_TRY_BETAS =
  "A copy made with Deploy to Cloudflare takes a beta only when asked, from its beta workflow, Update Ember to its newest beta, once that's added to the copy, as How to try a beta says. Once the beta's release is out, Update Ember brings that, and releases alone after it.";
/** And how this copy tries one, where the Worker knows it has the beta workflow, or that it hasn't. */
export const HOW_THIS_COPY_TRIES_BETAS = `This copy takes a beta only when asked. To try this one, open the beta workflow on GitHub, choose Run workflow, and merge the pull request it opens. Update Ember then brings the betas after it, then its release, and releases alone after that. ${UNLESS_IT_CANT}`;
export const HOW_TO_ADD_THE_BETA_WORKFLOW = `This copy takes a beta only when asked, from its beta workflow, Update Ember to its newest beta, which it hasn't yet. Add it on GitHub, where it's filled in for you to commit, then run it from the repository's Actions tab and merge the pull request it opens. ${UNLESS_IT_CANT}`;

/** Where the workflows are in a copy. */
const WORKFLOW_FILE = ".github/workflows/update-ember.yml";
const BETA_WORKFLOW_FILE = ".github/workflows/update-ember-beta.yml";

/** The page of `copy`'s Update Ember workflow on GitHub, whose Run workflow runs it. */
export const workflowPageOf = ({ repository }: CopyOnGitHub) => `https://github.com/${repository}/actions/workflows/update-ember.yml`;
/** And of its beta workflow. */
export const betaWorkflowPageOf = ({ repository }: CopyOnGitHub) => `https://github.com/${repository}/actions/workflows/update-ember-beta.yml`;

/** GitHub's editor for a new file, `filename`, on the branch of `copy` that deploys, filled in with `value` for them to commit. */
function newFileLinkOf({ repository, branch }: CopyOnGitHub, filename: string, value: string): string {
  // A branch's name may hold what a link can't, such as `#`, so each of its parts goes in encoded.
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repository}/new/${encoded}?${new URLSearchParams({ filename, value })}`;
}

/** GitHub's editor with Ember's Update Ember workflow filled in for `copy`, as the deploy's log links to it. */
export const addWorkflowLinkOf = (copy: CopyOnGitHub) => newFileLinkOf(copy, WORKFLOW_FILE, UPDATE_WORKFLOW);
/** And with its beta workflow. */
export const addBetaWorkflowLinkOf = (copy: CopyOnGitHub) => newFileLinkOf(copy, BETA_WORKFLOW_FILE, BETA_WORKFLOW);

/** What the card says of updating `copy`, with its link: to running the copy's workflow, or adding it, or for a copy the Worker doesn't know, to the docs. */
function updating(copy: CopyOnGitHub | null): { says: string; link: string; href: string } {
  if (!copy) return { says: HOW_COPIES_UPDATE, link: "How to update", href: UPDATING_EMBER };
  if (copy.workflow) return { says: HOW_THIS_COPY_UPDATES, link: "Open GitHub action to update", href: workflowPageOf(copy) };
  return { says: HOW_TO_ADD_THE_WORKFLOW, link: "Add GitHub action to update", href: addWorkflowLinkOf(copy) };
}

/** And of trying a beta on `copy`: running its beta workflow, or adding it, or for a copy the Worker doesn't know, the docs. */
function trying(copy: CopyOnGitHub | null): { says: string; link: string; href: string } {
  if (!copy) return { says: HOW_COPIES_TRY_BETAS, link: "How to try a beta", href: TRYING_BETAS };
  if (copy.betaWorkflow) return { says: HOW_THIS_COPY_TRIES_BETAS, link: "Open GitHub action to try it", href: betaWorkflowPageOf(copy) };
  return { says: HOW_TO_ADD_THE_BETA_WORKFLOW, link: "Add GitHub action to try betas", href: addBetaWorkflowLinkOf(copy) };
}

/**
 * What the card says of this Ember under its heading: which release it is while a newer one is out, else
 * whether it's the newest, or a beta ahead of it, which is the newest beta where the tags name one that
 * isn't newer.
 */
function noteOf(check: ReleaseCheck): string {
  const { release, beta, newest, newestBeta } = check;
  if (updateOf(check)) return `This is Ember ${release}.`;
  if (beta) return newest ? `This is ${newestBeta ? "the newest beta" : "a beta"}, ahead of Ember ${newest.release}, the newest release.` : "This is a beta. GitHub didn't say whether its release is out.";
  return newest ? "This is the newest release." : "GitHub didn't say whether a newer release is out.";
}

interface Props {
  check: ReleaseCheck | null;
  /** Has the Worker ask GitHub again, as Check for updates does, settling once it's answered, which `check` then says. */
  onCheckForUpdates: () => Promise<void>;
  /** Says why asking failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** The release this Ember is, and whether a newer one is out, or a beta to try, once the Worker has said, as it does only for administrators. */
export function EmberVersion({ check, onCheckForUpdates, onFailed }: Props) {
  if (!check) return null;
  const { release, copy } = check;
  const newer = updateOf(check);
  const update = updating(copy);
  const beta = betaToTryOf(check);
  return (
    <>
      <section aria-labelledby="ember-version-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
        <div>
          <h2 id="ember-version-heading" className="text-base font-semibold">
            {newer ? `Ember ${newer.release} is available` : `Ember ${release}`}
          </h2>
          <p className={NOTE}>{noteOf(check)}</p>
        </div>
        {newer && <p className={NOTE}>{update.says}</p>}
        <CheckForUpdates checkedAt={check.checkedAt} onCheck={onCheckForUpdates} onFailed={onFailed}>
          {newer && (
            <>
              <a href={newer.notes} target="_blank" rel="noopener" className={BUTTON}>
                What's new
              </a>
              <a href={update.href} target="_blank" rel="noopener" className={BUTTON}>
                {update.link}
              </a>
            </>
          )}
        </CheckForUpdates>
      </section>
      {beta && <BetaToTry beta={beta} copy={copy} />}
    </>
  );
}

/** When GitHub last named the newest release, said as a thread's summary says when its newest reply came. */
const lastCheckedOf = (checkedAt: string) => `Last checked ${lastReplyLabel(new Date(checkedAt)).long}.`;

/**
 * Check for updates, after the links in `children`, and under it, while the Worker asks GitHub again,
 * that it's checking, else when GitHub last named the newest release, `checkedAt`, if it has.
 */
function CheckForUpdates({ checkedAt, onCheck, onFailed, children }: { checkedAt: string | null; onCheck: () => Promise<void>; onFailed: (error: unknown) => void; children: ReactNode }) {
  const [checking, setChecking] = useState(false);
  const mounted = useMounted();

  const check = () => {
    setChecking(true);
    onCheck().then(
      () => {
        if (mounted.current) setChecking(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setChecking(false);
        onFailed(error);
      },
    );
  };

  return (
    <div>
      <div className="flex flex-wrap gap-[1ch]">
        {children}
        <button type="button" onClick={check} disabled={checking} className={BUTTON}>
          Check for updates
        </button>
      </div>
      <p role="status" className={cn(NOTE, "mt-2 empty:mt-0")}>
        {checking ? "Checking for updates…" : checkedAt && lastCheckedOf(checkedAt)}
      </p>
    </div>
  );
}

/** The box under the card that offers `beta` to try, a little red, as a beta is experimental, with how `copy` tries it. */
function BetaToTry({ beta, copy }: { beta: NamedRelease; copy: CopyOnGitHub | null }) {
  const tryBeta = trying(copy);
  return (
    <section aria-labelledby="ember-beta-heading" className="flex flex-col gap-3 rounded-[10px] border border-beta-border bg-beta-background px-[2ch] py-4 text-start max-md:px-3">
      <div>
        <h2 id="ember-beta-heading" className="text-base font-semibold">{`Ember ${beta.release} is out to try`}</h2>
        <p className={NOTE}>{tryBeta.says}</p>
      </div>
      <div className="flex flex-wrap gap-[1ch]">
        <a href={beta.notes} target="_blank" rel="noopener" className={BUTTON}>
          What's in it
        </a>
        <a href={tryBeta.href} target="_blank" rel="noopener" className={BUTTON}>
          {tryBeta.link}
        </a>
      </div>
    </section>
  );
}
