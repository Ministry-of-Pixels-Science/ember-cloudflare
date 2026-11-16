import type { DirectoryUser, Me } from "@ember/protocol";
import type { AgentAccess } from "@ember/protocol/agents";

/** What's said of an agent in every room open to everyone, new ones too, as the project's owner worded it (2026-11-15). */
export const EVERY_ROOM = "Every room";

/** What's said of an agent in no room, which direct messages alone reach. */
export const DMS_ONLY = "Direct messages only";

/** What's said of an agent kept for administrators, by how it's kept. */
export const KEPT_FOR: Readonly<Record<Exclude<AgentAccess, "everyone">, string>> = { admins: "Admins only", "admin-dms": "Admin DMs only" };

/** Whether `me` can ask someone the people directory lists: an AI agent kept for administrators answers only them. */
export const canAsk = (person: Pick<DirectoryUser, "adminsOnly">, me: Me) => me.administrator || person.adminsOnly !== true;

/**
 * `person` as the people directory lists them now, `listed`: its entry over what was read of them before,
 * with whether only administrators can ask them, which the entry leaves out once anyone can again.
 */
export const asListed = <P extends DirectoryUser>(person: P, listed: DirectoryUser): P => ({ ...person, ...listed, adminsOnly: listed.adminsOnly });

/**
 * How many AI agents `me` can ask, of the `people` the directory lists, which the sidebar's Available
 * Agents says: @ember and the agents administrators made, while they're active, which none is while
 * Ember AI is off.
 */
export function agentsToAsk(people: Iterable<DirectoryUser>, me: Me): number {
  let count = 0;
  for (const person of people) if (person.agent && person.status === "active" && canAsk(person, me)) count++;
  return count;
}
