import { signInAs } from "../../fixtures";
import { expect, test } from "./fixtures";

test("the welcome screen fits the phone", async ({ page, session, screenIsFine }) => {
  await signInAs(page, session);
  await page.goto("/welcome");
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome to / })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeEditable();
  await screenIsFine();
});
