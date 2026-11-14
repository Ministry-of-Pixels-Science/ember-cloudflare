import messages from "../migrations/0001_messages.sql";
import clientMessageIds from "../migrations/0002_client_message_ids.sql";
import usersAndSessions from "../migrations/0003_users_and_sessions.sql";
import roomsAndMemberships from "../migrations/0004_rooms_and_memberships.sql";
import accounts from "../migrations/0005_accounts.sql";
import revocations from "../migrations/0006_revocations.sql";
import pendingRevocations from "../migrations/0007_pending_revocations.sql";
import deletedRooms from "../migrations/0008_deleted_rooms.sql";
import roomIcons from "../migrations/0009_room_icons.sql";
import roomEvents from "../migrations/0010_room_events.sql";
import unreadMarks from "../migrations/0011_unread_marks.sql";
import richText from "../migrations/0012_rich_text.sql";
import favorites from "../migrations/0013_favorites.sql";
import roomsByAge from "../migrations/0014_rooms_by_age.sql";
import numberedChanges from "../migrations/0015_numbered_changes.sql";
import directKeys from "../migrations/0016_direct_keys.sql";
import directActivity from "../migrations/0017_direct_activity.sql";
import bans from "../migrations/0018_bans.sql";
import messagesByCreator from "../migrations/0019_messages_by_creator.sql";
import sharedRoomOrder from "../migrations/0020_shared_room_order.sql";
import unindexedMessages from "../migrations/0021_unindexed_messages.sql";
import pendingReindexes from "../migrations/0022_pending_reindexes.sql";
import recentSearches from "../migrations/0023_recent_searches.sql";
import pushSubscriptions from "../migrations/0024_push_subscriptions.sql";
import roomEventMessages from "../migrations/0025_room_event_messages.sql";
import pushSubscriptionIds from "../migrations/0026_push_subscription_ids.sql";
import bots from "../migrations/0027_bots.sql";
import blobs from "../migrations/0028_blobs.sql";
import fileMessages from "../migrations/0029_file_messages.sql";
import filePreviews from "../migrations/0030_file_previews.sql";
import purgedFiles from "../migrations/0031_purged_files.sql";
import avatars from "../migrations/0032_avatars.sql";
import logos from "../migrations/0033_logos.sql";
import messageCards from "../migrations/0034_message_cards.sql";
import pushSubscriptionsPerBrowser from "../migrations/0035_push_subscriptions_per_browser.sql";
import invitationDismissals from "../migrations/0036_invitation_dismissals.sql";
import identities from "../migrations/0037_identities.sql";
import membershipChecks from "../migrations/0038_membership_checks.sql";
import pendingIdentities from "../migrations/0039_pending_identities.sql";
import searchResultsReindex from "../migrations/0040_search_results.sql";
import emailLinks from "../migrations/0041_email_links.sql";
import emailLinkRequests from "../migrations/0042_email_link_requests.sql";
import passwordResets from "../migrations/0043_password_resets.sql";
import threads from "../migrations/0044_threads.sql";
import answerLevels from "../migrations/0045_answer_levels.sql";
import assistantModels from "../migrations/0046_assistant_models.sql";
import searchFiltersReindex from "../migrations/0047_search_filters.sql";
import recentSearchesWithFilters from "../migrations/0048_recent_searches.sql";
import identityAccounts from "../migrations/0049_identity_accounts.sql";
import agents from "../migrations/0050_agents.sql";
import huddles from "../migrations/0051_huddles.sql";
import agentPromptTemplates from "../migrations/0052_agent_prompt_templates.sql";
import unbannedOpenRooms from "../migrations/0053_unbanned_open_rooms.sql";
import agentThinkingLevels from "../migrations/0054_agent_thinking_levels.sql";
import apps from "../migrations/0055_apps.sql";
import agentTools from "../migrations/0056_agent_tools.sql";
import waitingCalls from "../migrations/0057_waiting_calls.sql";
import appSignIns from "../migrations/0058_app_sign_ins.sql";
import appSignInClients from "../migrations/0059_app_sign_in_clients.sql";
import appScopeWanted from "../migrations/0060_app_scope_wanted.sql";
import ownAppSignIns from "../migrations/0061_own_app_sign_ins.sql";
import outsideAi from "../migrations/0062_outside_ai.sql";
import searchIndex from "../search-migrations/0001_search_index.sql";
import searchResults from "../search-migrations/0002_search_results.sql";
import searchFilters from "../search-migrations/0003_search_filters.sql";

/**
 * The kind of Durable Object whose tables a migration creates or changes. On DO SQLite each object
 * applies only its own kind's migrations, so a room's storage never holds the workspace's tables;
 * D1 holds every kind's. The search index keeps its tables in its own storage on either backend
 * (`SEARCH_MIGRATIONS`).
 */
export type Scope = "room" | "workspace" | "search";

export interface Migration {
  name: string;
  scope: Scope;
  sql: string;
}

/**
 * Every file in migrations/, oldest first. D1 gets them all from `wrangler d1 migrations apply`; each
 * Durable Object applies the ones for its scope that its storage is missing when it opens. A test
 * checks this list against the directory.
 */
export const MIGRATIONS: Migration[] = [
  { name: "0001_messages.sql", scope: "room", sql: messages },
  { name: "0002_client_message_ids.sql", scope: "room", sql: clientMessageIds },
  { name: "0003_users_and_sessions.sql", scope: "workspace", sql: usersAndSessions },
  { name: "0004_rooms_and_memberships.sql", scope: "workspace", sql: roomsAndMemberships },
  { name: "0005_accounts.sql", scope: "workspace", sql: accounts },
  { name: "0006_revocations.sql", scope: "room", sql: revocations },
  { name: "0007_pending_revocations.sql", scope: "workspace", sql: pendingRevocations },
  { name: "0008_deleted_rooms.sql", scope: "workspace", sql: deletedRooms },
  { name: "0009_room_icons.sql", scope: "workspace", sql: roomIcons },
  { name: "0010_room_events.sql", scope: "room", sql: roomEvents },
  { name: "0011_unread_marks.sql", scope: "workspace", sql: unreadMarks },
  { name: "0012_rich_text.sql", scope: "room", sql: richText },
  { name: "0013_favorites.sql", scope: "workspace", sql: favorites },
  { name: "0014_rooms_by_age.sql", scope: "workspace", sql: roomsByAge },
  { name: "0015_numbered_changes.sql", scope: "room", sql: numberedChanges },
  { name: "0016_direct_keys.sql", scope: "workspace", sql: directKeys },
  { name: "0017_direct_activity.sql", scope: "workspace", sql: directActivity },
  { name: "0018_bans.sql", scope: "workspace", sql: bans },
  { name: "0019_messages_by_creator.sql", scope: "room", sql: messagesByCreator },
  { name: "0020_shared_room_order.sql", scope: "workspace", sql: sharedRoomOrder },
  { name: "0021_unindexed_messages.sql", scope: "room", sql: unindexedMessages },
  { name: "0022_pending_reindexes.sql", scope: "workspace", sql: pendingReindexes },
  { name: "0023_recent_searches.sql", scope: "workspace", sql: recentSearches },
  { name: "0024_push_subscriptions.sql", scope: "workspace", sql: pushSubscriptions },
  { name: "0025_room_event_messages.sql", scope: "room", sql: roomEventMessages },
  { name: "0026_push_subscription_ids.sql", scope: "workspace", sql: pushSubscriptionIds },
  { name: "0027_bots.sql", scope: "workspace", sql: bots },
  { name: "0028_blobs.sql", scope: "room", sql: blobs },
  { name: "0029_file_messages.sql", scope: "room", sql: fileMessages },
  { name: "0030_file_previews.sql", scope: "room", sql: filePreviews },
  { name: "0031_purged_files.sql", scope: "room", sql: purgedFiles },
  { name: "0032_avatars.sql", scope: "workspace", sql: avatars },
  { name: "0033_logos.sql", scope: "workspace", sql: logos },
  { name: "0034_message_cards.sql", scope: "room", sql: messageCards },
  { name: "0035_push_subscriptions_per_browser.sql", scope: "workspace", sql: pushSubscriptionsPerBrowser },
  { name: "0036_invitation_dismissals.sql", scope: "workspace", sql: invitationDismissals },
  { name: "0037_identities.sql", scope: "workspace", sql: identities },
  { name: "0038_membership_checks.sql", scope: "workspace", sql: membershipChecks },
  { name: "0039_pending_identities.sql", scope: "workspace", sql: pendingIdentities },
  { name: "0040_search_results.sql", scope: "workspace", sql: searchResultsReindex },
  { name: "0041_email_links.sql", scope: "workspace", sql: emailLinks },
  { name: "0042_email_link_requests.sql", scope: "workspace", sql: emailLinkRequests },
  { name: "0043_password_resets.sql", scope: "workspace", sql: passwordResets },
  { name: "0044_threads.sql", scope: "room", sql: threads },
  { name: "0045_answer_levels.sql", scope: "workspace", sql: answerLevels },
  { name: "0046_assistant_models.sql", scope: "workspace", sql: assistantModels },
  { name: "0047_search_filters.sql", scope: "workspace", sql: searchFiltersReindex },
  { name: "0048_recent_searches.sql", scope: "workspace", sql: recentSearchesWithFilters },
  { name: "0049_identity_accounts.sql", scope: "workspace", sql: identityAccounts },
  { name: "0050_agents.sql", scope: "workspace", sql: agents },
  { name: "0051_huddles.sql", scope: "workspace", sql: huddles },
  { name: "0052_agent_prompt_templates.sql", scope: "workspace", sql: agentPromptTemplates },
  { name: "0053_unbanned_open_rooms.sql", scope: "workspace", sql: unbannedOpenRooms },
  { name: "0054_agent_thinking_levels.sql", scope: "workspace", sql: agentThinkingLevels },
  { name: "0055_apps.sql", scope: "workspace", sql: apps },
  { name: "0056_agent_tools.sql", scope: "workspace", sql: agentTools },
  { name: "0057_waiting_calls.sql", scope: "room", sql: waitingCalls },
  { name: "0058_app_sign_ins.sql", scope: "workspace", sql: appSignIns },
  { name: "0059_app_sign_in_clients.sql", scope: "workspace", sql: appSignInClients },
  { name: "0060_app_scope_wanted.sql", scope: "workspace", sql: appScopeWanted },
  { name: "0061_own_app_sign_ins.sql", scope: "workspace", sql: ownAppSignIns },
  { name: "0062_outside_ai.sql", scope: "workspace", sql: outsideAi },
];

/**
 * Every file in search-migrations/, oldest first: the search index's, which it applies to its own
 * storage when it opens, whatever `STORAGE_BACKEND` says, so wrangler never puts them in D1. Its tables
 * hold nothing the rooms can't send it again, and D1 can't export a database that holds a virtual table,
 * as FTS5's are. A test checks this list against the directory.
 */
export const SEARCH_MIGRATIONS: Migration[] = [
  { name: "0001_search_index.sql", scope: "search", sql: searchIndex },
  { name: "0002_search_results.sql", scope: "search", sql: searchResults },
  { name: "0003_search_filters.sql", scope: "search", sql: searchFilters },
];

/**
 * Applies the migrations for `scope` that a Durable Object's storage is missing, recording each in
 * the table wrangler keeps for D1. Rooms from before this table existed ran 0001 already; it only
 * creates what's missing, so it runs again harmlessly and is recorded.
 */
export function migrate(storage: DurableObjectStorage, scope: Scope): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(storage.sql.exec<{ name: string }>("SELECT name FROM d1_migrations").toArray().map((row) => row.name));
  for (const migration of scope === "search" ? SEARCH_MIGRATIONS : MIGRATIONS) {
    if (migration.scope !== scope || applied.has(migration.name)) continue;
    storage.transactionSync(() => {
      storage.sql.exec(migration.sql);
      storage.sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", migration.name);
    });
  }
}
