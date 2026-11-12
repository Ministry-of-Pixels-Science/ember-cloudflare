import { describe, expect, it } from "vitest";
import {
  ASSISTANT_NAME,
  canBeCustomDomain,
  CUSTOM_DOMAIN_NOT_A_HOST,
  DEFAULT_NAVIGATION_ICONS,
  domainOfEmailAddress,
  domainsInWords,
  EMAIL_ADDRESS_NEEDED,
  EMAIL_DOMAINS_REFUSED,
  EMAIL_FROM_REFUSED,
  EMAIL_SIGN_UP_PATH,
  MAX_OTHER_ADDRESSES,
  emailAddressesIn,
  emailDomainOf,
  emailSignUpLink,
  INVITATION_PATH,
  invitationLink,
  INVITATIONS_AT_ONCE,
  INVOLVEMENTS,
  isEmailAddress,
  isReservedName,
  isInvolvement,
  isMessageTooLong,
  isNewer,
  isPasswordTooLong,
  isPasswordTooShort,
  isRoomIcon,
  isRoomId,
  joiningProblemOf,
  joinsWithLink,
  mailboxOf,
  mailboxText,
  mailboxUnder,
  MAX_ACCOUNT_NAME_LENGTH,
  MAX_BIO_LENGTH,
  MAX_BOOST_LENGTH,
  MAX_CHECKED_MESSAGES,
  MAX_CUSTOM_STYLES_LENGTH,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_LISTED_USERS,
  MAX_MESSAGE_HTML_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  MAX_SHARED_ORDER,
  MAX_TAGLINE_LENGTH,
  MAX_TURNSTILE_TOKEN_LENGTH,
  MAX_USER_NAME_LENGTH,
  memberfulProblemOf,
  memberfulSignInPath,
  MIN_PASSWORD_LENGTH,
  NAVIGATION_ICONS_REFUSED,
  NAVIGATION_SLOTS,
  NAME_RESERVED,
  NAME_TOO_LONG,
  NO_EMAIL_ADDRESSES,
  NOT_A_CUSTOM_DOMAIN,
  NOT_AN_EMAIL_ADDRESS,
  onlyAddressesAt,
  othersAfterMove,
  parseAccountChanges,
  parseClientFrame,
  parseCustomDomainCheck,
  parseCustomStyles,
  parseEmailLinkRequest,
  parseInvitationRequest,
  parseEmailLinkSignUp,
  parseInvolvementChange,
  parseNewDirect,
  parseNewRoom,
  parseOpenSignUp,
  parsePasswordReset,
  parsePasswordResetRequest,
  parsePasswordResetWithCode,
  parseMemberfulDisconnection,
  parseProfileChanges,
  parseResendApiKey,
  parseRoleChange,
  parseRoomChanges,
  parseRoomSocketParams,
  parseServerFrame,
  parseSharedOrder,
  parseSignUp,
  parseTurnstileKeysChange,
  parseWorkspaceClientFrame,
  PASSWORD_RESET_CODE_NEEDED,
  PASSWORD_RESET_PATH,
  passwordResetCodeOf,
  PASSWORD_TOO_SHORT,
  RESEND_API_KEY_REFUSED,
  resendApiKeyOf,
  ROOM_ICON_NAMES,
  ROOM_PROTOCOL,
  roomSocketQuery,
  sameName,
  signInSaying,
  signsUpOpenly,
  signsUpWithEmailDomain,
  startingInvolvement,
  suggestedCount,
  TAGLINE_TOO_LONG,
  TURNSTILE_FAILED,
  TURNSTILE_SECRET_KEY_REFUSED,
  TURNSTILE_SITE_KEY_REFUSED,
  turnstileKeyOf,
  EMAIL_ADDRESS_TOO_LONG,
  withEmailAddress,
  withNavigationIcons,
  type WorkspaceServerFrame,
} from "./index";

const parse = (frame: object) => parseClientFrame(JSON.stringify(frame));
/** What a room socket's address with `params` says, as the worker's URLSearchParams reads it. */
const read = (params: Record<string, string>) => parseRoomSocketParams({ get: (name) => params[name] ?? null });

describe("Send a message", () => {
  it("accepts a well-formed message, leaving its markup for the room to read", () => {
    for (const body of ["<p>hi</p>", "  <p>hi</p>\n", "", " "]) {
      expect(parse({ type: "message.create", clientMessageId: "c1", body }), body).toEqual({ type: "message.create", clientMessageId: "c1", body });
    }
    expect(parse({ type: "message.update", messageId: "m1", body: "" })).toEqual({ type: "message.update", messageId: "m1", body: "" });
  });

  it("rejects bodies that aren't strings, unknown types and invalid JSON", () => {
    expect(parse({ type: "message.create", clientMessageId: "c1", body: 7 })).toBeNull();
    expect(parse({ type: "message.update", messageId: "m1" })).toBeNull();
    expect(parse({ type: "nope" })).toBeNull();
    expect(parseClientFrame("{")).toBeNull();
    expect(parseClientFrame("null")).toBeNull();
  });

  it(`limits a message's markup to ${MAX_MESSAGE_HTML_LENGTH} characters and client ids to 64`, () => {
    expect(parse({ type: "message.create", clientMessageId: "c1", body: "x".repeat(MAX_MESSAGE_HTML_LENGTH) })).not.toBeNull();
    expect(parse({ type: "message.create", clientMessageId: "c1", body: "x".repeat(MAX_MESSAGE_HTML_LENGTH + 1) })).toBeNull();
    expect(parse({ type: "message.update", messageId: "m1", body: "x".repeat(MAX_MESSAGE_HTML_LENGTH + 1) })).toBeNull();
    expect(parse({ type: "message.create", clientMessageId: "c".repeat(65), body: "hi" })).toBeNull();
  });

  it(`counts a message's plain text in UTF-16 units, as the room does, up to ${MAX_MESSAGE_LENGTH}`, () => {
    expect(isMessageTooLong("x".repeat(MAX_MESSAGE_LENGTH))).toBe(false);
    expect(isMessageTooLong("x".repeat(MAX_MESSAGE_LENGTH + 1))).toBe(true);
    expect(isMessageTooLong("🔥".repeat(MAX_MESSAGE_LENGTH / 2))).toBe(false);
    expect(isMessageTooLong("🔥".repeat(MAX_MESSAGE_LENGTH / 2 + 1))).toBe(true);
  });

  it("names the room protocol's revision on a room socket's address, which is the first when it doesn't", () => {
    expect(ROOM_PROTOCOL).toBe(4);
    expect(read({ visible: "1", protocol: String(ROOM_PROTOCOL) })).toEqual({ visible: true, protocol: ROOM_PROTOCOL });
    expect(read({ visible: "1" })).toEqual({ visible: true, protocol: 1 });
    expect(read({ protocol: "two" })).toEqual({ visible: true, protocol: 1 });
  });
});

describe("Threads", () => {
  it("sends a reply to a message's thread, and to the room too only when it says so", () => {
    const reply = { type: "message.create", clientMessageId: "c1", body: "<p>hi</p>", parentId: "m1" };
    expect(parse(reply)).toEqual({ ...reply, alsoSend: false });
    expect(parse({ ...reply, alsoSend: true })).toEqual({ ...reply, alsoSend: true });
    expect(parse({ ...reply, alsoSend: "yes" })).toEqual({ ...reply, alsoSend: false });
    expect(parse({ type: "message.create", clientMessageId: "c1", body: "", alsoSend: true })).toEqual({ type: "message.create", clientMessageId: "c1", body: "" });
    for (const parentId of [null, "", 42, "x".repeat(65)]) expect(parse({ ...reply, parentId }), String(parentId)).toBeNull();
  });

  it("opens a thread, pages back through its replies as history does, and closes it", () => {
    expect(parse({ type: "thread.open", parentId: "m1" })).toEqual({ type: "thread.open", parentId: "m1" });
    expect(parse({ type: "thread.close", parentId: "m1" })).toEqual({ type: "thread.close", parentId: "m1" });
    expect(parse({ type: "thread.before", parentId: "m1", before: "r1", limit: 5000 })).toEqual({ type: "thread.before", parentId: "m1", before: "r1", limit: 100 });
    expect(parse({ type: "thread.before", parentId: "m1", before: "r1" })).toEqual({ type: "thread.before", parentId: "m1", before: "r1", limit: undefined });
    for (const bad of [undefined, "", 42, "x".repeat(65)]) {
      expect(parse({ type: "thread.open", parentId: bad }), String(bad)).toBeNull();
      expect(parse({ type: "thread.close", parentId: bad }), String(bad)).toBeNull();
      expect(parse({ type: "thread.before", parentId: bad, before: "r1" }), String(bad)).toBeNull();
      expect(parse({ type: "thread.before", parentId: "m1", before: bad }), String(bad)).toBeNull();
    }
  });
});

describe("Custom reactions", () => {
  it("limits reactions to the stored column width", () => {
    expect(parse({ type: "boost.create", messageId: "m1", content: "x".repeat(MAX_BOOST_LENGTH) })).not.toBeNull();
    expect(parse({ type: "boost.create", messageId: "m1", content: "x".repeat(MAX_BOOST_LENGTH + 1) })).toBeNull();
  });
});

describe("Scroll back through history", () => {
  it("clamps history page sizes", () => {
    expect(parse({ type: "history.before", before: "m1", limit: 5000 })).toEqual({ type: "history.before", before: "m1", limit: 100 });
    expect(parse({ type: "history.before", before: "m1", limit: 0 })).toEqual({ type: "history.before", before: "m1", limit: 1 });
    expect(parse({ type: "history.before", before: "m1" })).toEqual({ type: "history.before", before: "m1", limit: undefined });
    expect(parse({ type: "history.after", after: "m1", limit: 5000 })).toEqual({ type: "history.after", after: "m1", limit: 100 });
    expect(parse({ type: "history.after", after: "m1", limit: 2.5 })).toEqual({ type: "history.after", after: "m1", limit: 2 });
  });

  it("pages from a message's id, which history can't do without", () => {
    for (const cursor of [undefined, "", 42, "x".repeat(65)]) {
      expect(parse({ type: "history.before", before: cursor }), String(cursor)).toBeNull();
      expect(parse({ type: "history.after", after: cursor }), String(cursor)).toBeNull();
    }
  });
});

describe("Link to a message", () => {
  it("asks for the page around a message, or the newest page when it names none", () => {
    expect(parse({ type: "history.around", messageId: "m1" })).toEqual({ type: "history.around", messageId: "m1" });
    expect(parse({ type: "history.around" })).toEqual({ type: "history.around", messageId: undefined });
    for (const messageId of ["", 42, null, "x".repeat(65)]) expect(parse({ type: "history.around", messageId }), String(messageId)).toBeNull();
  });

  it("carries the message a permalink names on the room socket's address", () => {
    expect(roomSocketQuery({ visible: true, around: "01J9 Z/3" })).toBe(`?visible=1&protocol=${ROOM_PROTOCOL}&around=01J9%20Z%2F3`);
    const read = (params: Record<string, string>) => parseRoomSocketParams({ get: (name) => params[name] ?? null }).around;
    expect(read({ around: "01J9Z3" })).toBe("01J9Z3");
    for (const around of ["", "x".repeat(65)]) expect(read({ around }), around).toBeUndefined();
    expect(read({})).toBeUndefined();
  });
});

describe("Catch up after a reconnect", () => {
  it("checks a bounded list of client message ids", () => {
    const check = (clientMessageIds: unknown) => parse({ type: "message.check", clientMessageIds });
    expect(check(["c1", "c2"])).toEqual({ type: "message.check", clientMessageIds: ["c1", "c2"] });
    expect(check(Array.from({ length: MAX_CHECKED_MESSAGES }, (_, i) => `c${i}`))).not.toBeNull();

    for (const clientMessageIds of [[], "c1", ["c1", 2], ["c1", ""], ["x".repeat(65)], Array.from({ length: MAX_CHECKED_MESSAGES + 1 }, (_, i) => `c${i}`)]) {
      expect(check(clientMessageIds), JSON.stringify(clientMessageIds)).toBeNull();
    }
  });

  it("carries the latest change a tab has seen on its room socket's address, as a whole number", () => {
    expect(roomSocketQuery({ visible: true, since: 0 })).toBe(`?visible=1&protocol=${ROOM_PROTOCOL}&since=0`);
    expect(roomSocketQuery({ visible: false, since: 42 })).toBe(`?visible=0&protocol=${ROOM_PROTOCOL}&since=42`);
    const read = (params: Record<string, string>) => parseRoomSocketParams({ get: (name) => params[name] ?? null }).since;
    expect(read({ visible: "1", since: "42" })).toBe(42);
    expect(read({ since: "0" })).toBe(0);
    for (const since of ["", "-1", "1.5", "1e3", "0x10", " 42", "9".repeat(16)]) expect(read({ since }), since).toBeUndefined();
    expect(read({})).toBeUndefined();
  });
});

describe("Presence", () => {
  it("takes whether a tab is shown, as a boolean", () => {
    expect(parse({ type: "presence.visible", visible: false })).toEqual({ type: "presence.visible", visible: false });
    expect(parse({ type: "presence.visible", visible: true, extra: 1 })).toEqual({ type: "presence.visible", visible: true });
    for (const visible of [undefined, null, 1, "true", "visible"]) {
      expect(parse({ type: "presence.visible", visible }), String(visible)).toBeNull();
    }
  });

  it("carries whether a tab is shown on its room socket's address, which counts it as shown when it doesn't say", () => {
    expect(roomSocketQuery({ visible: true })).toBe(`?visible=1&protocol=${ROOM_PROTOCOL}`);
    expect(roomSocketQuery({ visible: false })).toBe(`?visible=0&protocol=${ROOM_PROTOCOL}`);
    expect(read({ visible: "1" })).toMatchObject({ visible: true });
    expect(read({ visible: "0" })).toMatchObject({ visible: false });
    expect(read({})).toMatchObject({ visible: true });
    expect(read({ visible: "yes" })).toMatchObject({ visible: true });
  });
});

describe("One live connection per tab outside the open room", () => {
  it("takes only pings on the workspace socket", () => {
    expect(parseWorkspaceClientFrame('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseWorkspaceClientFrame('{"type":"ping","nonce":"n1"}')).toEqual({ type: "ping" });
    for (const raw of ['{"type":"typing.start"}', '{"type":"message.create","clientMessageId":"c1","body":"hi"}', "[]", "null", "{"]) {
      expect(parseWorkspaceClientFrame(raw), raw).toBeNull();
    }
  });

  it("reads the workspace socket's frames as the server sends them", () => {
    const welcome: WorkspaceServerFrame = {
      type: "welcome",
      you: { id: "u1", name: "Ada", administrator: true },
      account: { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false },
    };
    expect(parseServerFrame<WorkspaceServerFrame>(JSON.stringify(welcome))).toEqual(welcome);
    expect(parseServerFrame<WorkspaceServerFrame>('{"type":7}')).toBeNull();
  });
});

describe("Open a room", () => {
  it("takes sortable ids and legacy rooms' addresses as room ids, and nothing else", () => {
    expect(isRoomId("mgp3x2c4a1b2c3d4")).toBe(true);
    expect(isRoomId("general")).toBe(true);
    expect(isRoomId("dm-ab12")).toBe(true);
    expect(isRoomId("General")).toBe(false);
    expect(isRoomId("-x")).toBe(false);
    expect(isRoomId("a/b")).toBe(false);
    expect(isRoomId("_health")).toBe(false);
    expect(isRoomId("x".repeat(64))).toBe(false);
  });
});

describe("Room icons", () => {
  it("takes the name of every icon in the catalog, Lucide's and Iconoir's", () => {
    expect(ROOM_ICON_NAMES).toHaveLength(3540);
    expect(ROOM_ICON_NAMES).toEqual(expect.arrayContaining(["coffee", "rocket", "star", "hash", "iconoir:regular:coffee-cup", "iconoir:solid:heart"]));
    expect(ROOM_ICON_NAMES.filter((name) => !isRoomIcon(name))).toEqual([]);
  });

  it("refuses anything that isn't exactly one", () => {
    const values = ["not-a-lucide-icon", "../coffee", "<svg></svg>", " coffee ", "Coffee", "home", "constructor", "", null, true, [], ["coffee"], 7, {}];
    const iconoir = ["lucide:house", "iconoir:heart", "iconoir:solid:../heart", "iconoir:regular:not-an-icon", "iconoir:Regular:coffee-cup"];
    expect([...values, ...iconoir].filter(isRoomIcon)).toEqual([]);
  });

  it('takes a new or changed room\'s icon, "" for the default, or none, which keeps the one it has', () => {
    expect(parseNewRoom({ kind: "open", name: "Design", icon: "coffee" })).toEqual({ kind: "open", name: "Design", icon: "coffee" });
    expect(parseNewRoom({ kind: "closed", name: "Leads", icon: "" })).toEqual({ kind: "closed", name: "Leads", icon: "", memberIds: [] });
    expect(parseRoomChanges({ icon: "rocket" })).toEqual({ icon: "rocket" });
    expect(parseRoomChanges({ icon: "iconoir:solid:heart" })).toEqual({ icon: "iconoir:solid:heart" });
    expect(parseRoomChanges({ icon: "", kind: "open" })).toEqual({ icon: "", kind: "open" });
    expect(parseRoomChanges({ name: "Design" })).toHaveProperty("icon", undefined);
  });

  it.each(["not-a-lucide-icon", "../coffee", "<svg></svg>", " coffee ", "Coffee", null, true, []])("refuses the icon %j", (icon) => {
    const refused = 'Icon must be one of the room icons, or "" for the default';
    expect(parseNewRoom({ kind: "open", name: "Design", icon })).toBe(refused);
    expect(parseRoomChanges({ name: "Design", icon })).toBe(refused);
  });
});

describe("Create an open room", () => {
  it("takes a kind and a trimmed name", () => {
    expect(parseNewRoom({ kind: "open", name: "  Design  " })).toEqual({ kind: "open", name: "Design" });
    expect(parseNewRoom({ kind: "open", name: "x".repeat(MAX_ROOM_NAME_LENGTH) })).toEqual({ kind: "open", name: "x".repeat(MAX_ROOM_NAME_LENGTH) });
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["a list", [], 'Kind must be "open" or "closed"'],
    ["no kind", { name: "Design" }, 'Kind must be "open" or "closed"'],
    ["a direct message", { kind: "direct", name: "Design" }, 'Kind must be "open" or "closed"'],
    ["no name", { kind: "open" }, `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`],
    ["a blank name", { kind: "open", name: "   " }, `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`],
    ["a name that isn't text", { kind: "open", name: 42 }, `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`],
    ["a name that's too long", { kind: "open", name: "x".repeat(MAX_ROOM_NAME_LENGTH + 1) }, `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseNewRoom(body)).toBe(error);
  });
});

describe("Create a private room", () => {
  it("takes a closed room's members, or nobody", () => {
    expect(parseNewRoom({ kind: "closed", name: "Leads", memberIds: ["u1", "u2"] })).toEqual({ kind: "closed", name: "Leads", memberIds: ["u1", "u2"] });
    expect(parseNewRoom({ kind: "closed", name: "Leads" })).toEqual({ kind: "closed", name: "Leads", memberIds: [] });
  });

  it("refuses members that aren't a bounded list of ids", () => {
    const tooMany = Array.from({ length: MAX_LISTED_USERS + 1 }, (_, i) => `u${i}`);
    for (const memberIds of ["u1", [1], [""], ["x".repeat(65)], tooMany]) {
      expect(parseNewRoom({ kind: "closed", name: "Leads", memberIds }), JSON.stringify(memberIds).slice(0, 40)).toBe(`Members must be a list of at most ${MAX_LISTED_USERS} user ids`);
    }
    expect(parseNewRoom({ kind: "closed", name: "Leads", memberIds: tooMany.slice(1) })).not.toBeTypeOf("string");
  });
});

describe("Room settings page", () => {
  it("takes a trimmed name, or nothing to change", () => {
    expect(parseRoomChanges({ name: "  Design  " })).toEqual({ name: "Design" });
    expect(parseRoomChanges({})).toEqual({});
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["a blank name", { name: "   " }, `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`],
    ["a name that isn't text", { name: null }, `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`],
    ["a name that's too long", { name: "x".repeat(MAX_ROOM_NAME_LENGTH + 1) }, `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`],
    ["a direct message", { kind: "direct" }, 'Kind must be "open" or "closed"'],
    ["a kind that isn't one", { name: "Design", kind: "secret" }, 'Kind must be "open" or "closed"'],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseRoomChanges(body)).toBe(error);
  });
});

describe("Switch a room between open and private", () => {
  it("takes making a room open, with or without a new name, and ignores members it doesn't need", () => {
    expect(parseRoomChanges({ kind: "open" })).toEqual({ kind: "open" });
    expect(parseRoomChanges({ name: " Design ", kind: "open", memberIds: ["u1"] })).toEqual({ name: "Design", kind: "open" });
  });
});

describe("Add and remove private room members", () => {
  it("takes a private room's members, even nobody", () => {
    expect(parseRoomChanges({ name: "Leads", kind: "closed", memberIds: ["u1", "u2"] })).toEqual({ name: "Leads", kind: "closed", memberIds: ["u1", "u2"] });
    expect(parseRoomChanges({ kind: "closed", memberIds: [] })).toEqual({ kind: "closed", memberIds: [] });
  });

  it("refuses making a room private without its members listed, since everyone left out is taken out", () => {
    const tooMany = Array.from({ length: MAX_LISTED_USERS + 1 }, (_, i) => `u${i}`);
    for (const memberIds of [undefined, "u1", [1], [""], tooMany]) {
      expect(parseRoomChanges({ kind: "closed", memberIds }), JSON.stringify(memberIds)?.slice(0, 40)).toBe(`Members must be a list of at most ${MAX_LISTED_USERS} user ids`);
    }
  });
});

describe("Start or reopen a direct message", () => {
  it("takes the people to start a DM with, or nobody, for a DM with yourself", () => {
    expect(parseNewDirect({ userIds: ["u1", "u2"] })).toEqual({ userIds: ["u1", "u2"] });
    expect(parseNewDirect({ userIds: [] })).toEqual({ userIds: [] });
    expect(parseNewDirect({})).toEqual({ userIds: [] });
  });

  it("refuses anything but a bounded list of ids", () => {
    const tooMany = Array.from({ length: MAX_LISTED_USERS + 1 }, (_, i) => `u${i}`);
    for (const body of [null, [], "u1", { userIds: "u1" }, { userIds: [1] }, { userIds: [""] }, { userIds: null }, { userIds: tooMany }]) {
      const refused = Array.isArray(body) || typeof body !== "object" || body === null ? "Expected a JSON object" : `People must be a list of at most ${MAX_LISTED_USERS} user ids`;
      expect(parseNewDirect(body), JSON.stringify(body).slice(0, 40)).toBe(refused);
    }
    expect(parseNewDirect({ userIds: tooMany.slice(1) })).not.toBeTypeOf("string");
  });
});

describe("Suggested people", () => {
  it("suggests 20 people less those in your DMs, you included, and one more", () => {
    expect(suggestedCount(0)).toBe(19);
    expect(suggestedCount(1)).toBe(18);
    expect(suggestedCount(2)).toBe(17);
    expect(suggestedCount(19)).toBe(0);
    expect(suggestedCount(25)).toBe(0);
  });
});

describe("Rename the workspace", () => {
  it("takes the workspace's name as typed, even blank, or nothing to change", () => {
    expect(parseAccountChanges({ name: "  Ember Studio " })).toEqual({ name: "  Ember Studio " });
    expect(parseAccountChanges({ name: "" })).toEqual({ name: "" });
    expect(parseAccountChanges({ name: "x".repeat(MAX_ACCOUNT_NAME_LENGTH) })).toEqual({ name: "x".repeat(MAX_ACCOUNT_NAME_LENGTH) });
    expect(parseAccountChanges({})).toEqual({});
    expect(parseAccountChanges({ logo: "earth.png" })).toEqual({});
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["a list", [{ name: "Ember Studio" }], "Expected a JSON object"],
    ["a name that isn't text", { name: 7 }, `Name must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`],
    ["a name that's too long", { name: "x".repeat(MAX_ACCOUNT_NAME_LENGTH + 1) }, `Name must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseAccountChanges(body)).toBe(error);
  });
});

describe("Workspace tagline", () => {
  it("takes a tagline on one line, with no space at either end, or blank for none, with the name or alone", () => {
    expect(parseAccountChanges({ tagline: "Engines for every occasion" })).toEqual({ tagline: "Engines for every occasion" });
    expect(parseAccountChanges({ name: "Ember", tagline: " Engines\tfor\r\nevery\u00a0 occasion  " })).toEqual({ name: "Ember", tagline: "Engines for every occasion" });
    expect(parseAccountChanges({ tagline: "" })).toEqual({ tagline: "" });
    expect(parseAccountChanges({ tagline: " \n " })).toEqual({ tagline: "" });
  });

  it("counts its characters as it's kept", () => {
    const longest = "x".repeat(MAX_TAGLINE_LENGTH);
    expect(parseAccountChanges({ tagline: longest })).toEqual({ tagline: longest });
    expect(parseAccountChanges({ tagline: `  ${longest}\n` })).toEqual({ tagline: longest });
    expect(parseAccountChanges({ tagline: `x${" ".repeat(10_000)}y` })).toEqual({ tagline: "x y" });
    expect(parseAccountChanges({ tagline: `${longest}x` })).toBe(TAGLINE_TOO_LONG);
    expect(parseAccountChanges({ tagline: `${longest} x` })).toBe(TAGLINE_TOO_LONG);
  });

  it.each([
    ["null", { tagline: null }],
    ["a number", { tagline: 30 }],
    ["a list", { tagline: ["Engines"] }],
    ["a good name beside a bad tagline", { name: "Ember Studio", tagline: false }],
  ])("refuses %s and says why", (_, body) => {
    expect(parseAccountChanges(body)).toBe(TAGLINE_TOO_LONG);
  });
});

describe("Translation buttons", () => {
  it("takes Hide translation buttons as true or false, with the name or alone", () => {
    expect(parseAccountChanges({ settings: { hideTranslationButtons: false } })).toEqual({ settings: { hideTranslationButtons: false } });
    expect(parseAccountChanges({ name: "Ember Studio", settings: { hideTranslationButtons: true } })).toEqual({
      name: "Ember Studio",
      settings: { hideTranslationButtons: true },
    });
    expect(parseAccountChanges({ settings: {} })).toEqual({ settings: {} });
  });

  it.each([
    ["settings that aren't an object", { settings: [true] }, "Settings must be a JSON object"],
    ["a setting that isn't true or false", { settings: { hideTranslationButtons: "false" } }, "Hide translation buttons must be true or false"],
    ["a setting it doesn't know", { settings: { hideTranslationButtons: true, allowGuests: true } }, "Unknown setting: allowGuests"],
    ["a setting named for an object's own methods", { settings: { toString: true } }, "Unknown setting: toString"],
    ["a good setting beside a bad name", { name: 7, settings: { hideTranslationButtons: true } }, `Name must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseAccountChanges(body)).toBe(error);
  });
});

describe("Navigation icons", () => {
  it("takes an icon for any of the rail's buttons and appearance modes, or \"\" for its own", () => {
    expect(parseAccountChanges({ navigationIcons: { home: "coffee", dark: "iconoir:solid:heart", search: "" } })).toEqual({
      navigationIcons: { home: "coffee", dark: "iconoir:solid:heart", search: "" },
    });
    expect(parseAccountChanges({ name: "Ember", navigationIcons: {} })).toEqual({ name: "Ember", navigationIcons: {} });
    expect(parseAccountChanges({ name: "Ember" })).toEqual({ name: "Ember" });
  });

  it("takes a slot's own icon as its default", () => {
    expect(NAVIGATION_SLOTS.every((slot) => isRoomIcon(DEFAULT_NAVIGATION_ICONS[slot]))).toBe(true);
    expect(parseAccountChanges({ navigationIcons: { home: "iconoir:regular:home", dms: "iconoir:regular:home" } })).toEqual({
      navigationIcons: { home: "", dms: "iconoir:regular:home" },
    });
  });

  it.each([
    ["a slot it doesn't know", { settings: "coffee" }],
    ["a slot named like an object's own", { constructor: "coffee" }],
    ["markup", { home: "<svg></svg>" }],
    ["an icon's name in capitals", { home: "Coffee" }],
    ["an Iconoir variant it doesn't know", { home: "iconoir:unknown:coffee-cup" }],
    ["a path", { home: "iconoir:regular:../coffee-cup" }],
    ["null", { home: null }],
    ["a list of icons", { home: ["coffee"] }],
  ])("refuses %s", (_, navigationIcons) => {
    expect(parseAccountChanges({ navigationIcons })).toBe(NAVIGATION_ICONS_REFUSED);
  });

  it("refuses anything but an object of slots", () => {
    for (const navigationIcons of ["coffee", null, [], ["home"], 42]) expect(parseAccountChanges({ navigationIcons })).toBe(NAVIGATION_ICONS_REFUSED);
  });

  it("changes only the slots a change names, giving \"\" its default again", () => {
    expect(withNavigationIcons({ home: "coffee", dms: "mail" }, { home: "", dark: "moon-star" })).toEqual({ dms: "mail", dark: "moon-star" });
    expect(withNavigationIcons({ home: "coffee" }, {})).toEqual({ home: "coffee" });
  });
});

describe("Custom domain", () => {
  it("takes a custom domain as a host, with its port where it has one, or null for none", () => {
    expect(parseAccountChanges({ customDomain: "chat.example.com" })).toEqual({ customDomain: "chat.example.com" });
    expect(parseAccountChanges({ customDomain: "chat.example.com:8443" })).toEqual({ customDomain: "chat.example.com:8443" });
    expect(parseAccountChanges({ customDomain: "xn--bcher-kva.example" })).toEqual({ customDomain: "xn--bcher-kva.example" });
    const longest = `${"a".repeat(63)}.`.repeat(3) + "a".repeat(61);
    expect(parseAccountChanges({ customDomain: `${longest}:65535` })).toEqual({ customDomain: `${longest}:65535` });
    expect(parseAccountChanges({ customDomain: null })).toEqual({ customDomain: null });
    expect(parseAccountChanges({ name: "Ember Studio", customDomain: null })).toEqual({ name: "Ember Studio", customDomain: null });
  });

  it.each([
    ["an address with its scheme", "https://chat.example.com"],
    ["one with a path", "chat.example.com/"],
    ["capitals, which location.host never has", "Chat.Example.com"],
    ["nothing", ""],
    ["an empty label", "chat..example.com"],
    ["a port without a host", ":8443"],
    ["a port past 65535, which no URL has", "chat.example.com:65536"],
    ["port 0, where nothing answers", "chat.example.com:0"],
    ["a port with a leading zero, which location.host never has", "chat.example.com:08443"],
    ["a name longer than DNS allows", `${"a".repeat(63)}.`.repeat(3) + "a".repeat(62)],
    ["a number", 42],
    ["a list", ["chat.example.com"]],
  ])("refuses %s", (_, customDomain) => {
    expect(parseAccountChanges({ customDomain })).toBe(CUSTOM_DOMAIN_NOT_A_HOST);
  });

  it("can't be where a deploy or wrangler dev puts Ember, but can be a name under localhost", () => {
    for (const hostname of ["ember.kro.workers.dev", "workers.dev", "Ember.Kro.Workers.Dev", "localhost", "127.0.0.1", "127.8.0.1", "[::1]"]) expect([hostname, canBeCustomDomain(hostname)]).toEqual([hostname, false]);
    for (const hostname of ["chat.example.com", "workers.dev.example.com", "chat.localhost", "example.com"]) expect([hostname, canBeCustomDomain(hostname)]).toEqual([hostname, true]);
  });

  it("checks a domain that could be Ember's, as a host, with its port where it has one", () => {
    expect(parseCustomDomainCheck({ domain: "chat.example.com" })).toEqual({ domain: "chat.example.com" });
    expect(parseCustomDomainCheck({ domain: "chat.localhost:8443" })).toEqual({ domain: "chat.localhost:8443" });
    for (const domain of ["ember.kro.workers.dev", "localhost:8787", "127.0.0.1"]) expect(parseCustomDomainCheck({ domain })).toBe(NOT_A_CUSTOM_DOMAIN);
    for (const body of [{ domain: "https://chat.example.com" }, { domain: "Chat.Example.com" }, { domain: "chat.example.com:99999" }, { domain: "[::1]" }, { domain: 42 }, {}, null, ["chat.example.com"]])
      expect(parseCustomDomainCheck(body)).toBe(CUSTOM_DOMAIN_NOT_A_HOST);
  });

  it("remembers the custom domains Ember moves away from, newest first, until it moves to one again", () => {
    // Going back from chat.example.com, at the workers.dev address, which always reaches Ember.
    expect(othersAfterMove([], ["chat.example.com", "ember.kro.workers.dev"], "ember.kro.workers.dev")).toEqual(["chat.example.com"]);
    // Asked at an older domain, which reaches it too.
    expect(othersAfterMove(["old.example.com"], ["chat.example.com", "team.example.com"], "ember.kro.workers.dev")).toEqual(["chat.example.com", "team.example.com", "old.example.com"]);
    expect(othersAfterMove(["chat.example.com", "old.example.com"], ["ember.kro.workers.dev", "chat.example.com"], "chat.example.com")).toEqual(["old.example.com"]);
    // From no address of its own, or to none, as Stop using it leaves it.
    expect(othersAfterMove([], [null, "chat.example.com"], "ember.kro.workers.dev")).toEqual(["chat.example.com"]);
    expect(othersAfterMove(["chat.example.com"], ["team.example.com", "localhost:8787"], null)).toEqual(["team.example.com", "chat.example.com"]);
    // Only the latest few.
    const older = ["a", "b", "c", "d", "e"].map((name) => `${name}.example.com`);
    expect(othersAfterMove(older, ["chat.example.com"], "ember.kro.workers.dev")).toEqual(["chat.example.com", ...older.slice(0, MAX_OTHER_ADDRESSES - 1)]);
  });
});

describe("Sending email", () => {
  it("reads a From address as an address, or a name, in quotes or not, and an address in angle brackets", () => {
    expect(mailboxOf("ember@example.com")).toEqual({ name: null, address: "ember@example.com" });
    expect(mailboxOf("  Ember <ember@example.com> ")).toEqual({ name: "Ember", address: "ember@example.com" });
    expect(mailboxOf("Ember<ember@example.com>")).toEqual({ name: "Ember", address: "ember@example.com" });
    expect(mailboxOf('"Acme, Inc." <chat@acme.example>')).toEqual({ name: "Acme, Inc.", address: "chat@acme.example" });
    expect(mailboxOf("<ember@example.com>")).toEqual({ name: null, address: "ember@example.com" });
    expect(mailboxOf("Café Ember <o'brien+chat@mail.example.co.uk>")).toEqual({ name: "Café Ember", address: "o'brien+chat@mail.example.co.uk" });
  });

  it.each([
    ["nothing", ""],
    ["a name alone", "Ember"],
    ["an address without a domain", "ember@"],
    ["one whose domain has no dot", "ember@localhost"],
    ["one with a space", "em ber@example.com"],
    ["two addresses", "ember@example.com, chat@example.com"],
    ["a name with a line break, which would add a header", "Ember\nBcc: everyone@example.com <ember@example.com>"],
    ["a name with a quote inside", 'Ember "Chat" <ember@example.com>'],
    ["an address too long to deliver", `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH - 11)}@example.com`],
    ["a name longer than a person's", `${"a".repeat(MAX_USER_NAME_LENGTH + 1)} <ember@example.com>`],
  ])("refuses %s", (_, text) => {
    expect(mailboxOf(text)).toBeNull();
  });

  it("writes a From address with its name in quotes where a From line needs them", () => {
    expect(mailboxText({ name: null, address: "ember@example.com" })).toBe("ember@example.com");
    expect(mailboxText({ name: "Ember", address: "ember@example.com" })).toBe("Ember <ember@example.com>");
    expect(mailboxText({ name: "Acme, Inc.", address: "chat@acme.example" })).toBe('"Acme, Inc." <chat@acme.example>');
    expect(mailboxText(mailboxOf('"Acme, Inc." <chat@acme.example>')!)).toBe('"Acme, Inc." <chat@acme.example>');
  });

  it("sends from a From address without a name under the workspace's, which a From line can hold", () => {
    const join = { name: null, address: "join@example.com" };
    expect(mailboxUnder(join, "NYLLON")).toEqual({ name: "NYLLON", address: "join@example.com" });
    expect(mailboxText(mailboxUnder(join, "Acme, Inc."))).toBe('"Acme, Inc." <join@example.com>');
    expect(mailboxUnder(join, ' The "Best"\nClub <3 ')).toEqual({ name: "The Best Club 3", address: "join@example.com" });
    expect(mailboxUnder(join, "Bcc: everyone@example.com\r\n")).toEqual({ name: "Bcc: everyone@example.com", address: "join@example.com" });
    for (const name of ["", "  ", '"<>"']) expect(mailboxUnder(join, name)).toEqual(join);
    expect(mailboxUnder({ name: "Ember", address: "ember@example.com" }, "NYLLON")).toEqual({ name: "Ember", address: "ember@example.com" });
  });

  it("takes the From address as a workspace change, as it writes it, with null or blank for none", () => {
    expect(parseAccountChanges({ emailFrom: " Ember <ember@example.com>" })).toEqual({ emailFrom: "Ember <ember@example.com>" });
    expect(parseAccountChanges({ emailFrom: "Acme, Inc. <chat@acme.example>" })).toEqual({ emailFrom: '"Acme, Inc." <chat@acme.example>' });
    expect(parseAccountChanges({ emailFrom: null })).toEqual({ emailFrom: null });
    expect(parseAccountChanges({ emailFrom: "  " })).toEqual({ emailFrom: null });
    for (const emailFrom of ["Ember", 42, ["ember@example.com"], { address: "ember@example.com" }]) expect(parseAccountChanges({ emailFrom })).toBe(EMAIL_FROM_REFUSED);
  });

  it("takes a Resend API key as Resend writes one, without the spaces pasted around it", () => {
    expect(resendApiKeyOf("re_123456789_abcdefghijklmnop")).toBe("re_123456789_abcdefghijklmnop");
    expect(resendApiKeyOf("  re_AbC.dEf-123\n")).toBe("re_AbC.dEf-123");
    expect(parseResendApiKey({ apiKey: " re_123 " })).toEqual({ apiKey: "re_123" });
  });

  it.each([
    ["nothing", ""],
    ["a key without Resend's start", "sk_live_123"],
    ["the start alone", "re_"],
    ["one with a space inside", "re_123 456"],
    ["one with a line break inside, which would add a header", "re_123\nX-Other: 1"],
    ["one with a character a header can't carry", "re_123é"],
    ["one longer than any of Resend's", `re_${"a".repeat(254)}`],
  ])("refuses %s as a Resend API key", (_, text) => {
    expect(resendApiKeyOf(text)).toBeNull();
    expect(parseResendApiKey({ apiKey: text })).toBe(RESEND_API_KEY_REFUSED);
  });

  it("refuses a Resend API key that isn't text", () => {
    for (const data of [null, "re_123", { apiKey: 123 }, { apiKey: ["re_123"] }, {}]) expect(parseResendApiKey(data)).toBe(RESEND_API_KEY_REFUSED);
  });
});

describe("Only administrators create rooms (setting)", () => {
  it("takes Must be admin to create new rooms as true or false, beside the other settings", () => {
    expect(parseAccountChanges({ settings: { restrictRoomCreation: true } })).toEqual({ settings: { restrictRoomCreation: true } });
    expect(parseAccountChanges({ settings: { restrictRoomCreation: false, hideTranslationButtons: true } })).toEqual({
      settings: { restrictRoomCreation: false, hideTranslationButtons: true },
    });
    expect(parseAccountChanges({ settings: { restrictRoomCreation: "true" } })).toBe("Must be admin to create new rooms must be true or false");
  });
});

describe("Ways to join", () => {
  it("takes the join link's switch and Open as true or false, beside the other settings", () => {
    expect(parseAccountChanges({ settings: { joinLink: false, openSignUp: true } })).toEqual({ settings: { joinLink: false, openSignUp: true } });
    expect(parseAccountChanges({ settings: { joinLink: "off" } })).toBe("Join link must be true or false");
    expect(parseAccountChanges({ settings: { openSignUp: null } })).toBe("Open must be true or false");
  });

  it("lets people in with the join link while its switch is on, but never while Memberful is members only", () => {
    expect(joinsWithLink({ joinLink: true, memberfulSignIn: false })).toBe(true);
    expect(joinsWithLink({ joinLink: false, memberfulSignIn: false })).toBe(false);
    expect(joinsWithLink({ joinLink: true, memberfulSignIn: true })).toBe(false);
  });

  it("lets anyone sign up while Open is on, but never while Memberful is members only", () => {
    expect(signsUpOpenly({ openSignUp: true, memberfulSignIn: false })).toBe(true);
    expect(signsUpOpenly({ openSignUp: false, memberfulSignIn: false })).toBe(false);
    expect(signsUpOpenly({ openSignUp: true, memberfulSignIn: true })).toBe(false);
  });

  it("names why joining went to sign in in the sign-in page's address, and reads only the reasons it knows", () => {
    expect(signInSaying("link_off")).toBe("/session/new?joining=link_off");
    expect(joiningProblemOf("closed")).toBe("closed");
    expect(joiningProblemOf("link_off")).toBe("link_off");
    for (const value of [null, "", "toString", "Closed", "constructor"]) expect(joiningProblemOf(value)).toBeNull();
  });
});

describe("Sign up without a link", () => {
  it("takes a sign-up as the join form sends it, with Turnstile's token if there is one", () => {
    const signUp = { name: " Ada ", emailAddress: "ada@example.com", password: "secret words" };
    expect(parseOpenSignUp(signUp)).toEqual({ name: "Ada", emailAddress: "ada@example.com", password: "secret words" });
    expect(parseOpenSignUp({ ...signUp, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" })).toEqual({
      name: "Ada",
      emailAddress: "ada@example.com",
      password: "secret words",
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    });
    expect(parseOpenSignUp({ ...signUp, turnstileToken: "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH) })).toMatchObject({ turnstileToken: "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH) });
  });

  it.each([
    ["a sign-up without a name", { emailAddress: "ada@example.com", password: "secret words" }, "Name, email address and password are required"],
    ["a token that isn't text", { name: "Ada", emailAddress: "ada@example.com", password: "secret words", turnstileToken: 7 }, "Turnstile's token must be at most 2048 characters"],
    [
      "a token longer than Turnstile's",
      { name: "Ada", emailAddress: "ada@example.com", password: "secret words", turnstileToken: "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1) },
      "Turnstile's token must be at most 2048 characters",
    ],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseOpenSignUp(body)).toBe(error);
  });
});

describe("Invite people by email", () => {
  it("takes 1 to 20 email addresses to invite, each once whatever its case, as first given", () => {
    expect(parseInvitationRequest({ emailAddresses: ["ann@example.com", "Bob@Example.com", "ANN@example.com", "bob@example.com"] })).toEqual(["ann@example.com", "Bob@Example.com"]);
    const most = Array.from({ length: INVITATIONS_AT_ONCE }, (_, n) => `person${n}@example.com`);
    expect(parseInvitationRequest({ emailAddresses: most })).toEqual(most);
  });

  it.each([
    ["no list", {}, NO_EMAIL_ADDRESSES],
    ["an empty list", { emailAddresses: [] }, NO_EMAIL_ADDRESSES],
    ["an address alone", { emailAddresses: "ann@example.com" }, NO_EMAIL_ADDRESSES],
    ["more than 20", { emailAddresses: Array.from({ length: INVITATIONS_AT_ONCE + 1 }, (_, n) => `person${n}@example.com`) }, "Invite at most 20 email addresses at once"],
    ["something that isn't an address", { emailAddresses: ["ann@example.com", "ann"] }, NOT_AN_EMAIL_ADDRESS],
    ["an address with a name", { emailAddresses: ["Ann <ann@example.com>"] }, NOT_AN_EMAIL_ADDRESS],
    ["one that isn't text", { emailAddresses: [7] }, NOT_AN_EMAIL_ADDRESS],
    ["one too long to keep", { emailAddresses: [`${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH - 11)}@example.com`] }, NOT_AN_EMAIL_ADDRESS],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseInvitationRequest(body)).toBe(error);
  });

  it("finds the email addresses in a list as it's pasted, apart by commas, semicolons, spaces or lines, or with names, saying what else it found", () => {
    expect(emailAddressesIn("ann@example.com, bob@example.com;cy@example.com\ndee@example.com  eve@example.com")).toEqual({
      emailAddresses: ["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com", "eve@example.com"],
      refused: [],
    });
    expect(emailAddressesIn('Ann Smith <ann@example.com>, "Bob, Jr." <bob@example.com>\r\nCy <cy@example.com>')).toEqual({
      emailAddresses: ["ann@example.com", "bob@example.com", "cy@example.com"],
      refused: [],
    });
    expect(emailAddressesIn("Ann Smith ann@example.com")).toEqual({ emailAddresses: ["ann@example.com"], refused: ["Ann", "Smith"] });
    expect(emailAddressesIn("Ann <ann@example.com>; ANN@example.com")).toEqual({ emailAddresses: ["ann@example.com"], refused: [] });
    expect(emailAddressesIn("Ann <ann@example.com> bob@example.com")).toEqual({ emailAddresses: ["ann@example.com", "bob@example.com"], refused: [] });
    expect(emailAddressesIn("<ann@example.com> bob@example.com Cy <cy@example.com> Dee Smith <dee@example.com> eve")).toEqual({
      emailAddresses: ["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com"],
      refused: ["eve"],
    });
    expect(emailAddressesIn("ann bob@example cy@example.com")).toEqual({ emailAddresses: ["cy@example.com"], refused: ["ann", "bob@example"] });
    expect(emailAddressesIn(" \n , ")).toEqual({ emailAddresses: [], refused: [] });
  });

  it("knows an email address Ember can send to", () => {
    expect(isEmailAddress("o'brien+chat@mail.example.co.uk")).toBe(true);
    for (const address of ["", "ann", "ann@", "ann@localhost", "an n@example.com", "<ann@example.com>", `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH - 11)}@example.com`]) {
      expect(isEmailAddress(address), address).toBe(false);
    }
  });
});

describe("Join with an invitation", () => {
  it("puts an invitation's secret in its link's fragment", () => {
    expect(invitationLink("Ab-_9z")).toBe(`${INVITATION_PATH}#token=Ab-_9z`);
    expect(INVITATION_PATH).toBe("/join/invitation");
  });

  it("takes a join with an invitation as its form sends it, with the link's secret and no email address", () => {
    expect(parseEmailLinkSignUp({ token: "secret", name: " Hal ", password: "heuristically", emailAddress: "someone@else.example" })).toEqual({ token: "secret", name: "Hal", password: "heuristically" });
  });

  it.each([
    ["something that isn't an object", "Hal", "Expected a JSON object"],
    ["one without a name", { token: "secret", name: " ", password: "heuristically" }, "Name and password are required"],
    ["one without a password", { token: "secret", name: "Hal" }, "Name and password are required"],
    ["one without the link's secret", { name: "Hal", password: "heuristically" }, "Name and password are required"],
    ["a name too long", { token: "secret", name: "H".repeat(MAX_USER_NAME_LENGTH + 1), password: "heuristically" }, NAME_TOO_LONG],
    ["the AI assistant's name", { token: "secret", name: " ember ", password: "heuristically" }, NAME_RESERVED],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseEmailLinkSignUp(body)).toBe(error);
  });
});

describe("Join with an email domain", () => {
  it("puts the secret of a link someone asked for in its fragment, at its page", () => {
    expect(emailSignUpLink("Ab-_9z")).toBe(`${EMAIL_SIGN_UP_PATH}#token=Ab-_9z`);
    expect(EMAIL_SIGN_UP_PATH).toBe("/join/email");
  });

  it("lets people in at the email domains while Email domain is on with a domain, but never while Memberful is members only", () => {
    const on = { emailDomainSignUp: true, emailDomains: ["example.org"], memberfulSignIn: false };
    expect(signsUpWithEmailDomain(on)).toBe(true);
    expect(signsUpWithEmailDomain({ ...on, emailDomainSignUp: false })).toBe(false);
    expect(signsUpWithEmailDomain({ ...on, emailDomains: [] })).toBe(false);
    expect(signsUpWithEmailDomain({ ...on, memberfulSignIn: true })).toBe(false);
  });

  it.each([
    ["example.org", "example.org"],
    ["  Example.ORG ", "example.org"],
    ["@example.org", "example.org"],
    ["mail.example.co.uk", "mail.example.co.uk"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["XN--BCHER-KVA.example", "xn--bcher-kva.example"],
    ["my-team.example", "my-team.example"],
    ["example.org.", null],
    ["", null],
    ["localhost", null],
    ["192.0.2.1", null],
    ["ann@example.org", null],
    ["example.org/path", null],
    ["https://example.org", null],
    ["example.org:443", null],
    ["exa mple.org", null],
    ["-example.org", null],
    ["example-.org", null],
    ["example..org", null],
    ["example.123", null],
    ["[::1]", null],
    ["%65xample.org", null],
    [`${"a".repeat(64)}.example`, null],
    [`${"a.".repeat(126)}example`, null],
  ])("reads %j as the domain %j", (typed, domain) => {
    expect(emailDomainOf(typed)).toBe(domain);
  });

  it("reads an email address's domain as it reads a domain", () => {
    expect(domainOfEmailAddress("Ann@Example.ORG")).toBe("example.org");
    expect(domainOfEmailAddress("ann@bücher.example")).toBe("xn--bcher-kva.example");
    expect(domainOfEmailAddress("ann")).toBeNull();
    expect(domainOfEmailAddress("@example.org")).toBeNull();
  });

  it("takes Email domain's switch, and its domains as DNS has them, once each", () => {
    expect(parseAccountChanges({ settings: { emailDomainSignUp: true } })).toEqual({ settings: { emailDomainSignUp: true } });
    expect(parseAccountChanges({ settings: { emailDomainSignUp: "on" } })).toBe("Email domain must be true or false");
    expect(parseAccountChanges({ emailDomains: ["Example.org", "@example.org", "bücher.example"] })).toEqual({ emailDomains: ["example.org", "xn--bcher-kva.example"] });
    expect(parseAccountChanges({ emailDomains: [] })).toEqual({ emailDomains: [] });
    expect(parseAccountChanges({ emailDomains: Array.from({ length: 100 }, (_, n) => `team${n}.example`) })).toMatchObject({ emailDomains: expect.any(Array) });
  });

  it.each([
    ["a domain that isn't in a list", "example.org"],
    ["one that isn't a domain", ["example.org", "not a domain"]],
    ["one that isn't text", [null]],
    ["more than 100", Array.from({ length: 101 }, (_, n) => `team${n}.example`)],
  ])("refuses %s for Email domain's domains", (_, emailDomains) => {
    expect(parseAccountChanges({ name: "Ember", emailDomains })).toBe(EMAIL_DOMAINS_REFUSED);
  });

  it("names the domains in words", () => {
    expect(domainsInWords([])).toBe("");
    expect(domainsInWords(["example.org"])).toBe("example.org");
    expect(domainsInWords(["example.org", "example.net"])).toBe("example.org or example.net");
    expect(domainsInWords(["example.org", "example.net", "example.com"])).toBe("example.org, example.net or example.com");
    expect(onlyAddressesAt(["example.org", "example.net"])).toBe("Only email addresses at example.org or example.net can join this way.");
  });

  it("takes an ask for a link as its form sends it, with the address's domain, keeping the address as given but for an international domain", () => {
    expect(parseEmailLinkRequest({ emailAddress: " Ann@Example.org " })).toEqual({ emailAddress: "Ann@Example.org", domain: "example.org" });
    expect(parseEmailLinkRequest({ emailAddress: "ann@bücher.example" })).toEqual({ emailAddress: "ann@xn--bcher-kva.example", domain: "xn--bcher-kva.example" });
    expect(parseEmailLinkRequest({ emailAddress: "ann@example.org", turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" })).toEqual({
      emailAddress: "ann@example.org",
      domain: "example.org",
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    });
  });

  it.each([
    ["something that isn't an object", "ann@example.org", "Expected a JSON object"],
    ["no address", {}, EMAIL_ADDRESS_NEEDED],
    ["what isn't an address", { emailAddress: "ann" }, EMAIL_ADDRESS_NEEDED],
    ["an address at what isn't a domain", { emailAddress: "ann@localhost" }, EMAIL_ADDRESS_NEEDED],
    ["an address too long", { emailAddress: `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH)}@example.org` }, EMAIL_ADDRESS_NEEDED],
    ["a token longer than Turnstile's", { emailAddress: "ann@example.org", turnstileToken: "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1) }, "Turnstile's token must be at most 2048 characters"],
  ])("refuses an ask with %s and says why", (_, body, error) => {
    expect(parseEmailLinkRequest(body)).toBe(error);
  });
});

describe("Sign in with Memberful", () => {
  it("takes Memberful and its Members only as true or false, beside the other settings", () => {
    expect(parseAccountChanges({ settings: { memberfulJoin: true } })).toEqual({ settings: { memberfulJoin: true } });
    expect(parseAccountChanges({ settings: { memberfulSignIn: true } })).toEqual({ settings: { memberfulSignIn: true } });
    expect(parseAccountChanges({ settings: { memberfulJoin: false, memberfulSignIn: false, restrictRoomCreation: true } })).toEqual({
      settings: { memberfulJoin: false, memberfulSignIn: false, restrictRoomCreation: true },
    });
    expect(parseAccountChanges({ settings: { memberfulJoin: "on" } })).toBe("Memberful must be true or false");
    expect(parseAccountChanges({ settings: { memberfulSignIn: 1 } })).toBe("Members only must be true or false");
  });

  it("names the page to come back to, if any, in Sign in with Memberful's address", () => {
    expect(memberfulSignInPath(null)).toBe("/auth/memberful");
    expect(memberfulSignInPath("/rooms/general?x=1#y")).toBe("/auth/memberful?return_to=%2Frooms%2Fgeneral%3Fx%3D1%23y");
  });

  it("reads only the problems it knows from the sign-in page's address", () => {
    expect(memberfulProblemOf("membership")).toBe("membership");
    expect(memberfulProblemOf("refused")).toBe("refused");
    for (const value of [null, "", "toString", "Membership", "constructor"]) expect(memberfulProblemOf(value)).toBeNull();
  });
});

describe("Shared room order", () => {
  it("takes a list of distinct rooms, or none, which clears the order", () => {
    expect(parseSharedOrder({ roomIds: ["0000000000000002", "general"] })).toEqual(["0000000000000002", "general"]);
    expect(parseSharedOrder({ roomIds: [] })).toEqual([]);
    expect(parseSharedOrder({ roomIds: Array.from({ length: MAX_SHARED_ORDER }, (_, i) => `room-${i}`) })).toHaveLength(MAX_SHARED_ORDER);
  });

  it.each([
    ["no list", {}, "roomIds must be an array"],
    ["a body that isn't an object", null, "roomIds must be an array"],
    ["a list that isn't one", { roomIds: "general" }, "roomIds must be an array"],
    ["more rooms than an order can rank", { roomIds: Array.from({ length: MAX_SHARED_ORDER + 1 }, (_, i) => `room-${i}`) }, "too many rooms"],
    ["a room twice", { roomIds: ["general", "general"] }, "room IDs must be unique and valid"],
    ["an id that isn't a room's", { roomIds: ["general", 7] }, "room IDs must be unique and valid"],
  ])("refuses %s, and says why", (_, body, error) => {
    expect(parseSharedOrder(body)).toBe(error);
  });
});

describe("Custom CSS", () => {
  it("takes custom CSS as typed, even blank, or nothing to change", () => {
    expect(parseCustomStyles({ customStyles: "  body { color: red }\n" })).toEqual({ customStyles: "  body { color: red }\n" });
    expect(parseCustomStyles({ customStyles: "" })).toEqual({ customStyles: "" });
    expect(parseCustomStyles({ customStyles: "x".repeat(MAX_CUSTOM_STYLES_LENGTH) })).toEqual({ customStyles: "x".repeat(MAX_CUSTOM_STYLES_LENGTH) });
    expect(parseCustomStyles({})).toEqual({});
    expect(parseCustomStyles({ name: "Ember Studio" })).toEqual({});
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["a list", [{ customStyles: "" }], "Expected a JSON object"],
    ["CSS that isn't text", { customStyles: null }, "Custom CSS must be at most 100,000 characters"],
    ["CSS that's too long", { customStyles: "x".repeat(MAX_CUSTOM_STYLES_LENGTH + 1) }, "Custom CSS must be at most 100,000 characters"],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseCustomStyles(body)).toBe(error);
  });
});

describe("Make or revoke administrators", () => {
  it("makes someone an administrator only for exactly \"administrator\", and a member for anything else", () => {
    expect(parseRoleChange({ role: "administrator" })).toEqual({ role: "administrator" });
    for (const role of ["member", "", "Administrator", " administrator", "bot", null, 1, ["administrator"]]) {
      expect(parseRoleChange({ role }), JSON.stringify(role)).toEqual({ role: "member" });
    }
  });

  it.each([
    ["no body", null],
    ["a list", [{ role: "administrator" }]],
    ["text", "administrator"],
    ["an object without a role", { name: "Grace" }],
  ])("finds no role change in %s", (_, body) => {
    expect(parseRoleChange(body)).toBeNull();
  });
});

describe("Notification levels", () => {
  it("takes exactly one of the four levels", () => {
    expect(INVOLVEMENTS).toEqual(["mentions", "everything", "nothing", "invisible"]);
    for (const involvement of INVOLVEMENTS) {
      expect(isInvolvement(involvement)).toBe(true);
      expect(parseInvolvementChange({ involvement })).toBe(involvement);
    }
  });

  it.each([
    ["no body", null],
    ["text", "everything"],
    ["an object without a level", { level: "everything" }],
    ["a blank level", { involvement: "" }],
    ["a level in capitals", { involvement: "Everything" }],
    ["a level with spaces", { involvement: " nothing" }],
    ["another word", { involvement: "all" }],
    ["a list", { involvement: ["mentions"] }],
    ["a number", { involvement: 1 }],
  ])("finds no level in %s", (_, body) => {
    expect(parseInvolvementChange(body)).toBeNull();
  });

  it("starts DMs at all messages and other rooms at @mentions", () => {
    expect(startingInvolvement({ id: "general", kind: "open", name: "general", icon: null })).toBe("mentions");
    expect(startingInvolvement({ id: "secret", kind: "closed", name: "secret", icon: null })).toBe("mentions");
    expect(startingInvolvement({ id: "dm", kind: "direct", members: [], activeAt: "2026-10-16T00:00:00.000Z" })).toBe("everything");
  });
});

describe("Edit your profile", () => {
  it("takes each field as typed, even blank, leaving out what isn't sent", () => {
    const typed = { name: " ", emailAddress: "", password: " ".repeat(MIN_PASSWORD_LENGTH), bio: "Countess of Lovelace\n", currentPassword: " ", pushSubscriptionEndpoint: "" };
    expect(parseProfileChanges(typed)).toEqual(typed);
    expect(parseProfileChanges({ name: "Ada", avatar: "" })).toEqual({ name: "Ada" });
    expect(parseProfileChanges({})).toEqual({});
  });

  it("takes as long a name and email address as Ember keeps, a password as long as sign-in does, and a bio as long as the form lets anyone type", () => {
    const longest = {
      name: "x".repeat(MAX_USER_NAME_LENGTH),
      emailAddress: `${"x".repeat(MAX_EMAIL_ADDRESS_LENGTH - "@example.com".length)}@example.com`,
      password: "🔐".repeat(MAX_PASSWORD_LENGTH / 2),
      bio: "x".repeat(MAX_BIO_LENGTH),
      pushSubscriptionEndpoint: `https://fcm.googleapis.com/${"x".repeat(MAX_PUSH_ENDPOINT_LENGTH - "https://fcm.googleapis.com/".length)}`,
    };
    expect(parseProfileChanges(longest)).toEqual(longest);
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["a list", [{ name: "Ada" }], "Expected a JSON object"],
    ["a name that isn't text", { name: null }, "Name must be text"],
    ["an email address that isn't text", { emailAddress: ["ada@example.com"] }, "Email address must be text"],
    ["a password that isn't text", { password: 12345678 }, "Password must be text"],
    ["a bio that isn't text", { bio: false }, "Bio must be text"],
    ["a name longer than Ember keeps", { name: "x".repeat(MAX_USER_NAME_LENGTH + 1) }, "Name must be at most 100 characters"],
    ["an email address longer than any deliverable one", { emailAddress: `${"x".repeat(MAX_EMAIL_ADDRESS_LENGTH)}@example.com` }, "Email address must be at most 254 characters"],
    ["a password shorter than first run takes", { password: "1234567" }, PASSWORD_TOO_SHORT],
    ["four emoji, which the field's minlength counts as eight", { password: "🔐🔐🔐🔐" }, PASSWORD_TOO_SHORT],
    ["a password longer than sign-in takes", { password: "x".repeat(MAX_PASSWORD_LENGTH + 1) }, "Password must be at most 72 characters."],
    ["a bio longer than the form takes", { bio: "x".repeat(MAX_BIO_LENGTH + 1) }, "Bio must be at most 200 characters"],
    ["a current password that isn't text", { currentPassword: 12345678 }, "Current password must be text"],
    ["an endpoint that isn't text", { pushSubscriptionEndpoint: {} }, "Push subscription endpoint must be text"],
    ["an endpoint longer than a subscription's", { pushSubscriptionEndpoint: "x".repeat(MAX_PUSH_ENDPOINT_LENGTH + 1) }, "Endpoint can't be longer than 2048 characters"],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseProfileChanges(body)).toBe(error);
  });
});

describe("Disconnect Memberful", () => {
  it("takes your password and this browser's push subscription endpoint as typed, leaving out what isn't sent", () => {
    const typed = { currentPassword: " ", pushSubscriptionEndpoint: "" };
    expect(parseMemberfulDisconnection(typed)).toEqual(typed);
    expect(parseMemberfulDisconnection({ currentPassword: "compiler", name: "Grace" })).toEqual({ currentPassword: "compiler" });
    expect(parseMemberfulDisconnection({})).toEqual({});
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["a list", [{ currentPassword: "compiler" }], "Expected a JSON object"],
    ["a password that isn't text", { currentPassword: 12345678 }, "Current password must be text"],
    ["an endpoint that isn't text", { pushSubscriptionEndpoint: {} }, "Push subscription endpoint must be text"],
    ["an endpoint longer than a subscription's", { pushSubscriptionEndpoint: "x".repeat(MAX_PUSH_ENDPOINT_LENGTH + 1) }, "Endpoint can't be longer than 2048 characters"],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseMemberfulDisconnection(body)).toBe(error);
  });
});

describe("Reset a password from the server", () => {
  it("takes an email address and a password as they're given", () => {
    expect(parsePasswordReset({ emailAddress: " Ada@example.com", password: "  correct horse  " })).toEqual({
      emailAddress: " Ada@example.com",
      password: "  correct horse  ",
    });
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["text", "ada@example.com", "Expected a JSON object"],
    ["no email address", { password: "correct horse" }, "Email address and password are required"],
    ["a blank email address", { emailAddress: "", password: "correct horse" }, "Email address and password are required"],
    ["an email address that isn't text", { emailAddress: ["ada@example.com"], password: "correct horse" }, "Email address and password are required"],
    ["no password", { emailAddress: "ada@example.com" }, "Email address and password are required"],
    ["a password that isn't text", { emailAddress: "ada@example.com", password: 12345678 }, "Email address and password are required"],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parsePasswordReset(body)).toBe(error);
  });
});

describe("Reset a forgotten password with an emailed code", () => {
  it("takes an ask for a code with the address as given, and Turnstile's token if it has one", () => {
    expect(parsePasswordResetRequest({ emailAddress: " Ada@example.com" })).toEqual({ emailAddress: " Ada@example.com" });
    expect(parsePasswordResetRequest({ emailAddress: "ada", turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" })).toEqual({ emailAddress: "ada", turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });
  });

  it.each([
    ["something that isn't an object", "ada@example.com", "Expected a JSON object"],
    ["no address", {}, EMAIL_ADDRESS_NEEDED],
    ["a blank address", { emailAddress: "  " }, EMAIL_ADDRESS_NEEDED],
    ["an address too long", { emailAddress: `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH)}@example.org` }, EMAIL_ADDRESS_TOO_LONG],
    ["a token longer than Turnstile's", { emailAddress: "ada@example.com", turnstileToken: "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1) }, "Turnstile's token must be at most 2048 characters"],
    ["a token that isn't text", { emailAddress: "ada@example.com", turnstileToken: 42 }, "Turnstile's token must be at most 2048 characters"],
  ])("refuses an ask with %s and says why", (_, body, error) => {
    expect(parsePasswordResetRequest(body)).toBe(error);
  });

  it("reads a code as it's typed or pasted: in groups, with spaces or a dash, and in full-width digits", () => {
    for (const typed of ["12345678", " 1234 5678 ", "1234-5678", "１２３４５６７８", "12 34 56 78"]) expect(passwordResetCodeOf(typed), typed).toBe("12345678");
    for (const typed of ["1234567", "123456789", "1234567a", "1234.5678", "", "١٢٣٤٥٦٧٨"]) expect(passwordResetCodeOf(typed), typed).toBeNull();
  });

  it("takes a new password with the code, read as typed, and refuses one without a code that can be one on the code's field", () => {
    expect(parsePasswordResetWithCode({ emailAddress: "ada@example.com", code: "1234 5678", password: " difference engine " })).toEqual({
      emailAddress: "ada@example.com",
      code: "12345678",
      password: " difference engine ",
    });
    expect(parsePasswordResetWithCode({ emailAddress: "ada@example.com", code: "1234", password: "difference engine" })).toEqual({ error: PASSWORD_RESET_CODE_NEEDED, field: "code" });
    expect(parsePasswordResetWithCode({ emailAddress: `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH)}@example.org`, code: "12345678", password: "difference engine" })).toEqual({
      error: EMAIL_ADDRESS_TOO_LONG,
      field: "emailAddress",
    });
    for (const body of [null, [], { emailAddress: "ada@example.com", code: "12345678" }, { emailAddress: "", code: "12345678", password: "difference engine" }, { emailAddress: "ada@example.com", code: 12345678, password: "difference engine" }]) {
      expect(parsePasswordResetWithCode(body), JSON.stringify(body)).toHaveProperty("error");
      expect(parsePasswordResetWithCode(body)).not.toHaveProperty("field");
    }
  });

  it("links to its page, and back to sign in, with the email address typed", () => {
    expect(withEmailAddress(PASSWORD_RESET_PATH, "ada+ember@example.com")).toBe("/passwords/new?email_address=ada%2Bember%40example.com");
    expect(withEmailAddress("/session/new", "")).toBe("/session/new");
  });
});

describe("Check that people are people with Cloudflare Turnstile", () => {
  const keys = { siteKey: "0x4AAAAAAA-a-widgets-site-key", secretKey: "0x4AAAAAAA-a-widgets-secret-key", turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" };

  it("takes a widget's keys as Cloudflare writes them, and its test keys, without the spaces pasted around them", () => {
    expect(turnstileKeyOf("0x4AAAAAAA-a-widgets-site-key")).toBe("0x4AAAAAAA-a-widgets-site-key");
    expect(turnstileKeyOf(" 0x4AAAAAAA_A-widgets_SECRET_key\n")).toBe("0x4AAAAAAA_A-widgets_SECRET_key");
    expect(turnstileKeyOf("1x00000000000000000000AA")).toBe("1x00000000000000000000AA");
    expect(turnstileKeyOf("1x0000000000000000000000000000000AA")).toBe("1x0000000000000000000000000000000AA");
    expect(turnstileKeyOf(`0x${"A".repeat(98)}`)).toHaveLength(100);
    expect(parseTurnstileKeysChange({ ...keys, siteKey: ` ${keys.siteKey} `, secretKey: `${keys.secretKey}\n` })).toEqual(keys);
  });

  it.each([
    ["nothing", ""],
    ["a key without a widget's start", "sk_live_0123456789abcdef"],
    ["the start alone", "0x"],
    ["one too short to be a widget's", "0x4AAAAAAAAAAAAAA"],
    ["one with a space inside", "0x4AAAAAAA 4AAAAAAAAAAA"],
    ["one with a character a widget's keys never have", "0x4AAAAAAA4AAAAAAAAAAA.A"],
    ["one longer than any of Cloudflare's", `0x${"A".repeat(99)}`],
  ])("refuses %s as a site key or a secret key", (_, text) => {
    expect(turnstileKeyOf(text)).toBeNull();
    expect(parseTurnstileKeysChange({ ...keys, siteKey: text })).toEqual({ error: TURNSTILE_SITE_KEY_REFUSED, field: "siteKey" });
    expect(parseTurnstileKeysChange({ ...keys, secretKey: text })).toEqual({ error: TURNSTILE_SECRET_KEY_REFUSED, field: "secretKey" });
  });

  it("refuses the site key given again as the secret key", () => {
    expect(parseTurnstileKeysChange({ ...keys, secretKey: ` ${keys.siteKey}` })).toEqual({ error: TURNSTILE_SECRET_KEY_REFUSED, field: "secretKey" });
  });

  it("refuses keys without the token of the check they passed, on Turnstile's check", () => {
    for (const turnstileToken of [undefined, "", 42, [keys.turnstileToken], "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1)]) {
      expect(parseTurnstileKeysChange({ ...keys, turnstileToken }), String(turnstileToken)).toEqual({ error: TURNSTILE_FAILED, field: "turnstile" });
    }
    const longest = "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH);
    expect(parseTurnstileKeysChange({ ...keys, turnstileToken: longest })).toEqual({ ...keys, turnstileToken: longest });
  });

  it("refuses keys that aren't text, on the first field they're about", () => {
    for (const data of [null, keys.siteKey, [], {}, { ...keys, siteKey: 42 }]) {
      expect(parseTurnstileKeysChange(data), JSON.stringify(data)).toEqual({ error: TURNSTILE_SITE_KEY_REFUSED, field: "siteKey" });
    }
    expect(parseTurnstileKeysChange({ ...keys, secretKey: [keys.secretKey] })).toEqual({ error: TURNSTILE_SECRET_KEY_REFUSED, field: "secretKey" });
  });
});

describe("Set up the workspace", () => {
  it("takes a name, an email address and a password, trimming only the name", () => {
    expect(parseSignUp({ name: "  Ada Lovelace ", emailAddress: "ada@example.com", password: " secret  words " })).toEqual({
      name: "Ada Lovelace",
      emailAddress: "ada@example.com",
      password: " secret  words ",
    });
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["no name", { emailAddress: "ada@example.com", password: "12345678" }, "Name, email address and password are required"],
    ["a blank name", { name: "  ", emailAddress: "ada@example.com", password: "12345678" }, "Name, email address and password are required"],
    ["no email address", { name: "Ada", emailAddress: "", password: "12345678" }, "Name, email address and password are required"],
    ["no password", { name: "Ada", emailAddress: "ada@example.com" }, "Name, email address and password are required"],
    ["a password that isn't text", { name: "Ada", emailAddress: "ada@example.com", password: 12345678 }, "Name, email address and password are required"],
    ["a name longer than Ember keeps", { name: "x".repeat(MAX_USER_NAME_LENGTH + 1), emailAddress: "ada@example.com", password: "secret words" }, "Name must be at most 100 characters"],
    [
      "an email address longer than any deliverable one",
      { name: "Ada", emailAddress: `${"x".repeat(MAX_EMAIL_ADDRESS_LENGTH)}@example.com`, password: "secret words" },
      "Email address must be at most 254 characters",
    ],
    ["the AI assistant's name", { name: "Ember", emailAddress: "ada@example.com", password: "secret words" }, NAME_RESERVED],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseSignUp(body)).toBe(error);
  });

  it("keeps the AI assistant's name for it, however it's written", () => {
    for (const name of ["Ember", "ember", "EMBER", " eMbEr ", "@ember", "@ Ember", "Ｅｍｂｅｒ", "Em\u200Bber", "\u00A0Ember\u00A0"]) expect(isReservedName(name), name).toBe(true);
    for (const name of ["Embers", "Ember Lee", "Amber", "Emb er", "ember@example.com", ""]) expect(isReservedName(name), name).toBe(false);
    expect(ASSISTANT_NAME).toBe("Ember");
  });

  it("tells names that look the same apart from names that don't, as an agent's is kept for it", () => {
    for (const name of ["Recap", "recap", " RECAP ", "@Recap", "Ｒｅｃａｐ", "Re\u200Bcap"]) expect(sameName(name, "Recap"), name).toBe(true);
    for (const name of ["Recaps", "Re cap", "Recap Bot", ""]) expect(sameName(name, "Recap"), name).toBe(false);
  });

  it("takes a name and an email address as long as Ember keeps, counting the name once trimmed", () => {
    const name = "x".repeat(MAX_USER_NAME_LENGTH);
    const emailAddress = `${"x".repeat(MAX_EMAIL_ADDRESS_LENGTH - "@example.com".length)}@example.com`;
    expect(parseSignUp({ name: ` ${name} `, emailAddress, password: "secret words" })).toEqual({ name, emailAddress, password: "secret words" });
  });

  it("counts a password's characters, not its bytes or UTF-16 units", () => {
    expect(["", "short", "1234567", "éééé", "🔐🔐🔐🔐", "🔐🔐🔐🔐🔐🔐🔐"].filter(isPasswordTooShort)).toHaveLength(6);
    expect(isPasswordTooShort("12345678")).toBe(false);
    expect(isPasswordTooShort("🔐".repeat(8))).toBe(false);
  });

  it("measures a password's length as the form's maxlength does, in UTF-16 units", () => {
    expect(isPasswordTooLong("x".repeat(72))).toBe(false);
    expect(isPasswordTooLong("🔐".repeat(36))).toBe(false);
    expect(isPasswordTooLong("x".repeat(73))).toBe(true);
    expect(isPasswordTooLong("🔐".repeat(37))).toBe(true);
  });
});

describe("Check for updates", () => {
  it("puts a beta after the release before it and before its own, as copies take it", () => {
    for (const [later, earlier] of [
      ["0.5.0-beta.1", "0.4.2"],
      ["0.5.0-beta.2", "0.5.0-beta.1"],
      ["0.5.0-beta.10", "0.5.0-beta.9"],
      ["0.5.0", "0.5.0-beta.10"],
      ["0.5.1", "0.5.0"],
      ["0.6.0-beta.1", "0.5.9"],
      ["0.10.0", "0.9.0"],
    ]) {
      expect(isNewer(later!, earlier!), `${later} after ${earlier}`).toBe(true);
      expect(isNewer(earlier!, later!), `${earlier} after ${later}`).toBe(false);
      expect(isNewer(later!, later!), `${later} after itself`).toBe(false);
    }
  });
});
