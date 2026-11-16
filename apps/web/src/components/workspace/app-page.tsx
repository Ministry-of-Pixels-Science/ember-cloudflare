import { Fragment, useCallback, useEffect, useLayoutEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { APP_SIGNED_IN_PATH, type Me } from "@ember/protocol";
import {
  APPS_FORBIDDEN,
  MAX_APP_CLIENT_ID_LENGTH,
  MAX_APP_CLIENT_SECRET_LENGTH,
  MAX_APP_NAME_LENGTH,
  MAX_APP_TOKEN_LENGTH,
  MAX_APP_TOOLS,
  MAX_APP_URL_LENGTH,
  type App,
  type AppChanges,
  type AppClient,
  type AppId,
  type AppRefused,
  type AppSignIn,
  type NewApp,
  type SetAsideTool,
} from "@ember/protocol/apps";
import { AUTH_FORM } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { useFlash } from "@/components/flash";
import { RefreshDouble } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { agentSettingsPath, appSettingsPath, navigate } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { ApiError, beginAppSignIn, beginNewAppSignIn, changeApp, connectApp, disconnectApp, fetchApp, fetchApps, isSignedOut, readAppTools } from "@/lib/api";
import { dateTimeLabel } from "@/lib/messages";
import { openPage } from "@/lib/page";
import { cn } from "@/lib/utils";
import { AGENTS_PATH, useAgentsOnly } from "./agent-list";
import { toolsOf } from "./app-list";
import { BUTTON } from "./email-settings";
import { DeleteButton, isMissing } from "./room-settings-page";
import { CHANGES_SAVED, PageHeading, Panel, SettingsPage } from "./settings-page";

// The pages for connecting an app and changing one, which share the app form. Connecting one goes on to
// its page, which lists the tools Ember read from its server, and can read them again. An app whose
// server asks for a sign-in is connected by signing in there: the form sends the browser to its
// authorization server, which sends it back to the page that finishes (app-signed-in-page.tsx). Where
// the service doesn't come to know Ember by itself, the form asks for the client ID an administrator
// got by registering Ember there.

/** What Remove app asks first, in the browser's own dialog. */
export const CONFIRM_REMOVE_APP = "Are you sure you want to remove this app? Ember forgets its token or sign-in, and the tools it read.";

/** What the form says while Ember asks an app's server for its tools, which can take a while. */
export const READING_TOOLS = "Reading its tools…";

/** What the form says while Ember finds where an app's server signs people in, before the browser goes there. */
export const FINDING_SIGN_IN = "Finding its sign-in…";

/** What each field is for. */
export const URL_EXPLAINED = "Where its MCP server is, which the app's documentation gives. It often ends in /mcp.";
export const TOKEN_EXPLAINED = "Optional. Ember sends it to the server with every request, keeps it encrypted, and never shows it again.";
export const TOKEN_KEPT = "It has a token. Leave this blank to keep it, or type another.";

/** What a signed-in app's page says of its server's address, and of the sign-in Ember keeps. */
export const ADDRESS_KEPT = "This app signs in to its server there, so its address stays as it is. To move it, remove it and connect it again.";
export const SIGN_IN_EXPLAINED = "Ember keeps the sign-in encrypted, and gets itself a new token from it as each one ends.";
export const SIGN_IN_HAS_ENDED = "Its sign-in has ended, so Ember doesn't ask its server, and no agent can use its tools. Sign in to it again.";
/** What a signed-in app's page says once its server has refused something as more than the sign-in allows, with the `scopes` it asked for, which signing in again asks for too. */
export const wantsMore = (scopes: string) => `Its server has asked for more than this sign-in allows (${scopes.split(" ").join(", ")}). Sign in again to allow it.`;

/** What's said once an app Ember was signed in to is removed: whether its service, at `url`, took the sign-in back, or it's left to take back there. */
export const removedNotice = (name: string, url: string, revoked: boolean) => {
  const host = URL.parse(url)?.host ?? "its service";
  return revoked ? `${name} is removed, and ${host} took back Ember's sign-in.` : `${name} is removed. Ember couldn't take back its sign-in at ${host}, so remove Ember's access there.`;
};

/** What the form says in place of offering a sign-in, while it has another address than the app's. */
export const SIGN_IN_STAYS = "Ember signs in to an app at the address it's connected at. To sign in at another, remove this app and connect it there.";

/** What the form says of what it asks for once a service doesn't come to know Ember by itself: the address to register Ember there with, the client ID that gets, and its secret. */
export const REDIRECT_EXPLAINED = "Register Ember with the service as an OAuth app, and give it this as the address it sends people back to, which it may call a redirect or callback URL.";
export const CLIENT_ID_EXPLAINED = "The client ID the service gave Ember when you registered it there.";
export const CLIENT_SECRET_EXPLAINED = "Optional: only if the service gave one with the client ID. Ember keeps it encrypted, and never shows it again.";
export const CLIENT_SECRET_KEPT = "Leave this blank to keep the secret Ember has, if the service gave one, or type another.";

/** Where a service sends an administrator's browser back to Ember, once they've signed in there. */
export const redirectAddress = () => `${location.origin}${APP_SIGNED_IN_PATH}`;

/** Who signed in to an app's server for Ember, and when. */
export const signedInBy = ({ by, at }: AppSignIn) => `Signed in ${by ? `by ${by.name}, ` : ""}${dateTimeLabel(new Date(at))}.`;

/** What the button that begins a sign-in to the server at `url` says: where it goes. */
export const signInTo = (url: string) => `Sign in to ${URL.parse(url.trim())?.host ?? "its server"}`;

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** A card of the page, as the workspace settings' cards are. */
const CARD = "flex min-w-0 flex-col gap-4 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3";

type AppField = NonNullable<AppRefused["field"]>;

/** The app form's fields as typed: its name, its server's address, a token to send it, whether to stop sending the one it has, and who Ember is to a service that asks, by its client ID and secret. */
interface Fields {
  name: string;
  url: string;
  token: string;
  noToken: boolean;
  clientId: string;
  clientSecret: string;
}

const NO_FIELDS: Fields = { name: "", url: "", token: "", noToken: false, clientId: "", clientSecret: "" };

/** The client ID `app` signed in with, as its field shows it: none is an empty field. */
const clientIdOf = (app: App) => app.signIn?.clientId ?? "";

/**
 * What the client's fields come to once `app` is read again, as `read`, with what's `typed` in them: an
 * ID left as the app had it follows the client another administrator signed in as since, and a secret
 * typed for the one it had doesn't go with another.
 */
function clientFollowing(typed: Fields, app: App, read: App): Partial<Fields> {
  if (typed.clientId.trim() !== clientIdOf(app)) return {};
  return { clientId: clientIdOf(read), ...(clientIdOf(read) !== clientIdOf(app) && { clientSecret: "" }) };
}

const fieldsOf = (app: App): Fields => ({ ...NO_FIELDS, name: app.name, url: app.url, clientId: clientIdOf(app) });

/**
 * Why what the form sends is refused, said on the field it's about, or else, with none, under its
 * button, and whether that's for want of a sign-in, which the form then offers, or of a client ID for
 * one, which it then asks for.
 */
interface Refusal {
  field: AppField | null;
  error: string;
  signIn: boolean;
  client: boolean;
}

const APP_FIELDS: readonly string[] = ["name", "url", "token", "clientId", "clientSecret"] satisfies AppField[];

/** What a 422 answer says is refused, on the field of the form it names, if it names one. */
const refusalOf = (error: unknown): Refusal | null =>
  error instanceof ApiError && error.status === 422
    ? { field: error.field !== undefined && APP_FIELDS.includes(error.field) ? (error.field as AppField) : null, error: error.message, signIn: error.signIn === true, client: error.client === true }
    : null;

/** Who the form says Ember is to the app's service: the client ID as typed, "" for none, with its secret, if one's typed. */
const clientOf = ({ clientId, clientSecret }: Fields): AppClient => ({ clientId: clientId.trim(), ...(clientSecret.trim() !== "" && { clientSecret }) });

/** The app the form asks Ember to connect. */
const newAppOf = ({ name, url, token }: Fields): NewApp => ({ name, url, ...(token.trim() !== "" && { token }) });

/**
 * The fields typed differently from `app` as it loaded. Only they're sent, so a save doesn't put back
 * what another administrator has saved since, and Ember reads the server's tools again only for another
 * address or token.
 */
export function changesOf(app: App, typed: Fields): AppChanges {
  const changes: AppChanges = {};
  if (typed.name.trim() !== app.name) changes.name = typed.name;
  if (typed.url.trim() !== app.url) changes.url = typed.url;
  if (typed.token.trim() !== "") changes.token = typed.token;
  else if (typed.noToken && app.hasToken) changes.token = "";
  return changes;
}

interface PageProps {
  me: Me;
  /** Says why something failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Connect an app, which only administrators may open while Ember AI is on: anyone else is sent away at once, as from the agents' pages. */
export function NewAppPage({ me, onFailed }: PageProps) {
  const [ready, setReady] = useState(false);
  const [fields, setFields] = useState(NO_FIELDS);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Whether the server's sign-in turned out to want a client ID, which the form asks for until the address changes.
  const [asksClient, setAsksClient] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const { forbidden, failed } = useAgentsOnly(onFailed);
  const flash = useFlash();
  const mounted = useMounted();
  useTitle("Connect an app");

  // Before the form paints, so anyone else never sees it.
  useLayoutEffect(() => {
    if (!me.administrator) forbidden(APPS_FORBIDDEN);
  }, [me.administrator, forbidden]);

  // Listing the apps says whether Ember AI is on, before anything is typed.
  useEffect(() => {
    if (!me.administrator) return;
    let stopped = false;
    fetchApps().then(
      () => !stopped && setReady(true),
      (error: unknown) => {
        if (!stopped || isSignedOut(error)) failed(error);
      },
    );
    return () => void (stopped = true);
  }, [me.administrator, failed]);

  /** Sends `request`, the form saying it's `working` meanwhile, then does `done` with what it answers, or says why it's refused or failed. */
  const send = <T,>(working: string, request: () => Promise<T>, done: (answer: T) => void) => {
    setWorking(working);
    setRefusal(null);
    request().then(
      (answer) => mounted.current && done(answer),
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setWorking(null);
        const refused = refusalOf(error);
        if (!refused) return failed(error);
        setRefusal(refused);
        if (refused.client) setAsksClient(true);
      },
    );
  };
  const connect = () =>
    send(READING_TOOLS, () => connectApp(newAppOf(fields)), (app) => {
      navigate(appSettingsPath(app.id));
      flash("notice", connectedNotice(app));
    });
  // The form is as it was for whoever comes back to it with the browser's Back.
  const signIn = () =>
    send(FINDING_SIGN_IN, () => beginNewAppSignIn({ name: fields.name, url: fields.url, ...(asksClient && clientOf(fields)) }), (authorizationUrl) => {
      setWorking(null);
      openPage(authorizationUrl);
    });

  return (
    <SettingsPage back={AGENTS_PATH}>
      <Panel aria-busy={!ready}>
        {ready && (
          <AppForm
            saved={null}
            fields={fields}
            onChange={(typed) => {
              // A client is one service's, so what's typed of it doesn't follow the form to another address.
              const moved = typed.url !== fields.url;
              if (moved) setAsksClient(false);
              setFields(moved ? { ...typed, clientId: "", clientSecret: "" } : typed);
              setRefusal(null);
            }}
            refusal={refusal}
            busy={working !== null}
            working={working}
            canSave
            onSave={connect}
            offersSignIn={refusal?.signIn === true}
            asksClient={asksClient}
            onSignIn={signIn}
          />
        )}
      </Panel>
    </SettingsPage>
  );
}

/** What a page says once `app` is connected. */
export const connectedNotice = (app: App) => `${app.name} is connected. Ember read ${toolsOf(app.tools.length)} from it.`;

/** What the page is doing, which its buttons wait for. */
type Busy = "saving" | "reading" | "signing-in" | "removing" | null;

/**
 * A connected app's page, which only administrators may open while Ember AI is on, as Connect an app: the
 * app form, then the tools Ember read from its server, with Read its tools again, and Remove app, which
 * asks first. An app that signs in to its server says who signed in in place of its token, with Sign in
 * again, which sends the browser to its authorization server. An id that isn't a connected app's gets
 * the 404 page.
 */
export function AppSettingsPage({ appId, me, onMissing, onFailed }: PageProps & { appId: AppId; onMissing: () => void }) {
  const [app, setApp] = useState<App | null>(null);
  const [fields, setFields] = useState(NO_FIELDS);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  // Whether reading the tools again was refused for want of a sign-in, which the form then offers.
  const [unreadOffersSignIn, setUnreadOffersSignIn] = useState(false);
  // Whether the server's sign-in turned out to want a client ID, which the form then asks for, as it does for an app that signed in with one.
  const [askedClient, setAskedClient] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const { forbidden, failed: agentsOnly } = useAgentsOnly(onFailed);
  const failed = useCallback((error: unknown) => (isMissing(error) ? onMissing() : agentsOnly(error)), [onMissing, agentsOnly]);
  const flash = useFlash();
  const mounted = useMounted();
  useTitle("Edit app");

  useLayoutEffect(() => {
    if (!me.administrator) forbidden(APPS_FORBIDDEN);
  }, [me.administrator, forbidden]);

  const show = useCallback((app: App) => {
    setApp(app);
    setFields(fieldsOf(app));
  }, []);

  useEffect(() => {
    if (!me.administrator) return;
    let stopped = false;
    fetchApp(appId).then(
      (app) => !stopped && show(app),
      (error: unknown) => {
        // A page left before its app loads only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) failed(error);
      },
    );
    return () => void (stopped = true);
  }, [me.administrator, appId, show, failed]);

  /** Sends `request`, which `doing` says the page is busy with, then does `done` with what it answers, or `refused` with what a 422 says, or else says why it failed. */
  const send = <T,>(doing: NonNullable<Busy>, request: () => Promise<T>, done: (answer: T) => void, refused: (refusal: Refusal) => void) => {
    setBusy(doing);
    setRefusal(null);
    setUnread(null);
    setUnreadOffersSignIn(false);
    request().then(
      (answer) => {
        if (!mounted.current) return;
        setBusy(null);
        done(answer);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setBusy(null);
        const why = refusalOf(error);
        if (why) refused(why);
        else failed(error);
      },
    );
  };

  const changes = app ? changesOf(app, fields) : {};
  const rereads = changes.url !== undefined || changes.token !== undefined;
  const save = () =>
    send(
      "saving",
      () => changeApp(appId, changes),
      (saved) => {
        show(saved);
        flash("notice", rereads ? `Changes saved. Ember read ${toolsOf(saved.tools.length)} from ${saved.name}.` : CHANGES_SAVED);
      },
      setRefusal,
    );
  const readAgain = () =>
    send(
      "reading",
      () => readAppTools(appId),
      // What's typed stays as it is, and a field left as the app had it follows what another administrator has saved since, or signed in as, so that the next save or sign-in doesn't put the old back. Sending no token is switched back off once the app keeps none, as the switch isn't shown then.
      (read) => {
        if (app) setFields((typed) => ({ ...typed, ...(typed.name.trim() === app.name && { name: read.name }), ...(typed.url.trim() === app.url && { url: read.url }), ...clientFollowing(typed, app, read), ...(!read.hasToken && { noToken: false }) }));
        setApp(read);
      },
      ({ error, signIn }) => {
        setUnread(error);
        setUnreadOffersSignIn(signIn);
      },
    );
  const asksClient = askedClient || (app?.signIn?.clientId ?? null) !== null;
  const signIn = () =>
    send("signing-in", () => beginAppSignIn(appId, asksClient ? clientOf(fields) : undefined), openPage, (refused) => {
      setRefusal(refused);
      if (refused.client) setAskedClient(true);
    });
  const remove = () => {
    if (!confirm(CONFIRM_REMOVE_APP)) return;
    send(
      "removing",
      () => disconnectApp(appId),
      ({ revoked }) => {
        navigate(AGENTS_PATH);
        if (app && revoked !== undefined) flash(revoked ? "notice" : "alert", removedNotice(app.name, app.url, revoked));
      },
      ({ error }) => setUnread(error),
    );
  };

  return (
    <SettingsPage back={AGENTS_PATH}>
      <Panel aria-busy={app === null}>
        {app && (
          <>
            <AppForm
              saved={app}
              fields={fields}
              onChange={(fields) => {
                setFields(fields);
                setRefusal(null);
              }}
              refusal={refusal}
              busy={busy !== null}
              working={busy === "saving" && rereads ? READING_TOOLS : busy === "signing-in" ? FINDING_SIGN_IN : null}
              canSave={Object.keys(changes).length > 0}
              onSave={save}
              offersSignIn={refusal?.signIn === true || unreadOffersSignIn}
              asksClient={asksClient}
              onSignIn={signIn}
            />
            <hr className="my-8 w-full" />
            <Tools app={app} busy={busy} unread={unread} onReadAgain={readAgain} />
            <hr className="my-8 w-full" />
            <DeleteButton label={`Remove ${app.name}`} text="Remove app" disabled={busy !== null} onClick={remove} />
          </>
        )}
      </Panel>
    </SettingsPage>
  );
}

interface FormProps {
  /** The app as it's connected, or null for one not yet. */
  saved: App | null;
  fields: Fields;
  onChange: (fields: Fields) => void;
  refusal: Refusal | null;
  /** Whether the form or one of the page's buttons is on its way to the server, which the form's button waits for, its fields kept as they were sent: what it answers would replace anything typed since. */
  busy: boolean;
  /** What Ember is doing that can take a while, as the form says it: reading the app's tools, or finding its sign-in. */
  working: string | null;
  /** Whether there's anything to send. */
  canSave: boolean;
  onSave: () => void;
  /** Whether the app's server asked for a sign-in, or took no token it was given, which the form then offers to begin. */
  offersSignIn: boolean;
  /** Whether the form asks who Ember is to the app's service: once its sign-in wants a client ID Ember can't get itself, and for an app that signed in with one. */
  asksClient: boolean;
  /** Begins a sign-in to the app's server, which the form offers once the server asks for one, and a signed-in app's page always. */
  onSignIn: () => void;
}

/**
 * The app form: the app's name, its server's address and the token Ember sends it, each with what it's
 * for under it, or why it was refused, and Connect, or Save changes, which says so while Ember reads the
 * server's tools. A server that asks for a sign-in has the form offer one under the token, and an app
 * that's signed in to has its sign-in in the token's place, its address kept. A sign-in that wants a
 * client ID has the form ask for one, with its secret, before the button that begins it.
 */
function AppForm({ saved, fields, onChange, refusal, busy, working, canSave, onSave, offersSignIn, asksClient, onSignIn }: FormProps) {
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && canSave) onSave();
  };
  const refused = (field: AppField) => (refusal?.field === field ? true : undefined);
  const describedBy = (id: string, field: AppField) => (refusal?.field === field ? `${id}-refusal` : `${id}-description`);
  const signedIn = saved?.signIn ?? null;
  // A sign-in is to the address the app has, so it's offered, and its client asked for, only while the form has that one.
  const moved = saved !== null && fields.url.trim() !== saved.url;
  const client = asksClient && !moved && <Client kept={signedIn?.clientId ?? null} fields={fields} onChange={onChange} refusal={refusal} busy={busy} onSignIn={onSignIn} />;

  return (
    <form onSubmit={save} className={AUTH_FORM}>
      <PageHeading title={saved ? "Edit app" : "Connect an app"}>
        An app is another service's MCP server. Ember reads the tools it offers when you connect it, and again whenever you ask.
      </PageHeading>
      <Field id="app_name" label="Name">
        <Input
          id="app_name"
          readOnly={busy}
          placeholder="Name the app"
          maxLength={MAX_APP_NAME_LENGTH}
          autoComplete="off"
          autoFocus={saved === null}
          required
          data-1p-ignore
          aria-invalid={refused("name")}
          aria-describedby={refusal?.field === "name" ? "app_name-refusal" : undefined}
          value={fields.name}
          onChange={(event) => onChange({ ...fields, name: event.target.value })}
          className={FIELD_INPUT}
        />
        <Under id="app_name" field="name" refusal={refusal} />
      </Field>
      <Field id="app_url" label="Server address">
        <Input
          id="app_url"
          readOnly={busy || signedIn !== null}
          type="url"
          inputMode="url"
          placeholder="https://example.com/mcp"
          maxLength={MAX_APP_URL_LENGTH}
          autoComplete="off"
          required
          aria-invalid={refused("url")}
          aria-describedby={describedBy("app_url", "url")}
          value={fields.url}
          onChange={(event) => onChange({ ...fields, url: event.target.value })}
          className={FIELD_INPUT}
        />
        <Under id="app_url" field="url" refusal={refusal}>
          {signedIn ? ADDRESS_KEPT : URL_EXPLAINED}
        </Under>
      </Field>
      {signedIn ? (
        <SignedIn signIn={signedIn} refusal={refusal} busy={busy} onSignIn={onSignIn}>
          {client}
        </SignedIn>
      ) : (
        <>
          <Token saved={saved} fields={fields} onChange={onChange} refusal={refusal} busy={busy} offersSignIn={offersSignIn && !asksClient && !moved} onSignIn={onSignIn} />
          {offersSignIn && moved && <p className={NOTE}>{SIGN_IN_STAYS}</p>}
          {client}
          {asksClient && !moved && (
            <button type="button" disabled={busy} onClick={onSignIn} className={cn(BUTTON, "self-start")}>
              {signInTo(fields.url)}
            </button>
          )}
        </>
      )}
      <SubmitButton disabled={busy || !canSave}>{saved ? "Save changes" : "Connect"}</SubmitButton>
      <p role="status" className={cn(NOTE, "-mt-1 text-center wrap-anywhere empty:hidden", working === null && "text-negative")}>
        {working ?? (refusal?.field === null ? refusal.error : null)}
      </p>
    </form>
  );
}

/** The token's field: what it's for, or why it was refused, Send no token for an app that has one, and Sign in, once the server asks for a sign-in. */
function Token({ saved, fields, onChange, refusal, busy, offersSignIn, onSignIn }: Pick<FormProps, "saved" | "fields" | "onChange" | "refusal" | "busy" | "offersSignIn" | "onSignIn">) {
  const keepsToken = saved?.hasToken === true;
  return (
    <Field id="app_token" label="Token">
      <Input
        id="app_token"
        readOnly={busy}
        type="password"
        placeholder={keepsToken ? "Unchanged" : "None"}
        maxLength={MAX_APP_TOKEN_LENGTH}
        autoComplete="off"
        data-1p-ignore
        disabled={fields.noToken}
        aria-invalid={refusal?.field === "token" ? true : undefined}
        aria-describedby={refusal?.field === "token" ? "app_token-refusal" : "app_token-description"}
        value={fields.token}
        onChange={(event) => onChange({ ...fields, token: event.target.value })}
        className={FIELD_INPUT}
      />
      <Under id="app_token" field="token" refusal={refusal}>
        {keepsToken ? TOKEN_KEPT : TOKEN_EXPLAINED}
      </Under>
      {keepsToken && (
        <label className="flex min-h-9 cursor-pointer items-center gap-[1ch] text-[0.9em]">
          <input
            type="checkbox"
            checked={fields.noToken}
            disabled={busy}
            onChange={(event) => onChange({ ...fields, token: "", noToken: event.target.checked })}
            className="size-4 flex-none accent-foreground"
          />
          <span>Send no token</span>
        </label>
      )}
      {offersSignIn && (
        <button type="button" disabled={busy} onClick={onSignIn} className={cn(BUTTON, "self-start")}>
          {signInTo(fields.url)}
        </button>
      )}
    </Field>
  );
}

/**
 * Who Ember is to a service that doesn't come to know it by itself: the address to register Ember
 * there with, which is only to copy, then the client ID that gets, and its secret, each with what it's
 * for under it, or why it was refused. `kept` is the client ID the app signed in with, whose secret
 * stays while the ID does. Enter in either begins the sign-in, as they're what it's begun with.
 */
function Client({ kept, fields, onChange, refusal, busy, onSignIn }: Pick<FormProps, "fields" | "onChange" | "refusal" | "busy" | "onSignIn"> & { kept: string | null }) {
  const keepsSecret = kept !== null && fields.clientId.trim() === kept;
  const signInOnEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!busy) onSignIn();
  };
  return (
    <>
      <Field id="app_redirect" label="Redirect address">
        <Input id="app_redirect" readOnly aria-describedby="app_redirect-description" value={redirectAddress()} onFocus={(event) => event.target.select()} onKeyDown={signInOnEnter} className={FIELD_INPUT} />
        <p id="app_redirect-description" className={NOTE}>
          {REDIRECT_EXPLAINED}
        </p>
      </Field>
      <Field id="app_client_id" label="Client ID">
        <Input
          id="app_client_id"
          readOnly={busy}
          maxLength={MAX_APP_CLIENT_ID_LENGTH}
          autoComplete="off"
          data-1p-ignore
          aria-invalid={refusal?.field === "clientId" ? true : undefined}
          aria-describedby={refusal?.field === "clientId" ? "app_client_id-refusal" : "app_client_id-description"}
          value={fields.clientId}
          onChange={(event) => onChange({ ...fields, clientId: event.target.value })}
          onKeyDown={signInOnEnter}
          className={FIELD_INPUT}
        />
        <Under id="app_client_id" field="clientId" refusal={refusal}>
          {CLIENT_ID_EXPLAINED}
        </Under>
      </Field>
      <Field id="app_client_secret" label="Client secret">
        <Input
          id="app_client_secret"
          readOnly={busy}
          type="password"
          placeholder={keepsSecret ? "Unchanged" : "None"}
          maxLength={MAX_APP_CLIENT_SECRET_LENGTH}
          autoComplete="off"
          data-1p-ignore
          aria-invalid={refusal?.field === "clientSecret" ? true : undefined}
          aria-describedby={refusal?.field === "clientSecret" ? "app_client_secret-refusal" : "app_client_secret-description"}
          value={fields.clientSecret}
          onChange={(event) => onChange({ ...fields, clientSecret: event.target.value })}
          onKeyDown={signInOnEnter}
          className={FIELD_INPUT}
        />
        <Under id="app_client_secret" field="clientSecret" refusal={refusal}>
          {keepsSecret ? CLIENT_SECRET_KEPT : CLIENT_SECRET_EXPLAINED}
        </Under>
      </Field>
    </>
  );
}

/**
 * In the token's place for an app that signs in to its server: who signed in, and when, that the
 * sign-in has ended, if it has, or that its server asks for more than it allows, who Ember is to its service, if the form asks (`children`), and Sign in
 * again, with why that couldn't begin, if it couldn't.
 */
function SignedIn({ signIn, refusal, busy, onSignIn, children }: { signIn: AppSignIn; refusal: Refusal | null; busy: boolean; onSignIn: () => void; children?: ReactNode }) {
  return (
    <div role="group" aria-labelledby="app-sign-in-label" className="flex min-w-0 flex-col gap-[7px] text-start">
      <span id="app-sign-in-label" className="text-[13px] font-[550]">
        Sign-in
      </span>
      {signIn.ended && (
        <p role="alert" className={cn(NOTE, "text-negative")}>
          {SIGN_IN_HAS_ENDED}
        </p>
      )}
      {signIn.wantsScope !== null && (
        <p role="alert" className={cn(NOTE, "wrap-anywhere text-negative")}>
          {wantsMore(signIn.wantsScope)}
        </p>
      )}
      <p className={NOTE}>
        {signedInBy(signIn)} {SIGN_IN_EXPLAINED}
      </p>
      {children && <div className="flex min-w-0 flex-col gap-5 py-2">{children}</div>}
      <button type="button" disabled={busy} onClick={onSignIn} className={cn(BUTTON, "self-start")}>
        Sign in again
      </button>
      {refusal?.field === "token" && (
        <p role="alert" className={cn(NOTE, "wrap-anywhere text-negative")}>
          {refusal.error}
        </p>
      )}
    </div>
  );
}

/** Under a field: why it's refused, if it is, or else what's said of it, if anything is. */
function Under({ id, field, refusal, children }: { id: string; field: AppField; refusal: Refusal | null; children?: ReactNode }) {
  if (refusal?.field === field) {
    return (
      <p id={`${id}-refusal`} role="alert" className={cn(NOTE, "wrap-anywhere text-negative")}>
        {refusal.error}
      </p>
    );
  }
  if (children === undefined) return null;
  return (
    <p id={`${id}-description`} className={NOTE}>
      {children}
    </p>
  );
}

/** What the Tools card says of how many of an app's tools Ember keeps, when it has more. */
export const toolsLeftOut = (count: number) => `It has ${count} more that Ember leaves out: it keeps ${MAX_APP_TOOLS} at most, and none whose name or inputs it can't give a model.`;

/** What the Tools card says over the tools set aside for agents that had them. */
export const SET_ASIDE_EXPLAINED = "Set aside, as this app changed them after they were picked. No agent is given one until you pick it again on the agent's page, as it's described now:";

/** What the Tools card says of an app whose server has come to have no tools Ember can use. */
export const NO_TOOLS = "Its server has no tools Ember can use any more.";

/** What the Tools card says of a picked tool its app no longer has. */
export const TOOL_IS_GONE = "the app no longer has it";

/**
 * The tools of an app set aside for agents that had them: each by its name there, with the agents,
 * linked to their pages, where an administrator picks it again.
 */
function SetAside({ tools }: { tools: SetAsideTool[] }) {
  return (
    <div role="group" aria-labelledby="app-set-aside-heading" className="rounded-[10px] border border-negative px-[1.5ch] py-2.5">
      <p id="app-set-aside-heading" className={NOTE}>
        {SET_ASIDE_EXPLAINED}
      </p>
      <ul className="flex flex-col">
        {tools.map(({ name, gone, agents }) => (
          <li key={name} className="flex flex-wrap items-baseline gap-x-[1ch]">
            <code className="font-mono text-[0.9em] font-semibold wrap-anywhere">{name}</code>
            <span className={NOTE}>
              {gone ? `${TOOL_IS_GONE}, ` : ""}picked for{" "}
              {agents.map(({ id, name }, index) => (
                <Fragment key={id}>
                  {index > 0 && ", "}
                  <PageLink href={agentSettingsPath(id)} className="underline">
                    {name}
                  </PageLink>
                </Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The Tools card: what the app's server calls itself, when Ember last read its tools and who connected
 * it, Read its tools again, with why that failed, if it did, the tools set aside for agents that had
 * them, and each tool by its name there, with what it's called, if that's something else, and what
 * its server says it does, which is the server's word.
 */
function Tools({ app, busy, unread, onReadAgain }: { app: App; busy: Busy; unread: string | null; onReadAgain: () => void }) {
  const read = `Read ${dateTimeLabel(new Date(app.toolsReadAt))}`;
  const facts = [...(app.serverName ? [`Its server calls itself ${app.serverName}`] : []), read, ...(app.connectedBy ? [`Connected by ${app.connectedBy.name}`] : [])];
  return (
    <section aria-labelledby="app-tools-heading" aria-busy={busy === "reading"} className={CARD}>
      <div className="flex flex-wrap items-center gap-x-[1ch] gap-y-3">
        <div className="min-w-[14em] flex-1">
          <h2 id="app-tools-heading" className="text-base font-semibold">
            {app.tools.length === 0 ? "Tools" : `Tools (${app.tools.length})`}
          </h2>
          <p className={cn(NOTE, "wrap-anywhere")}>{facts.join(" · ")}</p>
        </div>
        <button type="button" disabled={busy !== null} onClick={onReadAgain} className={cn(BUTTON, "gap-[0.5em]")}>
          <RefreshDouble className="size-[18px]" />
          <span>Read its tools again</span>
        </button>
      </div>
      <p role="status" className={cn(NOTE, "wrap-anywhere empty:hidden", busy !== "reading" && "text-negative")}>
        {busy === "reading" ? READING_TOOLS : unread}
      </p>
      <p className={NOTE}>Each description is the app's own. Pick the tools an agent may use on the agent's page.</p>
      {app.tools.length === 0 && <p className={NOTE}>{NO_TOOLS}</p>}
      {app.setAside.length > 0 && <SetAside tools={app.setAside} />}
      {app.tools.length > 0 && (
        <ul aria-labelledby="app-tools-heading" className="flex max-h-[28em] flex-col overflow-y-auto overscroll-contain rounded-[10px] border bg-background">
          {app.tools.map(({ name, title, description }) => (
            <li key={name} className="border-t px-[1.5ch] py-2.5 first:border-t-0">
              <div className="flex flex-wrap items-baseline gap-x-[1ch]">
                <code className="font-mono text-[0.9em] font-semibold wrap-anywhere">{name}</code>
                {title !== null && title !== name && <span className={NOTE}>{title}</span>}
              </div>
              {description !== "" && <p className="text-[0.9em] wrap-anywhere whitespace-pre-line text-message-ink max-md:text-[13px]">{description}</p>}
            </li>
          ))}
        </ul>
      )}
      {app.toolsLeftOut > 0 && <p className={NOTE}>{toolsLeftOut(app.toolsLeftOut)}</p>}
    </section>
  );
}
