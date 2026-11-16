import { useEffect, useState } from "react";
import type { UserId } from "@ember/protocol";
import { MAX_AGENT_TOOLS, type OfferedApp, type ToolPick } from "@ember/protocol/apps";
import { PageLink } from "@/components/page-link";
import { useMounted } from "@/hooks/use-mounted";
import { NEW_APP_PATH } from "@/hooks/use-route";
import { ApiError, fetchAgentTools, isSignedOut, pickAgentTools } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isOff } from "./agent-list";

// The Tools card on @ember's page and on a saved agent's: every connected app's tools, by app, each with
// a checkbox an administrator picks it with, and, under one that's picked, another that has the agent's
// calls of it always allowed. Each is saved as it's made, as the page's switches are.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** What the card says of the tools `name` is picked. */
export const toolsExplained = (name: string) =>
  `Pick what ${name} may use of the apps you've connected, up to ${MAX_AGENT_TOOLS} tools. Anyone who can ask ${name} could have it use them, with the token each app was connected with, and allows each call on a card first, unless you always allow the tool.`;

/** What the box under a picked tool says it does for the agent `name`. */
export const alwaysAllowExplained = (name: string) => `Always allow: ${name} calls it without asking first, and the room is shown each call`;

/** What the card says in place of its tools, with no app connected. */
export const NO_APPS_TO_PICK = "No apps are connected yet.";

/** What the card says under an app whose server has come to have no tools Ember can use. */
export const NO_TOOLS_TO_PICK = "Its server has no tools Ember can use any more.";

/** What the card says under a tool whose app describes it another way than when it was picked. */
export const TOOL_CHANGED = "Its app describes this tool another way than when it was picked, so it's set aside. Pick it again to keep it.";

/** How many of the tools an agent may use are picked. */
export const pickedOf = (count: number) => `${count} of ${MAX_AGENT_TOOLS} picked`;

/** The tools `apps` have an agent use. */
const picksIn = (apps: readonly OfferedApp[]): ToolPick[] =>
  apps.flatMap(({ id, tools }) => tools.filter(({ picked }) => picked).map(({ name, fingerprint, alwaysAllowed }) => ({ appId: id, name, fingerprint, ...(alwaysAllowed && { alwaysAllowed }) })));

/** Whether `pick` is of the tool `tool` is of. */
const isPickOf = (pick: ToolPick, tool: ToolPick) => pick.appId === tool.appId && pick.name === tool.name;

/** Whether the server refused picks for a reason the card says itself: too many, or a tool that's gone. */
const isRefusal = (error: unknown): error is ApiError => error instanceof ApiError && (error.status === 422 || (error.status === 409 && !isOff(error)));

interface Props {
  /** Whose tools these are: @ember's id, or an agent's. */
  agentId: UserId;
  /** What it's called. */
  name: string;
  /** Says why loading or saving failed, unless the card says so itself. */
  onFailed: (error: unknown) => void;
}

/** The Tools card: each connected app's tools, with the ones the agent may use checked, saved as they're picked. */
export function AgentTools({ agentId, name, onFailed }: Props) {
  const [apps, setApps] = useState<OfferedApp[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mounted = useMounted();

  useEffect(() => {
    let stopped = false;
    fetchAgentTools(agentId).then(
      (apps) => !stopped && setApps(apps),
      (error: unknown) => {
        // A card gone before its tools load only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [agentId, onFailed]);

  /**
   * Saves `picks` as every tool the agent may use, and shows what the server then offers: after a
   * refusal, what it offers now, and after any other failure, what was `shown` before the pick.
   */
  const save = (picks: ToolPick[], shown: OfferedApp[] | null) => {
    setSaving(true);
    setRefusal(null);
    pickAgentTools(agentId, picks)
      .catch((error: unknown) => {
        if (!isRefusal(error)) throw error;
        if (mounted.current) setRefusal(error.message);
        return fetchAgentTools(agentId);
      })
      .then(
        (apps) => {
          if (!mounted.current) return;
          setApps(apps);
          setSaving(false);
        },
        (error: unknown) => {
          if (!mounted.current && !isSignedOut(error)) return;
          setApps(shown);
          setSaving(false);
          onFailed(error);
        },
      );
  };

  const picks = apps ? picksIn(apps) : [];
  const full = picks.length >= MAX_AGENT_TOOLS;
  /** Checks or unchecks a tool at once, as a checkbox does, and saves the picks that leaves: the server's answer then says what's picked. */
  const pick = (tool: ToolPick, picked: boolean) => {
    setApps((apps) => apps && apps.map((app) => (app.id === tool.appId ? { ...app, tools: app.tools.map((offered) => (offered.name === tool.name ? { ...offered, picked, alwaysAllowed: false } : offered)) } : app)));
    save(picked ? [...picks, tool] : picks.filter((pick) => !isPickOf(pick, tool)), apps);
  };
  /** Has a picked tool's calls always allowed, or asked for again, and saves the picks as that leaves them. */
  const alwaysAllow = (tool: ToolPick, alwaysAllowed: boolean) => {
    setApps((apps) => apps && apps.map((app) => (app.id === tool.appId ? { ...app, tools: app.tools.map((offered) => (offered.name === tool.name ? { ...offered, alwaysAllowed } : offered)) } : app)));
    save(
      picks.map((pick) => (isPickOf(pick, tool) ? { ...tool, ...(alwaysAllowed && { alwaysAllowed }) } : pick)),
      apps,
    );
  };

  return (
    <section aria-labelledby="agent-tools-heading" aria-busy={apps === null || saving} className="flex min-w-0 flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-[1ch]">
          <h2 id="agent-tools-heading" className="text-base font-semibold">
            Tools
          </h2>
          {apps !== null && apps.length > 0 && <span className={NOTE}>{pickedOf(picks.length)}</span>}
        </div>
        <p id="agent-tools-description" className={NOTE}>
          {toolsExplained(name)}
        </p>
      </div>
      {refusal !== null && (
        <p role="alert" className={cn(NOTE, "text-negative")}>
          {refusal}
        </p>
      )}
      {apps?.length === 0 && (
        <p className={cn(NOTE, "rounded-[10px] border border-dashed border-muted-foreground px-[1ch] py-4 text-center")}>
          {NO_APPS_TO_PICK}{" "}
          <PageLink href={NEW_APP_PATH} className="underline">
            Connect an app
          </PageLink>
        </p>
      )}
      {apps?.map(({ id, name: app, tools }) => (
        <fieldset key={id} disabled={saving} className="flex min-w-0 flex-col">
          <legend className="pb-1 font-semibold">{app}</legend>
          {tools.length === 0 && <p className={NOTE}>{NO_TOOLS_TO_PICK}</p>}
          <ul className="flex max-h-[24em] flex-col overflow-y-auto overscroll-contain rounded-[10px] border bg-background empty:hidden">
            {tools.map(({ name: tool, title, description, fingerprint, picked, changed, alwaysAllowed }) => (
              <li key={tool} className="border-t first:border-t-0">
                {/* For fingers, the box sits far enough into its label, whatever the font, for a fingertip on it to land on the label. */}
                <label className="flex cursor-pointer items-start gap-[1.5ch] px-[1.5ch] py-2.5 has-disabled:cursor-default touch:min-h-11 touch:ps-4">
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={!picked && full}
                    onChange={(event) => pick({ appId: id, name: tool, fingerprint }, event.target.checked)}
                    aria-label={title !== null && title !== tool ? `${tool}, ${title}` : tool}
                    aria-describedby={`agent-tool-${id}-${tool}`}
                    className="mt-1 size-4 flex-none accent-foreground"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-[1ch]">
                      <code className="font-mono text-[0.9em] font-semibold wrap-anywhere">{tool}</code>
                      {title !== null && title !== tool && <span className={NOTE}>{title}</span>}
                    </span>
                    <span id={`agent-tool-${id}-${tool}`} className="block">
                      {description !== "" && <span className="block text-[0.9em] wrap-anywhere whitespace-pre-line text-message-ink max-md:text-[13px]">{description}</span>}
                      {changed && <span className={cn(NOTE, "block text-negative")}>{TOOL_CHANGED}</span>}
                    </span>
                  </span>
                </label>
                {picked && (
                  <label className="flex cursor-pointer items-center gap-[1.5ch] ps-[calc(3ch+1rem)] pe-[1.5ch] pb-2.5 has-disabled:cursor-default touch:min-h-12 touch:ps-[calc(2rem+1.5ch)] touch:pb-0">
                    <input
                      type="checkbox"
                      checked={alwaysAllowed}
                      onChange={(event) => alwaysAllow({ appId: id, name: tool, fingerprint }, event.target.checked)}
                      aria-label={`Always allow ${tool}`}
                      className="size-4 flex-none accent-foreground"
                    />
                    <span className={NOTE}>{alwaysAllowExplained(name)}</span>
                  </label>
                )}
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
    </section>
  );
}
