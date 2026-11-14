import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  LOGO_TOO_LARGE,
  MAX_ACCOUNT_NAME_LENGTH,
  MAX_LOGO_SIZE,
  MAX_TAGLINE_LENGTH,
  type Account,
  type AccountSettings,
  type DirectoryUser,
  type EmailInvitation,
  type EmberAddresses,
  type Me,
  type PersonRole,
  type ReleaseCheck,
  type RoomId,
  type SidebarRoom,
  type WorkspaceSettings,
} from "@ember/protocol";
import { AccountLogo, STOCK_LOGO } from "@/components/account-logo";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { useFlash } from "@/components/flash";
import { Crown, Plus } from "@/components/icons/iconoir";
import { scrollMainContentToTop } from "@/components/main-content";
import { PageLink } from "@/components/page-link";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { newRoomPath, useHash } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { changeAccount, changeLogo, changeRole, fetchWorkspaceSettings, isSignedOut, regenerateJoinCode, removeLogo, removePerson } from "@/lib/api";
import { HUDDLE_CHAT_TITLE } from "@/lib/huddle-chat";
import { logoVariantsOf } from "@/lib/previews";
import { apart } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { AgentList } from "./agent-list";
import { AppList } from "./app-list";
import { AssistantSettings } from "./assistant-settings";
import { AssistantSetup } from "./assistant-setup";
import { CustomDomainSettings } from "./custom-domain-settings";
import { EmberVersion } from "./ember-version";
import { EmailSettings, sendsEmail } from "./email-settings";
import { EmailSetup } from "./email-setup";
import { HuddlesSettings } from "./huddles-settings";
import { HuddlesSetup } from "./huddles-setup";
import { InviteByEmail } from "./invite-by-email";
import { InviteLink } from "./invite-link";
import { OutsideAiSettings } from "./outside-ai-settings";
import { PeopleList } from "./people-list";
import { PicturePicker } from "./picture-picker";
import { RoomOrder } from "./room-order";
import { workspaceSectionOf } from "./settings-navigation";
import { CHANGES_SAVED, PageHeading, Panel, SECTION_HEADING, SettingsPage, TITLE, TITLE_LINK } from "./settings-page";
import { TurnstileSettings } from "./turnstile-settings";
import { TurnstileSetup } from "./turnstile-setup";
import { HowPeopleJoin, WaysToJoin } from "./ways-to-join";

interface Props {
  me: Me;
  /** Where Go Back goes: the last room visited. */
  back: string;
  /**
   * Called as the page asks for the workspace, by loading or saving it. What it returns is called with
   * the workspace the server answers, for the rail and sidebar to show.
   */
  askForAccount: () => (account: Account) => void;
  /** Called with the join link's code as the page loads or regenerates it, for the welcome card to show. */
  onJoinCodeChanged: (joinCode: string) => void;
  /** Loads the people directory again, which the page lists people from, settling once it has or failed. */
  reloadPeople: () => Promise<void>;
  /** Called with someone as the page changes them, for the people directory to show. */
  onPersonChanged: (person: DirectoryUser) => void;
  /** Says why loading or saving failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
  /** The rooms in this person's sidebar, as it lists them now, or null until it has. */
  rooms: SidebarRoom[] | null;
  /** The ones of them the shared order ranks, in its order. */
  sharedOrder: RoomId[];
  /** Called with the rooms of theirs the shared order ranks, as the server answers them, once they save it. */
  onSharedOrderSaved: (sharedOrder: RoomId[]) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
  /** For an administrator, the release this Ember is and the newest one, once the Worker has said, or else null. */
  release: ReleaseCheck | null;
  /** Asks the Worker that afresh, as General's Check for updates does, settling once it's answered, which `release` then says. */
  onCheckForUpdates: () => Promise<void>;
}

/**
 * Workspace settings, in six sections, of which the address's fragment shows one, all of them staying
 * drawn so what's typed in one waits there while another shows:
 *
 * - General, where administrators change the workspace's icon, which one picked saves at once, showing it
 *   meanwhile, and Remove icon takes away, then rename the workspace, give it a tagline, and show or hide
 *   the translation buttons, which Save changes saves together, and see which release of Ember this is,
 *   and when a newer one is out, which Check for updates asks GitHub again. Members see its icon, name
 *   and tagline.
 *   The rail's icons are in Custom styles (`NavigationIconSettings`), where the project's owner moved
 *   them.
 * - Rooms and permissions: New room, which members don't get while only administrators can create
 *   rooms, then for administrators, the switch that says so, and the rooms' order for everyone, each
 *   linking to its settings.
 * - Membership: for administrators, who can join, with switches for Open, the join link, which they can
 *   regenerate, and Memberful, how Ember sends email, and whether Cloudflare Turnstile checks who joins,
 *   or for members, the links that let people in, then the administrators and members, whom
 *   administrators can make administrators or members and remove.
 * - Domain settings: for administrators, the custom domain Ember answers at.
 * - AI assistant: for administrators, whether Ember's AI agents run on models through Cloudflare AI
 *   Gateway, which Set up Ember AI connects, and while they do, the agents, @ember first, each linking to
 *   its page, and New agent. Then whether AI apps, such as Claude, may connect to Ember as the people in
 *   it (Outside AI).
 * - Huddles: for administrators, whether huddles are on, through the Realtime SFU app whose keys Set up
 *   huddles takes.
 */
export function WorkspaceSettingsPage({
  me,
  back,
  askForAccount,
  onJoinCodeChanged,
  reloadPeople,
  onPersonChanged,
  onFailed,
  rooms,
  sharedOrder,
  onSharedOrderSaved,
  onSessionChanged,
  release,
  onCheckForUpdates,
}: Props) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  // What's typed in Workspace name and Tagline, or null for either while it's as the workspace has it,
  // when the field follows the workspace socket, so that saving one never puts back what another tab
  // changed in the other.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [typedTagline, setTypedTagline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The address of the logo picked, shown while it saves. */
  const [pickedLogo, setPickedLogo] = useState<string | null>(null);
  const [savingLogo, setSavingLogo] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Where the Hide translation buttons switch was moved to, until Save changes saves it with the name.
  const [hidingTranslations, setHidingTranslations] = useState<boolean | null>(null);
  // Where Must be admin to create new rooms was moved to, while that's saved.
  const [restrictingCreation, setRestrictingCreation] = useState<boolean | null>(null);
  // Set up email, while it's open, with what to go on to once it closes with Ember able to send email.
  const [emailSetup, setEmailSetup] = useState<{ then?: () => void } | null>(null);
  const [settingUpTurnstile, setSettingUpTurnstile] = useState(false);
  const [settingUpAssistant, setSettingUpAssistant] = useState(false);
  const [settingUpHuddles, setSettingUpHuddles] = useState(false);
  const account = useAccount();
  const name = typedName ?? account.name;
  const tagline = typedTagline ?? account.tagline;
  const people = useContext(PeopleContext);
  // The people as they are now, for answers that come later.
  const peopleNow = useRef(people);
  useLayoutEffect(() => {
    peopleNow.current = people;
  }, [people]);
  const flash = useFlash();
  const mounted = useMounted();
  const section = workspaceSectionOf(useHash());
  useTitle("Community settings");

  // Another section starts at its top: the page scrolls up as the fragment changes.
  useLayoutEffect(scrollMainContentToTop, [section]);

  // A page that has gone only reports a session that's ended, which goes to sign in.
  const listPeople = useCallback(
    () => void reloadPeople().catch((error: unknown) => (mounted.current || isSignedOut(error)) && onFailed(error)),
    [reloadPeople, onFailed, mounted],
  );

  // Everyone's listed as the page loads, rather than as the directory last loaded.
  useEffect(() => listPeople(), [listPeople]);

  // Loaded again when someone makes them an administrator or a member, which changes what they can do here.
  const administrator = me.administrator;
  useEffect(() => {
    let stopped = false;
    const answered = askForAccount();
    fetchWorkspaceSettings().then(
      (settings) => {
        if (stopped) return;
        setSettings(settings);
        setTypedName(null);
        setTypedTagline(null);
        answered(settings.account);
        // Only administrators have the welcome card, and they're always given the code.
        if (settings.joinCode !== null) onJoinCodeChanged(settings.joinCode);
      },
      (error: unknown) => {
        // A page left before its settings load only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [administrator, askForAccount, onJoinCodeChanged, onFailed]);

  // The name, the tagline and, if it was moved, the translation buttons' switch, sent together.
  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const answered = askForAccount();
    const sent = { name, tagline };
    const hideTranslationButtons = hidingTranslations;
    changeAccount({ ...sent, ...(hideTranslationButtons !== null && { settings: { hideTranslationButtons } }) }).then(
      (account) => {
        answered(account);
        if (!mounted.current) return;
        setSaving(false);
        // Unless it's been moved again since.
        setHidingTranslations((hiding) => (hiding === hideTranslationButtons ? null : hiding));
        setSettings((settings) => settings && { ...settings, account });
        // Each shows as it's kept, the tagline with no space at its ends, unless it's been typed over since.
        setTypedName((typed) => (typed === sent.name ? null : typed));
        setTypedTagline((typed) => (typed === sent.tagline ? null : typed));
        flash("notice", CHANGES_SAVED);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };

  // The picked logo's address is let go of once the saved one takes its place.
  useEffect(() => () => void (pickedLogo && URL.revokeObjectURL(pickedLogo)), [pickedLogo]);

  /** Saves `file` as the workspace's logo, once it's picked. */
  const saveLogo = (file: File) => {
    if (file.size > MAX_LOGO_SIZE) return flash("alert", LOGO_TOO_LARGE);
    setPickedLogo(URL.createObjectURL(file));
    showLogo(logoVariantsOf(file).then((variants) => changeLogo({ file, variants })), CHANGES_SAVED);
  };

  /** Shows the workspace's logo as `change` saves it, flashing `notice` once it has. */
  function showLogo(change: Promise<Account>, notice?: string) {
    setSavingLogo(true);
    const answered = askForAccount();
    change.then(
      (account) => {
        answered(account);
        if (!mounted.current) return;
        setSavingLogo(false);
        setPickedLogo(null);
        setSettings((settings) => settings && { ...settings, account });
        if (notice) flash("notice", notice);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSavingLogo(false);
        setPickedLogo(null);
        onFailed(error);
      },
    );
  }

  // A switch saves at once, with no notice after, then `settled` is called.
  const saveSwitch = (settings: AccountSettings, settled: () => void) => {
    const answered = askForAccount();
    changeAccount({ settings }).then(
      (account) => {
        answered(account);
        if (mounted.current) settled();
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        settled();
        onFailed(error);
      },
    );
  };
  /** Saves Email domain's domains, turning it on with them if `turnOn`, flashing a notice once they're saved. */
  const saveEmailDomains = (emailDomains: string[], turnOn: boolean, settled: (saved: boolean) => void) => {
    const answered = askForAccount();
    changeAccount({ emailDomains, ...(turnOn && { settings: { emailDomainSignUp: true } }) }).then(
      (account) => {
        answered(account);
        if (!mounted.current) return;
        setSettings((settings) => settings && { ...settings, account, emailDomains });
        settled(true);
        flash("notice", CHANGES_SAVED);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        settled(false);
        onFailed(error);
      },
    );
  };
  const switchRoomCreation = (restrict: boolean) => {
    if (restrictingCreation !== null) return;
    setRestrictingCreation(restrict);
    saveSwitch({ restrictRoomCreation: restrict }, () => setRestrictingCreation(null));
  };
  const sharedRooms = useMemo(() => rooms && apart(rooms).shared, [rooms]);

  /** Changes the invitations shown as `change` says, which only workspace settings shows. */
  const changeInvitations = useCallback(
    (change: (invitations: EmailInvitation[]) => EmailInvitation[]) => setSettings((settings) => settings && { ...settings, invitations: change(settings.invitations) }),
    [],
  );

  /** Shows how Ember sends email as Set up email, or Stop sending email, changes it, which only workspace settings shows. */
  const showEmail = (change: (email: WorkspaceSettings["email"]) => WorkspaceSettings["email"]) => setSettings((settings) => settings && { ...settings, email: change(settings.email) });
  /** Shows the addresses Ember knows reach it as the Custom domain section changes them, which only workspace settings shows. */
  const showAddresses = (change: (addresses: EmberAddresses) => EmberAddresses) => setSettings((settings) => settings && { ...settings, addresses: change(settings.addresses) });
  const setUpEmail = (then?: () => void) => setEmailSetup({ then });
  /** Shows where Ember's Turnstile keys come from as Set up Turnstile, or turning Turnstile off, changes it, which only workspace settings shows. */
  const showTurnstile = (turnstile: WorkspaceSettings["turnstile"]) => setSettings((settings) => settings && { ...settings, turnstile });
  /** Shows Ember AI as Set up Ember AI, or turning it off, changes it, which only workspace settings shows. */
  const showAssistant = (assistant: WorkspaceSettings["assistant"]) => setSettings((settings) => settings && { ...settings, assistant });
  /** Shows whether AI apps may connect, as the Outside AI card's switch changes it. */
  const showOutsideAi = (outsideAi: boolean) => setSettings((settings) => settings && { ...settings, outsideAi });
  /** Shows huddles as Set up huddles, or turning them off, changes them, which only workspace settings shows. */
  const showHuddles = (huddles: WorkspaceSettings["huddles"]) => setSettings((settings) => settings && { ...settings, huddles });

  // Regenerate join link: no confirmation first, and no notice after.
  const regenerate = () => {
    setRegenerating(true);
    regenerateJoinCode().then(
      (joinCode) => {
        onJoinCodeChanged(joinCode);
        if (!mounted.current) return;
        setRegenerating(false);
        setSettings((settings) => settings && { ...settings, joinCode });
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setRegenerating(false);
        onFailed(error);
      },
    );
  };

  // A crown: no notice after. Once the workspace socket or a load has said the person changed while the
  // answer was on its way, the answer may be older than that, so it's left out, and the directory loads
  // again unless they already have the role it gives them.
  const changeRoleOf = useCallback(
    (person: DirectoryUser, role: PersonRole) =>
      changeRole(person.id, role).then(
        (changed) => {
          const listed = peopleNow.current.get(person.id);
          if (listed === person) onPersonChanged(changed);
          else if (listed?.role !== changed.role) listPeople();
        },
        (error: unknown) => {
          if (mounted.current || isSignedOut(error)) onFailed(error);
        },
      ),
    [onPersonChanged, onFailed, mounted, listPeople],
  );

  // Delete: no notice after, once it's confirmed. The person leaves the list as the directory hears
  // they're removed, from this answer or the workspace socket, as a role's answer is kept.
  const removeOf = useCallback(
    (person: DirectoryUser) =>
      removePerson(person.id).then(
        (removed) => {
          const listed = peopleNow.current.get(person.id);
          if (listed === person) onPersonChanged(removed);
          else if (listed?.status !== removed.status) listPeople();
        },
        (error: unknown) => {
          if (mounted.current || isSignedOut(error)) onFailed(error);
        },
      ),
    [onPersonChanged, onFailed, mounted, listPeople],
  );

  return (
    <SettingsPage back={back}>
      <Panel
        id="community-settings"
        hidden={section !== "community-settings"}
        aria-labelledby="community-settings-heading"
        aria-busy={settings === null}
        className="flex flex-col gap-6"
      >
        <PageHeading id="community-settings-heading" title="Basic community settings" className={SECTION_HEADING}>
          Manage your community name, icon, and preferences.
        </PageHeading>
        {settings &&
          (settings.canAdminister ? (
            <>
              <PicturePicker
                id="account_logo"
                src={pickedLogo ?? account.logo ?? STOCK_LOGO}
                alt="Community icon"
                label="Upload icon"
                description="Choose a community icon"
                onChoose={saveLogo}
                disabled={savingLogo}
                // Remove icon: no confirmation first, and no notice after.
                remove={account.logo ? { label: "Remove icon", onRemove: () => showLogo(removeLogo()) } : null}
              />
              <form onSubmit={save} className="flex flex-col gap-6">
                <Field id="account_name" label="Community name" translation="account_name">
                  {/* Not focused as the page opens, and the cursor goes where it's put. */}
                  <Input
                    id="account_name"
                    autoComplete="off"
                    maxLength={MAX_ACCOUNT_NAME_LENGTH}
                    placeholder="Name this account"
                    data-ember-preserve-selection
                    value={name}
                    onChange={(event) => setTypedName(event.target.value)}
                    // This field alone has no focus ring.
                    className={cn(FIELD_INPUT, "focus-visible:outline-none")}
                  />
                </Field>
                <Field id="account_tagline" label="Tagline">
                  <Input
                    id="account_tagline"
                    autoComplete="off"
                    maxLength={MAX_TAGLINE_LENGTH}
                    placeholder="Sum it up in a few words"
                    aria-describedby="account-tagline-description"
                    value={tagline}
                    onChange={(event) => setTypedTagline(event.target.value)}
                    className={FIELD_INPUT}
                  />
                  <p id="account-tagline-description" className="text-[0.8em] text-muted-foreground">
                    Shown under the community name in the sidebar, up to {MAX_TAGLINE_LENGTH} characters. Leave it empty for none.
                  </p>
                </Field>
                <div id="localization-settings" className="mt-1 flex items-center gap-x-[1ch] gap-y-4 rounded-[10px] border bg-surface p-5">
                  <div className="min-w-0 flex-1 text-start">
                    <div>Hide translation buttons</div>
                    <p id="localization-description" className="text-[0.8em] text-muted-foreground max-md:text-[12px]">
                      Hide language help throughout the app for everyone.
                    </p>
                  </div>
                  <Switch
                    checked={hidingTranslations ?? account.hideTranslationButtons}
                    onCheckedChange={setHidingTranslations}
                    aria-label="Hide translation buttons"
                    aria-describedby="localization-description"
                  />
                </div>
                {/* On a page of community settings, as wide as it needs, but at least 126px, at the form's end. */}
                <SubmitButton disabled={saving} className="w-auto min-w-[126px] self-end">
                  Save changes
                </SubmitButton>
              </form>
              <EmberVersion check={release} onCheckForUpdates={onCheckForUpdates} onFailed={onFailed} />
            </>
          ) : (
            <>
              {/* `account_logo_tag(style: "txt-xx-large center")`: 5ch wide at 2.4rem. */}
              <AccountLogo src={account.logo ?? STOCK_LOGO} className="mx-auto w-[5ch] text-[2.4rem]" />
              <hgroup>
                <h2 className="text-[24px] font-bold wrap-anywhere max-md:text-[22px]">{account.name}</h2>
                {account.tagline && <p className="text-muted-foreground wrap-anywhere">{account.tagline}</p>}
              </hgroup>
            </>
          ))}
      </Panel>
      <Panel id="channel-settings" hidden={section !== "channel-settings"} aria-labelledby="channel-settings-heading" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3 upto-500px:items-start">
          <h2 id="channel-settings-heading" className={TITLE}>
            Room order and permissions
          </h2>
          {(me.administrator || !account.restrictRoomCreation) && (
            <PageLink href={newRoomPath("open")} className={TITLE_LINK}>
              <Plus className="size-[18px]" />
              <span>New room</span>
            </PageLink>
          )}
        </div>
        {settings?.canAdminister ? (
          <>
            <div className="flex items-center gap-x-[1ch] gap-y-4 border-t pt-5">
              <div className="flex min-w-0 grow items-center gap-x-[1ch] text-start">
                <Crown className="size-[18px]" />
                Must be admin to create new rooms
              </div>
              <Switch
                checked={restrictingCreation ?? account.restrictRoomCreation}
                onCheckedChange={switchRoomCreation}
                aria-label="Must be admin to create new rooms"
              />
            </div>
            {sharedRooms && <RoomOrder rooms={sharedRooms} sharedOrder={sharedOrder} onSaved={onSharedOrderSaved} onSessionChanged={onSessionChanged} />}
          </>
        ) : (
          settings && <p className="text-muted-foreground">Community admins manage room order and permissions.</p>
        )}
      </Panel>
      <Panel id="membership-settings" hidden={section !== "membership-settings"} aria-labelledby="membership-settings-heading" className="flex flex-col gap-6">
        <PageHeading id="membership-settings-heading" title="Membership" className={SECTION_HEADING}>
          Invite people and manage access to your community.
        </PageHeading>
        {settings && (
          <div className="min-w-0">
            {settings.canAdminister ? (
              <div className="flex flex-col gap-6">
                <WaysToJoin
                  settings={settings}
                  saveSwitch={saveSwitch}
                  saveEmailDomains={saveEmailDomains}
                  onSetUpEmail={setUpEmail}
                  onSetUpTurnstile={() => setSettingUpTurnstile(true)}
                  joinLink={settings.joinCode !== null && <InviteLink joinCode={settings.joinCode} onRegenerate={regenerate} regenerating={regenerating} />}
                />
                <InviteByEmail
                  invitations={settings.invitations}
                  emails={sendsEmail(settings.email)}
                  onSetUpEmail={() => setUpEmail()}
                  onInvitationsChanged={changeInvitations}
                  onFailed={onFailed}
                />
                <EmailSettings
                  email={settings.email}
                  askForAccount={askForAccount}
                  onSetUp={() => setUpEmail()}
                  onStopped={() => showEmail((email) => ({ ...email, from: null }))}
                  onFailed={onFailed}
                />
                {emailSetup && (
                  <EmailSetup
                    email={settings.email}
                    askForAccount={askForAccount}
                    onEmailChanged={(email) => showEmail(() => email)}
                    onFromSaved={(from) => showEmail((email) => ({ ...email, from }))}
                    onClose={(sends) => {
                      setEmailSetup(null);
                      if (sends) emailSetup.then?.();
                    }}
                    onFailed={onFailed}
                  />
                )}
                <TurnstileSettings
                  turnstile={settings.turnstile}
                  onSetUp={() => setSettingUpTurnstile(true)}
                  onStopped={showTurnstile}
                  onFailed={onFailed}
                />
                {settingUpTurnstile && (
                  <TurnstileSetup turnstile={settings.turnstile} onSaved={showTurnstile} onClose={() => setSettingUpTurnstile(false)} onFailed={onFailed} />
                )}
              </div>
            ) : (
              <HowPeopleJoin joinCode={settings.joinCode} memberfulSite={settings.memberfulSite} />
            )}
            <hr className="my-4 w-full" />
            <PeopleList
              people={people}
              myId={me.id}
              onChangeRole={settings.canAdminister ? changeRoleOf : undefined}
              onRemove={settings.canAdminister ? removeOf : undefined}
            />
          </div>
        )}
      </Panel>
      <Panel id="domain-settings" hidden={section !== "domain-settings"} aria-labelledby="domain-settings-heading" className="flex flex-col gap-6">
        <PageHeading id="domain-settings-heading" title="Domain settings" className={SECTION_HEADING}>
          Choose the address people open your community at.
        </PageHeading>
        {settings &&
          (settings.canAdminister ? (
            <CustomDomainSettings
              addresses={settings.addresses}
              showAddresses={showAddresses}
              askForAccount={askForAccount}
              onSaved={() => flash("notice", CHANGES_SAVED)}
              onFailed={onFailed}
            />
          ) : (
            <p className="text-muted-foreground">Community admins manage the community's domain.</p>
          ))}
      </Panel>
      <Panel id="assistant-settings" hidden={section !== "assistant-settings"} aria-labelledby="assistant-settings-heading" className="flex flex-col gap-6">
        <PageHeading id="assistant-settings-heading" title="AI assistant" className={SECTION_HEADING}>
          Add AI agents people can ask in the chat.
        </PageHeading>
        {settings &&
          (settings.canAdminister ? (
            <>
              <AssistantSettings
                assistant={settings.assistant}
                onSetUp={() => setSettingUpAssistant(true)}
                onStopped={() => showAssistant(null)}
                onFailed={onFailed}
              />
              {settings.assistant && <AgentList assistant={settings.assistant} onFailed={onFailed} />}
              {settings.assistant && <AppList onFailed={onFailed} />}
              <OutsideAiSettings on={settings.outsideAi} onChanged={showOutsideAi} onFailed={onFailed} />
              {settingUpAssistant && (
                <AssistantSetup
                  assistant={settings.assistant}
                  deployedAccountId={settings.cloudflareAccountId}
                  onSaved={showAssistant}
                  onClose={() => setSettingUpAssistant(false)}
                  onFailed={onFailed}
                />
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Community admins manage the AI assistant.</p>
          ))}
      </Panel>
      <Panel id="huddles-settings" hidden={section !== "huddles-settings"} aria-labelledby="huddles-settings-heading" className="flex flex-col gap-6">
        <PageHeading id="huddles-settings-heading" title="Huddles" className={SECTION_HEADING}>
          {HUDDLE_CHAT_TITLE} in your rooms.
        </PageHeading>
        {settings &&
          (settings.canAdminister ? (
            <>
              <HuddlesSettings huddles={settings.huddles} onSetUp={() => setSettingUpHuddles(true)} onStopped={() => showHuddles(null)} onFailed={onFailed} />
              {settingUpHuddles && (
                <HuddlesSetup
                  huddles={settings.huddles}
                  deployedAccountId={settings.cloudflareAccountId}
                  onSaved={showHuddles}
                  onClose={() => setSettingUpHuddles(false)}
                  onFailed={onFailed}
                />
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Community admins manage huddles.</p>
          ))}
      </Panel>
    </SettingsPage>
  );
}
