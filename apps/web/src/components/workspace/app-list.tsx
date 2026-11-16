import { useEffect, useState } from "react";
import { APPS_FULL, MAX_APPS, type AppSummary } from "@ember/protocol/apps";
import { EditPencil, Plus } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { appSettingsPath, NEW_APP_PATH } from "@/hooks/use-route";
import { fetchApps, isSignedOut } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BUTTON } from "./email-settings";
import { ROUND_BUTTON } from "./link-buttons";

// The Apps card on the AI assistant tab, under Agents, for administrators while Ember AI is on: Connect
// an app, then each app connected, by name, with where its MCP server is, how many tools Ember read
// from it, whether Ember's sign-in to it has ended, and whether any tool an agent had is set aside, each
// with a link to its page.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** What the card says of apps. */
export const APPS_EXPLAINED = `Connect another service by the address of its MCP server, and Ember reads the tools it offers, which you pick for @ember and for each agent on its page. Each call an agent makes waits on a card in its room until whoever asked, or an administrator, allows it, unless you always allow that agent the tool. You can connect up to ${MAX_APPS}.`;

/** What the card says in place of its list, with no app connected. */
export const NO_APPS = "No apps are connected yet.";

/** What a row says of an app's tools that are set aside for an agent that had them, as its page says which. */
export const setAsideOf = (count: number) => (count === 1 ? "1 picked tool is set aside: its app changed it" : `${count} picked tools are set aside: their app changed them`);

/** What a row says of an app whose sign-in has ended, which its page signs in to again. */
export const SIGN_IN_ENDED = "Its sign-in has ended: sign in to it again on its page";

/** What a row says of an app whose server asks for more than Ember's sign-in to it allows, which signing in again on its page asks for. */
export const WANTS_ACCESS = "Its server asks for more than its sign-in allows: sign in to it again on its page";

/** How many tools a row says Ember read from an app. */
export const toolsOf = (count: number) => (count === 1 ? "1 tool" : `${count} tools`);

/** Where an app's server is, as a row names it: its host, and its path unless that's only a slash. */
export function addressOf(url: string): string {
  const address = URL.parse(url);
  if (!address) return url;
  return address.host + (address.pathname === "/" ? "" : address.pathname);
}

interface Props {
  /** Says why loading the apps failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** The Apps card: Connect an app, unless there are as many as there can be, then the apps, by name. */
export function AppList({ onFailed }: Props) {
  const [apps, setApps] = useState<AppSummary[] | null>(null);

  useEffect(() => {
    let stopped = false;
    fetchApps().then(
      (apps) => !stopped && setApps(apps),
      (error: unknown) => {
        // A card gone before its apps load only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [onFailed]);

  const full = (apps?.length ?? 0) >= MAX_APPS;
  return (
    <section aria-labelledby="apps-heading" aria-busy={apps === null} className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex flex-wrap items-center gap-x-[1ch] gap-y-3">
        <div className="min-w-[16em] flex-1">
          <h2 id="apps-heading" className="text-base font-semibold">
            Apps
          </h2>
          <p id="apps-description" className={NOTE}>
            {full ? APPS_FULL : APPS_EXPLAINED}
          </p>
        </div>
        {full ? (
          <button type="button" disabled aria-describedby="apps-description" className={cn(BUTTON, "gap-[0.5em]")}>
            <Plus className="size-[18px]" />
            <span>Connect an app</span>
          </button>
        ) : (
          <PageLink href={NEW_APP_PATH} className={cn(BUTTON, "gap-[0.5em]")}>
            <Plus className="size-[18px]" />
            <span>Connect an app</span>
          </PageLink>
        )}
      </div>
      {apps?.length === 0 && <p className={cn(NOTE, "rounded-[10px] border border-dashed border-muted-foreground px-[1ch] py-4 text-center")}>{NO_APPS}</p>}
      {apps !== null && apps.length > 0 && (
        <ul aria-labelledby="apps-heading" className="flex flex-col">
          {apps.map(({ id, name, url, toolCount, setAside, signInEnded, wantsAccess }) => (
            <li key={id} className="flex items-center gap-x-[1.5ch] border-t py-3 last:pb-0">
              <div className="min-w-0 flex-1">
                <strong className="block truncate">{name}</strong>
                <p className={cn(NOTE, "wrap-anywhere")}>{[addressOf(url), toolsOf(toolCount)].join(" · ")}</p>
                {signInEnded && <p className={cn(NOTE, "text-negative")}>{SIGN_IN_ENDED}</p>}
                {wantsAccess && !signInEnded && <p className={cn(NOTE, "text-negative")}>{WANTS_ACCESS}</p>}
                {setAside > 0 && <p className={cn(NOTE, "text-negative")}>{setAsideOf(setAside)}</p>}
              </div>
              <PageLink href={appSettingsPath(id)} className={ROUND_BUTTON}>
                <EditPencil className="size-[1.3em]" />
                <span className="sr-only">Edit {name}</span>
              </PageLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
