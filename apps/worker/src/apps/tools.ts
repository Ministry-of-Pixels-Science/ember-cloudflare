import type { CardAction, UserId } from "@ember/protocol";
import { CALL_ACTIONS, type AppId, type CallDecision } from "@ember/protocol/apps";
import { ToolError, type EmberTool } from "../assistant/tool-calls";
import type { SlackPayload } from "../bots/slack";
import type { Env } from "../env";
import { workspace, type AppCallAccess, type AskedBy } from "../workspace";
import { toolCard, type Clicked } from "./cards";
import { appConnector } from "./connector";

// Connected apps' tools as @ember and the agents use them: an administrator picks them for each
// (Workspace.pickAgentTools), the room gives them to the model beside Ember's own (tool-calls.ts), and
// every call asks first, on a card in the room, which whoever asked, or an administrator, allows or not,
// unless the administrator has that agent's calls of the tool always allowed: those are made at once,
// each shown on a card in the room as it is. A tool that answers with a card of its own, in Slack's
// Block Kit, has the room shown it, and a click on a button of that card calls the tool it names, for
// whoever clicked (cards.ts). In someone's direct conversation with an agent, a call of a tool of an
// app they've signed in to themselves goes as them, with their sign-in, and always asks them first.
// The model never has an app's address or its token: it names a tool, and Ember calls it.

/**
 * A connected app's tool picked for an agent: its app, by its id and name, and the tool as its server
 * described it when it was picked, with the JSON Schema of what it takes as JSON, as the Workspace
 * hands it to a room, and whether the agent's calls of it are made without asking first. One that's
 * whoever asked's `own` is called as them, with the sign-in they made to its app themselves, in their
 * direct conversation with the agent, and never without asking first.
 */
export interface PickedTool {
  appId: AppId;
  appName: string;
  name: string;
  title: string | null;
  description: string;
  takes: string;
  fingerprint: string;
  alwaysAllowed: boolean;
  own?: true;
}

/** An app's tool as a model was given it: the name the model calls it by, `as`, and which tool that is, as it was picked, and whether as whoever asked's `own`. */
export type GivenTool = Pick<PickedTool, "appId" | "appName" | "name" | "fingerprint" | "own"> & { as: string };

/** `tool` as its model was given it, without what the model read of it. */
export const givenAs = ({ as, appId, appName, name, fingerprint, own }: GivenTool): GivenTool => ({ as, appId, appName, name, fingerprint, ...(own && { own }) });

/** The longest name a provider takes for a tool, of letters, digits, `_` and `-`. */
const MAX_NAME_LENGTH = 64;

const plain = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, "_");

/**
 * `picked`, each by the name its model calls it by: its app's name, then its own, as providers take a
 * name, cut to what they take, and numbered where two would be the same.
 */
export function givenTools(picked: readonly PickedTool[]): Array<PickedTool & GivenTool> {
  const taken = new Set<string>();
  return picked.map((tool) => {
    const app = plain(tool.appName).replace(/^_+|_+$/g, "").slice(0, 20) || "app";
    const name = `${app}__${plain(tool.name)}`.slice(0, MAX_NAME_LENGTH);
    let as = name;
    for (let n = 2; taken.has(as); n++) as = `${name.slice(0, MAX_NAME_LENGTH - `_${n}`.length)}_${n}`;
    taken.add(as);
    return { ...tool, as };
  });
}

/** What a model reads of an app's tool: whose it is, that each call waits to be allowed, or is shown to the room, or goes as whoever asked, and the app's own words for it, which are the app's. */
const describedAs = ({ appName, title, description, alwaysAllowed, own }: PickedTool) =>
  [
    own
      ? `A tool of ${appName}, an app this workspace's administrators connected, which the person you're answering has signed in to themselves: here, a call of it is made as them. Each call waits until they allow it, so call it only when they asked for what it does, with what they'd expect.`
      : alwaysAllowed
        ? `A tool of ${appName}, an app this workspace's administrators connected. Each call is made at once and shown to everyone in the room, so call it only when the person you're answering asked for what it does, with what they'd expect.`
        : `A tool of ${appName}, an app this workspace's administrators connected. Each call waits until the person you're answering allows it, so call it only when they asked for what it does, with what they'd expect.`,
    title === null ? "" : `${appName} calls it: ${title}`,
    description === "" ? "" : `${appName} describes it: ${description}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

/** Why a call the room was shown wasn't made after all: its server has changed the tool, couldn't be asked for it, or refused it as more than Ember's sign-in allows. */
export type Unmade = "changed" | "unasked" | "refused";

/** A call the room was shown, which it's told wasn't made after all, and why, with `unmade`. */
export interface ShownCall {
  unmade(why: Unmade): Promise<void>;
}

/** Shows the room a call that's made without asking first, with what it's called with, answering why it couldn't, if it couldn't. */
export type ShowsCall = (input: Record<string, unknown>) => Promise<string | ShownCall>;

/** Shows the room the card a tool answered a call with, as a Slack payload, answering why it couldn't, if it couldn't. */
export type ShowsCard = (card: SlackPayload) => Promise<string | null>;

/**
 * The tool `given` for `agentId`'s model, answering whoever `asked`: with its description and what it
 * takes for a question, `described`, or without them going on from a call, whose request lists them
 * already. It asks first, unless the agent's calls of it are always allowed, which `shown` being there
 * says: such a call is made once the room is shown it, and not when it can't be. The room is shown the
 * card a call is answered with, if it is with one, through `cards`.
 */
export function appTool(env: Env, agentId: UserId, given: GivenTool, asked: AskedBy, { described, shown, cards }: { described?: PickedTool; shown?: ShowsCall; cards?: ShowsCard } = {}): EmberTool {
  const unshowable = (input: Record<string, unknown>) => (written(input).length > MAX_SHOWN_INPUT_LENGTH ? TOO_LONG_TO_SHOW : null);
  return {
    name: given.as,
    description: described ? describedAs(described) : "",
    takes: described ? (JSON.parse(described.takes) as Record<string, unknown>) : { type: "object" },
    ...(!shown && { asksFirst: true as const, unaskable: unshowable }),
    run: async (input) => {
      const tooLong = shown ? unshowable(input) : null;
      if (tooLong !== null) throw new ToolError(tooLong);
      return called(env, agentId, given, input, asked, shown, cards);
    },
  };
}

/** Whether the sign-in to the app asked as `access` has ended, so that its server isn't asked until an administrator signs in again, or the person whose own it is does. */
export const hasEnded = (access: Pick<AppCallAccess, "signedIn" | "key">) => access.signedIn && access.key === null;

/** What's said of an app whose sign-in has ended, to a model whose call of its tool isn't made, and to an administrator who has its tools read. */
export const signInEnded = (appName: string) => `Ember's sign-in to ${appName} has ended. An administrator has to sign in to it again, on its page.`;

/** What's said to a model of a call an app's server refused as more than Ember's sign-in to it allows, which signing in again asks for. */
export const wantsMoreAccess = (appName: string) => `${appName} says this takes more access than Ember's sign-in to it has. An administrator has to sign in to it again, on its page, to allow it.`;

/** What's said to a model of a call that was to go as the person it's answering, whose own sign-in to the app has ended, or who has signed out of it since it was to. */
export const ownSignInEnded = (appName: string) =>
  `The sign-in to ${appName} of the person you're answering has ended. They have to sign in to it again, under Apps on their profile, or sign out of it there to use the one this workspace shares.`;

/** What's said to a model of a call an app's server refused as more than the own sign-in of the person it's answering allows, which their signing in again asks for. */
export const ownWantsMoreAccess = (appName: string) =>
  `${appName} says this takes more access than the sign-in to it of the person you're answering has. They have to sign in to it again, under Apps on their profile, to allow it.`;

/** Why a call isn't made of a tool that isn't its agent's to call any more. */
export class ToolGone extends ToolError {}

/** What a model is told of a call made without asking first that the room couldn't be shown. */
export const CALL_NOT_SHOWN = "Not run: the room couldn't be shown this call, and a call nobody is shown isn't made.";

/** What a model is told, after what a call answered, once the room has been shown the card its tool answered with. */
export const shownAsCard = (appName: string) => `(The room has been shown this on a card from ${appName}, so there's no need to write it out again, or to make a card of it.)`;

/**
 * What a model reads of calling `tool` with `input` for `agentId` (`answered`), once the room has been
 * shown the card the call was answered with, if it was with one, through `cards`, which the model is
 * then told.
 */
async function called(env: Env, agentId: UserId, tool: GivenTool, input: Record<string, unknown>, asked: AskedBy, shown?: ShowsCall, cards?: ShowsCard): Promise<string> {
  const { text, blocks } = await answered(env, agentId, tool, input, asked, shown);
  return blocks !== undefined && cards && (await carded(tool, blocks, cards)) ? `${text}\n\n${shownAsCard(tool.appName)}` : text;
}

/**
 * What a click on a button of a tool's card comes to, by `clicked`: what calling `tool` with `input`,
 * what the button holds, for `agentId`, whose card it is, was answered with (`answered`), its text,
 * and the card to put in the clicked one's place, if it was answered with one Ember draws. The click
 * is its own leave: nobody is asked first, as whoever clicked chose to, and it's they who `asked`.
 */
export async function calledFromCard(env: Env, agentId: UserId, tool: GivenTool, input: Record<string, unknown>, clicked: Clicked, asked: AskedBy): Promise<{ text: string; card: SlackPayload | null }> {
  const { text, blocks } = await answered(env, agentId, tool, input, asked);
  return { text, card: blocks === undefined ? null : toolCard(tool, blocks, clicked) };
}

/**
 * What calling `tool` with `input` for `agentId` comes to, once someone allowed it, or once the room
 * is `shown` it, as the agent's calls of it are always allowed: what its app answered, its text and
 * the Block Kit blocks beside it, if any, or why not, thrown, in words for a model. The Workspace says
 * where it goes, as it finds the tool then: one no longer picked for the agent, changed since, or,
 * with nobody asked, no longer always allowed, isn't called, and neither is one the room can't be
 * shown, or one of an app whose sign-in has ended. A call shown that then isn't made, as its tool is
 * found changed, its server can't be asked, or its server refuses it as more than Ember's sign-in
 * allows, has the room told so, and why. One refused so has the Workspace keep what its server asked
 * for, for an administrator to sign in again with. A tool that's whoever `asked`'s own is called as
 * them, with the sign-in they made to its app themselves, or not at all once that has ended: what its
 * server asks for beyond it is kept for them, and what it lists to them isn't read as the app's tools.
 */
async function answered(env: Env, agentId: UserId, tool: GivenTool, input: Record<string, unknown>, asked: AskedBy, shown?: ShowsCall): Promise<{ text: string; blocks?: string }> {
  const access = await workspace(env).appToolCall(agentId, tool, shown !== undefined, tool.own ? asked : undefined);
  if (!access) throw new ToolGone(`Not run: ${tool.as} isn't one of your tools any more${shown ? ", or each call of it has to be allowed now" : ""}.`);
  if (hasEnded(access)) throw new ToolError(`Not run: ${(access.own ? ownSignInEnded : signInEnded)(tool.appName)}`);
  const shownCall = await shown?.(input);
  if (typeof shownCall === "string") {
    console.error(`A call of the tool ${tool.name} of app ${tool.appId} wasn't made, as the room couldn't be shown it: ${shownCall}`);
    throw new ToolError(CALL_NOT_SHOWN);
  }
  const { text, failed, unmade, changed, scope, blocks } = await appConnector(env).call(access.url, access.key, { name: tool.name, fingerprint: tool.fingerprint }, input);
  await Promise.all([changed && !access.own && readAgain(env, tool, access), scope !== undefined && wantsScope(env, tool, scope, access), unmade && shownCall?.unmade(changed ? "changed" : scope !== undefined ? "refused" : "unasked")]);
  if (scope !== undefined) throw new ToolError(`Not run: ${(access.own ? ownWantsMoreAccess : wantsMoreAccess)(tool.appName)}`);
  if (failed) throw new ToolError(text);
  return { text, ...(blocks !== undefined && { blocks }) };
}

/**
 * Whether the room was shown `blocks`, the Block Kit blocks `tool`'s app answered a call with, as
 * JSON, as the tool's card. Blocks Ember doesn't draw whole aren't shown, and neither are ones the room
 * can't keep: the model has the call's text all the same.
 */
async function carded(tool: GivenTool, blocks: string, show: ShowsCard): Promise<boolean> {
  const card = toolCard(tool, blocks);
  if (!card) return false;
  try {
    const unshown = await show(card);
    if (unshown !== null) console.error(`The card the tool ${tool.name} of app ${tool.appId} answered with wasn't shown: ${unshown}`);
    return unshown === null;
  } catch (error) {
    console.error(`Showing the card the tool ${tool.name} of app ${tool.appId} answered with failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return false;
  }
}

/**
 * Reads the tools of `tool`'s app again, asked as `access` has it, once a call has found its server no
 * longer lists the tool as it was picked, so that the agents' pages say so, and how it's described now,
 * or that its server has no tools any more. A server that doesn't answer leaves the app as it was, and
 * the tool uncalled all the same.
 */
async function readAgain(env: Env, tool: GivenTool, access: AppCallAccess): Promise<void> {
  try {
    const read = await appConnector(env).read(access.url, access.key, true);
    if (!("error" in read)) await workspace(env).keepAppRead(tool.appId, read, access);
  } catch (error) {
    console.error(`Reading the tools of app ${tool.appId} again, after a call found one changed, failed: ${error instanceof Error ? error.name : "unknown error"}`);
  }
}

/** Has the Workspace keep the `scope` that `tool`'s app, asked as `access` has it, refused a call for want of. A Workspace that can't be told leaves the call refused all the same. */
async function wantsScope(env: Env, tool: GivenTool, scope: string, access: AppCallAccess): Promise<void> {
  try {
    await workspace(env).keepAppScopeWanted(tool.appId, scope, access);
  } catch (error) {
    console.error(`Keeping what app ${tool.appId} asked for beyond its sign-in failed: ${error instanceof Error ? error.name : "unknown error"}`);
  }
}

/** The block a call's card has its buttons in. */
const CALL_BLOCK = "ember.call";

/**
 * The most characters of what a tool is called with that its card shows, as JSON: a call with more is
 * never asked for, or made, so that nobody allows what they couldn't read, and the room is shown all
 * that an app is sent.
 */
export const MAX_SHOWN_INPUT_LENGTH = 3_000;

/** What a model is told of a call with more than a card shows. */
export const TOO_LONG_TO_SHOW = `Not run: what you called it with is longer than the ${MAX_SHOWN_INPUT_LENGTH.toLocaleString("en-US")} characters, as JSON, that the call's card in the room can show. Call it with less.`;

/** What a tool is called with as its card shows it: nothing for no fields, or else indented JSON. */
const written = (input: Record<string, unknown>) => (Object.keys(input).length === 0 ? "" : JSON.stringify(input, null, 2));

/** What a call's card says once it's answered, or once it waited too long. */
export const CALL_OUTCOMES = {
  allow: (who: string) => `Allowed by ${who}.`,
  deny: (who: string) => `Not allowed by ${who}.`,
  late: () => "Nobody allowed this in time, so it wasn't run. Ask again to try once more.",
};

/** Text shown as it's written: a name like `:tada:` in what a tool is called with is shown as it goes to the app, not as an emoji. */
const plainText = (text: string) => ({ type: "plain_text", text, emoji: false });

/** The blocks every card of a call starts with: its `header`, the tool and what it's called with, in plain text, as the app and the model wrote them, and a `note` under them. */
function callBlocks(header: string, { name }: GivenTool, input: Record<string, unknown>, note: string): Record<string, unknown>[] {
  const shown = written(input);
  return [
    { type: "header", text: plainText(header) },
    { type: "section", text: plainText(shown === "" ? `${name}, with nothing` : `${name}, with:\n${shown}`) },
    { type: "context", elements: [plainText(note)] },
  ];
}

/** What the card of a call that waits says of who can allow it, and as whom it goes: with Ember's token or sign-in, or, for a tool that's the asker's `own`, as them. */
export const callNote = (askerName: string, { appName, own }: Pick<GivenTool, "appName" | "own">) =>
  own
    ? `${askerName} can allow this call. It goes to ${appName} as ${askerName}, with the sign-in they made to it themselves.`
    : `${askerName} or an administrator can allow this call. It goes to ${appName} with the token an administrator connected it with.`;

/**
 * The card a room posts for a call that waits, as a Slack payload: who wants to use which app, the tool
 * and what it's called with, and Allow once and Deny, or, once it's answered, `outcome` in their place.
 */
export function callCard(botName: string, askerName: string, tool: GivenTool, input: Record<string, unknown>, outcome?: string): SlackPayload {
  const button = (decision: CallDecision, label: string, style?: string) => ({ type: "button", text: plainText(label), action_id: CALL_ACTIONS[decision], ...(style && { style }) });
  const note = outcome ?? callNote(askerName, tool);
  return {
    blocks: [
      ...callBlocks(`${botName} wants to use ${tool.appName}`, tool, input, note),
      ...(outcome === undefined ? [{ type: "actions", block_id: CALL_BLOCK, elements: [button("allow", "Allow once", "primary"), button("deny", "Deny")] }] : []),
    ],
  };
}

/** What the card of a call made without asking first says of why it was. */
export const alwaysAllowedFor = (botName: string) => `An administrator always allows ${botName} this tool, so nobody was asked first.`;

/** What the card of a call made without asking first says once the call wasn't made after all: it found its tool changed, couldn't ask its server for it, or was refused for want of access. */
export const unmadeFor = (botName: string, appName: string, why: Unmade = "changed") =>
  why === "changed"
    ? `Not run: ${appName} has changed this tool since an administrator picked it for ${botName}, who is without it until one picks it again.`
    : why === "refused"
      ? `Not run: ${wantsMoreAccess(appName)}`
      : `Not run: Ember couldn't get through to ${appName} to make this call.`;

/**
 * The card a room posts for a call made without asking first, as the agent's calls of the tool are
 * always allowed, as a Slack payload: who used which app, the tool and what it was called with, or,
 * once the call wasn't made after all, `unmade`, that it wasn't, and why.
 */
export function usedCard(botName: string, tool: GivenTool, input: Record<string, unknown>, unmade?: Unmade): SlackPayload {
  const header = unmade ? `${botName} didn't use ${tool.appName}` : `${botName} used ${tool.appName}`;
  return { blocks: callBlocks(header, tool, input, unmade ? unmadeFor(botName, tool.appName, unmade) : alwaysAllowedFor(botName)) };
}

/** What the button `action` answers a call that waits with, or undefined for any other button. */
export function callDecisionOf({ id, blockId }: CardAction): CallDecision | undefined {
  if (blockId !== CALL_BLOCK) return undefined;
  return id === CALL_ACTIONS.allow ? "allow" : id === CALL_ACTIONS.deny ? "deny" : undefined;
}
