import type { AppConnector } from "./apps/connector";
import type { ChatRoom } from "./chat-room";
import type { OutsideAi } from "./outside/endpoint";
import type { PasswordHasher } from "./passwords";
import type { SearchIndex } from "./search-index";
import type { Unfurler } from "./unfurl";
import type { Workspace } from "./workspace";

export type StorageBackend = "do-sqlite" | "d1";

export interface Env {
  ASSETS: Fetcher;
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  PASSWORD_HASHER: DurableObjectNamespace<PasswordHasher>;
  UNFURLER: DurableObjectNamespace<Unfurler>;
  SEARCH_INDEX: DurableObjectNamespace<SearchIndex>;
  APP_CONNECTOR: DurableObjectNamespace<AppConnector>;
  OUTSIDE_AI: DurableObjectNamespace<OutsideAi>;
  /** Only bound when D1 is configured in wrangler.jsonc. */
  DB?: D1Database;
  /**
   * The R2 bucket that keeps the files people upload to rooms. Unbound, Ember keeps none: uploading
   * answers 503 and a file's address 404.
   */
  FILES?: R2Bucket;
  /**
   * Cloudflare Images, which makes the preview of a picture that came without one, as from a bot or a
   * browser that couldn't read it, where its message would otherwise show it as a file: one over 5 MiB,
   * or that not every browser shows (files/previews.ts). It makes 5,000 a month free. Unbound, or past
   * what the account's plan makes, such a picture shows as a file.
   */
  IMAGES?: ImagesBinding;
  STORAGE_BACKEND: StorageBackend;
  /**
   * Comma-separated addresses of rooms from before the Workspace kept a list, which it registers as
   * open rooms so their messages stay reachable. Only the old preview Worker, `ember-preview`, was
   * deployed with it.
   */
  LEGACY_ROOMS?: string;
  SESSION_SECRET: string;
  /** "true" lets anyone sign in with just a name, for tests and demos. Leave it unset otherwise. */
  EMBER_GUEST_SIGN_IN?: string;
  /** What the Set up Ember form suggests for the administrator's name in place of "Kevin Rose". */
  EMBER_SETUP_NAME_PLACEHOLDER?: string;
  /** What the Set up Ember form suggests for their email address in place of "kevin@kevinrose.com". */
  EMBER_SETUP_EMAIL_PLACEHOLDER?: string;
  /**
   * The setup password, which the Set up Ember page asks for, so that only whoever deployed Ember sets
   * it up (setup.ts). Deploy to Cloudflare's form asks the deployer to make one up. With neither it nor
   * EMBER_SETUP_TOKEN, setup is closed, except over loopback, where `wrangler dev` serves.
   */
  EMBER_SETUP_PASSWORD?: string;
  /**
   * 64 lowercase hex characters (`openssl rand -hex 32`) that the setup link a deploy prints carries,
   * which also lets its holder set Ember up. `pnpm run deploy` makes one for a Worker that has neither it
   * nor a setup password. Set to anything else, it counts as a setup password.
   */
  EMBER_SETUP_TOKEN?: string;
  /**
   * 64 lowercase hex characters (`openssl rand -hex 32`) that let apps/worker/scripts/reset-password.ts
   * reset anyone's password. Unset, nothing can, so set it only while it's needed.
   */
  EMBER_RECOVERY_TOKEN?: string;
  /**
   * The address of the Memberful site whose members may join and sign in, such as
   * https://example.memberful.com, once an administrator turns Memberful on (memberful.ts). Without it,
   * or either of the two keys of the site's custom app below, Memberful can't be turned on, and nobody
   * signs in with it.
   */
  MEMBERFUL_URL?: string;
  /** The OAuth identifier of the Memberful site's custom app, a server-side one. */
  MEMBERFUL_CLIENT_ID?: string;
  /** That app's client secret, which never leaves the Worker. */
  MEMBERFUL_CLIENT_SECRET?: string;
  /**
   * That app's API key, with which the Workspace asks Memberful's admin API whose memberships are
   * active, when a webhook says one changed, and once a day (memberful-api.ts). Without it, only
   * signing in checks a membership, and Memberful's webhooks are refused, as they are without the
   * secret below.
   */
  MEMBERFUL_API_KEY?: string;
  /** The secret Memberful signs its webhooks to `/webhooks/memberful` with, which its Webhooks settings show. */
  MEMBERFUL_WEBHOOK_SECRET?: string;
  /**
   * The site key of a Cloudflare Turnstile widget, whose check the open sign-up form shows, and the forms
   * that ask Ember to email a link to join or a code to reset a password, to check that whoever fills
   * them in is a person (turnstile.ts). With the secret key below, it takes the place of the keys an
   * administrator gives in Set up Turnstile. Without either, the forms have no check, and only their
   * limits hold bots back.
   */
  TURNSTILE_SITE_KEY?: string;
  /** That widget's secret key, with which the Worker asks Cloudflare whether a check passed. */
  TURNSTILE_SECRET_KEY?: string;
  /** Where the browser tests' stand-in for Turnstile's siteverify listens, which the Worker asks only at a loopback address. */
  TURNSTILE_SITEVERIFY_URL?: string;
  /**
   * Cloudflare Email Service's binding, which Ember sends its email with, from the address an
   * administrator gives in Membership (mail.ts). wrangler.jsonc declares it, but it only delivers from a
   * domain onboarded to Email Sending, and to anyone but the account's own verified addresses only on
   * the Workers Paid plan.
   */
  EMAIL?: SendEmail;
  /**
   * An API key of Resend's, which Ember sends its email with in place of Cloudflare's binding, as an
   * account on Workers Free can, from a domain verified in Resend.
   */
  RESEND_API_KEY?: string;
  /** Where Resend's API is, for the browser tests' stand-in, which only a loopback address can be. */
  RESEND_API_URL?: string;
  /**
   * The ID of the Cloudflare account the Worker is deployed to, which a Worker can't learn by itself:
   * `pnpm run deploy` gives it, and Set up Ember AI fills it in for administrators.
   */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /**
   * Where Cloudflare's API is, which Ember AI asks AI Gateway through, for the browser tests' stand-in,
   * which only a loopback address can be: `http://127.0.0.1:8793` has Ember ask
   * `http://127.0.0.1:8793/accounts/<id>/ai/v1/...` (assistant/gateway.ts).
   */
  AI_GATEWAY_URL?: string;
  /**
   * Where Ember reads the models file, which lists the models it offers besides Workers AI's
   * (docs/models.md): unset, the one on Ember's main branch, or else an https address, or the browser
   * tests' stand-in's at a loopback one, or nowhere, when it's blank, so that Ember offers only the file
   * its release shipped with.
   */
  EMBER_MODELS_URL?: string;
  /**
   * Where the Realtime SFU's API is, which huddles run through, for the browser tests' stand-in, which only
   * a loopback address can be: `http://127.0.0.1:8794` has Ember ask
   * `http://127.0.0.1:8794/v1/apps/<id>/...` (huddles/sfu.ts).
   */
  REALTIME_SFU_URL?: string;
  /**
   * The public half of the P-256 key pair that signs push notifications (VAPID): the point, compressed
   * or not, in URL-safe Base64. `pnpm vapid:keys` makes a pair. Without both halves, or with a pair that
   * doesn't match, push notifications are off. Browsers subscribe with it, so changing it orphans every
   * subscription.
   */
  VAPID_PUBLIC_KEY?: string;
  /** The private half of the VAPID key pair: its scalar, up to 32 bytes, in URL-safe Base64. */
  VAPID_PRIVATE_KEY?: string;
  /**
   * Whom push services may contact about this deployment's pushes, a `mailto:` or `https:` address.
   * Unset, it's this project's address.
   */
  VAPID_SUBJECT?: string;
  /** What to call this deployment's version. */
  APP_VERSION?: string;
  /** The commit deployed, which stands in for the version when APP_VERSION isn't set. */
  GIT_REVISION?: string;
  /**
   * The GitHub repository of the copy of Ember deployed, as `owner/name`, which `pnpm run deploy` gives
   * where git's origin is a copy on GitHub, with GIT_BRANCH, the branch that deploys, UPDATE_WORKFLOW,
   * "true" where the copy has the Update Ember workflow, and BETA_WORKFLOW, "true" where it has the beta
   * workflow: General's release card links to running each, or to adding it.
   */
  GITHUB_REPOSITORY?: string;
  GIT_BRANCH?: string;
  UPDATE_WORKFLOW?: string;
  BETA_WORKFLOW?: string;
  /**
   * Any value but a blank one lets plain HTTP through rather than redirecting it to HTTPS, and leaves
   * out HSTS. Loopback addresses, where `wrangler dev` serves, never need it.
   */
  DISABLE_SSL?: string;
}

/** Whether people may sign in with just a name, and guests who did may stay signed in. */
export const guestSignIn = (env: Env) => env.EMBER_GUEST_SIGN_IN === "true";
