import { describe, expect, it } from "vitest";
import { snippetName } from "./snippet-dialog";

describe("snippetName", () => {
  it("names a snippet after its title, or Untitled, as a text file", () => {
    expect(snippetName("")).toBe("Untitled.txt");
    expect(snippetName("   ")).toBe("Untitled.txt");
    expect(snippetName(" Release notes ")).toBe("Release notes.txt");
    expect(snippetName("Version 1.2")).toBe("Version 1.2.txt");
  });

  it("keeps an extension the title ends in", () => {
    expect(snippetName("deploy.sh")).toBe("deploy.sh");
    expect(snippetName("schema.sql")).toBe("schema.sql");
  });

  it("makes the slashes that would name folders dashes", () => {
    expect(snippetName("notes/today")).toBe("notes-today.txt");
    expect(snippetName("C:\\temp\\log")).toBe("C:-temp-log.txt");
  });
});
