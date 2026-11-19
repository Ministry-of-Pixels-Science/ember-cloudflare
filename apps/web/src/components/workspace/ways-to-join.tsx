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
import { SingleSignOnSettings } from "./sso-settings";
import { SetUpTurnstile } from "./turnstile-settings";

// The ways for new people to join, at the top of Membership: for administrators, a card for each, Open,
// Join link, Email domain, Memberful and Single sign-on, whose switch saves as it's flipped, as the
// Memberful card's did, and which shows the way's settings while it's on. Open lets anyone in, and
// Memberful's Members only only its members, as SSO only does the provider's people, so while one is on
// the ways it overrides are greyed out, keeping their settings for when it's off. Members only and SSO
// only together let in both, so while one is on, the other card's switch turns its own on or off with
// it, as nothing else of it lets anyone in then. Members see the links that let people in.

/** What turning on Open asks first, since it lets anyone in. */
export const CONFIRM_OPEN = "Are you sure you want to let anyone create an account? Ember doesn't check that the email addresses people sign up with are theirs.";

/** What turning on Memberful's Members only asks first, since it keeps everyone but administrators, and the people they invite, from signing in with a password. */
export const CONFIRM_MEMBERS_ONLY =
  "Are you sure only Memberful's members should sign in? Everyone but administrators and the people they invite will need a Memberful membership to sign in.";

/** What turning on SSO only asks first, as Members only does. */
export const CONFIRM_SSO_ONLY =
  "Turn on SSO only? Everyone except administrators and people you invite will need an account with your provider to sign in.";

/** Why a way is greyed out while Open is on. */
const OPEN_OVERRIDES = "Set aside while Open lets anyone join.";

/** Why a way is greyed out while Memberful is members only. */
const MEMBERS_ONLY_OVERRIDES = "Off while Memberful is members only.";

/** Why a way is greyed out while single sign-on is the only way in. */
const SSO_ONLY_OVERRIDES = "Off while SSO only is on.";

/** Why a way is greyed out while Memberful and single sign-on are the only ways in. */
const EITHER_ONLY_OVERRIDES = "Off while Memberful and single sign-on are the only ways in.";

/**
 * What turning on SSO only, or Members only, adds to its question while the other way is set up without
 * being the only way in too, as it signs in those who joined with it even while it's off: that it closes
 * the other way, to them as well, who have no password to reset, so only an administrator's sign-in link
 * lets them in meanwhile.
 */
export const CLOSES_MEMBERFUL =
  " Nobody will be able to sign in with Memberful either, even members who joined with it, unless Members only is on as well. Those without a password will need a sign-in link from an administrator to get back in.";
export const CLOSES_SSO =
  " Nobody will be able to sign in with single sign-on either, even people who joined with it, unless SSO only is on as well. Those without a password will need a sign-in link from an administrator to get back in.";

/** What the Memberful card says while SSO only closes it, in place of what it does, and the other way around. */
const MEMBERFUL_CLOSED = "Off while SSO only is on, even for members who joined with it. Turn it on to let Memberful's members in alongside the provider's people.";
const SSO_CLOSED = "Off while Memberful is members only, even for people who joined with it. Turn it on to let the provider's people in alongside Memberful's members.";

/** What the Memberful card says in place of Members only's switch while SSO only is on, and the other way around. */
const MEMBERS_ONLY_BESIDE_SSO =
  "SSO only is on, so Memberful's members join and sign in alongside the provider's people. Nobody else can join but the people you invite, and only they and administrators sign in with a password.";
const SSO_ONLY_BESIDE_MEMBERFUL =
  "Memberful is members only, so the provider's people join and sign in alongside Memberful's members. Nobody else can join but the people you invite, and only they and administrators sign in with a password.";

const CARD = "flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3";
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

type WaySetting = keyof Pick<AccountSettings, "openSignUp" | "joinLink" | "emailDomainSignUp" | "memberfulJoin" | "memberfulSignIn" | "ssoJoin" | "ssoSignIn">;

const ASKS_FIRST: Partial<Record<WaySetting, string>> = { openSignUp: CONFIRM_OPEN, memberfulSignIn: CONFIRM_MEMBERS_ONLY, ssoSignIn: CONFIRM_SSO_ONLY };

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
  /** Opens Set up single sign-on, calling `then`, if given, once it closes with the provider saved. */
  onSetUpSso: (then?: () => void) => void;
  /** Shows the provider as removing it left it. */
  onSsoForgotten: (sso: WorkspaceSettings["sso"]) => void;
  /** Says why removing the provider failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
  /** The join link, with its buttons, which its card shows while it's on. */
  joinLink: ReactNode;
}

/** Who can join, for administrators: a card for each way, with its switch, and its settings while it's on. */
export function WaysToJoin({ settings, saveSwitch, saveEmailDomains, onSetUpEmail, onSetUpTurnstile, onSetUpMemberful, onSetUpSso, onSsoForgotten, onFailed, joinLink }: Props) {
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
  // Turning an only-switch on turns its way on with it, as the server does.
  const memberful = moved.memberfulJoin ?? (moved.memberfulSignIn || account.memberfulJoin);
  // Off with Memberful, as the server turns it.
  const membersOnly = memberful && (moved.memberfulSignIn ?? account.memberfulSignIn);
  const sso = moved.ssoJoin ?? (moved.ssoSignIn || account.ssoJoin);
  // Off with Single sign-on, likewise.
  const ssoOnly = sso && (moved.ssoSignIn ?? account.ssoSignIn);
  // A way sets the others aside while it's on, until turning it off is saved, so that none is turned on
  // while the server still has the way that overrides it on, which would refuse it.
  const openOverrides = open || account.openSignUp;
  const membersOnlyOverrides = membersOnly || account.memberfulSignIn;
  const ssoOnlyOverrides = ssoOnly || account.ssoSignIn;
  // Why the ways that people who sign in only elsewhere turn off are greyed out, if they are.
  const elsewhereOnly =
    membersOnlyOverrides && ssoOnlyOverrides ? EITHER_ONLY_OVERRIDES : membersOnlyOverrides ? MEMBERS_ONLY_OVERRIDES : ssoOnlyOverrides ? SSO_ONLY_OVERRIDES : null;

  const switchTo =
    (setting: WaySetting, asking = true) =>
    (on: boolean) => {
      if (moved[setting] !== undefined) return;
      const question = on && asking ? questionFor(setting) : undefined;
      if (question && !confirm(question)) return;
      setMoved((moved) => ({ ...moved, [setting]: on }));
      saveSwitch({ [setting]: on }, () => setMoved(({ [setting]: _, ...others }) => others));
    };
  /**
   * What turning `setting` on asks first, if anything, warning that it closes the other way while that's
   * set up without being the only way in too, since it signs in those who joined with it even while it's off.
   */
  const questionFor = (setting: WaySetting) => {
    const question = ASKS_FIRST[setting];
    if (setting === "ssoSignIn" && settings.memberfulSite !== null && !membersOnly) return `${question}${CLOSES_MEMBERFUL}`;
    if (setting === "memberfulSignIn" && settings.sso !== null && !ssoOnly) return `${question}${CLOSES_SSO}`;
    return question;
  };
  /**
   * The switch of a way whose only-switch is `onlySetting`, while the other way, whose only-switch is
   * `otherOnly`, is the only way in, when the way lets nobody in unless it's the only way in too: on turns
   * that on, which turns the way on with it, without asking, as the other did, and off turns the way off,
   * which turns that off too. As on and off save different settings, it waits for either's move, lest the
   * earlier save land last, and for a move of `otherOnly`, as it asks nothing only because that's on:
   * were turning that on refused, this one alone would close the other way unasked.
   */
  const switchBeside = (setting: WaySetting, onlySetting: WaySetting, otherOnly: WaySetting) => (on: boolean) => {
    if (moved[setting] !== undefined || moved[onlySetting] !== undefined || moved[otherOnly] !== undefined) return;
    if (on) switchTo(onlySetting, false)(true);
    else switchTo(setting)(false);
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
        setAside={open ? null : elsewhereOnly}
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
        setAside={elsewhereOnly ?? (openOverrides ? OPEN_OVERRIDES : null)}
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
        setAside={elsewhereOnly ?? (openOverrides ? OPEN_OVERRIDES : null)}
      />
      <MemberfulSettings
        site={settings.memberfulSite}
        webhooks={settings.memberfulWebhooks}
        keys={settings.memberfulKeys}
        onSetUp={onSetUpMemberful}
        checked={ssoOnly ? membersOnly : memberful}
        onCheckedChange={ssoOnly ? switchBeside("memberfulJoin", "memberfulSignIn", "ssoSignIn") : switchTo("memberfulJoin")}
        membersOnly={membersOnly}
        beside={ssoOnly ? MEMBERS_ONLY_BESIDE_SSO : null}
        closed={ssoOnly && !membersOnly ? MEMBERFUL_CLOSED : null}
        onMembersOnlyChange={switchTo("memberfulSignIn")}
        // Saving either changes the other's setting too, so each waits for the other's move, lest saves
        // arriving out of order undo the later one. Beside SSO only, Memberful's waits for its move too
        // (`switchBeside`).
        memberfulSaving={moved.memberfulJoin !== undefined || (ssoOnly && moved.ssoSignIn !== undefined)}
        membersOnlySaving={moved.memberfulSignIn !== undefined}
        setAside={membersOnly ? null : openOverrides ? OPEN_OVERRIDES : null}
      />
      <SingleSignOnSettings
        sso={settings.sso}
        checked={membersOnly ? ssoOnly : sso}
        onCheckedChange={membersOnly ? switchBeside("ssoJoin", "ssoSignIn", "memberfulSignIn") : switchTo("ssoJoin")}
        ssoOnly={ssoOnly}
        beside={membersOnly ? SSO_ONLY_BESIDE_MEMBERFUL : null}
        closed={membersOnly && !ssoOnly ? SSO_CLOSED : null}
        onSsoOnlyChange={switchTo("ssoSignIn")}
        // As Memberful's two do, each waits for the other's move, and beside Members only, Single
        // sign-on's waits for its move too.
        ssoSaving={moved.ssoJoin !== undefined || (membersOnly && moved.memberfulSignIn !== undefined)}
        ssoOnlySaving={moved.ssoSignIn !== undefined}
        setAside={ssoOnly ? null : openOverrides ? OPEN_OVERRIDES : null}
        onSetUp={onSetUpSso}
        onForgotten={onSsoForgotten}
        onFailed={onFailed}
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
 * or with single sign-on, or both, or that only the people administrators invite can.
 */
export function HowPeopleJoin({ joinCode, memberfulSite }: { joinCode: string | null; memberfulSite: string | null }) {
  const account = useAccount();
  const open = signsUpOpenly(account);
  const linkCode = joinsWithLink(account) ? joinCode : null;
  // Open lets anyone in, people at the email domains too.
  const emailDomain = !open && signsUpWithEmailDomain(account);
  if (!open && linkCode === null && !emailDomain) {
    if (account.memberfulSignIn && account.ssoSignIn)
      return (
        <p className="text-start">
          <strong>Members sign in with Memberful or single sign-on</strong>, so the join link is off.
        </p>
      );
    if (account.memberfulSignIn)
      return (
        <p className="text-start">
          <strong>Members sign in with Memberful</strong>, so the join link is off.
        </p>
      );
    if (account.ssoSignIn)
      return (
        <p className="text-start">
          <strong>This workspace uses single sign-on</strong>, so the join link is off.
        </p>
      );
    return account.memberfulJoin && memberfulSite !== null ? (
      <p className="text-start">
        Members of <strong className="wrap-anywhere">{memberfulSite}</strong> join by signing in with Memberful
        {account.ssoJoin ? ", and others with single sign-on." : "."}
      </p>
    ) : account.ssoJoin ? (
      <p className="text-start">New people join with single sign-on.</p>
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
