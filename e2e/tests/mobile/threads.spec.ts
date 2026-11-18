import { editorField, openRoom, signInAs } from "../../fixtures";
import { expect, hasDrawerLayout, REACTION_PILLS, test } from "./fixtures";

test.beforeEach(async ({ page, session }) => {
  await signInAs(page, session);
});

test("a thread opens from its message's replies over the room, fits the phone, and goes back to the room", async ({ page, room, participant, screenIsFine }) => {
  const ada = await participant("Ada");
  const parent = await ada.say("Who's bringing snacks?");
  await ada.reply(parent.id, "I'll bring fruit");
  await openRoom(page, room);

  const replies = page.getByRole("article").filter({ hasText: "Who's bringing snacks?" }).getByRole("link", { name: /^1 reply\b/ });
  await expect(replies).toBeVisible();
  await screenIsFine({ denseTargets: [REACTION_PILLS] });

  await replies.tap();
  const thread = page.getByRole("complementary", { name: "Thread" });
  await expect(thread.getByRole("article").filter({ hasText: "I'll bring fruit" })).toBeVisible();
  await expect(editorField(thread, "Write a reply")).toBeVisible();
  await screenIsFine();

  // Phones go back to the room from the header, where wider screens close the thread.
  await thread.getByRole("link", { name: hasDrawerLayout(page) ? `Back to ${room.name}` : "Close thread" }).tap();
  await expect(thread).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}$`));
});

test("Reply in thread and Quote fit the phone in a message's actions", async ({ page, room, participant, screenIsFine }) => {
  await (await participant("Ada")).say("Reply to me in a thread");
  await openRoom(page, room);

  const message = page.getByRole("article").filter({ hasText: "Reply to me in a thread" });
  await message.getByRole("button", { name: "Message options" }).tap();
  const actions = page.getByRole("group", { name: "Message actions" });
  await expect(actions.getByRole("button", { name: "Quote" })).toBeVisible();
  await screenIsFine();

  await actions.getByRole("link", { name: "Reply in thread" }).tap();
  const thread = page.getByRole("complementary", { name: "Thread" });
  await expect(thread.getByRole("article").filter({ hasText: "Reply to me in a thread" })).toBeVisible();
  const alsoSend = thread.getByRole("checkbox", { name: `Also send to #${room.name}` });
  await expect(alsoSend).toBeVisible();
  // Its label is never cut short: where the buttons leave it too little room, it takes a line of its own above them.
  expect(await alsoSend.evaluate((box) => box.nextElementSibling!.scrollWidth <= box.nextElementSibling!.clientWidth)).toBe(true);
  await screenIsFine();
});
