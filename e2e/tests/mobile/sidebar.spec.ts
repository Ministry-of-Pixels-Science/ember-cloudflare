import type { Sidebar } from "@ember/protocol";
import { answerChanged, cookieHeader, createRoom, keepOtherRoomsOut, openRoom, rowsWithStars, signInAs } from "../../fixtures";
import { settle } from "./audits";
import { expect, hasDrawerLayout, test } from "./fixtures";

test.describe("Reorder starred rooms", () => {
  test("a finger held on a starred room drags it to a new place", async ({ page, request, session, browserName }) => {
    test.skip(browserName !== "chromium", "The finger moves through Chromium's DevTools, which WebKit hasn't");
    const rooms = [await createRoom(request, session, "general"), await createRoom(request, session, "random")];
    for (const room of rooms) {
      const starred = await request.put(`/api/rooms/${room.id}/favorite`, { data: { favorite: true }, headers: { Cookie: cookieHeader(session) } });
      expect(starred.status(), await starred.text()).toBe(200);
    }
    // Every other test's open rooms take everyone in too, so the sidebar lists just these.
    const ids = new Set(rooms.map((room) => room.id));
    await page.route("**/api/sidebar", (route) => answerChanged<Sidebar>(route, (list) => ({ ...list, rooms: list.rooms.filter((room) => ids.has(room.id)) })));
    await keepOtherRoomsOut(page, ids);
    await signInAs(page, session);
    await openRoom(page, rooms[0]!);
    if (hasDrawerLayout(page)) await page.getByRole("button", { name: "Open conversations" }).tap();
    const rows = page.getByRole("region", { name: "Rooms" }).getByRole("link");
    await expect.poll(() => rowsWithStars(rows)).toEqual(["#general★", "#random★"]);
    // Where the finger goes down is measured once the drawer has slid in, as a person would wait.
    await settle(page);

    // Playwright's touchscreen only taps, so the finger goes down, moves and lifts through DevTools.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove", x: number, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
    const from = (await rows.last().boundingBox())!;
    const to = (await rows.first().boundingBox())!;
    const x = from.x + from.width / 2;
    await touch("touchStart", x, from.y + from.height / 2);
    await expect(page.getByRole("status").filter({ hasText: "Moving random." })).toBeAttached();
    for (const y of [from.y, to.y + to.height / 2, to.y + 2]) await touch("touchMove", x, y);
    await expect.poll(() => rowsWithStars(rows)).toEqual(["#random★", "#general★"]);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByRole("status").filter({ hasText: "Starred room order saved." })).toBeAttached();
    // Lifting the finger on the room's row didn't open it.
    await expect(page).toHaveURL(new RegExp(`/rooms/${rooms[0]!.id}$`));

    const saved = await request.get("/api/sidebar", { headers: { Cookie: cookieHeader(session) } });
    expect(((await saved.json()) as Sidebar).favorites.rooms).toEqual([rooms[1]!.id, rooms[0]!.id]);
    // Lets the test end while the list is loading again.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
