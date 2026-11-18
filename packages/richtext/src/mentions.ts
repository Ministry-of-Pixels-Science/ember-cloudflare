// Mentions: `<action-text-attachment>` elements whose `sgid` names a user. Ember's sgid is the user's
// id. Campfire's are signed global ids, but any member can list every user's, so a signature protects
// nothing; and Lexxy, the composer, drops an sgid that starts like a URL, as `gid://` does, since
// DOMPurify vets every attribute's value as one.

import { attachmentNodes, loadContent, MAX_CONTENT_ATTACHMENT_DEPTH, sanitizeContentAttribute } from "./content";
import { detach, getAttr, setAttr, textContent, type Element } from "./tree";
import { OPENGRAPH_EMBED_CONTENT_TYPE, opengraphEmbedFromNode, type MentionUser, type ResolveMention } from "./attachments";
import { BODY, ParseLimitError, type HtmlParser } from "./markup";
import { isPlainParagraph } from "./plain-paragraph";
import { previewContent } from "./previews";
import { htmlEscape } from "./ruby";
import { toHtml } from "./serialize";

/** An Ember id: 16 lowercase base-36 characters (the Worker's `sortableId`), or @ember's, which is its own (`ASSISTANT_ID`). */
const USER_ID = /^(?:[0-9a-z]{16}|ember)$/;

/** The sgid that names a user in a mention. */
export function mentionSgid(userId: string): string {
  return userId;
}

/** The id of the user an sgid names, if it names one. */
export function userIdFromSgid(sgid: string): string | undefined {
  return USER_ID.test(sgid) ? sgid : undefined;
}

/** Someone as a mention shows them, by their avatar too. */
export interface MentionCard extends MentionUser {
  /** Their avatar's address. */
  avatarUrl: string;
}

/**
 * Campfire's users/_mention.html.erb: a mention as the editor shows it, the content of its attachment.
 * Unlike Campfire's, its avatar doesn't link to the person's page, which would leave what's being
 * written: a click on it picks the mention, to move or delete it, as a click on the name does.
 */
export function mentionContent({ id, name, avatarUrl }: MentionCard): string {
  return `<span class="mention" sgid="${htmlEscape(mentionSgid(id))}">${avatarTag(avatarUrl)} ${htmlEscape(name)}</span>`;
}

/**
 * Someone as Lexxy's mentions prompt offers them: as a mention shows them, with their username, if they
 * have one, and whether they're an AI agent, as @ember is.
 */
export interface PromptCard extends MentionCard {
  username?: string;
  agent?: boolean;
}

/**
 * Campfire's autocompletable/users/_prompt_item.html.erb: someone as Lexxy's mentions prompt offers
 * them, by their avatar and name, then their @username, if they have one, with a badge saying so after
 * an agent's, and the mention picking them writes. Unlike Campfire's, the avatar isn't a link: a click
 * anywhere on someone listed picks them, and screen readers can't reach a link in a list's option, whose
 * content ARIA makes presentational.
 */
export function mentionPromptItem(person: PromptCard): string {
  const name = htmlEscape(person.name);
  const username = person.username ? ` <span class="autocompletable__username">@${htmlEscape(person.username)}</span>` : "";
  const badge = person.agent ? ` <span class="autocompletable__badge">Agent</span>` : "";
  return `<lexxy-prompt-item search="${name}" sgid="${htmlEscape(mentionSgid(person.id))}">
  <template type="menu"><span class="autocomplete__item">${avatarTag(person.avatarUrl)}<span class="autocompletable__name">${name}</span>${username}${badge}</span></template>
  <template type="editor">${mentionContent(person)}</template>
</lexxy-prompt-item>
`;
}

/**
 * The markup the editor opens with for a body Ember stored: each mention given the content Lexxy shows
 * it by, since Lexxy drops an attachment without content. A mention of someone `card` doesn't know goes.
 * Each link preview is written again from what it shows on `host`, the one the page is served from, so
 * that the editor no more loads an image from this Ember than the message does.
 */
export function editableBody(parse: HtmlParser, stored: string, card: (userId: string) => MentionCard | undefined, host: string): string {
  if (isPlainParagraph(stored)) return stored;
  const content = parse(stored, BODY);
  for (const attachment of attachmentNodes(content)) {
    if (getAttr(attachment, "content-type") === OPENGRAPH_EMBED_CONTENT_TYPE) {
      sanitizeContentAttribute(parse, attachment);
      setAttr(attachment, "content", previewContent(opengraphEmbedFromNode(parse, attachment, host)));
      continue;
    }
    const userId = userIdFromSgid(getAttr(attachment, "sgid") ?? "");
    const person = userId === undefined ? undefined : card(userId);
    if (person) setAttr(attachment, "content", mentionContent(person));
    else detach(attachment);
  }
  return toHtml(content, { escapeAttributeBrackets: true });
}

/**
 * Whom markup the editor wrote mentions, once each, in order, named as their mentions show them: by the
 * text of each one's content, as the people search wrote it (`mentionContent`). Throws `ParseLimitError`
 * past the parser's limits.
 */
export function writtenMentions(parse: HtmlParser, markup: string): MentionUser[] {
  if (isPlainParagraph(markup)) return [];
  const people = new Map<string, MentionUser>();
  for (const attachment of attachmentNodes(parse(markup, BODY))) {
    const id = userIdFromSgid(getAttr(attachment, "sgid") ?? "");
    if (id === undefined || people.has(id)) continue;
    people.set(id, { id, name: textContent(parse(getAttr(attachment, "content") ?? "", BODY)).trim() });
  }
  return [...people.values()];
}

/** Campfire's `avatar_tag` (users/avatars_helper.rb), without its link: an image screen readers skip. */
const avatarTag = (url: string) => `<img class="avatar" aria-hidden="true" src="${htmlEscape(url)}" width="48" height="48">`;

/**
 * Every user an attachment's sgid names, in the body or in the content attachments that render
 * inside it, once each: the users to look up before resolving the body's mentions. The sgids are
 * read as parsed, character references and all. Markup past the parser's limits is skipped, since
 * `prepareBody` refuses it anyway.
 */
export function userIdsIn(parse: HtmlParser, markup: string): string[] {
  if (isPlainParagraph(markup)) return [];
  const ids = new Set<string>();
  const collect = (markup: string, depth: number) => {
    let attachments: Element[];
    try {
      attachments = attachmentNodes(parse(markup, BODY));
    } catch (error) {
      if (error instanceof ParseLimitError) return;
      throw error;
    }
    for (const attachment of attachments) {
      const id = userIdFromSgid(getAttr(attachment, "sgid") ?? "");
      if (id !== undefined) ids.add(id);
      const content = getAttr(attachment, "content");
      if (content !== undefined && depth < MAX_CONTENT_ATTACHMENT_DEPTH) collect(content, depth + 1);
    }
  };
  collect(markup, 0);
  return [...ids];
}

/**
 * `Message::Mentionee#mentioned_users`: the users the body's attachments resolve to, once each, in
 * order. Throws `ParseLimitError` past the parser's limits.
 */
export function mentionedUsers(parse: HtmlParser, markup: string, resolve: ResolveMention): MentionUser[] {
  return usersAttached(attachmentNodes(loadContent(parse, markup)), resolve);
}

/** The users attachments of a loaded body resolve to, once each, in order. */
export function usersAttached(attachments: Element[], resolve: ResolveMention): MentionUser[] {
  const users = new Map<string, MentionUser>();
  for (const node of attachments) {
    const sgid = getAttr(node, "sgid");
    const user = sgid === undefined ? undefined : resolve(sgid);
    if (user && !users.has(user.id)) users.set(user.id, user);
  }
  return [...users.values()];
}
