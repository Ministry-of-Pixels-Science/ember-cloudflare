import {
  CANT_EMAIL_LINKS,
  EMAIL_LINK_GONE,
  EMAIL_LINKS_LIMITED,
  INVITATION_GONE,
  isPasswordTooLong,
  isPasswordTooShort,
  JOINING_PROBLEMS,
  onlyAddressesAt,
  parseEmailLinkRequest,
  parseEmailLinkSignUp,
  parseOpenSignUp,
  parseSignUp,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  signInSaying,
  SIGN_UP_FULL,
  SIGN_UP_LIMITED,
  signsUpOpenly,
  signsUpWithEmailDomain,
  TURNSTILE_FAILED,
  type EmailLinkKind,
  type JoiningProblem,
  type Me,
  type SignUp,
} from "@ember/protocol";
import { agentsName } from "@ember/protocol/agents";
import { BLOCKED_WORDS_REFUSED } from "@ember/protocol/blocked-words";
import { waitUntil } from "cloudflare:workers";
import { authenticate, clientOf, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { userFormOf, userFormPhoto } from "./avatars";
import { jsonBodyOf } from "./bodies";
import { originFor } from "./custom-domain";
import type { Env } from "./env";
import { emailLinkDigest, newEmailLink } from "./invitations";
import { appPage, empty, formAnswer, home, signInFirst, signUpRefusal } from "./pages";
import { passwordHasher } from "./passwords";
import { passedTurnstile, turnstileKeysFor } from "./turnstile";
import { signInNeededWith, workspace, type NameRefusal, type OnlyWay } from "./workspace";
import type { NewPerson } from "./workspace-store";

// Joining with the workspace's join link, as Campfire's UsersController does (`new` and `create`),
// except that the form posts to /api/join/<code>. Before first run, there's no join code to match yet,
// so every link is a 404. An administrator can turn the link off, and while Memberful is members only
// (memberful.ts), or single sign-on the only way in (sso.ts), it's off too: either way it sends people
// to sign in. Signing up at /join, with no code,
// is Ember's own: anyone may while an administrator lets them, within its limits, and with Turnstile's
// check while Ember has a widget's keys. So is joining with an invitation's link, whichever ways to join
// are on, with the address it was sent to, and with a link someone asks Ember to email an address at the
// workspace's email domains, while an administrator lets those domains in.

/** What the join form answers while Memberful is members only, or single sign-on the only way in: why, and where to go instead. */
const elsewhereInstead = (way: OnlyWay) => ({ error: signInNeededWith(way), redirect: "/session/new" });

/** What a form for joining answers while its way in is off: why, and the sign-in page, which says so. */
const signInInsteadOf = (problem: JoiningProblem) => ({ error: JOINING_PROBLEMS[problem], redirect: signInSaying(problem) });

/** Sends the browser to sign in, saying why it can't join here. */
const signInSayingWhy = (request: Request, problem: JoiningProblem) =>
  new Response(null, { status: 302, headers: { Location: new URL(signInSaying(problem), request.url).href } });

/**
 * The join code in a join link's path, `/join/<code>`, or null if `pathname` isn't one. Codes are
 * letters, digits and dashes, which nothing percent-encodes, so the path holds them as they are.
 */
export const joinCodeOf = (pathname: string) => pathname.match(/^\/join\/([^/]+)$/)?.[1] ?? null;

/**
 * `GET /join/<code>`: the join page, which is the app's own, for someone signed out with the current
 * code, unless Memberful is members only, single sign-on the only way in, or the link is off, when it
 * sends them to sign in.
 */
export async function joinPage(request: Request, env: Env, code: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return empty(404);
  // Campfire's `require_unauthenticated_access` comes first: someone signed in goes home.
  const [session, link] = await Promise.all([authenticate(request, env), workspace(env).joinLink(code)]);
  if (session) return home(request);
  if (link === "not found") return empty(404);
  if (link === "memberful" || link === "sso" || link === "either") return signInFirst(request);
  if (link === "off") return signInSayingWhy(request, "link_off");
  return pageForJoining(request, env);
}

/**
 * `GET /join`: the join page without a code, for someone signed out while anyone may sign up, or else
 * sign-in, which says signing up is closed. Its policy lets Turnstile's check load, while Ember has a
 * widget's keys.
 */
export async function signUpPage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return empty(404);
  const [session, account] = await Promise.all([authenticate(request, env), workspace(env).account()]);
  if (session) return home(request);
  if (account === null || !signsUpOpenly(account)) return signInSayingWhy(request, "closed");
  return pageForJoining(request, env, (await turnstileKeysFor(env)) !== null);
}

/**
 * `GET /join/invitation`: the join page for an invitation's link, which holds its secret in the
 * fragment, out of the Worker's sight, so the page looks it up. It goes home for someone signed in, as
 * the app sends them, once the secret is out of the address.
 */
export async function invitationPage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return empty(404);
  return pageForJoining(request, env);
}

/**
 * `GET /join/email`: where someone asks for a link to join with an address at the workspace's email
 * domains, and the page that link opens, which holds its secret in the fragment, as an invitation's
 * does, so the Worker can't tell the two apart. The app sends someone signed in home, and anyone else
 * to sign in while Email domain is off, once the secret is out of the address. Its policy lets
 * Turnstile's check load, while Ember has a widget's keys.
 */
export async function emailSignUpPage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return empty(404);
  return pageForJoining(request, env, (await turnstileKeysFor(env)) !== null);
}

/** The app's page for joining, which no cache keeps, since what it shows depends on the workspace's switches. */
async function pageForJoining(request: Request, env: Env, turnstile = false): Promise<Response> {
  const page = await appPage(request, env, "/", { turnstile });
  page.headers.set("Cache-Control", "no-store");
  return page;
}

/**
 * `POST /api/join/<code>`: adds the person the join form describes as a member, in every open room,
 * with the photo it brings, and signs this browser in as them. Someone whose email address is taken
 * goes to sign in with it filled in, and nothing is created. While the link is off, or members sign in
 * with Memberful, it answers 403 before the form is read, and sends them to sign in.
 */
export async function join(request: Request, env: Env, code: string): Promise<Response> {
  const [session, link] = await Promise.all([authenticate(request, env), workspace(env).joinLink(code)]);
  if (session) return signedInAlready();
  if (link === "not found") return formAnswer({ error: "Not found" }, 404);
  if (link === "memberful" || link === "sso" || link === "either") return formAnswer(elsewhereInstead(link), 403);
  if (link === "off") return formAnswer(signInInsteadOf("link_off"), 403);

  const sent = await userFormOf(request);
  if ("error" in sent) return formAnswer({ error: sent.error, field: "avatar" }, sent.status);
  const form = parseSignUp(sent.fields);
  if (typeof form === "string") return signUpRefusal(form);
  const refusal = passwordRefusal(form.password);
  if (refusal) return refusal;
  const person = await personOf(env, form, sent.photo);
  if (person instanceof Response) return person;

  const token = newSessionToken();
  const user = await workspace(env).join(code, person, await tokenDigest(token, env.SESSION_SECRET), clientOf(request));
  if (user === "not found") return formAnswer({ error: "Not found" }, 404);
  if (user === "memberful" || user === "sso" || user === "either") return formAnswer(elsewhereInstead(user), 403);
  if (user === "off") return formAnswer(signInInsteadOf("link_off"), 403);
  if (user === "agent's name" || user === "blocked words") return nameRefused(user, form.name);
  if (!user) return emailAddressTaken(form.emailAddress);
  return formAnswer({ user } satisfies { user: Me }, 201, sessionCookie(request, token));
}

/**
 * `POST /api/join`: adds the person the open sign-up form describes, as `join` adds someone with the
 * join link, while anyone may sign up, and else answers 403 before the form is read, sending them to
 * sign in. Turnstile's check comes first, while Ember has a widget's keys, and else the limits that
 * stand in for it, all before the photo is stored or the password hashed: past the limit from the
 * address, or once the workspace's new people for the hour have filled it, it answers 429.
 */
export async function signUp(request: Request, env: Env): Promise<Response> {
  const [session, account] = await Promise.all([authenticate(request, env), workspace(env).account()]);
  if (session) return signedInAlready();
  if (account === null || !signsUpOpenly(account)) return formAnswer(signInInsteadOf("closed"), 403);

  const sent = await userFormOf(request);
  if ("error" in sent) return formAnswer({ error: sent.error, field: "avatar" }, sent.status);
  const form = parseOpenSignUp(sent.fields);
  if (typeof form === "string") return signUpRefusal(form);
  const refusal = passwordRefusal(form.password);
  if (refusal) return refusal;
  const client = clientOf(request);
  const turnstile = await turnstileKeysFor(env);
  if (turnstile && !(await passedTurnstile(env, turnstile.secretKey, form.turnstileToken, client.ip))) {
    return formAnswer({ error: TURNSTILE_FAILED, field: "turnstile" }, 422);
  }
  // Turnstile's check stops the scripts the limits guard against, so they hold only without its keys.
  const limited = turnstile === null;
  const begun = await workspace(env).beginSignUp(client.ip ?? "unknown", form.emailAddress, limited);
  if (begun !== "begun") return signUpRefused(begun, form.emailAddress);
  const person = await personOf(env, form, sent.photo);
  if (person instanceof Response) return person;

  const token = newSessionToken();
  const user = await workspace(env).signUp(person, await tokenDigest(token, env.SESSION_SECRET), client, limited);
  if (user === "closed" || user === "full") return signUpRefused(user, form.emailAddress);
  if (user === "agent's name" || user === "blocked words") return nameRefused(user, form.name);
  if (!user) return emailAddressTaken(form.emailAddress);
  return formAnswer({ user } satisfies { user: Me }, 201, sessionCookie(request, token));
}

/** What a link Ember emailed answers once it doesn't work, which its page says too, for each kind of link. */
const LINKS_GONE: Record<EmailLinkKind, string> = { invitation: INVITATION_GONE, email_domain: EMAIL_LINK_GONE };

const linkGone = (kind: EmailLinkKind) => formAnswer({ error: LINKS_GONE[kind] }, 404);

/**
 * `POST /api/join/invitation`, with an invitation's link, and `POST /api/join/email`, with one someone
 * asked for at the workspace's email domains, as `kind` says: adds the person the link's join form
 * describes as a member, with the address the link was sent to, in every open room, with the photo
 * they chose, and signs this browser in as them, spending the link. An invitation's works whichever
 * ways to join are on, and the other while Email domain lets in its address's domain. A link that
 * doesn't work answers 404 before the photo is stored or the password hashed, and an address with an
 * account goes to sign in with it filled in, leaving the link be.
 */
export async function joinWithEmailLink(request: Request, env: Env, kind: EmailLinkKind): Promise<Response> {
  if (await authenticate(request, env)) return signedInAlready();
  const sent = await userFormOf(request);
  if ("error" in sent) return formAnswer({ error: sent.error, field: "avatar" }, sent.status);
  const form = parseEmailLinkSignUp(sent.fields);
  if (typeof form === "string") return signUpRefusal(form);
  const refusal = passwordRefusal(form.password);
  if (refusal) return refusal;
  const linkDigest = await emailLinkDigest(form.token, env);
  const link = linkDigest ? await workspace(env).emailLinkFor(linkDigest) : null;
  if (!linkDigest || link?.kind !== kind) return linkGone(kind);
  const person = await personOf(env, { ...form, emailAddress: link.emailAddress }, sent.photo);
  if (person instanceof Response) return person;

  const token = newSessionToken();
  const user = await workspace(env).joinWithEmailLink(kind, linkDigest, person, await tokenDigest(token, env.SESSION_SECRET), clientOf(request));
  if (user === "gone") return linkGone(kind);
  if (user === "agent's name" || user === "blocked words") return nameRefused(user, form.name);
  if (!user) return emailAddressTaken(link.emailAddress);
  return formAnswer({ user } satisfies { user: Me }, 201, sessionCookie(request, token));
}

/**
 * `POST /api/email_links`, `{ emailAddress, turnstileToken? }`: emails the address a link to join with
 * it, while Email domain lets in its domain, answering 202 whether or not it has an account already,
 * which it's emailed about instead, so that the answer never says who has one. While Email domain is off
 * it answers 403 before the body is read, sending them to sign in, and an address at another domain is
 * refused on its field. Turnstile's check comes next, while Ember has a widget's keys, and else the
 * network's limit, which stands in for it. It answers 503 while Ember can't send email, and otherwise
 * before the Workspace is told which address to email, so that how soon it answers says nothing of the
 * address either, and an email the provider then refuses is only logged.
 */
export async function askForEmailLink(request: Request, env: Env): Promise<Response> {
  const [session, account] = await Promise.all([authenticate(request, env), workspace(env).account()]);
  if (session) return signedInAlready();
  if (account === null || !signsUpWithEmailDomain(account)) return formAnswer(signInInsteadOf("email_off"), 403);
  const asked = parseEmailLinkRequest(await jsonBodyOf(request));
  if (typeof asked === "string") return formAnswer({ error: asked, field: "emailAddress" }, 422);
  if (!account.emailDomains.includes(asked.domain)) return formAnswer({ error: onlyAddressesAt(account.emailDomains), field: "emailAddress" }, 422);
  const client = clientOf(request);
  const turnstile = await turnstileKeysFor(env);
  if (turnstile && !(await passedTurnstile(env, turnstile.secretKey, asked.turnstileToken, client.ip))) {
    return formAnswer({ error: TURNSTILE_FAILED, field: "turnstile" }, 422);
  }
  const link = await newEmailLink(env);
  const origin = originFor(request, account.customDomain);
  // Turnstile's check stops the scripts the network's limit guards against, so it holds only without its keys.
  const outcome = await workspace(env).askForEmailLink(client.ip ?? "unknown", asked.domain, turnstile === null);
  if (outcome === "off") return formAnswer(signInInsteadOf("email_off"), 403);
  if (outcome === "limited") return formAnswer({ error: EMAIL_LINKS_LIMITED }, 429);
  if (outcome === "unsendable") return formAnswer({ error: CANT_EMAIL_LINKS }, 503);
  // The Workspace is told the address only now, with the answer decided, and isn't waited for, so nothing
  // it finds out about the address, or does for it, can hold the answer back.
  waitUntil(
    workspace(env)
      .emailJoinLink(asked.emailAddress, asked.domain, link, origin)
      .catch((error: unknown) => console.error("Could not have a link to join emailed", error)),
  );
  return formAnswer({}, 202);
}

/** What a form for joining answers someone signed in: go home. */
const signedInAlready = () => formAnswer({ error: "You're signed in already", redirect: "/" }, 409);

/** Why a sign-up's password is refused, as first run refuses it, though Campfire takes any here, even an empty one, which makes an account nobody can sign in to. */
function passwordRefusal(password: string): Response | null {
  if (isPasswordTooLong(password)) return formAnswer({ error: PASSWORD_TOO_LONG, field: "password" }, 422);
  if (isPasswordTooShort(password)) return formAnswer({ error: PASSWORD_TOO_SHORT, field: "password" }, 422);
  return null;
}

/** The person `form` describes, ready to be added, with the photo `photo` brings stored and their password hashed, or the answer refusing the photo. */
async function personOf(env: Env, form: SignUp, photo: FormData | null): Promise<Omit<NewPerson, "id"> | Response> {
  const avatar = await userFormPhoto(env, photo);
  if (avatar && "error" in avatar) return formAnswer({ error: avatar.error, field: "avatar" }, avatar.status);
  const passwordDigest = await passwordHasher(env).hash(form.password);
  return { name: form.name, emailAddress: form.emailAddress, passwordDigest, avatar };
}

/** What a form for joining answers, on its field, for a name nobody can take: an AI agent's, or one with a word Blocked words keeps out. */
const nameRefused = (refusal: NameRefusal, name: string) => formAnswer({ error: refusal === "agent's name" ? agentsName(name) : BLOCKED_WORDS_REFUSED, field: "name" }, 422);

/** What a form for joining answers for an email address that has an account: sign in with it, filled in. */
function emailAddressTaken(emailAddress: string): Response {
  const signIn = `/session/new?${new URLSearchParams({ email_address: emailAddress })}`;
  return formAnswer({ error: "That email address has an account already", redirect: signIn }, 409);
}

/** What open sign-up answers when it can't go on. */
function signUpRefused(why: "closed" | "limited" | "full" | "taken", emailAddress: string): Response {
  if (why === "closed") return formAnswer(signInInsteadOf("closed"), 403);
  if (why === "taken") return emailAddressTaken(emailAddress);
  return formAnswer({ error: why === "limited" ? SIGN_UP_LIMITED : SIGN_UP_FULL }, 429);
}
