import { useContext, useEffect, useMemo, useState } from "react";
import { ASSISTANT_ID, ASSISTANT_NAME, type DirectoryUser } from "@ember/protocol";
import { AGENTS_FORBIDDEN, AGENTS_FULL, EMBER_DOES, MAX_AGENTS, type Agent } from "@ember/protocol/agents";
import { ASSISTANT_OFF, modelName, type AssistantSettings } from "@ember/protocol/assistant";
import { useFlash } from "@/components/flash";
import { EditPencil, Plus } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { agentSettingsPath, navigate, NEW_AGENT_PATH, WORKSPACE_SETTINGS_PATH } from "@/hooks/use-route";
import { DMS_ONLY, EVERY_ROOM, KEPT_FOR } from "@/lib/agents";
import { ApiError, fetchAgents, isSignedOut } from "@/lib/api";
import { byName } from "@/lib/people";
import { cn } from "@/lib/utils";
import { BUTTON } from "./email-settings";
import { ROUND_BUTTON } from "./link-buttons";
import { workspaceSectionPath } from "./settings-navigation";
import { UserAvatar } from "./user-avatar";

// The Agents card on the AI assistant tab, for administrators while Ember AI is on: New agent, then
// @ember, built in, and each agent made, by name, with what it does, its model, whether it searches the
// web, whether it's kept for administrators, and its rooms, each with a link to its page. An agent
// deleted or renamed elsewhere leaves or is renamed here as soon as the people directory hears of it, as
// the Chat bots page's bots do.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** The AI assistant tab, which the agents' pages go back to. */
export const AGENTS_PATH = workspaceSectionPath("assistant-settings");

/** Whether `error` says Ember AI is off. */
export const isOff = (error: unknown) => error instanceof ApiError && error.status === 409 && error.message === ASSISTANT_OFF;

/**
 * Sends anyone but an administrator away from the agents' pages to workspace settings, as the bot pages
 * do, and an administrator to the AI assistant tab while Ember AI is off, where it's turned on, each
 * with an alert saying why: `forbidden` and `off`, and `failed` with an error, which goes to `onFailed`
 * unless the server answered one of those.
 */
export function useAgentsOnly(onFailed: (error: unknown) => void) {
  const flash = useFlash();
  return useMemo(() => {
    const sendAway = (path: string, alert: string) => {
      navigate(path, { replace: true });
      flash("alert", alert);
    };
    const forbidden = (alert = AGENTS_FORBIDDEN) => sendAway(WORKSPACE_SETTINGS_PATH, alert);
    const off = () => sendAway(AGENTS_PATH, ASSISTANT_OFF);
    const failed = (error: unknown) => (error instanceof ApiError && error.status === 403 ? forbidden(error.message) : isOff(error) ? off() : onFailed(error));
    return { forbidden, off, failed };
  }, [flash, onFailed]);
}

/** What the card says of agents. */
export const AGENTS_EXPLAINED = `People mention an agent by name, and it answers following the instructions you gave it, on the model you chose for it. You can make up to ${MAX_AGENTS}.`;

/** What a row says of an agent that searches the web. */
export const SEARCHES_THE_WEB = "Searches the web";

/** The most rooms a row names, before it counts the rest. */
const ROOMS_NAMED = 3;

/** What a row says of an agent's rooms: every open room, new ones too, or the ones it's kept to, or else that only its DMs reach it. */
export function roomsOf(rooms: Agent["rooms"]): string {
  if (rooms === null) return EVERY_ROOM;
  if (rooms.length === 0) return DMS_ONLY;
  const names = rooms.map(({ name }) => name);
  return names.length > ROOMS_NAMED ? `${names.slice(0, ROOMS_NAMED).join(", ")} and ${names.length - ROOMS_NAMED} more` : names.join(", ");
}

/** What a row says of who can ask an agent, and where: its rooms, after Admins only for one kept for administrators, or that only their DMs reach it. */
export function reachOf({ access, rooms }: Pick<Agent, "access" | "rooms">): string[] {
  if (access === "admin-dms") return [KEPT_FOR[access]];
  return access === "admins" ? [KEPT_FOR[access], roomsOf(rooms)] : [roomsOf(rooms)];
}

interface Row {
  user: DirectoryUser;
  description: string;
  details: string[];
  builtIn: boolean;
}

/** @ember's row, from Ember AI's settings: the model it answers everyone with, whether people can pick theirs, and whether it searches. */
function emberRow(assistant: AssistantSettings, people: People): Row {
  const user = people.get(ASSISTANT_ID) ?? { id: ASSISTANT_ID, name: ASSISTANT_NAME, bio: null, role: "bot", status: "active", avatarUrl: assistant.avatarUrl };
  const model = modelName(assistant.model, assistant.models) + (assistant.models.length > 1 ? ", or the model each person picks" : "");
  const searches = assistant.webTools?.includes("search") ?? false;
  return { user, description: EMBER_DOES, details: [model, ...(searches ? [SEARCHES_THE_WEB] : []), roomsOf(null)], builtIn: true };
}

/** `agents` as the people directory has them now: by their names now, and without those it says are gone. */
const listedNow = (agents: Agent[], people: People) =>
  byName(agents.filter(({ id }) => people.get(id)?.status !== "deactivated").map((agent) => ({ ...agent, name: people.get(agent.id)?.name ?? agent.name })));

/** An agent's row, as the people directory has it now. */
const agentRow = (agent: Agent, people: People): Row => ({
  user: people.get(agent.id) ?? agent,
  description: agent.description,
  details: [agent.modelName, ...(agent.webTools.includes("search") ? [SEARCHES_THE_WEB] : []), ...reachOf(agent)],
  builtIn: false,
});

interface Props {
  assistant: AssistantSettings;
  /** Says why loading the agents failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** The Agents card: New agent, unless there are as many as there can be, then @ember and the agents, by name. */
export function AgentList({ assistant, onFailed }: Props) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const people = useContext(PeopleContext);

  useEffect(() => {
    let stopped = false;
    fetchAgents().then(
      (agents) => !stopped && setAgents(agents),
      (error: unknown) => {
        // A card gone before its agents load only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [onFailed]);

  const listed = listedNow(agents ?? [], people);
  const full = listed.length >= MAX_AGENTS;
  const rows = [emberRow(assistant, people), ...listed.map((agent) => agentRow(agent, people))];
  return (
    <section aria-labelledby="agents-heading" aria-busy={agents === null} className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex flex-wrap items-center gap-x-[1ch] gap-y-3">
        <div className="min-w-[16em] flex-1">
          <h2 id="agents-heading" className="text-base font-semibold">
            Agents
          </h2>
          <p id="agents-description" className={NOTE}>
            {full ? AGENTS_FULL : AGENTS_EXPLAINED}
          </p>
        </div>
        {full ? (
          <button type="button" disabled aria-describedby="agents-description" className={cn(BUTTON, "gap-[0.5em]")}>
            <Plus className="size-[18px]" />
            <span>New agent</span>
          </button>
        ) : (
          <PageLink href={NEW_AGENT_PATH} className={cn(BUTTON, "gap-[0.5em]")}>
            <Plus className="size-[18px]" />
            <span>New agent</span>
          </PageLink>
        )}
      </div>
      <ul aria-labelledby="agents-heading" className="flex flex-col">
        {rows.map(({ user, description, details, builtIn }) => (
          <li key={user.id} className="flex items-center gap-x-[1.5ch] border-t py-3 last:pb-0">
            <UserAvatar user={user} className="size-[2.65em] flex-none" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-x-[1ch]">
                <strong className="truncate">{user.name}</strong>
                {builtIn && <span className={NOTE}>Built in</span>}
              </div>
              <p className="text-[0.9em] wrap-anywhere text-message-ink max-md:text-[13px]">{description}</p>
              <p className={cn(NOTE, "wrap-anywhere")}>{details.join(" · ")}</p>
            </div>
            <PageLink href={agentSettingsPath(user.id)} className={ROUND_BUTTON}>
              <EditPencil className="size-[1.3em]" />
              <span className="sr-only">Edit {user.name}</span>
            </PageLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
