import { describe, expect, it } from "vitest";
import { huddlePath, isAppPage, MAX_ID_LENGTH, threadPath, TRANSFER_PATH, transferLink, workspacePageOf } from "./index";

describe("Error pages", () => {
  it("names the pages the app shows, for the Worker to serve the app at", () => {
    const pages = ["/", "/rooms", "/rooms/general", "/rooms/caf%C3%A9", "/rooms/opens/general", "/rooms/directs/ada-grace", "/rooms/opens/new", "/rooms/closeds/new"];
    for (const path of [...pages, "/rooms/opens/general/edit", "/account/edit", "/account/custom_styles/edit", "/session/new", "/oauth/authorize"]) expect(isAppPage(path), path).toBe(true);
    expect(workspacePageOf("/rooms/caf%C3%A9")).toEqual({ page: "room", roomId: "café" });
  });

  it("names nothing at any other path, which answers 404", () => {
    const paths = ["/nope", "/index.html", "/account", "/account/custom_styles", "/users/1/extra", "/rooms/general/extra", "/rooms/opens/general/extra", "/messages/1"];
    for (const path of paths) expect(isAppPage(path), path).toBe(false);
  });

  it("names nothing at Rails' unused actions", () => {
    for (const path of ["/rooms/new", "/rooms/general/edit"]) expect(isAppPage(path), path).toBe(false);
  });

  it("names nothing at a malformed escape, which can't be read", () => {
    for (const path of ["/rooms/%FF", "/rooms/%E0%A4", "/rooms/opens/%FF", "/rooms/closeds/%FF/edit"]) expect(workspacePageOf(path), path).toBeNull();
  });

  it("leaves extra slashes, setup's pages and the join link's to the Worker", () => {
    for (const path of ["/rooms/general/", "//rooms/general", "/session/new/", "/first_run", "/join/aB3d-Ef5h-iJ7k"]) expect(isAppPage(path), path).toBe(false);
  });
});

describe("New direct message dialog", () => {
  it("shows New direct message at its address", () => {
    expect(workspacePageOf("/rooms/directs/new")).toEqual({ page: "new-direct" });
    for (const path of ["/rooms/directs/new/", "/rooms/directs/new/edit"]) expect(workspacePageOf(path), path).not.toEqual({ page: "new-direct" });
  });
});

describe("Group DMs and DM names", () => {
  it("shows a DM's settings at its address", () => {
    expect(workspacePageOf("/rooms/directs/ada-grace/edit")).toEqual({ page: "direct-settings", roomId: "ada-grace" });
    expect(workspacePageOf("/rooms/directs/caf%C3%A9/edit")).toEqual({ page: "direct-settings", roomId: "café" });
    for (const path of ["/rooms/directs/%FF/edit", "/rooms/directs/ada-grace/edit/extra"]) expect(workspacePageOf(path), path).toBeNull();
  });
});

describe("Link to a message", () => {
  it("opens a message's room at its permalink, around the message", () => {
    expect(workspacePageOf("/rooms/caf%C3%A9/@m-1")).toEqual({ page: "room", roomId: "café", messageId: "m-1" });
    expect(workspacePageOf("/rooms/general/@m%2D1")).toEqual({ page: "room", roomId: "general", messageId: "m-1" });
    for (const path of ["/rooms/general/@", "/rooms/general/@m-1/extra", "/rooms/new/@m-1"]) expect(isAppPage(path), path).toBe(false);
  });

  it("opens the room at its newest messages for a permalink whose message id is malformed or too long for one", () => {
    expect(workspacePageOf("/rooms/general/@%FF")).toEqual({ page: "room", roomId: "general" });
    expect(workspacePageOf(`/rooms/general/@${"m".repeat(MAX_ID_LENGTH + 1)}`)).toEqual({ page: "room", roomId: "general" });
    const longest = "m".repeat(MAX_ID_LENGTH);
    expect(workspacePageOf(`/rooms/general/@${longest}`)).toEqual({ page: "room", roomId: "general", messageId: longest });
  });

  it("reads a message's own address, which goes on to its permalink", () => {
    expect(workspacePageOf("/rooms/caf%C3%A9/messages/m%2D1")).toEqual({ page: "message", roomId: "café", messageId: "m-1" });
    for (const path of ["/rooms/general/messages/%FF", `/rooms/general/messages/${"m".repeat(MAX_ID_LENGTH + 1)}`]) {
      expect(workspacePageOf(path), path).toEqual({ page: "message", roomId: "general" });
    }
    for (const path of ["/rooms/general/messages", "/rooms/general/messages/", "/rooms/general/messages/m-1/extra", "/rooms/new/messages/m-1"]) {
      expect(isAppPage(path), path).toBe(false);
    }
  });
});

describe("Threads", () => {
  it("opens a room with a message's thread beside it, or at a reply in the thread", () => {
    expect(workspacePageOf("/rooms/caf%C3%A9/threads/m%2D1")).toEqual({ page: "room", roomId: "café", threadId: "m-1" });
    expect(workspacePageOf("/rooms/general/threads/m-1/@r%2D2")).toEqual({ page: "room", roomId: "general", threadId: "m-1", replyId: "r-2" });
    expect(threadPath("café", "m-1")).toBe("/rooms/caf%C3%A9/threads/m-1");
    expect(threadPath("general", "m 1", "r/2")).toBe("/rooms/general/threads/m%201/@r%2F2");
    for (const path of ["/rooms/general/threads", "/rooms/general/threads/", "/rooms/general/threads/m-1/", "/rooms/general/threads/m-1/@", "/rooms/new/threads/m-1"]) {
      expect(isAppPage(path), path).toBe(false);
    }
  });

  it("opens the room without the thread, or the thread at its newest replies, for an id that's malformed or too long for one", () => {
    const tooLong = "m".repeat(MAX_ID_LENGTH + 1);
    for (const id of ["%FF", tooLong]) expect(workspacePageOf(`/rooms/general/threads/${id}`), id).toEqual({ page: "room", roomId: "general" });
    for (const id of ["%FF", tooLong]) expect(workspacePageOf(`/rooms/general/threads/m-1/@${id}`), id).toEqual({ page: "room", roomId: "general", threadId: "m-1" });
    expect(workspacePageOf("/rooms/%FF/threads/m-1")).toBeNull();
  });
});

describe("Huddles", () => {
  it("opens a room at its huddle's link, which offers to join its huddle", () => {
    expect(workspacePageOf("/rooms/caf%C3%A9/huddle")).toEqual({ page: "room", roomId: "café", huddle: true });
    expect(huddlePath("café")).toBe("/rooms/caf%C3%A9/huddle");
    expect(workspacePageOf(huddlePath("a/b"))).toEqual({ page: "room", roomId: "a/b", huddle: true });
    for (const path of ["/rooms/general/huddle/", "/rooms/general/huddle/extra", "/rooms/new/huddle", "/rooms/%FF/huddle", "/rooms/huddle/huddle/huddle"]) {
      expect(isAppPage(path), path).toBe(false);
    }
    // A room can be named huddle, as it can be named anything but new.
    expect(workspacePageOf("/rooms/huddle")).toEqual({ page: "room", roomId: "huddle" });
    expect(workspacePageOf("/rooms/huddle/huddle")).toEqual({ page: "room", roomId: "huddle", huddle: true });
  });
});

describe("Edit your profile", () => {
  it("shows your profile at anyone's profile address", () => {
    for (const path of ["/users/me/profile", "/users/01J9Z3/profile"]) expect(workspacePageOf(path), path).toEqual({ page: "profile" });
    for (const path of ["/users/me/profile/", "/users/me/profile/edit"]) expect(workspacePageOf(path), path).toBeNull();
  });
});

describe("Push subscriptions page", () => {
  it("shows your push subscriptions at anyone's address for them", () => {
    for (const path of ["/users/me/push_subscriptions", "/users/01J9Z3/push_subscriptions"]) {
      expect(workspacePageOf(path), path).toEqual({ page: "push-subscriptions" });
    }
    for (const path of ["/users/me/push_subscriptions/", "/users/me/push_subscriptions/new", "/users/me/push_subscriptions/1"]) {
      expect(workspacePageOf(path), path).toBeNull();
    }
  });
});

describe("Someone's profile page", () => {
  it("shows someone's page at /users/<id>, whatever the id", () => {
    expect(workspacePageOf("/users/0mgk3x2a9b4c5d")).toEqual({ page: "person", userId: "0mgk3x2a9b4c5d" });
    expect(workspacePageOf("/users/caf%C3%A9")).toEqual({ page: "person", userId: "café" });
    // An id nobody has is the page's to answer 404 for.
    expect(workspacePageOf("/users/profile")).toEqual({ page: "person", userId: "profile" });
    for (const path of ["/users", "/users/", "/users/%FF", "/users/ada/edit"]) expect(workspacePageOf(path), path).toBeNull();
  });
});

describe("Chat bots page", () => {
  it("shows the Chat bots page at `/account/bots`, where a bot's own address names nothing", () => {
    expect(workspacePageOf("/account/bots")).toEqual({ page: "bots" });
    for (const path of ["/account/bots/", "/account/bots/0mgk3x2a9b4c5e", "/account/bot"]) expect(workspacePageOf(path), path).toBeNull();
  });
});

describe("Add and edit a bot", () => {
  it("shows Add a chat bot at `/account/bots/new`, and a bot's settings at `/account/bots/<id>/edit`", () => {
    expect(workspacePageOf("/account/bots/new")).toEqual({ page: "new-bot" });
    expect(workspacePageOf("/account/bots/0mgk3x2a9b4c5e/edit")).toEqual({ page: "bot-settings", userId: "0mgk3x2a9b4c5e" });
    expect(workspacePageOf("/account/bots/caf%C3%A9/edit")).toEqual({ page: "bot-settings", userId: "café" });
    for (const path of ["/account/bots/new/", "/account/bots/%FF/edit", "/account/bots/0mgk3x2a9b4c5e/edit/extra", "/account/bots/0mgk3x2a9b4c5e/key"]) {
      expect(workspacePageOf(path), path).toBeNull();
    }
  });
});

describe("Connect an app and a connected app's page", () => {
  it("shows Connect an app at `/account/apps/new`, and a connected app's page at `/account/apps/<id>/edit`", () => {
    expect(workspacePageOf("/account/apps/new")).toEqual({ page: "new-app" });
    expect(workspacePageOf("/account/apps/0mgk3x2a9b4c5e/edit")).toEqual({ page: "app-settings", appId: "0mgk3x2a9b4c5e" });
    for (const path of ["/account/apps", "/account/apps/new/", "/account/apps/%FF/edit", "/account/apps/0mgk3x2a9b4c5e", "/account/apps/0mgk3x2a9b4c5e/edit/extra"]) {
      expect(workspacePageOf(path)).toBeNull();
    }
  });

  it("shows where an app's sign-in comes back to at `/account/apps/signed-in`", () => {
    expect(workspacePageOf("/account/apps/signed-in")).toEqual({ page: "app-signed-in" });
    expect(workspacePageOf("/account/apps/signed-in/")).toBeNull();
    expect(workspacePageOf("/account/apps/signed-in/edit")).toEqual({ page: "app-settings", appId: "signed-in" });
  });
});

describe("New agent and an agent's settings", () => {
  it("shows New agent at `/account/agents/new`, and an agent's settings, or @ember's, at `/account/agents/<id>/edit`", () => {
    expect(workspacePageOf("/account/agents/new")).toEqual({ page: "new-agent" });
    expect(workspacePageOf("/account/agents/0mgk3x2a9b4c5e/edit")).toEqual({ page: "agent-settings", agentId: "0mgk3x2a9b4c5e" });
    expect(workspacePageOf("/account/agents/ember/edit")).toEqual({ page: "agent-settings", agentId: "ember" });
    expect(workspacePageOf("/account/agents/caf%C3%A9/edit")).toEqual({ page: "agent-settings", agentId: "café" });
    for (const path of ["/account/agents", "/account/agents/new/", "/account/agents/%FF/edit", "/account/agents/0mgk3x2a9b4c5e", "/account/agents/0mgk3x2a9b4c5e/edit/extra"]) {
      expect(workspacePageOf(path), path).toBeNull();
    }
  });
});

describe("Private sign-in link", () => {
  it("puts a sign-in link's id in the fragment of /session/transfers", () => {
    expect(transferLink("0mgk3x2a9b4c5d.mgk3x2a9.Ab-_9z")).toBe("/session/transfers#token=0mgk3x2a9b4c5d.mgk3x2a9.Ab-_9z");
  });

  it("leaves a sign-in link's page to the Worker, as it's no workspace page", () => {
    expect(workspacePageOf(TRANSFER_PATH)).toBeNull();
    expect(isAppPage(TRANSFER_PATH)).toBe(false);
  });
});

describe("Search page", () => {
  it("shows search at `/searches`, whatever its query string, which the path leaves out", () => {
    expect(workspacePageOf("/searches")).toEqual({ page: "search" });
    expect(isAppPage("/searches")).toBe(true);
    for (const path of ["/searches/", "/searches/clear", "/search"]) expect(workspacePageOf(path), path).toBeNull();
  });
});
