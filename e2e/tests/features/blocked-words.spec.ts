import type { Page } from "@playwright/test";
import { cookieHeader } from "../../fixtures";
import { expect, test, unique } from "./fixtures";

/** Why a message with a blocked word isn't posted, as the composer says. */
const REFUSED = "This community doesn't allow one of these words.";

/** A word nobody else's test writes, since Blocked words keeps it out of the whole server. */
const uniqueWord = () => `fudge${crypto.randomUUID().slice(0, 8)}`;

/** Opens Membership from the rail's Admin link, as an administrator does, and saves `words` as its Blocked words. */
async function block(page: Page, ...words: string[]): Promise<void> {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Admin" }).click();
  await page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Membership" }).click();
  const card = page.getByRole("region", { name: "Blocked words" });
  await card.getByRole("textbox", { name: "Words and phrases, one a line or apart by commas" }).fill(words.join("\n"));
  await card.getByRole("button", { name: "Save blocked words" }).click();
  await expect(page.getByRole("alert")).toHaveText("Changes saved.");
  await expect(card.getByRole("button", { name: "Save blocked words" })).toHaveCount(0);
}

test.describe("Blocked words", () => {
  test("gives a message with a blocked word back to its writer, saying why, and posts it once it's changed", async ({ members, request, rooms }) => {
    const ada = await members.signIn(unique("Ada"), { administrator: true });
    const grace = await members.signIn(unique("Grace"));
    const word = uniqueWord();
    try {
      await block(ada.page, word);
      await ada.page.goto(`/rooms/${rooms.general.id}`);
      await ada.connected();

      await grace.send(`Oh ${word.toUpperCase()}, the build broke`);
      await expect(grace.composer()).toHaveText(`Oh ${word.toUpperCase()}, the build broke`);
      const footer = grace.page.locator("footer").filter({ has: grace.composer() });
      await expect(footer.getByRole("alert")).toHaveText(REFUSED);
      await expect(grace.message("the build broke")).toHaveCount(0);
      await expect(grace.page.getByText("Not sent")).toHaveCount(0);

      // A longer word that starts with it is another word.
      await grace.send(`Oh ${word}s, the build broke`);
      await expect(grace.message(`Oh ${word}s`)).toBeVisible();
      await expect(ada.message(`Oh ${word}s`)).toBeVisible();
      await expect(footer.getByRole("alert")).toHaveCount(0);
      await expect(grace.composer()).toHaveText("");
    } finally {
      // Nothing is blocked for the tests after this one.
      const cleared = await request.patch("/api/account", { data: { blockedWords: [] }, headers: { Cookie: cookieHeader(ada.session) } });
      expect(cleared.status(), await cleared.text()).toBe(200);
    }
  });
});
