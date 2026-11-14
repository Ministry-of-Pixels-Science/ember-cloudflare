import { useState } from "react";
import { MCP_PATH, type OutsideConnection } from "@ember/protocol/outside";
import { useFlash } from "@/components/flash";
import { useMounted } from "@/hooks/use-mounted";
import { disconnectOutside, isSignedOut } from "@/lib/api";
import { dateTimeLabel } from "@/lib/messages";
import { BUTTON } from "./email-settings";

// The AI apps section of your profile, while an administrator lets AI apps connect: the address to give
// an app such as Claude, which then asks you on a page of Ember's before it's connected, and each app
// connected as you, with Disconnect. Your profile shows it only while AI apps can connect as you. Boxed
// as the Apps section is.

/** What the section says of connecting an AI app. */
export const OUTSIDE_AI_EXPLAINED =
  "Connect an AI app, such as Claude, to Ember by giving it this address as a connector or MCP server. It sends you to a page here that asks you first, and can then see the rooms you're in, read their messages and search them, as you can.";

/** What the section says in place of its list, with nothing connected as you. */
export const NOTHING_CONNECTED = "No AI app is connected as you.";

/** What a row says of a connection: where its app came back to, when you connected it, and when it last asked Ember anything, if it has. */
export function connectionStatus({ comesBackTo, connectedAt, usedAt }: OutsideConnection): string {
  const connected = `From ${comesBackTo}, connected ${dateTimeLabel(new Date(connectedAt))}.`;
  return usedAt === null ? `${connected} It hasn't asked Ember anything yet.` : `${connected} It last asked Ember something ${dateTimeLabel(new Date(usedAt))}.`;
}

/** What's said once `name` is disconnected. */
export const disconnectedNotice = (name: string) => `${name} is disconnected. It can't read Ember as you any more.`;

/** The address to give an AI app: where this Ember answers them. */
export const outsideAddress = () => `${location.origin}${MCP_PATH}`;

interface Props {
  /** The AI apps connected as you, newest first. */
  connections: OutsideConnection[];
  /** Takes the ones left once one is disconnected. */
  onChanged: (connections: OutsideConnection[]) => void;
  /** Says why disconnecting failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** The address to give an AI app, and the apps connected as you, each with Disconnect. */
export function YourOutsideAi({ connections, onChanged, onFailed }: Props) {
  /** The connection being ended. */
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useMounted();
  const flash = useFlash();

  const disconnect = ({ id, name }: OutsideConnection) => {
    setBusy(id);
    disconnectOutside(id).then(
      ({ connections }) => {
        if (!mounted.current) return;
        setBusy(null);
        onChanged(connections);
        flash("notice", disconnectedNotice(name));
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setBusy(null);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="your-outside-ai-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id="your-outside-ai-heading" className="text-base font-semibold">
        AI apps
      </h2>
      <p id="your-outside-ai-description">{OUTSIDE_AI_EXPLAINED}</p>
      <input
        type="text"
        readOnly
        value={outsideAddress()}
        aria-label="The address to give an AI app"
        aria-describedby="your-outside-ai-description"
        className="min-h-[42px] w-full min-w-0 rounded-[9px] border bg-background px-[0.8em] py-[0.5em]"
      />
      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NOTHING_CONNECTED}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {connections.map((connection) => (
            <li key={connection.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 flex-col">
                <span className="font-semibold wrap-anywhere">{connection.name}</span>
                <span className="text-sm text-muted-foreground wrap-anywhere">{connectionStatus(connection)}</span>
              </div>
              <button type="button" disabled={busy !== null} aria-label={`Disconnect ${connection.name}`} onClick={() => disconnect(connection)} className={BUTTON}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
