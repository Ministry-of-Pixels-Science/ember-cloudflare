import { parseParts, showsAnything, type Card, type CardField, type CardPart } from "@ember/protocol";
import { cardAddress } from "@ember/richtext";
import { escapeText, plainTextHtml, utcTime } from "./mrkdwn";

// What Atlassian Statuspage's webhooks send (https://support.atlassian.com/statuspage/docs/enable-webhook-notifications/),
// which pages such as githubstatus.com offer their subscribers: its own JSON, with no `text`, so tools that only
// know Statuspage can post to a bot's Slack-compatible address. Cloudflare's status page sends the same `{ meta, incident }`
// from its generic webhook (https://www.cloudflarestatus.com/docs/notifications), with the incident's `latest_update`
// in place of its list of updates. An incident shows as a card of its name, linked, its latest update, its status,
// impact and affected components, in a bar the color of its impact, green once it's resolved, and a maintenance as one
// in blue with its window; a component's change of status shows as a line.

type Payload = Record<string, unknown>;

/** Statuspage's colors for an incident's impact, and for a component's status. */
const COLORS: Record<string, string> = {
  minor: "#f1c40f",
  major: "#e67e22",
  critical: "#e74c3c",
  maintenance: "#3498db",
  operational: "#2fcc66",
  degraded_performance: "#f1c40f",
  partial_outage: "#e67e22",
  major_outage: "#e74c3c",
  under_maintenance: "#3498db",
};

/** The statuses that end an incident or a maintenance, whose card turns green. */
const ENDED = new Set(["resolved", "postmortem", "completed"]);

/** The card a Statuspage webhook's payload shows, or null when `payload` isn't one. */
export function statuspageCard(payload: Payload): Card | null {
  if (!isObject(payload.meta)) return null;
  if (isObject(payload.incident)) return incidentCard(payload.incident);
  if (isObject(payload.component_update)) return componentCard(payload.component_update, isObject(payload.component) ? payload.component : {});
  return null;
}

/**
 * An incident: its name linked to its shortlink, its latest update, its status, impact and the components it
 * affects; or a maintenance, which Statuspage gives the impact `maintenance` and Cloudflare the `incident_type`, with
 * its window in place of its impact.
 */
function incidentCard(incident: Payload): Card | null {
  const update = latestUpdate([...listOf(incident.incident_updates), incident.latest_update]);
  const status = stringOf(update?.status) || stringOf(incident.status);
  const maintenance = incident.incident_type === "maintenance" || incident.impact === "maintenance";
  const impact = maintenance ? "maintenance" : stringOf(incident.impact_override) || stringOf(incident.impact);
  const name = stringOf(incident.name).trim();
  const href = addressOf(incident.shortlink);
  const fields: CardField[] = [
    ...field("Status", label(status), true),
    ...field("Impact", maintenance ? "" : label(impact), true),
    ...field("Window", windowOf(incident.scheduled_for, incident.scheduled_until), false),
    ...field("Components", componentsOf(update, incident), false),
  ];
  const body = plainTextHtml(stringOf(update?.body), false);
  const at = secondsOf(update?.display_at ?? update?.created_at ?? incident.updated_at);
  const candidates: (CardPart | null)[] = [
    name ? { kind: "title", text: name, ...(href && { href }) } : null,
    body ? { kind: "text", html: body } : null,
    fields.length > 0 ? { kind: "fields", fields } : null,
    at === undefined ? null : { kind: "footer", at },
  ];
  const parts = parseParts(candidates.filter((part) => part !== null), addressOf);
  if (!showsAnything(parts)) return null;
  const color = ENDED.has(status) ? COLORS.operational : COLORS[impact];
  return { source: "attachment", ...(color && { color }), parts };
}

/** A component's change of status, on one line: its name, and its status before and after. */
function componentCard(update: Payload, component: Payload): Card | null {
  const name = stringOf(component.name).trim();
  const after = stringOf(update.new_status) || stringOf(component.status);
  const before = stringOf(update.old_status);
  if (!name || !after) return null;
  const change = before && before !== after ? `${label(before)} → ${label(after)}` : label(after);
  const color = COLORS[after];
  return { source: "attachment", ...(color && { color }), parts: [{ kind: "text", html: `<p><strong>${escapeText(name)}</strong>: ${escapeText(change)}</p>` }] };
}

/** The update an incident's subscribers were last told of: the one shown latest, or the first listed when none says when. */
function latestUpdate(updates: unknown[]): Payload | undefined {
  let latest: Payload | undefined;
  for (const update of updates) {
    if (!isObject(update)) continue;
    if (!latest || (secondsOf(update.display_at ?? update.created_at) ?? -Infinity) > (secondsOf(latest.display_at ?? latest.created_at) ?? -Infinity)) latest = update;
  }
  return latest;
}

/** The components an incident affects, each in its status: those its update names, or else those the incident lists. */
function componentsOf(update: Payload | undefined, incident: Payload): string {
  const affected = listOf(update?.affected_components).flatMap((component) =>
    isObject(component) && stringOf(component.name) ? [[stringOf(component.name), stringOf(component.new_status)]] : [],
  );
  const listed = listOf(incident.components).flatMap((component) =>
    isObject(component) && stringOf(component.name) ? [[stringOf(component.name), stringOf(component.status)]] : [],
  );
  return (affected.length > 0 ? affected : listed).map(([name, status]) => (status ? `${name} (${label(status)})` : name!)).join(", ");
}

/** A maintenance's window, from when it's scheduled until when, in UTC, or "" for an incident, which has none. */
function windowOf(from: unknown, until: unknown): string {
  const start = secondsOf(from);
  if (start === undefined) return "";
  const end = secondsOf(until);
  return end === undefined ? utcTime(start) : `${utcTime(start)} – ${utcTime(end)}`;
}

/** A field of `title` over `value`, or none when there's no value. */
function field(title: string, value: string, short: boolean): CardField[] {
  const html = plainTextHtml(value, false);
  return html ? [{ title, html, short }] : [];
}

/** A status or impact as Statuspage shows it: `partial_outage` as "Partial outage". */
const label = (value: string) => {
  const words = value.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A moment Statuspage writes, in seconds, or undefined when it isn't one. */
function secondsOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : Math.floor(time / 1000);
}

/** An address in a payload that a card can show, a web address on a named host, or undefined. */
const addressOf = (url: unknown) => (typeof url === "string" ? cardAddress(url, "") : undefined);

const isObject = (value: unknown): value is Payload => typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown) => (typeof value === "string" ? value : "");

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
