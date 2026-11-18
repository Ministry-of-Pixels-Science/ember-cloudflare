import type { DirectoryUser, Me } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { agentsToAsk, asListed, canAsk } from "./agents";

const member: Me = { id: "u1", name: "Ada", administrator: false };
const administrator: Me = { id: "u2", name: "Grace", administrator: true };

/** Someone the people directory lists, an active person unless `person` says. */
const listed = (id: string, person: Partial<DirectoryUser> = {}): DirectoryUser => ({
  id,
  name: id,
  bio: null,
  role: "member",
  status: "active",
  avatarUrl: `/users/${id}/avatar`,
  ...person,
});

const ember = listed("ember", { role: "bot", agent: true });
const recap = listed("recap", { role: "bot", agent: true });
const herald = listed("herald", { role: "bot", agent: true, adminsOnly: true });
const deleted = listed("gone", { role: "bot", agent: true, status: "deactivated" });
const webhook = listed("deploys", { role: "bot" });
const linus = listed("u3");

describe("AI agents someone can ask", () => {
  it("lets anyone ask an agent, but one kept for administrators, which only they can", () => {
    expect(canAsk(recap, member)).toBe(true);
    expect(canAsk(herald, member)).toBe(false);
    expect(canAsk(herald, administrator)).toBe(true);
    expect(canAsk(linus, member)).toBe(true);
  });

  it("takes someone as the directory lists them now, with whether only administrators can ask them, which it leaves out once anyone can", () => {
    const fetched = { ...herald, emailAddress: null };
    expect(asListed(fetched, { ...herald, name: "Town Crier" })).toEqual({ ...fetched, name: "Town Crier" });
    const freed = asListed(fetched, listed("herald", { role: "bot", agent: true }));
    expect(freed.adminsOnly).toBeUndefined();
    expect(canAsk(freed, member)).toBe(true);
    expect(asListed(recap, herald).adminsOnly).toBe(true);
  });

  it("takes someone's username as the directory lists it, which it leaves out once they've taken theirs away", () => {
    const grace = listed("grace", { username: "amazing.grace" });
    expect(asListed(grace, listed("grace", { username: "grace" })).username).toBe("grace");
    expect(asListed(grace, listed("grace")).username).toBeUndefined();
  });

  it("counts the active agents, @ember among them, leaving out people, other bots and agents deleted", () => {
    expect(agentsToAsk([ember, recap, deleted, webhook, linus], member)).toBe(2);
    expect(agentsToAsk([linus, webhook], member)).toBe(0);
    expect(agentsToAsk([], administrator)).toBe(0);
  });

  it("counts the agents kept for administrators only for an administrator", () => {
    const people = new Map([ember, recap, herald].map((person) => [person.id, person]));
    expect(agentsToAsk(people.values(), member)).toBe(2);
    expect(agentsToAsk(people.values(), administrator)).toBe(3);
  });
});
