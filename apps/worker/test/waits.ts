import { vi } from "vitest";

// vitest gives a wait (`vi.waitFor`) a second unless the wait says otherwise, and has no setting for
// that. What the suite waits for, a room's alarm, say, or a call the Worker makes once it has answered,
// can take longer than a second on a busy runner, so a wait that doesn't say gets five.
const WAIT_MS = 5_000;

const waitFor = vi.waitFor;
vi.waitFor = (check, options = {}) => waitFor(check, typeof options === "number" ? options : { timeout: WAIT_MS, ...options });
