import type { Card, CardPart } from "@ember/protocol";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { dateTimeLabel } from "@/lib/messages";
import { marksFor } from "@/lib/search";
import { BotCards } from "./bot-card";
import { SearchMarks } from "./search-marks";

const card = (parts: CardPart[], rest: Partial<Card> = {}): Card => ({ source: "attachment", parts, ...rest });

/** Shows `cards` as a message shows them, answering the frames they're drawn in. */
function show(...cards: Card[]) {
  render(<BotCards cards={cards} />);
  return screen.getAllByRole("article");
}

/** The bar down a card's frame. */
const barOf = (frame: HTMLElement) => frame.querySelector<HTMLElement>(":scope > span[aria-hidden]")!;

describe("Bot cards", () => {
  it("shows an attachment's pretext above its frame, then its author, title, text, fields, image, buttons and footer, with its thumbnail beside them", () => {
    const at = 1792612211;
    const [frame] = show(
      card(
        [
          { kind: "author", name: "Alertmanager", href: "https://example.com/am", icon: "https://example.com/am.png" },
          { kind: "title", text: "[FIRING:1] HighErrorRate", href: "https://example.com/alerts" },
          { kind: "text", html: "<p>5xx responses are at <strong>7.2%</strong></p>" },
          {
            kind: "fields",
            fields: [
              { title: "Severity", html: "<p>critical</p>", short: true },
              { title: "Summary", html: "<p>Errors are up</p>", short: false },
            ],
          },
          { kind: "image", image: { url: "https://example.com/graph.png", alt: "" } },
          { kind: "buttons", buttons: [{ text: "Runbook", href: "https://example.com/runbook" }] },
          { kind: "footer", text: "Prometheus", icon: "https://example.com/p.png", at },
        ],
        { color: "danger", pretext: "<p>An alert, <em>firing</em></p>", thumb: { url: "https://example.com/thumb.png", alt: "" } },
      ),
    );
    expect(frame).toHaveAccessibleName("[FIRING:1] HighErrorRate");
    expect(frame!.previousElementSibling).toHaveTextContent("An alert, firing");

    const inFrame = within(frame!);
    expect(inFrame.getByRole("link", { name: "Alertmanager" })).toHaveAttribute("href", "https://example.com/am");
    expect(inFrame.getByRole("heading", { name: "[FIRING:1] HighErrorRate" })).toContainElement(inFrame.getByRole("link", { name: "[FIRING:1] HighErrorRate" }));
    expect(inFrame.getByRole("link", { name: "[FIRING:1] HighErrorRate" })).toHaveAttribute("target", "_blank");
    expect(inFrame.getByText("7.2%").tagName).toBe("STRONG");
    expect(inFrame.getByText("Severity").nextElementSibling).toHaveTextContent("critical");
    expect(inFrame.getByText("Severity").parentElement).not.toHaveClass("col-span-full");
    expect(inFrame.getByText("Summary").parentElement).toHaveClass("col-span-full");
    expect(inFrame.getByRole("link", { name: "Image from example.com" })).toHaveAttribute("href", "https://example.com/graph.png");
    expect(inFrame.getByRole("link", { name: "Runbook" })).toHaveAttribute("href", "https://example.com/runbook");
    expect(inFrame.getByText("Prometheus").parentElement!.querySelector("time")).toHaveAttribute("datetime", new Date(at * 1000).toISOString());
    expect(inFrame.getByText(dateTimeLabel(new Date(at * 1000)))).toBeInTheDocument();
    expect([...frame!.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([
      "https://example.com/am.png",
      "https://example.com/graph.png",
      "https://example.com/p.png",
      "https://example.com/thumb.png",
    ]);
  });

  it("draws the bar in Ember's colors for Slack's good, warning and danger, a hex color as it's given, and the border's color without one", () => {
    const frames = show(...["good", "warning", "danger", "#36a64f", undefined].map((color) => card([{ kind: "title", text: "Hi" }], color === undefined ? {} : { color })));
    expect(frames.map((frame) => [...barOf(frame).classList].find((name) => name.startsWith("bg-")) ?? barOf(frame).style.backgroundColor)).toEqual([
      "bg-positive",
      "bg-warning",
      "bg-negative",
      "rgb(54, 166, 79)",
      "bg-border",
    ]);
  });

  it("fills a primary button, and draws a danger one red, as Delete is", () => {
    show(
      card([
        {
          kind: "buttons",
          buttons: [
            { text: "Approve", href: "https://example.com/approve", style: "primary" },
            { text: "Roll back", href: "https://example.com/rollback", style: "danger" },
            { text: "Details", href: "https://example.com/details" },
          ],
        },
      ]),
    );
    expect(screen.getByRole("link", { name: "Approve" })).toHaveClass("bg-primary");
    expect(screen.getByRole("link", { name: "Roll back" })).toHaveClass("bg-negative-button", "text-white");
    expect(screen.getByRole("link", { name: "Details" })).toHaveClass("border", "bg-background");
  });

  it("draws a button that acts as a button, which tells its bot when it's clicked and waits until the room says it's answered", async () => {
    const user = userEvent.setup();
    let answer = (_went: boolean) => {};
    const onAction = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const approve = { id: "approve", blockId: "deploy-42", value: '{"build":42}' };
    const cards = [
      card([
        {
          kind: "buttons",
          buttons: [
            { text: "Approve", action: approve, style: "primary" },
            { text: "Reject", action: { id: "reject" }, style: "danger" },
            { text: "Logs", href: "https://example.com/logs" },
          ],
        },
        { kind: "section", html: "<p>Nightly</p>", button: { text: "Run", action: { id: "run" } } },
        { kind: "tiles", tiles: [{ title: "Build", buttons: [{ text: "Retry", action: { id: "retry" } }] }] },
      ]),
    ];
    render(<BotCards cards={cards} onAction={onAction} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Approve", "Reject", "Run", "Retry"]);
    expect(screen.getByRole("link", { name: "Logs" })).toHaveAttribute("href", "https://example.com/logs");
    const button = screen.getByRole("button", { name: "Approve" });
    expect(button).toHaveClass("bg-primary");
    expect(button).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Reject" })).toHaveClass("bg-negative-button", "text-white");

    await user.click(button);
    expect(onAction).toHaveBeenCalledExactlyOnceWith(approve);
    // Until its bot answers, it can't be clicked again, though the others can.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    await user.click(button);
    expect(onAction).toHaveBeenCalledOnce();

    await act(async () => answer(true));
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("disables a button that acts where a click has nowhere to go, as in a preview", () => {
    show(card([{ kind: "buttons", buttons: [{ text: "Approve", action: { id: "approve" } }] }]));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("leaves out links, images and icons on the page's own host, keeping their text", () => {
    const own = `https://${location.hostname}/files/1`;
    const [frame] = show(
      card(
        [
          { kind: "author", name: "Ada", href: own, icon: own },
          { kind: "title", text: "Deploy", href: own },
          { kind: "image", image: { url: own, alt: "" } },
          { kind: "buttons", buttons: [{ text: "Open", href: own }] },
          { kind: "footer", text: "CI", icon: own },
        ],
        { thumb: { url: own, alt: "" } },
      ),
    );
    expect(within(frame!).queryAllByRole("link")).toEqual([]);
    expect(frame!.querySelectorAll("img")).toHaveLength(0);
    expect(frame).toHaveTextContent("AdaDeployCI");
  });

  it("loads every image as it nears the screen, and without a referrer, so the site serving it doesn't learn which Ember shows it", () => {
    const image = (name: string) => ({ url: `https://example.com/${name}.png`, alt: "" });
    show(
      card(
        [
          { kind: "author", name: "Ada", icon: image("author").url },
          { kind: "image", image: image("image") },
          { kind: "footer", text: "CI", icon: image("footer").url },
        ],
        { thumb: image("thumb") },
      ),
      {
        source: "blocks",
        parts: [
          { kind: "section", html: "<p>Deployed</p>", thumb: image("section") },
          { kind: "context", items: [{ image: image("context") }] },
          { kind: "image", image: image("block") },
          { kind: "tiles", tiles: [{ hero: image("hero"), icon: image("icon"), title: "Lovelace" }] },
        ],
      },
    );
    const images = [...document.querySelectorAll("img")];
    expect(images).toHaveLength(9);
    for (const shown of images) {
      expect(shown, shown.src).toHaveAttribute("loading", "lazy");
      expect(shown, shown.src).toHaveAttribute("referrerpolicy", "no-referrer");
    }
  });

  it("frames a message's blocks without a bar, named by their header, with sections, a context row, a rule and an image under its title", () => {
    const [frame] = show({
      source: "blocks",
      parts: [
        { kind: "header", text: "Deploy finished" },
        {
          kind: "section",
          html: "<p><strong>web</strong> is live</p>",
          fields: [
            { html: "<p>production</p>", short: true },
            { html: "<p>42s</p>", short: true },
          ],
          thumb: { url: "https://example.com/logo.png", alt: "Logo" },
        },
        { kind: "section", html: "<p>Approve?</p>", button: { text: "Open", href: "https://example.com/open", style: "primary" } },
        { kind: "divider" },
        { kind: "context", items: [{ image: { url: "https://example.com/ada.png", alt: "Ada" } }, { html: "<p>By Ada</p>" }] },
        { kind: "image", image: { url: "https://example.com/chart.png", alt: "Error rate" }, title: "Last hour" },
      ],
    });
    expect(frame).toHaveAccessibleName("Deploy finished");
    expect(barOf(frame!)).toBeNull();

    const inFrame = within(frame!);
    expect(inFrame.getByRole("heading", { name: "Deploy finished", level: 4 })).toHaveClass("text-[18px]", "font-bold");
    expect(inFrame.getByText("web").tagName).toBe("STRONG");
    expect(inFrame.getByText("production").closest(".grid")).toContainElement(inFrame.getByText("42s"));
    expect(inFrame.getByRole("img", { name: "Logo" })).toHaveClass("size-[75px]");
    expect(inFrame.getByRole("link", { name: "Open" })).toHaveAttribute("href", "https://example.com/open");
    expect(inFrame.getByRole("link", { name: "Open" })).toHaveClass("bg-primary");
    expect(inFrame.getByRole("separator")).toBeInTheDocument();
    expect(inFrame.getByRole("img", { name: "Ada" })).toHaveClass("size-5");
    expect(inFrame.getByText("By Ada").closest(".message-content")).toHaveClass("text-xs", "text-message-muted");
    const figure = inFrame.getByRole("figure");
    expect(figure.querySelector("figcaption")).toHaveTextContent("Last hour");
    expect(figure).toContainElement(inFrame.getByRole("link", { name: "Error rate" }));
  });

  it("shows a table's cells, each column lined up as it says and cut short unless it wraps, in a region a keyboard can scroll", () => {
    const [frame] = show({
      source: "blocks",
      parts: [
        {
          kind: "table",
          rows: [
            ["<p>Service</p>", "<p>Region</p>", "<p>Errors</p>"],
            ['<p><a href="https://example.com/api">api</a></p>', "", "<p>42</p>"],
          ],
          columns: [
            { align: "left", wrap: true },
            { align: "center", wrap: false },
          ],
        },
      ],
    });
    const region = within(frame!).getByRole("region", { name: "Table" });
    expect(region).toHaveAttribute("tabindex", "0");
    const cells = within(region).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["Service", "Region", "Errors", "api", "", "42"]);
    // A column the table says nothing of lines up at the left, and is cut short.
    expect(cells.slice(0, 3).map((cell) => [...cell.classList].find((name) => name.startsWith("text-")))).toEqual(["text-start", "text-center", "text-start"]);
    expect(cells.slice(0, 3).map((cell) => cell.firstElementChild!.classList.contains("[&_p]:truncate"))).toEqual([false, true, true]);
    expect(within(region).getByRole("link", { name: "api" })).toHaveAttribute("href", "https://example.com/api");
  });

  it("shows small cards in a row a keyboard can scroll, with their buttons as Slack lays them out: a danger one at the left, a primary one furthest right", () => {
    const [frame] = show({
      source: "blocks",
      parts: [
        {
          kind: "tiles",
          tiles: [
            {
              hero: { url: "https://example.com/lovelace.png", alt: "A room with a long table" },
              icon: { url: "https://example.com/icon.png", alt: "" },
              title: "Lovelace",
              subtitle: "Second floor",
              body: "<p>Free until <strong>4 PM</strong></p>",
              subtext: "<p>Has a screen</p>",
              buttons: [
                { text: "Book", href: "https://example.com/book", style: "primary" },
                { text: "Cancel", href: "https://example.com/cancel", style: "danger" },
                { text: "Floor plan", href: "https://example.com/plan" },
              ],
            },
            { title: "Hopper" },
          ],
        },
      ],
    });
    const row = within(frame!).getByRole("region", { name: "Cards" });
    expect(row).toHaveAttribute("tabindex", "0");
    const [lovelace, hopper] = within(row).getAllByRole("listitem");
    const inLovelace = within(lovelace!);
    expect(inLovelace.getByRole("img", { name: "A room with a long table" })).toHaveClass("aspect-[2/1]");
    expect(lovelace!.querySelector('img[src="https://example.com/icon.png"]')).toHaveClass("size-8");
    expect(lovelace).toHaveTextContent("LovelaceSecond floorFree until 4 PMHas a screen");
    expect(inLovelace.getByText("4 PM").tagName).toBe("STRONG");
    expect(inLovelace.getByText("Has a screen").closest(".message-content")).toHaveClass("text-xs");
    expect(inLovelace.getAllByRole("link").map((link) => link.textContent)).toEqual(["Cancel", "Floor plan", "Book"]);
    expect(hopper).toHaveTextContent("Hopper");
    // The next card shows at the edge of a narrow one.
    expect(hopper).toHaveClass("max-w-[85%]");

    // One small card isn't a row of its own, and shrinks to fit.
    show({ source: "blocks", parts: [{ kind: "tiles", tiles: [{ title: "Turing" }] }] });
    expect(screen.getAllByRole("region", { name: "Cards" })).toHaveLength(1);
    expect(screen.getByText("Turing").closest("li")).toHaveClass("max-w-full");
  });

  it("leaves out a block's images and buttons on the page's own host, as an attachment's", () => {
    const own = `https://${location.hostname}/files/1`;
    const [frame] = show({
      source: "blocks",
      parts: [
        { kind: "section", html: "<p>Deploy</p>", thumb: { url: own, alt: "Logo" }, button: { text: "Open", href: own } },
        { kind: "context", items: [{ image: { url: own, alt: "Ada" } }, { html: "<p>By Ada</p>" }] },
        { kind: "image", image: { url: own, alt: "Chart" }, title: "Last hour" },
        { kind: "tiles", tiles: [{ hero: { url: own, alt: "Room" }, icon: { url: own, alt: "" }, title: "Lovelace", buttons: [{ text: "Book", href: own }] }] },
      ],
    });
    expect(within(frame!).queryAllByRole("link")).toEqual([]);
    expect(frame!.querySelectorAll("img")).toHaveLength(0);
    expect(frame).toHaveTextContent("DeployBy AdaLovelace");
  });

  it("folds text past 700 characters or 5 line breaks behind Show more, where a block that starts with a block starts one line", async () => {
    const user = userEvent.setup();
    const text = (html: string) => card([{ kind: "text", html }]);
    const headings = "<div><h4>1</h4></div><p>2</p><div><h4>3</h4></div><p>4</p><div><h4>5</h4></div><p>6</p>";
    show(text(`<p>${"x".repeat(700)}</p>`), text("<p>1<br>2<br>3<br>4<br>5<br>6</p>"), text(`<p>${"x".repeat(701)}</p>`), text("<p>1</p><p>2<br>3<br>4<br>5<br>6<br>7</p>"), text(headings));
    const buttons = screen.getAllByRole("button", { name: "Show more" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.previousElementSibling).toHaveClass("max-h-[5lh]", "overflow-hidden");

    await user.click(buttons[0]!);
    expect(buttons[0]).toHaveAccessibleName("Show less");
    expect(buttons[0]).toHaveAttribute("aria-expanded", "true");
    expect(buttons[0]!.previousElementSibling).not.toHaveClass("max-h-[5lh]");
  });

  it("marks what a search matched in each part of a card that has text, as each was searched", () => {
    const deploys = "https://example.com/deploys/42";
    render(
      <SearchMarks value={marksFor(["deploy"])}>
        <BotCards
          cards={[
            card(
              [
                { kind: "author", name: "Deploy bot", href: "https://example.com/bot" },
                { kind: "title", text: "Deploy finished", href: deploys },
                { kind: "header", text: "Deploy 42" },
                { kind: "text", html: "<p>The deploy went out</p>" },
                { kind: "fields", fields: [{ title: "Deploy", html: "<p>deploy 42</p>", short: true }] },
                { kind: "image", image: { url: "https://example.com/graph.png", alt: "" }, title: "Deploy graph" },
                { kind: "context", items: [{ html: "<p>By the deploy bot</p>" }] },
                { kind: "buttons", buttons: [{ text: "Open deploy", href: deploys }] },
                { kind: "table", rows: [["deploy", "42"]], columns: [{ align: "left", wrap: false }, { align: "right", wrap: false }] },
                { kind: "tiles", tiles: [{ title: "Deploy", subtitle: "deploy 42", body: "<p>deploy body</p>", subtext: "<p>deploy subtext</p>" }] },
                { kind: "footer", text: "Deploy log" },
              ],
              { pretext: "<p>A deploy</p>" },
            ),
          ]}
        />
      </SearchMarks>,
    );
    const marks = [...document.querySelectorAll("mark[data-search-match]")].map((mark) => mark.textContent);
    // The pretext, author, title, header, text, field's title and value, image's title, context, button,
    // table cell, tile's title, subtitle, body and subtext, and footer.
    expect(marks).toEqual(["deploy", "Deploy", "Deploy", "Deploy", "deploy", "Deploy", "deploy", "Deploy", "deploy", "deploy", "deploy", "Deploy", "deploy", "deploy", "deploy", "Deploy"]);
    expect(screen.getByRole("link", { name: "Open deploy" }).querySelector("mark")).toHaveTextContent("deploy");
  });
});
