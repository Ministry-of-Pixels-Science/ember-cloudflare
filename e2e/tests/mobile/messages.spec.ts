import { editorField, openRoom, signInAs } from "../../fixtures";
import { expect, REACTION_PILLS, test } from "./fixtures";

test.beforeEach(async ({ page, session }) => {
  await signInAs(page, session);
});

test("message actions open with a tap and fit the phone", async ({ page, room, participant, screenIsFine }) => {
  const ada = await participant("Ada");
  await ada.say("Tap the options button to react to this");
  await openRoom(page, room);

  // Phones can't hover, so each message has an options button instead. The actions open beside it,
  // over the timeline.
  const message = page.getByRole("article").filter({ hasText: "Tap the options button" });
  const options = message.getByRole("button", { name: "Message options" });
  const actions = page.getByRole("group", { name: "Message actions" });
  await options.tap();
  await expect(actions).toBeVisible();
  await screenIsFine();

  await actions.getByRole("button", { name: "More reactions" }).tap();
  const tray = page.getByRole("group", { name: "More reactions" });
  await expect(tray).toBeVisible();
  await screenIsFine();
  await tray.getByRole("button", { name: "Fire" }).tap();
  await expect(message.getByRole("list", { name: "Reactions" }).getByRole("button", { name: "🔥" })).toBeVisible();
  // A reaction closes the bar, and focus goes back to Message options.
  await expect(actions).toBeHidden();
  await expect(options).toBeFocused();

  await options.tap();
  await actions.getByRole("button", { name: "Thumbs up" }).tap();
  await expect(message.getByRole("list", { name: "Reactions" }).getByRole("button")).toHaveCount(2);
  await expect(actions).toBeHidden();
  await expect(options).toBeFocused();
  await screenIsFine({ denseTargets: [REACTION_PILLS] });
});

test("Add a boost, New boost's form and Delete this boost fit the phone", async ({ page, room, participant, screenIsFine }) => {
  const ada = await participant("Ada");
  await ada.say("React to this in your own words");
  await openRoom(page, room);

  const message = page.getByRole("article").filter({ hasText: "React to this" });
  const reactions = message.getByRole("list", { name: "Reactions" });
  await message.getByRole("button", { name: "Message options" }).tap();
  await page.getByRole("group", { name: "Message actions" }).getByRole("button", { name: "Thumbs up" }).tap();
  await message.getByRole("button", { name: "Add a boost" }).tap();
  const tray = page.getByRole("group", { name: "More reactions" });
  await expect(tray.getByRole("button", { name: "Muscle" })).toBeFocused();
  await screenIsFine({ denseTargets: [REACTION_PILLS] });

  // The form fits, and leaves the message its width.
  await tray.getByRole("button", { name: "New boost" }).tap();
  const field = message.getByRole("textbox", { name: "Custom reaction" });
  await expect(field).toBeFocused();
  await screenIsFine({ denseTargets: [REACTION_PILLS] });
  expect((await message.locator(".message-content").boundingBox())!.width).toBeGreaterThan(100);
  await field.fill("Lovely!");
  await message.getByRole("button", { name: "Add reaction" }).tap();
  const mine = reactions.getByRole("button", { name: "Lovely!" });
  await expect(mine).toBeVisible();

  await mine.tap();
  const remove = reactions.getByRole("button", { name: "Delete this boost" });
  await expect(remove).toBeFocused();
  await screenIsFine({ denseTargets: [REACTION_PILLS] });
  await remove.tap();
  await expect(mine).toHaveCount(0);
});

test("tapping Message options again closes the actions", async ({ page, room, participant }) => {
  const ada = await participant("Ada");
  await ada.say("Open and close my actions");
  await openRoom(page, room);

  const options = page.getByRole("article").filter({ hasText: "Open and close my actions" }).getByRole("button", { name: "Message options" });
  const actions = page.getByRole("group", { name: "Message actions" });
  await options.tap();
  await expect(actions).toBeVisible();
  await options.tap();
  await expect(options).toHaveAttribute("aria-expanded", "false");
  await expect(actions).toBeHidden();
});

test("tapping anywhere else closes the actions, so only one message has them open", async ({ page, room, participant }) => {
  const ada = await participant("Ada");
  // The first message's actions open over the next two, so the last one's button is clear of them.
  for (const text of ["The first message", "The second", "The third", "The last message"]) await ada.say(text);
  await openRoom(page, room);
  // In landscape the first message's button is under the header, so tapping it scrolls the timeline
  // up, and the composer's editor mounting then would resize the timeline, which keeps to its end
  // while it's that near, moving the button out from under the tap.
  await expect(editorField(page, "Write a message")).toBeVisible();

  const first = page.getByRole("article").filter({ hasText: "The first message" });
  const last = page.getByRole("article").filter({ hasText: "The last message" });
  const actions = page.getByRole("group", { name: "Message actions" });
  await first.getByRole("button", { name: "Message options" }).tap();
  await expect(actions).toHaveCount(1);
  await last.getByRole("button", { name: "Message options" }).tap();
  await expect(last.getByRole("button", { name: "Message options" })).toHaveAttribute("aria-expanded", "true");
  await expect(first.getByRole("button", { name: "Message options" })).toHaveAttribute("aria-expanded", "false");
  await expect(actions).toHaveCount(1);

  await first.getByText("The first message").tap();
  await expect(last.getByRole("button", { name: "Message options" })).toHaveAttribute("aria-expanded", "false");
  await expect(actions).toHaveCount(0);
});

test("your own messages can be edited on a phone", async ({ page, room, screenIsFine }) => {
  await openRoom(page, room);
  const composer = editorField(page, "Write a message");
  await composer.tap();
  await page.keyboard.type("A message to edit");
  await page.getByRole("button", { name: "Send Message" }).tap();

  const message = page.getByRole("article").filter({ hasText: "A message to edit" });
  await expect(message).not.toHaveAttribute("aria-busy");
  const edit = page.getByRole("group", { name: "Message actions" }).getByRole("button", { name: "Edit" });
  await message.getByRole("button", { name: "Message options" }).tap();
  await edit.tap();
  const field = editorField(message, "Edit message");
  await expect(field).toBeFocused();
  await screenIsFine();

  // Enter starts a new line here too, so saving and cancelling need buttons.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("with a second line");
  await message.getByRole("button", { name: "Save changes" }).tap();
  await expect(message.getByText("(edited)")).toBeVisible();
  await expect(message.locator(".message-content")).toContainText("A message to edit\nwith a second line", { useInnerText: true });

  await message.getByRole("button", { name: "Message options" }).tap();
  await edit.tap();
  await message.getByRole("button", { name: "Close editor and discard changes" }).tap();
  await expect(field).toBeHidden();
});

test("a snippet written on a phone shows its text in its message, folded behind Show more, and fits the phone", async ({ page, room, screenIsFine }) => {
  await openRoom(page, room);
  await page.locator("form.composer").getByRole("button", { name: "Attach", exact: true }).tap();
  await page.getByRole("menuitem", { name: /^Text snippet/ }).tap();
  const dialog = page.getByRole("dialog", { name: "Create a text snippet" });
  await dialog.getByLabel("Title (optional)").fill("deploy.sh");
  await dialog.getByLabel("Content").fill(Array.from({ length: 12 }, (_, step) => `echo "step ${step + 1}"`).join("\n"));
  await screenIsFine();
  await dialog.getByRole("button", { name: "Create snippet" }).tap();
  await page.getByRole("button", { name: "Send Message" }).tap();

  const message = page.getByRole("article").filter({ hasText: "deploy.sh" });
  await expect(message.locator("pre")).toContainText('echo "step 12"');
  await expect(message.getByRole("button", { name: "Show more" })).toBeVisible();
  await screenIsFine();
  await message.getByRole("button", { name: "Show more" }).tap();
  await expect(message.getByRole("button", { name: "Show less" })).toBeVisible();
  await screenIsFine();
});

test("Jump to newest message appears as one comes while you're scrolled back, and fits", async ({ page, room, participant, screenIsFine }) => {
  const ada = await participant("Ada");
  for (let i = 1; i <= 30; i++) await ada.say(`Message ${i}`);
  await openRoom(page, room);
  await expect(page.getByText("Message 30", { exact: true })).toBeVisible();

  await page.getByRole("log").evaluate((log) => log.scrollTo({ top: 0 }));
  // The timeline hears of a scroll by script with the next frame, as an IntersectionObserver does, so a
  // message that came sooner would find the reader still at the end, and take them back there.
  await expect(page.getByText("Message 30", { exact: true })).not.toBeInViewport();
  await ada.say("Message 31");
  const jump = page.getByRole("button", { name: "Jump to newest message" });
  await expect(jump).toBeVisible();
  await screenIsFine();

  await jump.tap();
  await expect(page.getByText("Message 31", { exact: true })).toBeInViewport();
});

test("the timeline stays on the newest message when it grows and then shrinks", async ({ page, room, participant }) => {
  const ada = await participant("Ada");
  for (let i = 1; i <= 30; i++) await ada.say(`Message ${i}`);
  await openRoom(page, room);
  const log = page.getByRole("log");
  const distanceFromEnd = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(await distanceFromEnd()).toBeLessThanOrEqual(1);

  // The timeline grows, as when an inset goes away or the keyboard closes, so its scroll position
  // is clamped and a scroll event queued. Before the next frame delivers it, the timeline shrinks, as
  // when the keyboard opens. That late scroll isn't the reader scrolling away from the newest message.
  await log.evaluate(async (el) => {
    const timeline = el.parentElement!;
    timeline.style.flex = `0 0 ${timeline.clientHeight + 120}px`;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    timeline.style.flex = "0 0 20px";
  });
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
});

test("a notice fits the phone and can be dismissed", async ({ page, room, screenIsFine }) => {
  // Pass the real socket through, and add an error from the room on top.
  let socket: { send: (message: string) => void } | undefined;
  await page.routeWebSocket(/\/api\/rooms\/.+\/socket/, (ws) => {
    ws.connectToServer();
    socket = ws;
  });
  await openRoom(page, room);
  socket!.send(JSON.stringify({ type: "error", message: "Something went wrong while sending your last message. Try again." }));

  const notice = page.getByRole("alert");
  await expect(notice).toBeVisible();
  await screenIsFine();
  await notice.getByRole("button", { name: "Dismiss" }).tap();
  await expect(notice).toBeHidden();
});
