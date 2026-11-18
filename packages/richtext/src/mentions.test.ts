import { describe, expect, it } from "vitest";
import { prepareBody, writtenBody } from "./body";
import { editableBody, mentionContent, mentionedUsers, mentionPromptItem, mentionSgid, userIdFromSgid, userIdsIn, writtenMentions, type MentionCard } from "./mentions";
import { parseHtml } from "./parse";
import { testUserId as id, testUsers } from "./testing/users";

const { users, resolve } = testUsers("David", "Jason");
const mention = (n: number) => `<action-text-attachment content-type="application/vnd.campfire.mention" sgid="${mentionSgid(id(n))}"></action-text-attachment>`;
const contentAttachment = (content: string) =>
  `<action-text-attachment content-type="text/html" content="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></action-text-attachment>`;

describe("How mentions look", () => {
  it("names users by their ids, which Lexxy keeps where it drops anything shaped like a URL", () => {
    expect(mentionSgid("0mgx5k2p9abc1234")).toBe("0mgx5k2p9abc1234");
    expect(userIdFromSgid("0mgx5k2p9abc1234")).toBe("0mgx5k2p9abc1234");
    // @ember's id is its own, the AI assistant's.
    expect(userIdFromSgid("ember")).toBe("ember");
    for (const sgid of ["gid://ember/User/0mgx5k2p9abc1234", "0MGX5K2P9ABC1234", "0mgx5k2p9abc123", "0mgx5k2p9abc12345", " 0mgx5k2p9abc1234", "0mgx5k2p9abc-234", "", "Ember", "embers", "@ember"]) {
      expect(userIdFromSgid(sgid), sgid).toBeUndefined();
    }
  });

  it("finds the users a body mentions, once each and in order", () => {
    const body = `<p>${mention(2)} and ${mention(1)} and ${mention(2)} and ${mention(3)}</p>`;
    expect(mentionedUsers(parseHtml, body, resolve).map((user) => user.id)).toEqual([id(2), id(1)]);
    expect(mentionedUsers(parseHtml, "<p>Nobody</p>", resolve)).toEqual([]);
  });

  it("lists every user a body's attachments name, to look up, nested ones included", () => {
    expect(userIdsIn(parseHtml, `<p>${mention(2)}${mention(2)}${contentAttachment(mention(7))}</p>`)).toEqual([id(2), id(7)]);
    expect(userIdsIn(parseHtml, `<p>${id(9)} <a href="${id(9)}">x</a></p>`)).toEqual([]);
  });

  it("reads the users' ids as the parser does, character references and all", () => {
    // The first character, written as a reference
    const encoded = (n: number) => `<action-text-attachment sgid="&#${id(n).charCodeAt(0)};${id(n).slice(1)}"></action-text-attachment>`;
    expect(userIdsIn(parseHtml, `${encoded(5)}${contentAttachment(encoded(6))}`)).toEqual([id(5), id(6)]);
    const body = `<p>Hi ${encoded(1)}</p>`;
    const found = new Map(userIdsIn(parseHtml, body).map((userId) => [userId, users.get(userId)]));
    expect(prepareBody(parseHtml, body, (sgid) => found.get(userIdFromSgid(sgid) ?? ""))?.mentions).toEqual([{ id: id(1), name: "David" }]);
  });

  it("lists the users of content attachments as deep as they render", () => {
    let body = "";
    for (let level = 9; level >= 0; level--) body = level === 0 ? `${mention(100)}${body}` : contentAttachment(`${mention(100 + level)}${body}`);
    expect(userIdsIn(parseHtml, body)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108].map(id));
    const resolved = new Set<string>();
    prepareBody(parseHtml, body, (sgid) => void resolved.add(userIdFromSgid(sgid)!));
    expect([...resolved]).toEqual(userIdsIn(parseHtml, body));
  });

  it("opens a stored body for editing with each mention's content, dropping a mention of someone unknown", () => {
    const david = { id: id(1), name: "David", avatarUrl: "/users/1.x/avatar?v=1" };
    const content = mentionContent(david).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const editable = editableBody(parseHtml, `<p>Hi ${mention(1)} and ${mention(2)}</p>`, (userId) => (userId === david.id ? david : undefined), "");
    expect(editable).toBe(`<p>Hi <action-text-attachment content-type="application/vnd.campfire.mention" sgid="${id(1)}" content="${content}"></action-text-attachment> and </p>`);
    expect(editableBody(parseHtml, "<p>Hi <strong>all</strong></p>", () => david, "")).toBe("<p>Hi <strong>all</strong></p>");
  });

  it("skips what's past the parser's limits", () => {
    expect(userIdsIn(parseHtml, `${mention(1)}${"<b>".repeat(401)}`)).toEqual([]);
    expect(userIdsIn(parseHtml, `${mention(1)}${contentAttachment(`${mention(2)}${"<b>".repeat(401)}`)}`)).toEqual([id(1)]);
  });
});

describe("@-mention people", () => {
  const ada = { id: id(1), name: `Ada "<Lovelace>" & co`, avatarUrl: "/users/1.x/avatar?v=1&a=<b>" };
  const avatar = '<img class="avatar" aria-hidden="true" src="/users/1.x/avatar?v=1&amp;a=&lt;b&gt;" width="48" height="48">';
  const name = "Ada &quot;&lt;Lovelace&gt;&quot; &amp; co";

  it("writes a mention as Campfire's _mention partial, with the avatar hidden from screen readers", () => {
    expect(mentionContent(ada)).toBe(`<span class="mention" sgid="${id(1)}">${avatar} ${name}</span>`);
  });

  it("reads whom the editor's markup mentions, once each, in order, by the names their mentions show", () => {
    const grace = { id: id(2), name: "Grace", avatarUrl: "/a.svg" };
    // As Lexxy writes a mention it inserted.
    const written = (person: MentionCard) =>
      `<action-text-attachment sgid="${person.id}" content="${mentionContent(person).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" content-type="application/vnd.campfire.mention"></action-text-attachment>`;
    const body = `<p>Hi ${written(ada)}, ${written(grace)} and ${written(ada)}</p>`;
    expect(writtenMentions(parseHtml, body)).toEqual([
      { id: id(1), name: `Ada "<Lovelace>" & co` },
      { id: id(2), name: "Grace" },
    ]);
    // What the room will make of it, as a message being sent shows until the room says.
    expect(writtenBody(parseHtml, `<p>Hi ${written(grace)}!</p>`)).toEqual({ plainText: "Hi @Grace!", mentions: [{ id: id(2), name: "Grace" }] });
    expect(writtenBody(parseHtml, "<p>Hi all</p>")).toEqual({ plainText: "Hi all", mentions: [] });
    // Campfire's own mentions link the avatar, and a mention without content goes unnamed.
    const linked = `<span class="mention"><a title="Grace" class="btn avatar" href="/users/2"><img src="/a.svg"></a> Grace</span>`;
    expect(writtenMentions(parseHtml, `<ul><li><action-text-attachment sgid="${id(2)}" content="${linked.replaceAll('"', "&quot;")}"></action-text-attachment></li></ul>`)).toEqual([{ id: id(2), name: "Grace" }]);
    expect(writtenMentions(parseHtml, `<p>${mention(1)}</p>`)).toEqual([{ id: id(1), name: "" }]);
    expect(writtenMentions(parseHtml, "<p>Hi @Ada</p>")).toEqual([]);
  });

  it("offers someone as Lexxy's prompt lists them, by avatar and name, with the mention picking them writes", () => {
    expect(mentionPromptItem(ada)).toBe(`<lexxy-prompt-item search="${name}" sgid="${id(1)}">
  <template type="menu"><span class="autocomplete__item">${avatar}<span class="autocompletable__name">${name}</span></span></template>
  <template type="editor">${mentionContent(ada)}</template>
</lexxy-prompt-item>
`);
  });

  it("badges an agent after its name in the prompt, but not in the mention picking it writes", () => {
    const ember = { id: "ember", name: "Ember", avatarUrl: "/users/ember.x/avatar?v=1" };
    const emberAvatar = '<img class="avatar" aria-hidden="true" src="/users/ember.x/avatar?v=1" width="48" height="48">';
    expect(mentionPromptItem({ ...ember, agent: true })).toBe(`<lexxy-prompt-item search="Ember" sgid="ember">
  <template type="menu"><span class="autocomplete__item">${emberAvatar}<span class="autocompletable__name">Ember</span> <span class="autocompletable__badge">Agent</span></span></template>
  <template type="editor">${mentionContent(ember)}</template>
</lexxy-prompt-item>
`);
    expect(mentionPromptItem({ ...ada, agent: false })).toBe(mentionPromptItem(ada));
  });

  it("shows someone's @username after their name in the prompt, escaped, but not in the mention picking them writes", () => {
    expect(mentionPromptItem({ ...ada, username: "ada<3" })).toBe(`<lexxy-prompt-item search="${name}" sgid="${id(1)}">
  <template type="menu"><span class="autocomplete__item">${avatar}<span class="autocompletable__name">${name}</span> <span class="autocompletable__username">@ada&lt;3</span></span></template>
  <template type="editor">${mentionContent(ada)}</template>
</lexxy-prompt-item>
`);
  });
});
