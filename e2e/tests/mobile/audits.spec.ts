import { auditScreen } from "./audits";
import { expect, test } from "./fixtures";

// Every other test leans on the audits, so check they catch what they should and nothing else.

/** A page laid out at the phone's width, as the app is. */
const phonePage = (body: string) => `<meta name="viewport" content="width=device-width, initial-scale=1">${body}`;

test("a control cut off for good fails, but not one scrolled partly out of view", async ({ page, safeArea }) => {
  await page.setContent(
    phonePage(`
      <div style="height: 24px; overflow: hidden"><button aria-label="Cut off" style="width: 44px; height: 44px"></button></div>
      <div style="height: 100px; overflow-y: auto">
        <div style="height: 80px"></div>
        <button aria-label="Scrolled" style="width: 44px; height: 44px"></button>
        <div style="height: 80px"></div>
      </div>
    `),
  );
  const { overflow, touchTargets } = await auditScreen(page, safeArea);
  expect(overflow).toEqual([expect.stringContaining('<button> "Cut off" spans')]);
  expect(touchTargets).toEqual([expect.stringContaining('<button> "Cut off" is 44px×44px (44px×24px of it shows)')]);
});

test("a control scrolled partly out of view must still be big enough", async ({ page, safeArea }) => {
  // Neither list is scrolled far enough to show all of its button, and the audits don't scroll.
  const list = (label: string, size: number) => `
    <div style="height: 100px; overflow-y: auto">
      <div style="height: 80px"></div>
      <button aria-label="${label}" style="display: block; width: ${size}px; height: ${size}px"></button>
      <div style="height: 80px"></div>
    </div>`;
  await page.setContent(phonePage(`${list("Small", 32)}${list("Big", 44)}`));
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringContaining('<button> "Small" is 32px×32px')]);
});

test("a small control scrolled partly out of view fails with a small label, but not wrapped in a big one", async ({ page, safeArea }) => {
  // Neither list is scrolled far enough to show all of its checkbox. A label only helps where a
  // fingertip on the checkbox would land on it.
  const list = (row: string) => `
    <div style="height: 100px; overflow-y: auto">
      <div style="height: 76px"></div>
      ${row}
      <div style="height: 80px"></div>
    </div>`;
  const checkbox = (id: string) => `<input type="checkbox" id="${id}" aria-label="${id}" style="margin: 0 0 0 14px; width: 16px; height: 16px">`;
  await page.setContent(
    phonePage(`
      ${list(`<div style="display: flex; align-items: center; height: 44px">${checkbox("Small")}<label for="Small" style="width: 12px; height: 16px"></label></div>`)}
      ${list(`<label style="display: flex; align-items: center; height: 44px">${checkbox("Wrapped")}Notify me</label>`)}
    `),
  );
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringContaining('<input> "Small" is 16px×16px and partly scrolled out of view')]);
});

test("a field all of which shows, in a label partly scrolled out of view, fails only if a fingertip on it can miss the label", async ({ page, safeArea }) => {
  // Each list has scrolled the top of a label out of view, but not the 24px field in it, as a page can
  // scroll past the top of the box around its join link. The first label ends with its field.
  const list = (label: string, height: number, align: string) => `
    <div class="list" style="height: 120px; margin-top: 60px; overflow-y: auto">
      <div style="height: 100px"></div>
      <label style="display: flex; align-items: ${align}; height: ${height}px"><input aria-label="${label}" style="box-sizing: border-box; width: 100%; height: 24px; margin: 0; border: 0"></label>
      <div style="height: 200px"></div>
    </div>`;
  await page.setContent(phonePage(`${list("Small", 32, "end")}${list("Big", 50, "center")}`));
  await page.evaluate(() => {
    const [small, big] = document.querySelectorAll(".list");
    small!.scrollTop = 104;
    big!.scrollTop = 106;
  });
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringMatching(/^<input> "Small" is .* partly scrolled out of view/)]);
});

test("a control scrolled a pixel out of view counts as all shown, crowded only by one that overlaps it", async ({ page, safeArea }) => {
  // Each list stacks two 44px buttons, as a phone stacks the Message options of one person's messages,
  // and is scrolled a pixel past the first one's top. Only in the second list do the buttons overlap.
  const list = (label: string, overlap: number) => `
    <div class="list" style="height: 200px; overflow-y: auto">
      <div style="height: 100px"></div>
      <button aria-label="${label}" style="display: block; margin: 0; width: 44px; height: 44px"></button>
      <button aria-label="Under ${label}" style="display: block; margin: -${overlap}px 0 0; width: 44px; height: 44px"></button>
      <div style="height: 200px"></div>
    </div>`;
  await page.setContent(phonePage(`${list("Touching", 0)}${list("Overlapped", 2)}`));
  await page.evaluate(() => document.querySelectorAll(".list").forEach((list) => (list.scrollTop = 101)));
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringContaining('<button> "Overlapped" is 44px×44px; a 44px fingertip on it can land on <button> "Under Overlapped"')]);
});

test("a control covered for good by something floating over its list fails, but not one the list can scroll clear", async ({ page, safeArea }) => {
  // The last button in each list sits under a floating notice; only the second list has room to
  // scroll it out from under.
  const list = (label: string, room: number) => `
    <div style="position: relative; flex: 1; height: 200px">
      <div class="list" style="height: 100%; overflow-y: auto">
        <div style="height: 200px"></div>
        <button aria-label="${label}" style="display: block; width: 100%; height: 48px"></button>
        <div style="height: ${room}px"></div>
      </div>
      <div style="position: absolute; inset: auto 0 0; height: 60px; background: Canvas">Floating notice</div>
    </div>`;
  await page.setContent(phonePage(`<div style="display: flex; gap: 8px">${list("Covered", 0)}${list("Clear", 60)}</div>`));
  await page.evaluate(() => document.querySelectorAll(".list").forEach((list) => (list.scrollTop = 48)));
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringContaining('<button> "Covered" is')]);
});

test("a control under something floating over its list must still be big enough once it's scrolled clear", async ({ page, safeArea }) => {
  // Both lists can scroll their button out from under the notice, but only one button fits a fingertip.
  const list = (label: string, size: number) => `
    <div style="position: relative; flex: 1; height: 200px">
      <div class="list" style="height: 100%; overflow-y: auto">
        <div style="height: 200px"></div>
        <button aria-label="${label}" style="display: block; margin: 0 auto; width: ${size}px; height: ${size}px"></button>
        <div style="height: 100px"></div>
      </div>
      <div style="position: absolute; inset: auto 0 0; height: 60px; background: Canvas">Floating notice</div>
    </div>`;
  await page.setContent(phonePage(`<div style="display: flex; gap: 8px">${list("Small", 32)}${list("Big", 44)}</div>`));
  await page.evaluate(() => document.querySelectorAll(".list").forEach((list) => (list.scrollTop = 48)));
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringContaining('<button> "Small" is 32px×32px')]);
});

test("a control's own popup may cover it while it shows, but not someone else's", async ({ page, safeArea }) => {
  // Each list covers the top of a field, but only the first field's is the list it shows.
  const field = (label: string, owns: boolean) => `
    <div style="position: relative; margin-top: 60px">
      <div role="textbox" aria-label="${label}" contenteditable="true" ${owns ? `aria-haspopup="listbox" aria-controls="${label}-list"` : ""} style="height: 44px"></div>
      <ul role="listbox" id="${label}-list" style="position: absolute; inset: -40px 0 auto; margin: 0; padding: 0; background: Canvas">
        <li role="option" style="height: 50px">Bea</li>
      </ul>
    </div>`;
  await page.setContent(phonePage(`${field("Own", true)}${field("Other", false)}`));
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringContaining('<div role=textbox> "Other" is')]);
});

test("controls behind a modal dialog are skipped, but the dialog's own must be big enough", async ({ page, safeArea }) => {
  // A modal <dialog> makes the page behind it inert without marking it, as a menu's aria-hidden does.
  await page.setContent(
    phonePage(`
      <button aria-label="Behind" style="width: 44px; height: 44px"></button>
      <dialog style="padding: 16px">
        <div style="display: flex; gap: 40px">
          <button aria-label="Small" style="width: 32px; height: 32px"></button>
          <button aria-label="Big" style="width: 44px; height: 44px"></button>
        </div>
      </dialog>
    `),
  );
  await page.evaluate(() => document.querySelector("dialog")!.showModal());
  const { touchTargets } = await auditScreen(page, safeArea);
  expect(touchTargets).toEqual([expect.stringContaining('<button> "Small" is 32px×32px')]);
});

test("a modal dialog isn't cut off by the box it's in, which it's drawn over", async ({ page, safeArea }) => {
  await page.setContent(
    phonePage(`
      <div style="width: 100px; height: 40px; overflow: hidden">
        <dialog style="width: 240px; padding: 16px"><button aria-label="Close" style="width: 44px; height: 44px"></button></dialog>
      </div>
    `),
  );
  await page.evaluate(() => document.querySelector("dialog")!.showModal());
  const { overflow } = await auditScreen(page, safeArea);
  expect(overflow).toEqual([]);
});

test("text cut off for good fails, but not text clamped or folded on purpose", async ({ page, safeArea }) => {
  await page.setContent(
    phonePage(`
      <p style="width: 120px; height: 20px; line-height: 20px; overflow: hidden">Cut off after one line, though it runs to several</p>
      <p style="width: 120px; line-height: 20px; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1">Clamped to one line, though it runs to several</p>
      <p id="folded" style="width: 120px; height: 20px; line-height: 20px; overflow: hidden">Folded after one line, though it runs to several</p>
      <button aria-expanded="false" aria-controls="folded" style="width: 120px; height: 44px">Show more</button>
      <p id="opened" style="width: 120px; height: 20px; line-height: 20px; overflow: hidden">Still cut off once opened, though it runs to several</p>
      <button aria-expanded="true" aria-controls="opened" style="width: 120px; height: 44px">Show less</button>
    `),
  );
  const { overflow } = await auditScreen(page, safeArea);
  expect(overflow.some((problem) => problem.includes('text in <p> "Cut off after one line'))).toBe(true);
  expect(overflow.some((problem) => problem.includes('text in <p> "Still cut off once opened'))).toBe(true);
  for (const problem of overflow) expect(problem).toMatch(/text in <p> "(Cut off after one line|Still cut off once opened)/);
});

test("a page wider than the phone fails, though the phone widens the window to fit it", async ({ page, safeArea, browserName }) => {
  await page.setContent(phonePage(`<div style="width: 120vw; height: 20px"></div>`));
  const { overflow } = await auditScreen(page, safeArea);
  // WebKit's phones don't widen the window, so there the box past the screen's edge fails too.
  const past = browserName === "webkit" ? [expect.stringMatching(/^<div> spans [\d.]+px–[\d.]+px on a [\d.]+px-wide screen$/)] : [];
  expect(overflow).toEqual([expect.stringContaining("the page scrolls sideways"), ...past]);
});
