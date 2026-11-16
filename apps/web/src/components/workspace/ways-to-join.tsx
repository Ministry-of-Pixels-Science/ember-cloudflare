import { useState, type ReactNode } from "react";
import {
  domainsInWords,
  joinsWithLink,
  signsUpOpenly,
  signsUpWithEmailDomain,
  SIGN_UPS_PER_ADDRESS,
  SIGN_UPS_PER_HOUR,
  type AccountSettings,
  type WorkspaceSettings,
} from "@ember/protocol";
import { PageLink } from "@/components/page-link";
import { Switch } from "@/components/ui/switch";
import { useAccount } from "@/hooks/use-account";
import { cn } from "@/lib/utils";
import { EmailDomainSettings } from "./email-domain-settings";
import { sendsEmail } from "./email-settings";
import { InviteLink, ShareableLink } from "./invite-link";
import { EMAIL_SIGN_UP_LINK, emailSignUpUrl, SIGN_UP_LINK, signUpUrl } from "./join-link";
import { MemberfulSettings } from "./memberful-settings";
import { workspaceSectionPath } from "./settings-navigation";
import { SetUpTurnstile } from "./turnstile-settings";

// The ways for new people to join, at the top of Membership: for administrators, a card for each, Open,
// Join link, Email domain and Memberful, whose switch saves as it's flipped, as the Memberful card's
// did, and which shows the way's settings while it's on. Open lets anyone in, and Memberful's Members
// only only its members, so while either is on the ways it overrides are greyed out, keeping their
// settings for when it's off. Members see the links that let people in.

/** What turning on Open asks first, since it lets anyone in. */
export const CONFIRM_OPEN = "Are you sure you want to let anyone create an account? Ember doesn't check that the email addresses people sign up with are theirs.";

/** What turning on Memberful's Members only asks first, since it keeps everyone but administrators, and the people they invite, from signing in with a password. */
export const CONFIRM_MEMBERS_ONLY =
  "Are you sure only Memberful's members should sign in? Everyone but administrators and the people they invite will need a Memberful membership to sign in.";

/** Why a way is greyed out while Open is on. */
const OPEN_OVERRIDES = "Set aside while Open lets anyone join.";

/** Why a way is greyed out while Memberful is members only. */
const MEMBERS_ONLY_OVERRIDES = "Off while Memberful is members only.";

const CARD = "flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3";
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

type WaySetting = keyof Pick<AccountSettings, "openSignUp" | "joinLink" | "emailDomainSignUp" | "memberfulJoin" | "memberfulSignIn">;

const ASKS_FIRST: Partial<Record<WaySetting, string>> = { openSignUp: CONFIRM_OPEN, memberfulSignIn: CONFIRM_MEMBERS_ONLY };

interface Props {
  settings: WorkspaceSettings;
  /** Saves a switch, as the page saves its others, then calls `settled`. */
  saveSwitch: (settings: AccountSettings, settled: () => void) => void;
  /** Saves Email domain's domains, turning it on with them if `turnOn`, then calls `settled` with whether it did. */
  saveEmailDomains: (domains: string[], turnOn: boolean, settled: (saved: boolean) => void) => void;
  /** Opens Set up email, calling `then`, if given, once it closes with Ember able to send email. */
  onSetUpEmail: (then?: () => void) => void;
  /** Opens Set up Turnstile, whose check lifts the limits that stand in for it. */
  onSetUpTurnstile: () => void;
  /** Opens Set up Memberful, calling `then`, if given, once it has kept the keys. */
  onSetUpMemberful: (then?: () => void) => void;
  /** The join link, with its buttons, which its card shows while it's on. */
  joinLink: ReactNode;
}

/** Who can join, for administrators: a card for each way, with its switch, and its settings while it's on. */
export function WaysToJoin({ settings, saveSwitch, saveEmailDomains, onSetUpEmail, onSetUpTurnstile, onSetUpMemberful, joinLink }: Props) {
  const account = useAccount();
  // The domains Email domain keeps, which the workspace shows only while it's on: as it last showed them,
  // saved here or in another tab, or else as the page loaded them. Set as it renders, rather than after,
  // so that the card never shows those it had before.
  const [keptDomains, setKeptDomains] = useState(settings.emailDomains);
  if (account.emailDomainSignUp && account.emailDomains !== keptDomains) setKeptDomains(account.emailDomains);
  // Where each switch was moved to, while that's saved.
  const [moved, setMoved] = useState<Pick<AccountSettings, WaySetting>>({});
  const open = moved.openSignUp ?? account.openSignUp;
  const link = moved.joinLink ?? account.joinLink;
  const emailDomain = moved.emailDomainSignUp ?? account.emailDomainSignUp;
  const memberful = moved.memberfulJoin ?? account.memberfulJoin;
  // Off with Memberful, as the server turns it.
  const membersOnly = memberful && (moved.memberfulSignIn ?? account.memberfulSignIn);
  // A way sets the others aside while it's on, until turning it off is saved, so that none is turned on
  // while the server still has the way that overrides it on, which would refuse it.
  const openOverrides = open || account.openSignUp;
  const membersOnlyOverrides = membersOnly || account.memberfulSignIn;

  const switchTo = (setting: WaySetting) => (on: boolean) => {
    if (moved[setting] !== undefined) return;
    const question = on ? ASKS_FIRST[setting] : undefined;
    if (question && !confirm(question)) return;
    setMoved((moved) => ({ ...moved, [setting]: on }));
    saveSwitch({ [setting]: on }, () => setMoved(({ [setting]: _, ...others }) => others));
  };

  return (
    <section aria-labelledby="ways-to-join-heading" className="flex flex-col gap-3">
      <header className="mb-1">
        <h2 id="ways-to-join-heading" className="mb-1.5 text-[17px] font-semibold">
          Who can join
        </h2>
        <p className="text-[13px] text-muted-foreground">Choose how new people can make an account.</p>
      </header>
      {/* Open and Members only can't both be on, but should both be, each can still be turned off. */}
      <Way
        id="open-sign-up"
        title="Open"
        description="Anyone can create an account at Ember's sign-up page."
        checked={open}
        onCheckedChange={switchTo("openSignUp")}
        setAside={membersOnlyOverrides && !open ? MEMBERS_ONLY_OVERRIDES : null}
      >
        <ShareableLink id="sign_up" label="Share so anyone can sign up" url={signUpUrl()} sharing={SIGN_UP_LINK} />
        {!account.restrictRoomCreation && (
          <p className={NOTE}>
            Anyone who signs up can create rooms. To keep that to administrators, turn on{" "}
            <PageLink href={workspaceSectionPath("channel-settings")} className="underline">
              Must be admin to create new rooms
            </PageLink>
            .
          </p>
        )}
        <p className={NOTE}>
          {settings.turnstile
            ? "Cloudflare Turnstile checks that whoever signs up is a person."
            : `Until Cloudflare Turnstile checks that whoever signs up is a person, ${SIGN_UPS_PER_ADDRESS} people can sign up from a network in an hour, and signing up waits once ${SIGN_UPS_PER_HOUR} people have joined in an hour. Setting up Turnstile lifts these limits.`}
        </p>
        {!settings.turnstile && <SetUpTurnstile onSetUp={onSetUpTurnstile} />}
      </Way>
      <Way
        id="join-link"
        title="Join link"
        description="Anyone with the link can create an account."
        checked={link}
        onCheckedChange={switchTo("joinLink")}
        setAside={membersOnlyOverrides ? MEMBERS_ONLY_OVERRIDES : openOverrides ? OPEN_OVERRIDES : null}
      >
        {joinLink}
      </Way>
      <EmailDomainSettings
        domains={keptDomains}
        emails={sendsEmail(settings.email)}
        turnstile={settings.turnstile !== null}
        checked={emailDomain}
        onCheckedChange={switchTo("emailDomainSignUp")}
        saveDomains={saveEmailDomains}
        onSetUpEmail={onSetUpEmail}
        onSetUpTurnstile={onSetUpTurnstile}
        setAside={membersOnlyOverrides ? MEMBERS_ONLY_OVERRIDES : openOverrides ? OPEN_OVERRIDES : null}
      />
      <MemberfulSettings
        site={settings.memberfulSite}
        webhooks={settings.memberfulWebhooks}
        keys={settings.memberfulKeys}
        onSetUp={onSetUpMemberful}
        checked={memberful}
        onCheckedChange={switchTo("memberfulJoin")}
        membersOnly={membersOnly}
        onMembersOnlyChange={switchTo("memberfulSignIn")}
        // Saving either changes the other's setting too, so each waits for the other's move, lest saves
        // arriving out of order undo the later one.
        memberfulSaving={moved.memberfulJoin !== undefined}
        membersOnlySaving={moved.memberfulSignIn !== undefined}
        setAside={openOverrides && !membersOnly ? OPEN_OVERRIDES : null}
      />
    </section>
  );
}

interface WayProps {
  id: string;
  title: string;
  /** Whom it lets in, in a line. */
  description: string;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  /** Why the switch can't be moved while another way overrides it, said in place of the description, or null. */
  setAside: string | null;
  /** Its settings, shown while it's on, unless it's set aside. */
  children: ReactNode;
}

/** A way to join's card: its switch, and its settings while it's on. */
function Way({ id, title, description, checked, onCheckedChange, setAside, children }: WayProps) {
  return (
    <section aria-labelledby={`${id}-heading`} className={CARD}>
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-heading`} className={cn("text-base font-semibold", setAside !== null && "text-muted-foreground")}>
            {title}
          </h3>
          <p id={`${id}-description`} className={NOTE}>
            {setAside ?? description}
          </p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={setAside !== null}
          aria-labelledby={`${id}-heading`}
          aria-describedby={`${id}-description`}
        />
      </div>
      {checked && setAside === null && children}
    </section>
  );
}

/**
 * How new people join, for members: open sign-up's link while it's on, or else Email domain's while it
 * lets people in, and the join link, with `joinCode`, while it does, unless they're a guest, who isn't
 * given the code, or else a line saying how they join with Memberful, if they do, at `memberfulSite`,
 * or that only the people administrators invite can.
 */
export function HowPeopleJoin({ joinCode, memberfulSite }: { joinCode: string | null; memberfulSite: string | null }) {
  const account = useAccount();
  const open = signsUpOpenly(account);
  const linkCode = joinsWithLink(account) ? joinCode : null;
  // Open lets anyone in, people at the email domains too.
  const emailDomain = !open && signsUpWithEmailDomain(account);
  if (!open && linkCode === null && !emailDomain) {
    if (account.memberfulSignIn)
      return (
        <p className="text-start">
          <strong>Members sign in with Memberful</strong>, so the join link is off.
        </p>
      );
    return account.memberfulJoin && memberfulSite !== null ? (
      <p className="text-start">
        Members of <strong className="wrap-anywhere">{memberfulSite}</strong> join by signing in with Memberful.
      </p>
    ) : (
      <p className="text-start">Only the people administrators invite can join.</p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {open && (
        <div className="rounded-[10px] border bg-surface p-5 upto-500px:p-3.5">
          <ShareableLink id="sign_up" label="Share so anyone can sign up" url={signUpUrl()} sharing={SIGN_UP_LINK} />
        </div>
      )}
      {emailDomain && (
        <div className="rounded-[10px] border bg-surface p-5 upto-500px:p-3.5">
          <ShareableLink
            id="email_sign_up"
            label={`Share with people at ${domainsInWords(account.emailDomains)}`}
            url={emailSignUpUrl()}
            sharing={EMAIL_SIGN_UP_LINK}
          />
        </div>
      )}
      {/* `#account_invitation`, a card on the surface. */}
      {linkCode !== null && (
        <div className="rounded-[10px] border bg-surface p-5 upto-500px:p-3.5">
          <InviteLink joinCode={linkCode} />
        </div>
      )}
    </div>
  );
}
