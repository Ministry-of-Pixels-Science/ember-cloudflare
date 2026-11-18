import { useEffect, useRef, useState, type ComponentType, type ReactNode, type Ref } from "react";
import {
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USER_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_TOO_SHORT,
  type NewWorkspace,
  type SetupAccess,
  type SetupPlaceholders,
} from "@ember/protocol";
import avatarPlaceholder from "@/components/avatar-placeholder.svg";
import { ArrowRight, Camera, Eye, Lock, Mail, User as UserIcon, type IconoirIconProps } from "@/components/icons/iconoir";
import { SETUP_TITLE, SetupCard, STEP_BUTTON } from "@/components/setup-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChosenPhoto, type PhotoChoice } from "@/hooks/use-chosen-photo";
import { navigate } from "@/hooks/use-route";
import { ApiError, checkSetupPassword, setUpWorkspace } from "@/lib/api";
import { whenIdle } from "@/lib/idle";
import { cn } from "@/lib/utils";
import { loadPage } from "@/lib/page";

// The Set up Ember page. Entering its fields doesn't select what's in them, since it isn't one of the
// app's pages, which do (`useSelectOnEntry`). Its name and email address placeholders come from
// /api/bootstrap: Kevin Rose's, unless the deployment suggests its own.
//
// A deployed Worker takes its setup password, which Deploy to Cloudflare's form had its deployer make
// up: the page asks for it first, has the Worker check it, and sends it with the form as a bearer token.
// One deployed from a terminal takes the setup link its deploy printed, `/first_run#token=<its setup
// token>`, instead: the token rides in the fragment, which no request or log sees, and goes with the form
// the same way, so the link opens the form without asking for a password. Where the Worker takes a
// password too, the Worker checks the link's token first, so a link that's out of date asks for the
// password instead. Opened without the link, or where the Worker has neither to match (`setupAccess`
// from /api/bootstrap), the page says what to do in the form's place, rather than showing a form that
// would be refused.
//
// Once the form has made the workspace, the page asks whether to turn huddles on (setup-huddles.tsx),
// and opens Ember from there.

/** What the setup password step says where the setup link it was opened with is refused. */
const STALE_LINK = "That setup link is out of date. Type this Ember's setup password instead.";
/** The token in a setup link's fragment. */
const setupTokenOf = (hash: string) => new URLSearchParams(hash.slice(1)).get("token") || null;
/** The Worker's setup password, as its settings in the Cloudflare dashboard name it. */
const SETUP_PASSWORD = "EMBER_SETUP_PASSWORD";
/** Where the dashboard keeps it. */
const WHERE_SECRETS_ARE = "in the Cloudflare dashboard, in this Worker's Settings under Variables and Secrets";
/** basecoat's `.ui-field .input`, over the stock input, and 44px tall for fingers as the app's fields are. */
const INPUT = "h-10 touch:h-11 rounded-[0.7rem] bg-card pr-3 pl-9 text-base shadow-none md:text-base dark:bg-card focus-visible:border-input focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring";
const FIELD_ICON = "pointer-events-none absolute top-1/2 left-3 z-[1] size-[1.125rem] -translate-y-1/2 text-muted-foreground";

/** The question about huddles, which loads with the pages few visits need, apart from the rest of the app. */
const loadSetupHuddles = () => import("@/components/workspace/pages").then((pages) => pages.SetupHuddles);
type SetupHuddles = Awaited<ReturnType<typeof loadSetupHuddles>>;

interface Props {
  placeholders: SetupPlaceholders;
  access: SetupAccess;
  onSetUp: (workspace: NewWorkspace) => void;
}

/**
 * Creates the workspace and its first administrator, with the photo they choose, given the setup
 * password or link where the deployment takes one (`access`), asks whether to turn huddles on, and then
 * opens general, its first room.
 */
export function SetupPage({ placeholders, access, onSetUp }: Props) {
  // Pasting the setup link over this page's address only changes the fragment, which loads no new
  // page, so each link opened starts afresh here, as the sign-in link page's does.
  const [opened, setOpened] = useState(0);
  /** The workspace, once the form has made it, and what asks about huddles before it opens. */
  const [made, setMade] = useState<{ workspace: NewWorkspace; SetupHuddles: SetupHuddles } | null>(null);
  useEffect(() => {
    const open = () => setOpened((count) => count + 1);
    addEventListener("hashchange", open);
    return () => removeEventListener("hashchange", open);
  }, []);
  useEffect(() => {
    const title = document.title;
    document.title = SETUP_TITLE;
    return () => void (document.title = title);
  }, []);

  const open = (workspace: NewWorkspace) => {
    navigate(`/rooms/${workspace.room.id}`, { replace: true });
    onSetUp(workspace);
  };
  // Where the question can't load, Ember opens without it, and huddles wait in community settings.
  const askAboutHuddles = (workspace: NewWorkspace) =>
    loadSetupHuddles().then(
      (SetupHuddles) => setMade({ workspace, SetupHuddles }),
      () => open(workspace),
    );

  if (made) return <made.SetupHuddles onOpen={() => open(made.workspace)} />;
  return <Setup key={opened} placeholders={placeholders} access={access} onSetUp={askAboutHuddles} />;
}

function Setup({ placeholders, access, onSetUp }: Props) {
  const [setupToken] = useState(() => setupTokenOf(location.hash));
  /** The setup password, or the setup link's token, the Worker has accepted, where it takes a password. */
  const [accepted, setAccepted] = useState<string | null>(null);

  // The token leaves the address bar and this tab's history as the page opens.
  useEffect(() => {
    if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
  }, []);

  if (access === "closed") return <SetupClosed />;
  if (access === "link" && setupToken === null) return <SetupLinkNeeded />;
  if (access === "password" && accepted === null) return <SetupPasswordStep linkToken={setupToken} onAccepted={setAccepted} />;
  return <SetupForm placeholders={placeholders} setupSecret={access === "password" ? accepted : setupToken} onSetUp={onSetUp} />;
}

/**
 * The page's first step where the deployment has a setup password: the Worker checks it before the
 * form opens, so a mistyped one is said to be wrong before anything else is filled in. The token of a
 * setup link it opens with, which a deploy may have printed too, is checked first the same way, so a
 * link that's out of date asks for the password rather than opening a form that would be refused.
 */
function SetupPasswordStep({ linkToken, onAccepted }: { linkToken: string | null; onAccepted: (secret: string) => void }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(linkToken !== null);
  const input = useRef<HTMLInputElement>(null);
  const linkChecked = useRef(false);

  /** Has the Worker check `secret`, the password typed or the token of the link the page opened `withLink`. */
  async function check(secret: string, withLink = false) {
    setBusy(true);
    setRefusal(null);
    setProblem(null);
    try {
      await checkSetupPassword(secret);
      onAccepted(secret);
    } catch (error) {
      setBusy(false);
      // A link that couldn't be checked opens the form all the same, which has it checked again when it's sent.
      if (withLink && !(error instanceof ApiError && error.status < 500)) return onAccepted(secret);
      if (!(error instanceof ApiError)) return setProblem("Couldn't reach Ember. Check your connection and try again.");
      // Someone else set it up first.
      if (error.status === 409) return loadPage("/");
      // Too many tries, say, which no other password would get past.
      if (error.status !== 403) return setProblem(error.message);
      // A refused one starts over, saying why beneath it.
      if (input.current) input.current.value = "";
      setRefusal(withLink ? STALE_LINK : error.message);
      input.current?.focus();
    }
  }

  // Once, though development's strict mode runs effects twice.
  useEffect(() => {
    if (linkToken === null || linkChecked.current) return;
    linkChecked.current = true;
    void check(linkToken, true);
  }, [linkToken]);

  return (
    <SetupCard problem={problem} subtitle="Ember is waiting for its administrator.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void check(input.current?.value ?? "");
        }}
      >
        <div className="grid gap-6 px-5 pt-6 pb-7">
          <SetupPasswordField ref={input} refusal={refusal} />
          <p className="text-sm leading-normal text-muted-foreground [overflow-wrap:anywhere]">
            Forgot it? Give <Code>{SETUP_PASSWORD}</Code> a new value {WHERE_SECRETS_ARE}, then type that one.
          </p>
        </div>
        <footer className="border-t bg-surface p-5">
          <Button type="submit" disabled={busy} className={cn(STEP_BUTTON, "w-full")}>
            Continue <ArrowRight className="size-[1.125rem]" />
          </Button>
        </footer>
      </form>
    </SetupCard>
  );
}

function SetupForm({ placeholders, setupSecret, onSetUp }: { placeholders: SetupPlaceholders; setupSecret: string | null; onSetUp: (workspace: NewWorkspace) => void }) {
  const [name, setName] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [passwordTooShort, setPasswordTooShort] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const photo = useChosenPhoto();
  // What asks about huddles next loads while the form is filled in, so that it's there once it's sent.
  useEffect(() => whenIdle(() => void loadSetupHuddles().catch(() => {})), []);

  async function submit() {
    setBusy(true);
    setPasswordTooShort(false);
    setProblem(null);
    try {
      // The form stays as it was sent until what comes next shows.
      onSetUp(await setUpWorkspace({ name, emailAddress, password: passwordInput.current?.value ?? "" }, await photo.photo(), setupSecret));
    } catch (error) {
      setBusy(false);
      if (!(error instanceof ApiError)) return setProblem("Couldn't reach Ember. Check your connection and try again.");
      // The name, email address and photo stay, and the password starts over.
      if (error.field === "password") {
        if (passwordInput.current) passwordInput.current.value = "";
        setPasswordTooShort(true);
        return passwordInput.current?.focus();
      }
      // A photo that's refused goes, so the form can be sent without it.
      if (error.field === "avatar") return photo.refuse(error.message);
      // Someone else set it up first.
      if (error.status === 409) return loadPage("/");
      // A setup password or link that isn't this deployment's is refused (403) with what to do, said here.
      setProblem(error.message);
    }
  }

  return (
    <SetupCard problem={problem} subtitle="Create the admin account for your workspace.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-7 px-5 pt-6 pb-7">
          <AvatarField photo={photo} disabled={busy} />
          <div className="grid gap-6">
            <Field id="user_name" label="Name" icon={UserIcon}>
              <Input
                id="user_name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={placeholders.name}
                maxLength={MAX_USER_NAME_LENGTH}
                autoComplete="name"
                autoFocus
                required
                data-1p-ignore
                className={INPUT}
              />
            </Field>
            <Field id="user_email_address" label="Email address" icon={Mail}>
              <Input
                id="user_email_address"
                type="email"
                value={emailAddress}
                onChange={(event) => setEmailAddress(event.target.value)}
                placeholder={placeholders.emailAddress}
                maxLength={MAX_EMAIL_ADDRESS_LENGTH}
                autoComplete="username"
                required
                className={INPUT}
              />
            </Field>
            <PasswordField ref={passwordInput} tooShort={passwordTooShort} />
          </div>
        </div>
        <footer className="border-t bg-surface p-5">
          <Button type="submit" disabled={busy} className={cn(STEP_BUTTON, "w-full")}>
            Continue <ArrowRight className="size-[1.125rem]" />
          </Button>
        </footer>
      </form>
    </SetupCard>
  );
}

/** The page without its form: what deploying Ember printed is the way in. */
function SetupLinkNeeded() {
  return (
    <SetupCard subtitle="Ember is waiting for its administrator.">
      <Notice>
        <p>
          Open the setup link that deploying Ember printed. It looks like <Code>{`${location.origin}/first_run#token=…`}</Code> and carries this deployment's
          setup token, so only whoever deployed it can set it up.
        </p>
        <p>
          The link is in the output of <Code>pnpm run deploy</Code>, or in the build's log in the Cloudflare dashboard after Deploy to Cloudflare. If it's lost, give
          the Worker a setup password instead: set <Code>{SETUP_PASSWORD}</Code> {WHERE_SECRETS_ARE}, then reload this page.
        </p>
      </Notice>
    </SetupCard>
  );
}

/** The page without its form: the Worker has neither a setup password nor a setup token. */
function SetupClosed() {
  return (
    <SetupCard subtitle="Nobody can set it up yet.">
      <Notice>
        <p>This deployment has no setup password, so nobody can set it up.</p>
        <p>
          Give it one: set <Code>{SETUP_PASSWORD}</Code> {WHERE_SECRETS_ARE}, then reload this page.
        </p>
      </Notice>
    </SetupCard>
  );
}

/** What to do, in the form's place, as the card's body. */
function Notice({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 px-5 pt-6 pb-7 text-base leading-normal upto-380px:text-sm [overflow-wrap:anywhere]">{children}</div>;
}

/** A command or an address to copy, in the card's text. */
function Code({ children }: { children: string }) {
  return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground">{children}</code>;
}

/**
 * The photo to start with, which shows as it's chosen, in a 96px circle with a camera on its corner, and
 * says why one is refused in place of its description. It can't change while the form is sent with it.
 */
function AvatarField({ photo, disabled }: { photo: PhotoChoice; disabled: boolean }) {
  return (
    <div className="grid min-w-0 justify-items-center gap-3.5">
      <label
        htmlFor="user_avatar"
        className="group relative block size-24 cursor-pointer rounded-full has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-4 has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-ring"
      >
        <span className="sr-only">Upload profile image (optional)</span>
        <img src={photo.preview ?? avatarPlaceholder} alt="Avatar preview" width={96} height={96} className="size-full rounded-full border bg-muted object-cover" />
        <span className="absolute -right-[0.2rem] -bottom-[0.2rem] grid size-[2.375rem] place-items-center rounded-full border bg-card text-foreground shadow-[0_1px_3px_#0002] group-hover:bg-muted">
          <Camera className="size-[1.125rem]" />
        </span>
        <input
          ref={photo.input}
          id="user_avatar"
          type="file"
          accept="image/*"
          aria-invalid={photo.refusal ? true : undefined}
          aria-describedby="avatar-description"
          disabled={disabled}
          onChange={photo.choose}
          className="absolute inset-0 size-full cursor-pointer rounded-[inherit] opacity-0 disabled:cursor-default"
        />
      </label>
      {photo.refusal ? (
        <p id="avatar-description" role="alert" className="text-sm leading-normal text-destructive">
          {photo.refusal}
        </p>
      ) : (
        <p id="avatar-description" className="text-sm leading-normal text-muted-foreground">
          Add a profile photo (optional).
        </p>
      )}
    </div>
  );
}

function Field({ id, label, icon: Icon, children }: { id: string; label: string; icon: ComponentType<IconoirIconProps>; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor={id} className="text-base leading-normal font-medium">
        {label}
      </label>
      <div className="relative min-w-0">
        <Icon className={FIELD_ICON} />
        {children}
      </div>
    </div>
  );
}

/** The setup password's field, with its show and hide toggle, saying why one was refused in place of its description. */
function SetupPasswordField({ ref, refusal }: { ref: Ref<HTMLInputElement>; refusal: string | null }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor="setup_password" className="text-base leading-normal font-medium">
        Setup password
      </label>
      <div className="relative min-w-0">
        <Lock className={FIELD_ICON} />
        {/* Uncontrolled, as the account's password is, and kept from password managers, which have nothing to fill in. */}
        <Input
          ref={ref}
          id="setup_password"
          type={visible ? "text" : "password"}
          placeholder="••••••••"
          autoComplete="off"
          autoFocus
          required
          aria-invalid={refusal ? true : undefined}
          aria-describedby="setup-password-description"
          data-1p-ignore
          className={cn(INPUT, "pr-11 touch:pr-12")}
        />
        <PasswordToggle controls="setup_password" visible={visible} onToggle={() => setVisible(!visible)} />
      </div>
      {refusal ? (
        <p id="setup-password-description" role="alert" className="text-sm leading-normal text-destructive">
          {refusal}
        </p>
      ) : (
        <p id="setup-password-description" className="text-sm leading-normal text-muted-foreground">
          The one you gave Ember when you deployed it.
        </p>
      )}
    </div>
  );
}

/** The password field, with its show and hide toggle. */
function PasswordField({ ref, tooShort }: { ref: Ref<HTMLInputElement>; tooShort: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor="user_password" className="text-base leading-normal font-medium">
        Password
      </label>
      <div className="relative min-w-0">
        <Lock className={FIELD_ICON} />
        {/* Uncontrolled, so what's typed never reaches its `value` attribute, where custom CSS could read it. */}
        <Input
          ref={ref}
          id="user_password"
          type={visible ? "text" : "password"}
          placeholder="••••••••"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          aria-invalid={tooShort || undefined}
          aria-describedby="password-description"
          className={cn(INPUT, "pr-11 touch:pr-12")}
        />
        <PasswordToggle controls="user_password" visible={visible} onToggle={() => setVisible(!visible)} />
      </div>
      {tooShort ? (
        <p id="password-description" role="alert" className="text-sm leading-normal text-destructive">
          {PASSWORD_TOO_SHORT}
        </p>
      ) : (
        <p id="password-description" className="text-sm leading-normal text-muted-foreground">
          Must be at least 8 characters.
        </p>
      )}
    </div>
  );
}

/** A password field's show and hide toggle, over the field's right end. */
function PasswordToggle({ controls, visible, onToggle }: { controls: string; visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-controls={controls}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      onClick={onToggle}
      className="absolute top-1/2 right-[0.2rem] grid size-9 -translate-y-1/2 touch:size-11 cursor-pointer place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-pressed:text-foreground"
    >
      <Eye className="size-[1.125rem]" />
    </button>
  );
}
