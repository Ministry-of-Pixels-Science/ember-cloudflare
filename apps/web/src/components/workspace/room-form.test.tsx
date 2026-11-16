import { MAX_ROOM_NAME_LENGTH, TRANSLATIONS, type User } from "@ember/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { AccessSwitch, CheckMark, RoomForm } from "./room-form";

const people = (count: number): User[] => Array.from({ length: count }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }));
const grace = { id: "grace", name: "Grace Hopper" };

function renderForm(props: Partial<ComponentProps<typeof RoomForm<User>>> = {}, wrapper?: (props: { children: ReactNode }) => ReactNode) {
  const onSave = vi.fn();
  render(
    <RoomForm
      canAdminister
      name="Design"
      onNameChange={vi.fn()}
      icon={null}
      onIconChange={vi.fn()}
      everyone={null}
      groups={[people(3)]}
      mark={() => <CheckMark />}
      saving={false}
      onSave={onSave}
      {...props}
    />,
    { wrapper },
  );
  return { onSave, user: userEvent.setup() };
}

/** The names listed, in order, not counting the avatars' initials. */
const names = () => screen.queryAllByRole("listitem").map((row) => row.querySelector("strong")!.textContent);

describe("Create an open room", () => {
  it("asks for the room's name, focused, and saves with Enter", async () => {
    const onNameChange = vi.fn();
    const { onSave, user } = renderForm({ onNameChange });
    const name = screen.getByRole("textbox", { name: "Room name" });
    expect(name).toHaveValue("Design");
    expect(name).toHaveFocus();
    expect(name).toBeRequired();
    expect(name).toHaveAttribute("placeholder", "Name the room");
    expect(name).toHaveAttribute("maxlength", String(MAX_ROOM_NAME_LENGTH));
    await user.type(name, "s");
    expect(onNameChange).toHaveBeenLastCalledWith("Designs");
    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("lists the people with what follows each name", () => {
    renderForm({ mark: (person) => person.id === "u1" && <span>marked</span> });
    expect(names()).toEqual(["Person 0", "Person 1", "Person 2"]);
    expect(screen.getByText("marked").closest("li")).toHaveTextContent("Person 1");
  });

  it("has a switch on the Everyone row when it can flip, named for what it would do", async () => {
    const onFlip = vi.fn();
    const { user } = renderForm({ everyone: { on: true, onFlip } });
    expect(names()[0]).toBe("Everyone");
    const everyone = screen.getByRole("switch", { name: "Give only some access to this room" });
    expect(everyone).toBeChecked();
    await user.click(everyone);
    expect(onFlip).toHaveBeenCalledOnce();
  });

  it("leaves the switch off the Everyone row when it can't flip", () => {
    renderForm({ everyone: { on: true } });
    expect(names()[0]).toBe("Everyone");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("disables Save and every switch while saving", () => {
    renderForm({ saving: true, everyone: { on: false, onFlip: vi.fn() }, mark: (person) => <AccessSwitch person={person} checked onCheckedChange={vi.fn()} /> });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    for (const toggle of screen.getAllByRole("switch")) expect(toggle).toBeDisabled();
  });
});

describe("Create a private room", () => {
  it("names the Everyone switch for opening the room when it's off", () => {
    renderForm({ everyone: { on: false, onFlip: vi.fn() } });
    expect(screen.getByRole("switch", { name: "Give everyone access to this room" })).not.toBeChecked();
  });

  it("lists each group by itself, with a line between", () => {
    renderForm({ groups: [[grace], [], people(2)] });
    expect(names()).toEqual(["Grace Hopper", "Person 0", "Person 1"]);
    // One line between the two groups that have anyone in them.
    expect(screen.getByRole("list").querySelectorAll(":scope > hr")).toHaveLength(1);
  });
});

describe("Room icon picker", () => {
  it("shows the room's icon after its name, to choose another", () => {
    renderForm({ icon: "coffee" });
    const name = screen.getByRole("textbox", { name: "Room name" });
    const picker = screen.getByRole("button", { name: "Choose room icon" });
    expect(name.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(picker).toHaveTextContent("Break Room");
    expect(picker).toBeEnabled();
  });

  it("holds the icon while saving", () => {
    renderForm({ icon: "coffee", saving: true });
    expect(screen.getByRole("button", { name: "Choose room icon" })).toBeDisabled();
  });

  it("shows no icon to people who can't change the room", () => {
    renderForm({ icon: "coffee", canAdminister: false });
    expect(screen.queryByRole("button", { name: "Choose room icon" })).not.toBeInTheDocument();
    expect(screen.queryByText("Room icon")).not.toBeInTheDocument();
  });
});

describe("Room settings page", () => {
  it("shows people who can't change the room its name as a heading, with no Save", () => {
    renderForm({ canAdminister: false, mark: () => null });
    expect(screen.getByRole("heading", { level: 2, name: "Design" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("filters a list of more than 20 people, by any part of their names whatever its case, once typing stops", async () => {
    const { user } = renderForm({ groups: [[grace], people(20)] });
    const filter = screen.getByRole("searchbox");
    expect(filter).toHaveAttribute("placeholder", "Filter…");
    await user.type(filter, "HOP");
    // Not yet: the filter waits for typing to stop.
    expect(names()).toHaveLength(21);
    await waitFor(() => expect(names()).toEqual(["Grace Hopper"]));
    await user.clear(filter);
    await waitFor(() => expect(names()).toHaveLength(21));
  });

  it("has no filter for 20 people or fewer", () => {
    renderForm({ groups: [people(20)] });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("doesn't save the form from the filter", async () => {
    const { onSave, user } = renderForm({ groups: [people(21)] });
    await user.type(screen.getByRole("searchbox"), "Person{Enter}");
    expect(onSave).not.toHaveBeenCalled();
    expect(within(screen.getByRole("list")).getByRole("searchbox")).toBeInTheDocument();
  });
});

describe("Translation buttons", () => {
  it("has a translation button by the room's name once an administrator shows them", () => {
    renderForm({}, ({ children }) => <AccountContext value={{ name: "Ember", tagline: "", hideTranslationButtons: false, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true }}>{children}</AccountContext>);
    expect(screen.getByText("Translate")).toBeInTheDocument();
    expect(screen.getByText(TRANSLATIONS.room_name[0][1])).toBeInTheDocument();
  });
});

describe("Avatars open people's pages", () => {
  it("links each person's avatar to their page, titled with their name, loading as it's scrolled to", () => {
    renderForm();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.getAttribute("href"), link.getAttribute("title")])).toEqual([
      ["/users/u0", "Person 0"],
      ["/users/u1", "Person 1"],
      ["/users/u2", "Person 2"],
    ]);
    expect(links[0]!.querySelector("img")).toHaveAttribute("loading", "lazy");
  });
});
