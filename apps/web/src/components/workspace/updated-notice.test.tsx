import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardLeaving } from "@/hooks/use-route";
import { useUpdated } from "@/hooks/use-updated";
import { reloadPage } from "@/lib/page";
import { UpdatedNotice } from "./updated-notice";

vi.mock("@/hooks/use-updated", () => ({ useUpdated: vi.fn() }));
vi.mock("@/lib/page", () => ({ reloadPage: vi.fn() }));

const notice = () => screen.queryByRole("status");

beforeEach(() => {
  vi.mocked(useUpdated).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("UpdatedNotice", () => {
  it("says nothing while the page is Ember as it's deployed", () => {
    vi.mocked(useUpdated).mockReturnValue(false);
    render(<UpdatedNotice />);
    expect(notice()).not.toBeInTheDocument();
  });

  it("says Ember has been updated, and reloads the page when asked", async () => {
    render(<UpdatedNotice />);
    expect(notice()).toHaveTextContent("Ember has been updated. Reload");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it("asks the page's guard first, so changes it holds aren't lost unasked", async () => {
    let proceed: (() => unknown) | null = null;
    const release = guardLeaving((path, go) => {
      expect(path).toBeNull();
      proceed = go;
      return true;
    });
    render(<UpdatedNotice />);
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reloadPage).not.toHaveBeenCalled();

    release();
    await proceed!();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it("goes once it's closed", async () => {
    render(<UpdatedNotice />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(notice()).not.toBeInTheDocument();
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
