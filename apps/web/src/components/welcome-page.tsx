import { useEffect, useState } from "react";
import { MAX_USER_NAME_LENGTH, type Me, type Profile, type ProfileChanges } from "@ember/protocol";
import { AUTH_FORM, AuthCard, AuthHeading, AuthPage, Problem, type SignedOutWorkspace } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { PhotoField } from "@/components/photo-field";
import { Input } from "@/components/ui/input";
import { UsernameField } from "@/components/username-field";
import { useChosenPhoto } from "@/hooks/use-chosen-photo";
import { useMounted } from "@/hooks/use-mounted";
import { useTitle } from "@/hooks/use-title";
import { ApiError, changeAvatar, changeProfile, fetchProfile, isSignedOut } from "@/lib/api";
import { loadPage } from "@/lib/page";
import { rememberThisPage } from "@/lib/return-path";

// The page someone new who joined with Memberful, or single sign-on, comes to before the page they
// signed in from: their picture, the name Memberful or the provider gave Ember, and a username made
// from it, each theirs to change.

const SIGN_IN_PATH = "/session/new";
const NO_CONNECTION = "Couldn't reach Ember. Check your connection and try again.";

interface Props {
  me: Me;
  workspace: SignedOutWorkspace;
  /** Goes on to the page they signed in from, as `me` with the name they chose. */
  onWelcomed: (me: Me) => void;
}

/** What Continue saves of the name and username typed: whatever differs from `profile`. */
function changesOf(profile: Profile, name: string, username: string): ProfileChanges {
  const changes: ProfileChanges = {};
  if (name !== profile.name) changes.name = name;
  if (username !== (profile.username ?? "")) changes.username = username;
  return changes;
}

/**
 * Welcomes someone new: the avatar they have, or the photo they choose, their name and their username,
 * as their profile has them, which Continue saves, the photo last, before going on. The name and
 * username stay as Continue sent them until it's done, so it goes on with what they show. What saved
 * stays saved when the rest is refused, so Continue sends only what's left the next time, and a photo
 * that's refused goes, saying why, so they can go on without it.
 */
export function WelcomePage({ me, workspace, onWelcomed }: Props) {
  /** Your profile as it loaded or Continue last saved it, or null until it has loaded. */
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const photo = useChosenPhoto();
  const mounted = useMounted();
  useTitle(`Welcome to ${workspace.account.name}`);

  useEffect(() => {
    let stopped = false;
    fetchProfile().then(
      ({ profile }) => {
        if (stopped) return;
        setProfile(profile);
        setName(profile.name);
        setUsername(profile.username ?? "");
      },
      (error: unknown) => !stopped && failed(error),
    );
    return () => void (stopped = true);
  }, []);

  /** Says why something failed, or goes to sign in once the session has ended, coming back here after. */
  function failed(error: unknown) {
    if (!isSignedOut(error)) return setProblem(error instanceof ApiError ? error.message : NO_CONNECTION);
    rememberThisPage();
    loadPage(SIGN_IN_PATH);
  }

  async function submit(loaded: Profile) {
    setBusy(true);
    setProblem(null);
    let saved = loaded;
    let savingPhoto = false;
    try {
      const changes = changesOf(saved, name, username);
      if (Object.keys(changes).length > 0) saved = (await changeProfile(changes)).profile;
      savingPhoto = true;
      const chosen = await photo.photo();
      if (chosen) saved = (await changeAvatar(chosen)).profile;
      onWelcomed({ ...me, name: saved.name });
    } catch (error) {
      if (!mounted.current) return;
      setProfile(saved);
      setBusy(false);
      if (savingPhoto && error instanceof ApiError && !isSignedOut(error)) return photo.refuse(error.message);
      failed(error);
    }
  }

  return (
    <AuthPage workspace={workspace}>
      {problem && <Problem>{problem}</Problem>}
      <AuthCard aria-busy={profile === null}>
        <AuthHeading title={`Welcome to ${workspace.account.name}`} logo={workspace.account.logo}>
          Choose how people here see you.
        </AuthHeading>
        <form
          className={AUTH_FORM}
          onSubmit={(event) => {
            event.preventDefault();
            if (profile && !busy) void submit(profile);
          }}
        >
          <PhotoField photo={photo} disabled={!profile || busy} current={profile?.avatarUrl} />
          <Field id="user_name" label="Name" translation="user_name">
            <Input
              id="user_name"
              required
              autoComplete="name"
              placeholder="Name"
              maxLength={MAX_USER_NAME_LENGTH}
              data-1p-ignore
              disabled={!profile}
              readOnly={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          <UsernameField value={username} onChange={setUsername} disabled={!profile} readOnly={busy} required />
          <SubmitButton disabled={!profile || busy}>Continue</SubmitButton>
        </form>
      </AuthCard>
    </AuthPage>
  );
}
