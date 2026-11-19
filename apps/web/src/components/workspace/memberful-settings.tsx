import type { WorkspaceSettings } from "@ember/protocol";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { WORKERS_DASHBOARD } from "./custom-domain-settings";
import { BUTTON } from "./email-settings";
import { MemberfulLink, memberfulNewWebhook, useMemberfulAddresses } from "./memberful-setup";

// The Memberful card in Membership's ways to join: an administrator lets the members of a Memberful site
// join and sign in with their accounts there, with the keys of a custom app there that Set up Memberful
// gives Ember, or that the deployment keeps as Worker secrets. While it's off, the card is its name, a
// line and its switch, as the project's owner asked (2026-10-26): turning it on before Ember has the keys
// opens Set up Memberful, which turns it on once they're kept, and once it's on, it has Members only,
// which keeps everyone else out, where Memberful sends members back to and its webhook, and Change keys,
// which opens Set up Memberful again. Laid out as the other ways to join are, with Members only's switch
// inside it.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  /** The Memberful site whose members can sign in, once Ember has its keys, or null while it hasn't. */
  site: string | null;
  /** Whether Ember also has what Memberful's webhooks take, so that a member whose membership lapses is signed out. */
  webhooks: boolean;
  /** Where Ember's Memberful keys come from: the deployment's secrets, Set up Memberful, or neither yet. */
  keys: WorkspaceSettings["memberfulKeys"];
  /** Opens Set up Memberful, calling `then`, if given, once it has kept the keys. */
  onSetUp: (then?: () => void) => void;
  /** Where Memberful's switch is: where it was moved to while that's saved, or else where the workspace has it. */
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  /** Where Members only's switch is, likewise. */
  membersOnly: boolean;
  onMembersOnlyChange: (on: boolean) => void;
  /** Whether a move of Memberful's switch is being saved, while which Members only's waits. */
  memberfulSaving?: boolean;
  /** Whether a move of Members only's switch is being saved, while which Memberful's waits. */
  membersOnlySaving?: boolean;
  /** Why the switch can't be moved while another way to join is on, said in place of what it does, or null. */
  setAside?: string | null;
  /** What's said in place of Members only's switch while SSO only is on, when the switch turns both on and off, or null. */
  beside?: string | null;
  /** What's said in place of what it does while SSO only closes it, or null. */
  closed?: string | null;
}

/**
 * Memberful, for administrators: its switch, and while it's on, Members only's, where Memberful sends
 * people back to, and Change keys, or the steps to hear Memberful's webhooks while the deployment's
 * secrets lack what they take. Turned on before Ember has the keys, it opens Set up Memberful instead,
 * and while it's on without them, it says nobody can sign in with Memberful until it's set up again.
 */
export function MemberfulSettings({
  site,
  webhooks,
  keys,
  onSetUp,
  checked,
  onCheckedChange,
  membersOnly,
  onMembersOnlyChange,
  memberfulSaving = false,
  membersOnlySaving = false,
  setAside = null,
  beside = null,
  closed = null,
}: Props) {
  const { redirectUrl, webhookUrl } = useMemberfulAddresses();
  // Without the keys, which the server would refuse it for, turning it on sets it up first.
  const switchTo = (on: boolean) => (on && site === null ? onSetUp(() => onCheckedChange(true)) : onCheckedChange(on));
  // What it takes shows only while it's on, unless another way to join sets it aside.
  const shown = checked && setAside === null;

  return (
    <section aria-labelledby="memberful-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 id="memberful-heading" className={cn("text-base font-semibold", setAside !== null && "text-muted-foreground")}>
            Memberful
          </h3>
          <p id="memberful-description" className={cn(NOTE, site === null && checked && "text-negative")}>
            {site === null && checked ? (
              "It's on, but Ember no longer has your Memberful site's keys, so nobody can sign in with Memberful until it's set up again."
            ) : setAside !== null ? (
              setAside
            ) : closed !== null && site !== null ? (
              closed
            ) : site === null ? (
              "Members of a Memberful site join and sign in with their Memberful account. Turning this on sets up Memberful first."
            ) : (
              <>
                Members of <strong className="wrap-anywhere">{site}</strong> join and sign in with their Memberful account.
                {/* Beside SSO only, turning it off turns Members only off too, which closes it. */}
                {beside === null
                  ? " Turned off, it lets nobody new join, but those who did keep signing in with it."
                  : " Turned off, it lets nobody in while SSO only is on, not even those who joined with it."}
                {webhooks && " A member whose membership lapses is signed out until it's renewed."}
              </>
            )}
          </p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={switchTo}
          // Beside SSO only, it saves Members only's setting or its own, so it waits for either's move.
          disabled={setAside !== null || membersOnlySaving || (beside !== null && memberfulSaving)}
          aria-labelledby="memberful-heading"
          aria-describedby="memberful-description"
        />
      </div>
      {shown && site !== null && beside !== null && <p className={cn(NOTE, "border-t pt-3")}>{beside}</p>}
      {shown && site !== null && beside === null && (
        <div className="flex items-center gap-x-[1ch] gap-y-4 border-t pt-3">
          <div className="min-w-0 flex-1">
            <div id="members-only-heading">Members only</div>
            <p id="members-only-description" className={NOTE}>
              Nobody else can join but the people you invite, and only they and administrators sign in with a password. Members who have one connect their
              Memberful account as they next sign in.
            </p>
          </div>
          <Switch
            checked={membersOnly}
            onCheckedChange={onMembersOnlyChange}
            disabled={memberfulSaving}
            aria-labelledby="members-only-heading"
            aria-describedby="members-only-description"
          />
        </div>
      )}
      {!shown ? null : site === null ? (
        <SetUpButton onSetUp={onSetUp} label="Set up Memberful" />
      ) : (
        <>
          {keys === "secret" && !webhooks && <WebhookSteps site={site} webhookUrl={webhookUrl} />}
          <p className={NOTE}>
            {webhooks ? (
              <>
                Memberful sends people back to <span className="wrap-anywhere">{redirectUrl}</span>, the OAuth Redirect URL of its custom app, and its webhook
                to <span className="wrap-anywhere">{webhookUrl}</span>. If Ember's address changes, change both there too.
              </>
            ) : (
              <>
                Memberful sends people back to <span className="wrap-anywhere">{redirectUrl}</span>, the OAuth Redirect URL of its custom app. If Ember's
                address changes, change it there too.
              </>
            )}
            {keys === "secret" && " The site and its keys are this Worker's secrets, MEMBERFUL_URL and the rest."}
          </p>
          {keys === "saved" && <SetUpButton onSetUp={onSetUp} label="Change keys" />}
        </>
      )}
    </section>
  );
}

/** A button that opens Set up Memberful. */
function SetUpButton({ onSetUp, label }: { onSetUp: () => void; label: string }) {
  return (
    <div>
      <button type="button" onClick={() => onSetUp()} className={BUTTON}>
        {label}
      </button>
    </div>
  );
}

/**
 * The steps to hear Memberful's webhooks while the deployment's secrets give Ember the custom app's keys
 * without what hearing them takes: a webhook at the Memberful site `site`, as Set up Memberful's last step
 * says, then two more secrets, its own, to check it came from Memberful, and the custom app's API key, to
 * check what it says.
 */
function WebhookSteps({ site, webhookUrl }: { site: string | null; webhookUrl: string }) {
  return (
    <>
      <p>A member whose membership lapses can't sign in again, but stays signed in where they are until Ember hears Memberful's webhooks.</p>
      <ol aria-label="Steps to sign out members whose membership lapses" className="flex list-decimal flex-col gap-2 ps-5">
        <li>
          In Memberful, go to{" "}
          <MemberfulLink href={memberfulNewWebhook(site)}>
            <em>Settings</em> → <em>Webhooks</em> → <em>Create webhook</em>
          </MemberfulLink>
          . Name it <strong>Ember</strong>, paste <strong className="wrap-anywhere">{webhookUrl}</strong> as the <em>Endpoint URL</em>, and select every
          event under <em>Member</em>, <em>Order</em>, <em>Subscription</em>, and <em>Plan</em>. <em>Download</em> isn't needed.
        </li>
        <li>
          Give this Worker two more secrets: the webhook's secret key as <code>MEMBERFUL_WEBHOOK_SECRET</code>, and the custom app's API Key as{" "}
          <code>MEMBERFUL_API_KEY</code>.{" "}
          <a href={WORKERS_DASHBOARD} target="_blank" rel="noopener" className="underline">
            Open the Cloudflare dashboard
          </a>
        </li>
      </ol>
    </>
  );
}
