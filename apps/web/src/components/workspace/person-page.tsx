import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DirectoryUser, Me, Person, PersonAnswer, User, UserId } from "@ember/protocol";
import type { AgentProfile } from "@ember/protocol/agents";
import { isWorkersAiModel } from "@ember/protocol/assistant";
import { ChatLines, EditPencil, Prohibition } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { PeopleContext, useNameOf } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { leave, PROFILE_PATH, useBackPath } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { asListed, canAsk } from "@/lib/agents";
import { banPerson, fetchPerson, isSignedOut, unbanPerson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentBadge, isAgent } from "./agent-badge";
import { HEADER_BUTTON } from "./page-header";
import { isMissing } from "./room-settings-page";
import { Panel, SettingsPage } from "./settings-page";
import { SignInLink } from "./sign-in-link";
import { UserAvatar } from "./user-avatar";

/** What the page of an AI agent kept for administrators, called `name`, says to anyone else, in place of the button that starts a DM with it. */
export const adminsOnlyAsk = (name: string) => `Only administrators can ask ${name}.`;

/** What Ban and Remove ban ask first. */
export const CONFIRM_BAN = "Are you sure you want to ban this user? This will log them out, delete their messages, and block their IP addresses.";
export const CONFIRM_UNBAN = "Are you sure you want to remove the ban on this user?";

interface Props {
  userId: UserId;
  me: Me;
  /** Starts a DM with someone, or opens the one you have, and goes there, settling with whether it did. */
  onStartDirect: (person: User) => Promise<boolean>;
  /** Changes someone in the people directory, as banning them or lifting their ban answers they are now. */
  onPersonChanged: (person: DirectoryUser) => void;
  /** Loads the people directory again, settling once it has or failed. */
  reloadPeople: () => Promise<void>;
  /** Nobody has the id, which Campfire's 404 page says. */
  onMissing: () => void;
  /** Says why loading failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * Campfire's `.btn` in a panel, the full width of the panel: 9px corners at medium weight, 36px tall, or
 * 44px for fingers, with its icon at 1.3em.
 */
const DIRECT_BUTTON =
  "inline-flex w-full min-h-9 cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border px-[1.1em] py-[0.5em] font-medium transition-[filter] aria-disabled:cursor-default touch:min-h-11";

/**
 * The page for someone, at `/users/<id>`, whatever their status, titled with their name: Go Back to the
 * page it was opened from, a pencil to Edit my profile on your own, and their avatar. Active and banned
 * people show their name and bio, with their email address for administrators, and active people a
 * button that starts a DM with them, or opens the one you have. Removed people show their name and that
 * they're no longer on this account, and bots their avatar, with the agent badge under an AI agent's
 * and, for an agent an administrator made, what `AboutAgent` says of it, then the DM button while
 * they're active, or, for an agent only administrators can ask, to anyone else, that they can't.
 * Administrators get a new sign-in link for anyone active who isn't a bot, themselves included, and Ban
 * for anyone else active or Remove ban for anyone banned. The people directory keeps what it lists of
 * them current. Members suspended for their Memberful membership's lapsing show as removed people do,
 * but to administrators, who see them as banned people, with why they can't sign in, and Ban.
 */
export function PersonPage({ userId, me, onStartDirect, onPersonChanged, reloadPeople, onMissing, onFailed }: Props) {
  const [fetched, setFetched] = useState<PersonAnswer | null>(null);
  // As the people directory lists them now, kept current by the workspace socket, with what only the page is told.
  const listed = useContext(PeopleContext).get(userId);
  // As it lists them now, for answers that come later.
  const listedNow = useRef(listed);
  useLayoutEffect(() => {
    listedNow.current = listed;
  }, [listed]);
  const person = fetched && (listed ? asListed(fetched.person, listed) : fetched.person);
  const [starting, setStarting] = useState(false);
  const [banning, setBanning] = useState(false);
  // How many times a ban or its lifting has loaded the page again.
  const [reloads, setReloads] = useState(0);
  const back = useBackPath();
  const mounted = useMounted();
  useTitle(person?.name ?? null);

  // Again once you become an administrator or stop being one, which decides whether it's told their
  // email address and given a sign-in link for them, and after a ban or its lifting.
  useEffect(() => {
    let stopped = false;
    fetchPerson(userId).then(
      (answer) => !stopped && setFetched(answer),
      (error: unknown) => {
        if (stopped && !isSignedOut(error)) return;
        if (isMissing(error)) onMissing();
        else onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [userId, me.administrator, reloads, onMissing, onFailed]);

  // Once the page's guard lets it, which a second click doesn't start again.
  const startDirect = () => {
    if (!person || starting) return;
    leave(async () => {
      setStarting(true);
      try {
        return await onStartDirect(person);
      } finally {
        if (mounted.current) setStarting(false);
      }
    });
  };

  // Ban and Remove ban ask first, then load the page again with no notice. Once the workspace socket or
  // a load has said they changed while the answer was on its way, the answer may be older than that, so
  // it's left out, and the directory loads again unless it has what it says. A page that has gone
  // stopped hearing what the directory has, so then the directory loads again.
  const toggleBan = () => {
    if (!person || banning) return;
    const banned = person.status === "banned";
    if (!confirm(banned ? CONFIRM_UNBAN : CONFIRM_BAN)) return;
    const asked = listedNow.current;
    setBanning(true);
    (banned ? unbanPerson : banPerson)(person.id)
      .then(
        (changed) => {
          if (mounted.current && listedNow.current === asked) onPersonChanged(changed);
          else if (listedNow.current?.status !== changed.status) void reloadPeople().catch(() => {});
          if (mounted.current) setReloads((reloads) => reloads + 1);
        },
        (error: unknown) => {
          if (mounted.current || isSignedOut(error)) onFailed(error);
        },
      )
      .finally(() => mounted.current && setBanning(false));
  };

  const mine = userId === me.id;
  // Gone as soon as you stop being an administrator, before the page has loaded them again.
  const transferId = me.administrator ? fetched?.transferId : undefined;
  const editProfile = mine && (
    <PageLink href={PROFILE_PATH} className={HEADER_BUTTON}>
      <EditPencil className="size-5" />
      <span className="sr-only">Edit my profile</span>
    </PageLink>
  );

  return (
    <SettingsPage back={back} links={editProfile}>
      <Panel aria-busy={person === null} className="text-center">
        {person && (
          <div className="flex flex-col gap-x-[1ch] gap-y-4 wrap-anywhere">
            <Avatar person={person} />
            {isAgent(person) && <AgentBadge className="mx-auto" />}
            {fetched?.agent && <AboutAgent name={person.name} agent={fetched.agent} meId={me.id} />}
            {person.role === "bot" ? (
              person.status !== "active" ? (
                <NoLongerHere name={person.name} />
              ) : canAsk(person, me) ? (
                // At the page's text size.
                <button type="button" aria-disabled={starting || undefined} onClick={startDirect} className={cn(DIRECT_BUTTON, "bg-background")}>
                  <ChatLines className="size-[1.3em]" />
                  <span className="sr-only">Ping {person.name}</span>
                </button>
              ) : (
                <div className="text-[0.8em] text-muted-foreground">{adminsOnlyAsk(person.name)}</div>
              )
            ) : person.status === "deactivated" || (person.status === "suspended" && !me.administrator) ? (
              <div>
                <h1 className="text-[23px] font-bold">{person.name}</h1>
                <NoLongerHere name={person.name} />
              </div>
            ) : (
              <>
                {/* Campfire's `.gap` with a third of its block space between rows. */}
                <div className="flex flex-col gap-x-[1ch] gap-y-[calc(1rem/3)]">
                  <h1 className="text-[23px] leading-[1.2] font-bold">{person.name}</h1>
                  {/* Campfire's link, left out for someone with no address. */}
                  {person.emailAddress !== undefined && (
                    <div>
                      {person.emailAddress && (
                        <a href={`mailto:${person.emailAddress}`} className="text-link underline hover:not-active:brightness-130">
                          {person.emailAddress}
                        </a>
                      )}
                    </div>
                  )}
                  <div>{person.bio}</div>
                </div>
                {person.status === "active" && (
                  <>
                    <div className="mx-[1ch] mt-4 px-[2ch] max-md:px-3">
                      {/* Named for what it does, since its icon is hidden. */}
                      <button
                        type="button"
                        aria-disabled={starting || undefined}
                        onClick={startDirect}
                        className={cn(DIRECT_BUTTON, "border-transparent bg-primary text-[17px] text-primary-foreground hover:not-active:brightness-70")}
                      >
                        <ChatLines className="size-[1.3em]" />
                        <span className="sr-only">Ping {person.name}</span>
                      </button>
                    </div>
                    {transferId && (
                      <>
                        {/* Campfire's borderless `hr`, spacing the sign-in link from the button. */}
                        <hr className="mt-4 mb-2 border-0" />
                        <SignInLink transferId={transferId} mine={mine} />
                      </>
                    )}
                  </>
                )}
                {person.status === "suspended" && (
                  <div className="mt-4">{person.name}’s Memberful membership has lapsed, so they can’t sign in until it’s renewed.</div>
                )}
                {me.administrator && !mine && (
                  <div className="mt-4">
                    <BanButton person={person} busy={banning} onClick={toggleBan} />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Panel>
    </SettingsPage>
  );
}

/**
 * The ban button, the full width of the panel: Ban with a cancel mark for someone active, or a red
 * Remove ban, Campfire's `.btn--negative`, for someone banned.
 */
function BanButton({ person, busy, onClick }: { person: Person; busy: boolean; onClick: () => void }) {
  const banned = person.status === "banned";
  return (
    <button
      type="button"
      aria-disabled={busy || undefined}
      onClick={onClick}
      className={cn(DIRECT_BUTTON, banned ? "border-transparent bg-negative-button text-white hover:not-active:brightness-70" : "bg-background")}
    >
      <Prohibition className="size-[1.3em]" />
      <span>{banned ? "Remove ban" : `Ban ${person.name}`}</span>
    </button>
  );
}

/**
 * Campfire's `.avatar.txt-xx-large.center` on white: 5ch across at 2.4rem, named "Profile avatar", and
 * dimmed under a cancel mark when they're banned (avatars.css).
 */
function Avatar({ person }: { person: Person }) {
  const banned = person.status === "banned";
  return (
    <div className="relative mx-auto grid size-[5ch] place-items-center rounded-full bg-white text-[2.4rem]">
      <UserAvatar user={person} label="Profile avatar" className={cn("col-start-1 row-start-1 size-[5ch]", banned && "opacity-50")} />
      {banned && <Prohibition className="absolute inset-0 size-full" />}
    </div>
  );
}

function NoLongerHere({ name }: { name: string }) {
  return <div>{name} is no longer on this account</div>;
}

/**
 * What an agent's page tells everyone of it, but its instructions: its name, what it does, then smaller
 * and muted, the model it answers with, whom that sends what's asked to, and who set it up, by the name
 * the people directory has for them now.
 */
function AboutAgent({ name, agent, meId }: { name: string; agent: AgentProfile; meId: UserId }) {
  const nameOf = useNameOf();
  return (
    <div className="flex flex-col gap-x-[1ch] gap-y-[calc(1rem/3)]">
      <h1 className="text-[23px] leading-[1.2] font-bold">{name}</h1>
      <div>{agent.description}</div>
      <div className="mx-auto max-w-[32em] text-[0.8em] text-muted-foreground">
        {runsOn(agent)} {agent.setUpBy.id === meId ? "You" : nameOf(agent.setUpBy)} set it up.
      </div>
    </div>
  );
}

/** The companies whose models AI Gateway sends to, by the start of their models' IDs. */
const MAKERS: Readonly<Record<string, string>> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", moonshotai: "Moonshot AI" };

/**
 * The model an agent answers with, and where it runs: on Cloudflare, for Workers AI's, or else at the
 * company that makes it, which AI Gateway sends the conversation the agent's asked in to.
 */
function runsOn({ model, modelName }: AgentProfile): string {
  if (isWorkersAiModel(model)) return `An AI agent running on ${modelName}, on Cloudflare’s Workers AI.`;
  const maker = MAKERS[model.split("/", 1)[0]!] ?? "the model’s maker";
  return `An AI agent running on ${modelName} through Cloudflare AI Gateway, which sends the conversation you ask it in to ${maker}.`;
}
