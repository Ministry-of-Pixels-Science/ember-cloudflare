import { useContext, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AVATAR_TOO_LARGE,
  MAX_AVATAR_SIZE,
  MAX_BIO_LENGTH,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USER_NAME_LENGTH,
  MEMBERFUL_DISCONNECTED_NOTICE,
  MIN_PASSWORD_LENGTH,
  type Me,
  type MemberfulStatus,
  type Profile,
  type ProfileAnswer,
  type ProfileChanges,
  type SidebarRoom,
} from "@ember/protocol";
import { AUTH_FORM } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { useFlash } from "@/components/flash";
import { LogOut } from "@/components/icons/iconoir";
import { Input } from "@/components/ui/input";
import { PeopleContext } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { usePush } from "@/hooks/use-push";
import { leave, useBackPath } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { changeAvatar, changeProfile, fetchProfile, isSignedOut, removeAvatar } from "@/lib/api";
import { avatarVariantOf } from "@/lib/previews";
import { pushEndpoint } from "@/lib/push";
import type { RoomAnswer } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { AnswerLevels } from "./answer-levels";
import { ConversationNotifications } from "./conversation-notifications";
import { MemberfulConnection } from "./memberful-connection";
import { InstallInstructions } from "./notification-help";
import { HEADER_TEXT_BUTTON } from "./page-header";
import { PicturePicker } from "./picture-picker";
import { PageHeading, Panel, SettingsPage } from "./settings-page";
import { SignInLink } from "./sign-in-link";
import { avatarUrlOf, avatarVersionOf } from "./user-avatar";
import { YourApps } from "./your-apps";
import { YourOutsideAi } from "./your-outside-ai";

interface Props {
  me: Me;
  /** Your rooms and DMs, as the sidebar's list has them, or null until it has loaded. */
  rooms: SidebarRoom[] | null;
  /** Called as a bell saves your level in a room, with what gives the room the level the server answers. */
  askForRoom: () => (answer: RoomAnswer) => void;
  /** Signs out, settling with whether it did. */
  onSignOut: () => Promise<boolean>;
  /** Says why loading or saving failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

const FIELDS = ["name", "emailAddress", "bio"] as const;

/** What the profile says once it has saved a new avatar. */
export const AVATAR_CHANGED = "It may take up to 30 minutes to change everywhere.";

/** Your avatar as the page shows it: its address, and whether you've uploaded one, which Remove avatar takes away. */
type Picture = Pick<Profile, "avatarUrl" | "avatar">;

/** The form's fields as typed, but for the passwords, which only their fields hold. */
type Fields = Record<(typeof FIELDS)[number], string>;

/** A profile in the form. */
const fieldsOf = ({ name, emailAddress, bio }: Profile): Fields => ({ name, emailAddress: emailAddress ?? "", bio: bio ?? "" });

/**
 * The fields `typed` differently from `saved`, the profile as the page last loaded or saved it, and
 * `password` and `currentPassword` if they're typed. Only they're sent, so a save doesn't put back what
 * another tab has saved since.
 */
function changesOf(saved: Fields, typed: Fields, password: string, currentPassword: string): ProfileChanges {
  const changes: ProfileChanges = password ? { password } : {};
  if (currentPassword) changes.currentPassword = currentPassword;
  for (const field of FIELDS) if (typed[field] !== saved[field]) changes[field] = typed[field];
  return changes;
}

/**
 * `changes` with this browser's push subscription named, if it has one and they hold a new password,
 * which forgets the rest of your browsers' subscriptions.
 */
async function keepingThisBrowsersPush(changes: ProfileChanges): Promise<ProfileChanges> {
  const endpoint = changes.password ? await pushEndpoint() : null;
  return endpoint ? { ...changes, pushSubscriptionEndpoint: endpoint } : changes;
}

/**
 * The form once `sent` is saved as `saved`: each field still as it was sent shows what's saved, which
 * may hold another tab's change. Whatever was typed meanwhile stays.
 */
function settled(typed: Fields, sent: Fields, saved: Fields): Fields {
  const fields = { ...typed };
  for (const field of FIELDS) if (typed[field] === sent[field]) fields[field] = saved[field];
  return fields;
}

/**
 * Your profile: how to install Ember, for the browsers that get steps, then your avatar, which a photo
 * picked saves at once, showing it meanwhile, with the notice "It may take up to 30 minutes to change
 * everywhere.", and Remove avatar takes away, then your name, email address, a new password, unless
 * Memberful signs you in without one, your current password while you have one, which changing your
 * email address or password takes, and your
 * bio, which Save changes saves with the notice "✓", keeping the page, then, while members sign in with
 * Memberful, connecting your Memberful account, or the one you've connected, which Disconnect Memberful
 * unlinks with the notice "Your Memberful account is disconnected.", then, while Ember AI is on, how much @ember thinks and
 * how long it answers you, then your notification level in each of your rooms and DMs, then a sign-in
 * link for you, a new one each time the page loads or saves, and Log out in the top bar. Go Back
 * returns to the page it was opened from. Your avatar, name and bio reach everyone's open pages at
 * once, through the workspace socket, as they reach the rail.
 */
export function ProfilePage({ me, rooms, askForRoom, onSignOut, onFailed }: Props) {
  const [fields, setFields] = useState<Fields | null>(null);
  /** The profile as the page last loaded or saved it. */
  const saved = useRef<Fields | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  /** The address of the photo picked, shown while it saves. */
  const [picked, setPicked] = useState<string | null>(null);
  const [savingPicture, setSavingPicture] = useState(false);
  const [transferId, setTransferId] = useState<string | null>(null);
  /** Whether you have a password, which the form then asks for to change your email address or password. */
  const [hasPassword, setHasPassword] = useState(false);
  /**
   * Whether you have an email address saved, which signing in with your password takes, so disconnecting
   * Memberful needs it: from loading and saving the profile alone, which change it, so a photo's answer
   * arriving late doesn't take it away.
   */
  const [hasEmailAddress, setHasEmailAddress] = useState(false);
  /** The Memberful account you've connected, or none to connect yet, or null while there's nothing to show. */
  const [memberful, setMemberful] = useState<MemberfulStatus | null>(null);
  /** Whether you need Memberful to sign in while it's members only, unlike administrators and the people they invite. */
  const [membershipNeeded, setMembershipNeeded] = useState(true);
  /** Which model @ember answers you with, how much it thinks and how long its answers are, or null while Ember AI is off. */
  const [assistant, setAssistant] = useState<Profile["assistant"]>(null);
  /** The connected apps you can sign in to yourself, each with your sign-in to it, if you've made one. */
  const [apps, setApps] = useState<Profile["apps"]>([]);
  const [outsideAi, setOutsideAi] = useState<Profile["outsideAi"]>(null);
  const [saving, setSaving] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const currentPasswordInput = useRef<HTMLInputElement>(null);
  /** Whether you've disconnected your Memberful account here, since when no answer shows it connected: connecting one reloads the page. */
  const disconnectedMemberful = useRef(false);
  const people = useContext(PeopleContext);
  const back = useBackPath();
  const flash = useFlash();
  const mounted = useMounted();
  const { platform } = usePush();
  useTitle(me.name);

  useEffect(() => {
    let stopped = false;
    fetchProfile().then(
      (answer) => {
        if (stopped) return;
        saved.current = fieldsOf(answer.profile);
        setFields(saved.current);
        setHasEmailAddress(answer.profile.emailAddress !== null);
        showAnswer(answer);
        // Only from here and the Ember AI section's own saves, as a save of the profile or a photo can
        // answer after a change there, with your model and levels from before it.
        setAssistant(answer.profile.assistant);
        // The same goes for the Apps section, which signing out there changes.
        setApps(answer.profile.apps);
        setOutsideAi(answer.profile.outsideAi);
      },
      (error: unknown) => {
        // A page left before its profile loads only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [onFailed]);

  // The picked photo's address is let go of once the saved one takes its place.
  useEffect(() => () => void (picked && URL.revokeObjectURL(picked)), [picked]);

  /**
   * Shows your avatar, whether you have a password, where you stand with Memberful and whether you need
   * it, and a new sign-in link, as an answer has them. An answer can arrive after a later one, as a
   * profile's save can after a photo's, and the later avatar stays then.
   */
  function showAnswer({ profile, transferId }: ProfileAnswer) {
    const answered = { avatarUrl: profile.avatarUrl, avatar: profile.avatar };
    setPicture((shown) => (shown && avatarVersionOf(shown.avatarUrl) > avatarVersionOf(answered.avatarUrl) ? shown : answered));
    // Nothing takes a password away, so an answer arriving late doesn't hide the field.
    setHasPassword((had) => had || profile.password);
    // Nothing connects a Memberful account without a reload, so once it's disconnected here, an answer
    // arriving late doesn't show it connected again, and shows what the Worker does for one disconnected.
    const { memberful } = profile;
    setMemberful(disconnectedMemberful.current && memberful?.connected ? (memberful.membersOnly ? { membersOnly: true, connected: null } : null) : memberful);
    setMembershipNeeded(profile.membershipNeeded);
    setTransferId(transferId);
  }

  /** Shows your profile as disconnecting your Memberful account answered it, with the notice. */
  function disconnected(answer: ProfileAnswer) {
    disconnectedMemberful.current = true;
    showAnswer(answer);
    flash("notice", MEMBERFUL_DISCONNECTED_NOTICE);
  }

  /** Saves `file` as your avatar, once a photo is picked. */
  const saveAvatar = (file: File) => {
    if (file.size > MAX_AVATAR_SIZE) return flash("alert", AVATAR_TOO_LARGE);
    setPicked(URL.createObjectURL(file));
    savePicture(avatarVariantOf(file).then((variant) => changeAvatar({ file, variant })), AVATAR_CHANGED);
  };

  /** Shows your avatar as `change` saves it, flashing `notice` once it has. */
  function savePicture(change: Promise<ProfileAnswer>, notice?: string) {
    setSavingPicture(true);
    change.then(
      (answer) => {
        if (!mounted.current) return;
        setSavingPicture(false);
        setPicked(null);
        showAnswer(answer);
        if (notice) flash("notice", notice);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSavingPicture(false);
        setPicked(null);
        onFailed(error);
      },
    );
  }

  const change = (field: keyof Fields) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((fields) => fields && { ...fields, [field]: event.target.value });

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!fields || !saved.current || saving) return;
    setSaving(true);
    const sent = fields;
    const password = passwordInput.current?.value ?? "";
    const currentPassword = currentPasswordInput.current?.value ?? "";
    keepingThisBrowsersPush(changesOf(saved.current, sent, password, currentPassword)).then(changeProfile).then(
      (answer) => {
        if (!mounted.current) return;
        setSaving(false);
        const now = fieldsOf(answer.profile);
        saved.current = now;
        setFields((fields) => fields && settled(fields, sent, now));
        setHasEmailAddress(answer.profile.emailAddress !== null);
        // The passwords leave their fields, unless others were typed meanwhile.
        if (passwordInput.current?.value === password) passwordInput.current.value = "";
        if (currentPasswordInput.current?.value === currentPassword) currentPasswordInput.current.value = "";
        showAnswer(answer);
        flash("notice", "✓");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };

  // Another tab's change reaches the people directory, whose address is the later one then.
  const listed = avatarUrlOf(people, me);
  const avatarUrl = picture && avatarVersionOf(picture.avatarUrl) >= avatarVersionOf(listed) ? picture.avatarUrl : listed;
  // Someone Memberful signs in who has no password is given none, as the Worker refuses one: Memberful is their way in.
  const signsInWithMemberfulAlone = !hasPassword && Boolean(memberful?.connected);

  const logOut = (
    <button type="button" onClick={() => leave(onSignOut)} className={HEADER_TEXT_BUTTON}>
      <LogOut className="h-5 w-[1.3em]" />
      <span>Log out</span>
    </button>
  );

  return (
    <SettingsPage back={back} links={logOut}>
      <Panel aria-busy={fields === null} className="flex flex-col gap-x-[1ch] gap-y-4">
        <PageHeading title="Your profile">Manage how you appear to the people in your workspace.</PageHeading>
        <InstallInstructions platform={platform} />
        <PicturePicker
          id="user_avatar"
          src={picked ?? avatarUrl}
          alt="Your avatar"
          label="Upload avatar"
          description="Choose a profile photo"
          onChoose={saveAvatar}
          disabled={!picture || savingPicture}
          remove={picture?.avatar ? { label: "Remove avatar", onRemove: () => savePicture(removeAvatar()) } : null}
        />
        <form onSubmit={save} className={AUTH_FORM}>
          {/* Nothing is focused as the page opens. */}
          <Field id="user_name" label="Name" translation="user_name">
            <Input
              id="user_name"
              autoComplete="name"
              placeholder="Enter your name"
              maxLength={MAX_USER_NAME_LENGTH}
              required
              data-1p-ignore
              disabled={!fields}
              value={fields?.name ?? ""}
              onChange={change("name")}
              className={FIELD_INPUT}
            />
          </Field>
          <Field id="user_email_address" label="Email address" translation="email_address">
            <Input
              id="user_email_address"
              type="email"
              autoComplete="username"
              placeholder="Enter your email address"
              maxLength={MAX_EMAIL_ADDRESS_LENGTH}
              disabled={!fields}
              value={fields?.emailAddress ?? ""}
              onChange={change("emailAddress")}
              className={FIELD_INPUT}
            />
          </Field>
          {!signsInWithMemberfulAlone && (
            <Field id="user_password" label="New password" translation="update_password">
              {/* Uncontrolled, so what's typed never reaches its `value` attribute, where custom CSS could read it. */}
              <Input
                ref={passwordInput}
                id="user_password"
                type="password"
                autoComplete="new-password"
                placeholder="Change password"
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={MAX_PASSWORD_LENGTH}
                aria-describedby="profile-password-help"
                disabled={!fields}
                className={FIELD_INPUT}
              />
              <p id="profile-password-help" className="text-[0.8em] text-muted-foreground">
                {/* Someone who signed in with just a name has no password, nor has someone who joined with Memberful once it no longer signs them in. */}
                {fields && !hasPassword ? "Leave blank to keep signing in without a password." : "Leave blank to keep your current password."}
                {/* As the one it replaces connected it, while it's saved with an email address to sign in by. */}
                {fields && hasPassword && memberful?.connected && fields.emailAddress.trim() !== "" && " A new one disconnects your Memberful account."}
              </p>
            </Field>
          )}
          {hasPassword && (
            <Field id="user_current_password" label="Current password" translation="password">
              {/* Uncontrolled too, and asked for as sign-in asks for it. */}
              <Input
                ref={currentPasswordInput}
                id="user_current_password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                maxLength={MAX_PASSWORD_LENGTH}
                aria-describedby="profile-current-password-help"
                disabled={!fields}
                className={FIELD_INPUT}
              />
              <p id="profile-current-password-help" className="text-[0.8em] text-muted-foreground">
                Needed to change your email address or password.
              </p>
            </Field>
          )}
          <Field id="user_bio" label="Bio" translation="bio">
            {/* Campfire's `.input` as a textarea: three rows, which you can make taller. */}
            <textarea
              id="user_bio"
              rows={3}
              placeholder="A few words about yourself…"
              maxLength={MAX_BIO_LENGTH}
              disabled={!fields}
              value={fields?.bio ?? ""}
              onChange={change("bio")}
              className={cn("w-full border placeholder:text-muted-foreground disabled:opacity-50", FIELD_INPUT, "resize-y")}
            />
          </Field>
          <SubmitButton disabled={!fields || saving}>Save changes</SubmitButton>
        </form>
        {memberful && (
          <MemberfulConnection
            connected={memberful.connected}
            membersOnly={memberful.membersOnly}
            hasPassword={hasPassword}
            hasEmailAddress={hasEmailAddress}
            membershipNeeded={membershipNeeded}
            onDisconnected={disconnected}
            onFailed={onFailed}
          />
        )}
        {assistant && <AnswerLevels assistant={assistant} onChanged={setAssistant} onFailed={onFailed} />}
        {apps.length > 0 && <YourApps apps={apps} onChanged={setApps} onFailed={onFailed} />}
        {outsideAi && <YourOutsideAi connections={outsideAi} onChanged={setOutsideAi} onFailed={onFailed} />}
        {rooms && <ConversationNotifications me={me} rooms={rooms} askForRoom={askForRoom} onFailed={onFailed} />}
        {transferId && <SignInLink transferId={transferId} mine />}
      </Panel>
    </SettingsPage>
  );
}
