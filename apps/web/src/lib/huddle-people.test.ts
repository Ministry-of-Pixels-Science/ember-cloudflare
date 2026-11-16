import type { DirectRoom, Room, User } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { hasHuddles, huddledWith, huddlePlace, inItNow, inItsHuddle, inTheHuddle, invitedOnceItStarts, sharingScreens } from "./huddle-people";

const [ada, priya, sam, deploys]: User[] = [
  { id: "ada", name: "Ada Lovelace" },
  { id: "priya", name: "Priya Patel" },
  { id: "sam", name: "Sam Rivera" },
  { id: "deploys", name: "Deploys" },
];
const launch: Room = { id: "launch", name: "Launch", kind: "open", icon: null };
const directOf = (...members: User[]): DirectRoom => ({ id: "direct-1", kind: "direct", members, activeAt: "2026-11-10T09:00:00.000Z" });
/** Deploys is a bot, which joins no huddle. */
const joinsNone = (user: User) => user.id === "deploys";

describe("huddledWith", () => {
  it("is the others in a direct message, but for whoever joins no huddle", () => {
    expect(huddledWith(directOf(ada!, priya!), "ada", joinsNone)).toEqual([priya]);
    expect(huddledWith(directOf(priya!, ada!, deploys!, sam!), "ada", joinsNone)).toEqual([priya, sam]);
  });

  it("is nobody in a direct message with oneself, or with only those who join none", () => {
    expect(huddledWith(directOf(ada!), "ada", joinsNone)).toEqual([]);
    expect(huddledWith(directOf(ada!, deploys!), "ada", joinsNone)).toEqual([]);
  });
});

describe("hasHuddles", () => {
  it("is so of every shared room", () => {
    expect(hasHuddles(launch, "ada", joinsNone)).toBe(true);
    expect(hasHuddles({ ...launch, kind: "closed" }, "ada", joinsNone)).toBe(true);
  });

  it("is so of a direct message with someone to huddle with, and of no other", () => {
    expect(hasHuddles(directOf(ada!, priya!), "ada", joinsNone)).toBe(true);
    expect(hasHuddles(directOf(ada!, deploys!, sam!), "ada", joinsNone)).toBe(true);
    expect(hasHuddles(directOf(ada!), "ada", joinsNone)).toBe(false);
    expect(hasHuddles(directOf(ada!, deploys!), "ada", joinsNone)).toBe(false);
  });
});

describe("huddlePlace", () => {
  it("is in a shared room, and with whoever a direct message is with", () => {
    expect(huddlePlace(launch, "Launch")).toBe("in Launch");
    expect(huddlePlace(directOf(ada!, priya!), "Priya Patel")).toBe("with Priya Patel");
  });
});

describe("invitedOnceItStarts", () => {
  it("names whoever a direct message's huddle invites, by first name up to three", () => {
    expect(invitedOnceItStarts(["Priya Patel"])).toBe("Priya is invited once it starts.");
    expect(invitedOnceItStarts(["Priya Patel", "Sam Rivera"])).toBe("Priya and Sam are invited once it starts.");
    expect(invitedOnceItStarts(["Priya Patel", "Sam Rivera", "Leo Park", "Maya Chen"])).toBe("Priya, Sam, Leo, and 1 other are invited once it starts.");
  });
});

describe("inItNow", () => {
  it("names up to three people by first name", () => {
    expect(inItNow(["Sam Rivera"], 1)).toBe("Sam is in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel"], 2)).toBe("Sam and Priya are in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel", "Leo Park"], 3)).toBe("Sam, Priya, and Leo are in it now.");
  });

  it("counts whoever's past the third", () => {
    expect(inItNow(["Sam Rivera", "Priya Patel", "Leo Park", "Maya Chen"], 4)).toBe("Sam, Priya, Leo, and 1 other are in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel", "Leo Park", "Maya Chen", "Ada Lovelace"], 5)).toBe("Sam, Priya, Leo, and 2 others are in it now.");
  });

  it("counts people it has no name for among the others", () => {
    expect(inItNow(["Sam Rivera"], 3)).toBe("Sam and 2 others are in it now.");
    expect(inItNow(["Sam Rivera", "Priya Patel"], 3)).toBe("Sam, Priya, and 1 other are in it now.");
  });

  it("counts people when it has no name at all", () => {
    expect(inItNow([], 1)).toBe("1 person is in it now.");
    expect(inItNow([], 4)).toBe("4 people are in it now.");
  });

  it("takes a name of one word, or with spaces around it, whole", () => {
    expect(inItNow(["Cher"], 1)).toBe("Cher is in it now.");
    expect(inItNow(["  Sam   Rivera "], 1)).toBe("Sam is in it now.");
  });
});

describe("inTheHuddle", () => {
  it("says when nobody else is in it", () => {
    expect(inTheHuddle([])).toBe("Just you in the huddle");
  });

  it("names up to three others, then you", () => {
    expect(inTheHuddle(["Sam Rivera"])).toBe("Sam and you are in the huddle");
    expect(inTheHuddle(["Sam Rivera", "Priya Patel"])).toBe("Sam, Priya, and you are in the huddle");
    expect(inTheHuddle(["Sam Rivera", "Priya Patel", "Leo Park"])).toBe("Sam, Priya, Leo, and you are in the huddle");
  });

  it("counts the others past the third", () => {
    expect(inTheHuddle(["Sam Rivera", "Priya Patel", "Leo Park", "Ada Lovelace"])).toBe("Sam, Priya, Leo, and 1 other are in the huddle");
    expect(inTheHuddle(Array.from({ length: 49 }, (_, index) => `Person ${index}`))).toBe("Person, Person, Person, and 46 others are in the huddle");
  });
});

describe("sharingScreens", () => {
  it("says nothing while nobody shares one", () => {
    expect(sharingScreens([], false)).toBeNull();
  });

  it("says when only you do, and names someone else who does by first name", () => {
    expect(sharingScreens([], true)).toBe("You're sharing your screen");
    expect(sharingScreens(["Sam Rivera"], false)).toBe("Sam is sharing a screen");
  });

  it("names both of two who do, you last", () => {
    expect(sharingScreens(["Sam Rivera", "Priya Patel"], false)).toBe("Sam and Priya are sharing screens");
    expect(sharingScreens(["Sam Rivera"], true)).toBe("Sam and you are sharing screens");
  });
});

describe("inItsHuddle", () => {
  it("names whoever is in it to someone who isn't, as far as their names are known", () => {
    expect(inItsHuddle(["Sam Rivera"], 1, false)).toBe("Sam is in the huddle");
    expect(inItsHuddle(["Sam Rivera", "Priya Patel"], 2, false)).toBe("Sam and Priya are in the huddle");
    expect(inItsHuddle(["Sam Rivera", "Priya Patel", "Leo Park", "Maya Chen"], 4, false)).toBe("Sam, Priya, Leo, and 1 other are in the huddle");
    expect(inItsHuddle(["Sam Rivera"], 3, false)).toBe("Sam and 2 others are in the huddle");
    expect(inItsHuddle([], 1, false)).toBe("1 person is in the huddle");
    expect(inItsHuddle([], 2, false)).toBe("2 people are in the huddle");
  });

  it("says it to someone in it as their own huddle does", () => {
    expect(inItsHuddle([], 0, true)).toBe("Just you in the huddle");
    expect(inItsHuddle(["Sam Rivera"], 1, true)).toBe("Sam and you are in the huddle");
    expect(inItsHuddle(["Sam Rivera", "Priya Patel", "Leo Park", "Ada Lovelace"], 4, true)).toBe("Sam, Priya, Leo, and 1 other are in the huddle");
  });

  it("counts everyone in it, them included, while it lacks a name", () => {
    expect(inItsHuddle([], 1, true)).toBe("2 people are in the huddle");
    expect(inItsHuddle(["Sam Rivera"], 2, true)).toBe("3 people are in the huddle");
  });
});
