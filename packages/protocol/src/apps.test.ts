import { describe, expect, it } from "vitest";
import { isAtHost } from "./apps";

describe("An app's address", () => {
  const hosts = ["chat.example.com", "ember.ada.workers.dev", "localhost:8787"];

  it("is Ember's own at one of its hosts, by any port and however its name is written", () => {
    for (const address of ["https://chat.example.com/mcp", "https://CHAT.example.com/mcp", "https://chat.example.com.:8443/mcp", "https://ember.ada.workers.dev/v2/mcp?x=1"]) {
      expect(isAtHost(address, hosts), address).toBe(true);
    }
  });

  it("is another's at a host only named like one of Ember's", () => {
    for (const address of ["https://mcp.chat.example.com/mcp", "https://chat.example.com.au/mcp", "https://example.com/mcp", "https://ada.workers.dev/mcp"]) {
      expect(isAtHost(address, hosts), address).toBe(false);
    }
  });

  it("is Ember's own on this computer only at the port Ember is at, where other servers run beside it", () => {
    expect(isAtHost("http://localhost:8787/mcp", hosts)).toBe(true);
    expect(isAtHost("http://localhost:3845/mcp", hosts)).toBe(false);
    expect(isAtHost("http://localhost/mcp", hosts)).toBe(false);
    expect(isAtHost("http://localhost/mcp", ["localhost"])).toBe(true);
  });
});
