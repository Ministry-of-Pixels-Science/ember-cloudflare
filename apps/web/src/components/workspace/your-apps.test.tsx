import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YOUR_APP_GONE, type YourApp, type YourAppSignedOut } from "@ember/protocol/apps";
import { FlashProvider } from "@/components/flash";
import { dateTimeLabel } from "@/lib/messages";
import * as page from "@/lib/page";
import { isOwnSignIn, NOT_SIGNED_IN, SIGN_IN_ENDED, signedInAt, signedOutNotice, WANTS_MORE, YOUR_APPS_EXPLAINED, YourApps } from "./your-apps";

const AT = "2026-11-14T09:00:00.000Z";
const LINEAR: YourApp = { id: "0mgk3x2a9b4c70", name: "Linear", signedInAt: null, ended: false, wantsMore: false };
const NOTION: YourApp = { id: "0mgk3x2a9b4c71", name: "Notion", signedInAt: AT, ended: false, wantsMore: false };
const AUTHORIZE = "https://auth.linear.example/authorize?client_id=ember&state=5f2c01";

/** Answers the requests the section makes as `answers` has them, by method and path, keeping which were made. */
function serve(answers: Record<string, () => Response | Promise<Response>>) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    requests.push(request);
    const answer = answers[request];
    if (!answer) throw new Error(`Unexpected request for ${request}`);
    return answer();
  });
  return requests;
}

/** Shows the section with `apps`, as your profile does. */
function show(apps: YourApp[]) {
  const [onChanged, onFailed] = [vi.fn(), vi.fn()];
  const opened = vi.spyOn(page, "openPage").mockImplementation(() => {});
  render(
    <FlashProvider workspace>
      <YourApps apps={apps} onChanged={onChanged} onFailed={onFailed} />
    </FlashProvider>,
  );
  return { user: userEvent.setup(), onChanged, onFailed, opened };
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("The Apps section of your profile", () => {
  it("lists each app with where you stand with it: not signed in, signed in and when, ended, or asked for more", () => {
    const ended: YourApp = { id: "0mgk3x2a9b4c72", name: "Sentry", signedInAt: AT, ended: true, wantsMore: false };
    const wanting: YourApp = { id: "0mgk3x2a9b4c73", name: "Tracker", signedInAt: AT, ended: false, wantsMore: true };
    show([LINEAR, NOTION, ended, wanting]);

    expect(screen.getByRole("heading", { level: 2, name: "Apps" })).toBeVisible();
    expect(screen.getByText(YOUR_APPS_EXPLAINED)).toBeVisible();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      `Linear${NOT_SIGNED_IN}Sign in`,
      `Notion${signedInAt(AT)}Sign out`,
      `Sentry${SIGN_IN_ENDED}Sign in againSign out`,
      `Tracker${signedInAt(AT)} ${WANTS_MORE}Sign in againSign out`,
    ]);
    expect(signedInAt(AT)).toBe(`You signed in ${dateTimeLabel(new Date(AT))}.`);
    expect(screen.getByRole("button", { name: "Sign in to Linear" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sign out of Notion" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sign in again to Sentry" })).toBeEnabled();
  });

  it("begins a sign-in and sends the browser to the app's service, noting for the page it comes back to that the sign-in is your own", async () => {
    const requests = serve({ [`POST /api/users/me/apps/${LINEAR.id}/sign-in`]: () => Response.json({ authorizationUrl: AUTHORIZE }) });
    const { user, opened } = show([LINEAR, NOTION]);

    await user.click(screen.getByRole("button", { name: "Sign in to Linear" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests).toEqual([`POST /api/users/me/apps/${LINEAR.id}/sign-in`]);
    expect(isOwnSignIn("5f2c01")).toBe(true);
    expect(isOwnSignIn("5f2c02")).toBe(false);
    expect(isOwnSignIn(null)).toBe(false);
    // Nothing else is begun while the browser leaves.
    expect(screen.getByRole("button", { name: "Sign out of Notion" })).toBeDisabled();
  });

  it("says why a sign-in didn't begin, and can be tried again", async () => {
    serve({ [`POST /api/users/me/apps/${LINEAR.id}/sign-in`]: () => Response.json({ error: YOUR_APP_GONE }, { status: 404 }) });
    const { user, onFailed, opened } = show([LINEAR]);

    await user.click(screen.getByRole("button", { name: "Sign in to Linear" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect((onFailed.mock.calls[0]![0] as Error).message).toBe(YOUR_APP_GONE);
    expect(opened).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in to Linear" })).toBeEnabled();
  });

  it("signs out, showing the apps as that leaves them, and says whether the app took the sign-in back", async () => {
    const left = [LINEAR, { ...NOTION, signedInAt: null }];
    let revoked = true;
    serve({ [`DELETE /api/users/me/apps/${NOTION.id}/sign-in`]: () => Response.json({ apps: left, revoked } satisfies YourAppSignedOut) });
    const { user, onChanged } = show([LINEAR, NOTION]);

    await user.click(screen.getByRole("button", { name: "Sign out of Notion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(signedOutNotice("Notion", true));
    expect(onChanged).toHaveBeenCalledWith(left);

    revoked = false;
    await user.click(screen.getByRole("button", { name: "Sign out of Notion" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(signedOutNotice("Notion", false)));
    expect(signedOutNotice("Notion", false)).toContain("remove Ember's access at Notion");
  });
});
