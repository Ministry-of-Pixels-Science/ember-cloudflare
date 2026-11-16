import { ASSISTANT_ID, avatarSvg, type DirectoryUser, type User } from "@ember/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { AvatarLink, DRAWINGS_KEPT, UserAvatar, userTitle } from "./user-avatar";

const ada: DirectoryUser = { id: "u1", name: "Ada Lovelace", bio: null, role: "member", status: "active", avatarUrl: "/users/u1.abc/avatar?v=20261014120000" };

/** Ada's initials, drawn in the page as the Worker draws them. */
const drawn = `data:image/svg+xml;base64,${btoa(avatarSvg(ada.id, ada.name))}`;

/** The image `avatar` draws, with the directory listing `people`. */
function picture(avatar: React.ReactElement, people: People = new Map([[ada.id, ada]])) {
  const { container, rerender } = render(<PeopleContext value={people}>{avatar}</PeopleContext>);
  return { image: container.querySelector("img")!, rerender: (next: People) => rerender(<PeopleContext value={next}>{avatar}</PeopleContext>) };
}

describe("Initials avatars", () => {
  it("shows the image the directory gives the address of, over the initials, hidden from screen readers", () => {
    const { image } = picture(<UserAvatar user={ada} />);
    expect(image).toHaveAttribute("src", ada.avatarUrl);
    expect(image.style.backgroundImage).toBe(`url("${drawn}")`);
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(image).not.toHaveAttribute("loading");
  });

  it("takes the initials from behind a picture once it loads, so they don't show through one that's see-through", () => {
    const { image } = picture(<UserAvatar user={ada} />);
    fireEvent.load(image);
    expect(image).toHaveAttribute("src", ada.avatarUrl);
    expect(image.style.backgroundImage).toBe("");
  });

  it("leaves them out while the next picture loads, since the last one shows until it has", () => {
    const { image, rerender } = picture(<UserAvatar user={ada} />);
    fireEvent.load(image);
    const changed = { ...ada, avatarUrl: "/users/u1.abc/avatar?v=20261015120000" };
    rerender(new Map([[ada.id, changed]]));
    expect(image).toHaveAttribute("src", changed.avatarUrl);
    expect(image.style.backgroundImage).toBe("");
  });

  it("crops a photo that isn't square to fill its square, as Campfire's `.avatar img` does", () => {
    expect(picture(<UserAvatar user={ada} />).image).toHaveClass("object-cover");
  });

  it("draws the initials while the directory doesn't list someone", () => {
    expect(picture(<UserAvatar user={{ id: ada.id, name: ada.name }} />, new Map()).image).toHaveAttribute("src", drawn);
  });

  it("shows the image the user it's given has until the directory lists them, as a bot just added", () => {
    const { image, rerender } = picture(<UserAvatar user={ada} />, new Map());
    expect(image).toHaveAttribute("src", ada.avatarUrl);
    const changed = { ...ada, avatarUrl: "/users/u1.abc/avatar?v=20261015120000" };
    rerender(new Map([[ada.id, changed]]));
    expect(image).toHaveAttribute("src", changed.avatarUrl);
  });

  it("draws the initials of the name the directory lists, which follows a rename since the user was copied", () => {
    const renamed = { ...ada, name: "Grace Hopper" };
    const { image } = picture(<UserAvatar user={ada} />, new Map([[ada.id, renamed]]));
    expect(image.style.backgroundImage).toBe(`url("data:image/svg+xml;base64,${btoa(avatarSvg(ada.id, "Grace Hopper"))}")`);
  });

  it("goes back to the initials when the image can't load, until the directory gives another", () => {
    const { image, rerender } = picture(<UserAvatar user={ada} />);
    fireEvent.error(image);
    expect(image).toHaveAttribute("src", drawn);
    const changed = { ...ada, avatarUrl: "/users/u1.abc/avatar?v=20261015120000" };
    rerender(new Map([[ada.id, changed]]));
    expect(image).toHaveAttribute("src", changed.avatarUrl);
  });

  it("waits to load in lists until it's scrolled near", () => {
    expect(picture(<UserAvatar user={ada} lazy />).image).toHaveAttribute("loading", "lazy");
  });

  it("keeps the initials it drew for only as many people as a page could show, the ones shown last", () => {
    const drawing = vi.spyOn(globalThis, "btoa");
    const someone = (n: number): User => ({ id: `shown-${n}`, name: `Someone ${n}` });
    const show = (people: User[]) => render(<PeopleContext value={new Map()}>{people.map((user, index) => <UserAvatar key={index} user={user} />)}</PeopleContext>).unmount();

    show([someone(0), someone(0)]);
    expect(drawing).toHaveBeenCalledOnce();
    show(Array.from({ length: DRAWINGS_KEPT - 1 }, (_, n) => someone(n + 1)));
    // Shown again, the first is the one shown last, so someone new takes the second's place instead.
    show([someone(0)]);
    show([someone(DRAWINGS_KEPT)]);
    expect(drawing).toHaveBeenCalledTimes(DRAWINGS_KEPT + 1);
    show([someone(0)]);
    expect(drawing).toHaveBeenCalledTimes(DRAWINGS_KEPT + 1);
    show([someone(1)]);
    expect(drawing).toHaveBeenCalledTimes(DRAWINGS_KEPT + 2);
    drawing.mockRestore();
  });
});

describe("Bots' avatars are circles", () => {
  const bot: DirectoryUser = { id: "b1", name: "Build Bot", bio: null, role: "bot", status: "active", avatarUrl: "/users/b1.abc/avatar?v=20261014120000" };
  const listing: People = new Map([
    [ada.id, ada],
    [bot.id, bot],
  ]);

  it("draws a bot as a circle where people are squares with rounded corners, as messages show them", () => {
    expect(picture(<UserAvatar user={ada} square />, listing).image).toHaveClass("rounded-[6px]");
    const { image } = picture(<UserAvatar user={{ id: bot.id, name: bot.name }} square />, listing);
    expect(image).toHaveClass("rounded-full");
    expect(image).not.toHaveClass("rounded-[6px]");
  });

  it("keeps a bot's circle whatever corners the place gives people's, as a thread's summary gives its faces 4px", () => {
    expect(picture(<UserAvatar user={ada} square className="size-6 rounded-[4px]" />, listing).image).toHaveClass("rounded-[4px]");
    const { image } = picture(<UserAvatar user={bot} square className="size-6 rounded-[4px]" />, listing);
    expect(image).toHaveClass("size-6", "rounded-full");
    expect(image).not.toHaveClass("rounded-[4px]");
  });

  it("draws @ember as a circle before the directory lists anyone", () => {
    expect(picture(<UserAvatar user={{ id: ASSISTANT_ID, name: "Ember" }} square />, new Map()).image).toHaveClass("rounded-full");
  });

  it("rounds the link to a bot's page as well, so the circle darkens under a mouse", () => {
    picture(
      <>
        <AvatarLink user={ada} square />
        <AvatarLink user={bot} square />
      </>,
      listing,
    );
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toHaveClass("rounded-[6px]");
    const link = screen.getByRole("link", { name: "Build Bot" });
    expect(link).toHaveClass("rounded-full");
    expect(link).not.toHaveClass("rounded-[6px]");
    expect(link.querySelector("img")).toHaveClass("rounded-full");
  });
});

describe("Avatars open people's pages", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("links to the person's page, titled with their name and bio as the directory lists them, around the image screen readers skip", () => {
    const { image } = picture(<AvatarLink user={{ id: ada.id, name: "Ada" }} />, new Map([[ada.id, { ...ada, bio: "Wrote the first program" }]]));
    const link = screen.getByRole("link", { name: "Ada Lovelace – Wrote the first program" });
    expect(link).toHaveAttribute("href", "/users/u1");
    expect(link).toHaveAttribute("title", "Ada Lovelace – Wrote the first program");
    expect(link).toContainElement(image);
    expect(image).toHaveAttribute("src", ada.avatarUrl);
    expect(image).toHaveAttribute("aria-hidden", "true");
  });

  it("is titled with the name the user has where the directory doesn't list them", () => {
    picture(<AvatarLink user={{ id: "u2", name: "Grace Hopper" }} />);
    expect(screen.getByRole("link", { name: "Grace Hopper" })).toHaveAttribute("href", "/users/u2");
  });

  it("is named by its image's label where it has one, as a boost's is", () => {
    picture(<AvatarLink user={ada} label="Ada Lovelace boosted 👍" reach="dense" />);
    expect(screen.getByRole("link", { name: "Ada Lovelace boosted 👍" })).toHaveAttribute("title", "Ada Lovelace");
  });

  it("escapes the id in its address", () => {
    picture(<AvatarLink user={{ id: "a/b?c", name: "Odd" }} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/users/a%2Fb%3Fc");
  });

  it("goes to the person's page in place", async () => {
    picture(<AvatarLink user={ada} />);
    const length = history.length;
    await userEvent.click(screen.getByRole("link"));
    expect(location.pathname).toBe("/users/u1");
    expect(history.length).toBe(length + 1);
  });

  it("titles someone with their name, then their bio after a dash where it isn't blank, as `User#title` does", () => {
    expect(userTitle({ name: "Ada", bio: "Wrote the first program" })).toBe("Ada – Wrote the first program");
    expect(userTitle({ name: "Ada", bio: " Poet " })).toBe("Ada –  Poet ");
    expect(userTitle({ name: "Ada", bio: "  " })).toBe("Ada");
    expect(userTitle({ name: "Ada", bio: null })).toBe("Ada");
    expect(userTitle({ name: "Ada" })).toBe("Ada");
  });
});
