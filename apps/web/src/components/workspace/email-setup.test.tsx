import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_FROM_REFUSED, RESEND_API_KEY_REFUSED, type Account, type AccountChanges, type EmailSettings as Email } from "@ember/protocol";
import { ApiError } from "@/lib/api";
import { EMAIL_SENDING_DASHBOARD, EmailSetup, WORKERS_PLANS } from "./email-setup";

const EMBER: Account = {
  name: "Ember",
  tagline: "",
  hideTranslationButtons: true,
  customStyles: "",
  restrictRoomCreation: false,
  logo: null,
  customDomain: null,
  joinLink: true,
  openSignUp: false,
  memberfulJoin: false,
  memberfulSignIn: false,
  emailDomainSignUp: false,
  emailDomains: [],
  navigationIcons: {},
  huddles: false,
  huddleCameras: true,
  huddleScreens: true,
};

/** How a new workspace sends email: with the binding wrangler.jsonc declares, from no address yet. */
const NEW_EMAIL: Email = { provider: "cloudflare", resendKey: null, cloudflare: true, from: null };
const RESEND_KEY = "re_123456789_abcdefghijklmnop";

interface Answers {
  /** What giving Ember a Resend API key answers, rather than Ember sending with it. */
  keySaved?: () => Response | Promise<Response>;
  /** What taking it away answers, rather than Ember sending with Cloudflare's binding. */
  keyForgotten?: () => Response | Promise<Response>;
  /** What saving the From address answers, rather than the workspace. */
  fromSaved?: () => Response | Promise<Response>;
  /** What checking a domain for Cloudflare Email Sending answers, rather than that it's onboarded. */
  domainChecked?: () => Response | Promise<Response>;
  /** What sending a test email answers, rather than that it went to Ada. */
  testSent?: () => Response | Promise<Response>;
}

/** Answers the dialog's requests as the server would for a workspace that sends email as `start` says, or as `answers` says. */
function serve(start: Email, { keySaved, keyForgotten, fromSaved, domainChecked, testSent }: Answers = {}) {
  let email = start;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    switch (`${init?.method} ${String(input)}`) {
      case "PUT /api/account/resend_api_key":
        if (keySaved) return keySaved();
        email = { ...email, provider: "resend", resendKey: "saved" };
        return Response.json(email);
      case "DELETE /api/account/resend_api_key":
        if (keyForgotten) return keyForgotten();
        email = { ...email, provider: email.cloudflare ? "cloudflare" : null, resendKey: null };
        return Response.json(email);
      case "PATCH /api/account":
        if (fromSaved) return fromSaved();
        email = { ...email, from: (JSON.parse(String(init?.body)) as AccountChanges).emailFrom ?? null };
        return Response.json({ account: EMBER });
      case "POST /api/account/sending_domain_checks":
        return domainChecked ? domainChecked() : Response.json({ onboarded: true });
      case "POST /api/account/test_email":
        return testSent ? testSent() : Response.json({ to: "ada@example.com" });
      default:
        throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
    }
  });
}

/** What the dialog asked of the server, in order, with what it sent. */
const asked = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => [`${init?.method} ${String(input)}`, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** Set up email, open on a workspace that sends email as `start` says, keeping what it saves as workspace settings does, until it closes. */
function showSetup(start: Email) {
  const callbacks = { onAccountChanged: vi.fn(), onEmailChanged: vi.fn(), onFromSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  function Setup() {
    const [email, setEmail] = useState(start);
    const [open, setOpen] = useState(true);
    const [askForAccount] = useState(() => () => callbacks.onAccountChanged);
    if (!open) return null;
    return (
      <EmailSetup
        email={email}
        askForAccount={askForAccount}
        onEmailChanged={(changed) => {
          callbacks.onEmailChanged(changed);
          setEmail(changed);
        }}
        onFromSaved={(from) => {
          callbacks.onFromSaved(from);
          setEmail((email) => ({ ...email, from }));
        }}
        onClose={(sends) => {
          callbacks.onClose(sends);
          setOpen(false);
        }}
        onFailed={callbacks.onFailed}
      />
    );
  }
  render(<Setup />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const choice = (name: string) => screen.getByRole("radio", { name });
const keyField = () => screen.getByRole("textbox", { name: "API key" });
const fromField = () => screen.getByRole("textbox", { name: "From" });
/** What the From step says of its address's domain, a moment after it's typed. */
const domainNote = () => screen.getByRole("status");
/** Waits for the From step to say `text` of its address's domain, which it does a moment after typing stops. */
const noted = (text: string) => waitFor(() => expect(domainNote()).toHaveTextContent(text), { timeout: 3000 });

/** Opens Set up email on a new workspace, choosing Cloudflare Email Service, at the From address. */
async function cloudflareFrom() {
  const shown = showSetup(NEW_EMAIL);
  await shown.user.click(await screen.findByRole("radio", { name: "Cloudflare Email Service" }));
  await shown.user.click(button("Continue"));
  await shown.user.click(await screen.findByRole("button", { name: "Continue" }));
  await dialog("Choose the From address");
  return shown;
}

afterEach(() => vi.restoreAllMocks());

describe("Sending email", () => {
  it("starts with what sends email, saying Cloudflare Email Service needs Workers Paid", async () => {
    serve(NEW_EMAIL);
    const { user, onClose } = showSetup(NEW_EMAIL);
    const setup = await dialog("Set up email");
    expect(within(setup).getByRole("heading", { name: "Set up email" })).toHaveFocus();
    expect(setup).toHaveAccessibleDescription("Ember emails invitations, the links people at your email domains join with, and codes to reset a forgotten password. Choose what sends them.");
    expect(choice("Resend")).not.toBeChecked();
    expect(choice("Resend")).toHaveAccessibleDescription(
      "Free for up to 100 emails a day, and 3,000 a month, whatever your Cloudflare plan. It takes a Resend account, and a domain to send from.",
    );
    expect(choice("Cloudflare Email Service")).toBeEnabled();
    expect(choice("Cloudflare Email Service")).toHaveAccessibleDescription(
      "Needs the Workers Paid plan ($5 a month) on the Cloudflare account that runs Ember.",
    );
    expect(button("Continue")).toBeDisabled();
    await user.click(choice("Resend"));
    expect(button("Continue")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(asked()).toEqual([]);
  });

  it("sets up Resend with an API key Ember checks, then the From address, then a test email, closing able to send", async () => {
    serve(NEW_EMAIL);
    const { user, onEmailChanged, onFromSaved, onAccountChanged, onClose } = showSetup(NEW_EMAIL);
    await user.click(await screen.findByRole("radio", { name: "Resend" }));
    await user.click(button("Continue"));

    const resend = await dialog("Send with Resend");
    expect(within(resend).getByRole("heading", { name: "Send with Resend" })).toHaveFocus();
    expect(resend).toHaveAccessibleDescription("Ember sends email with an API key from your Resend account, which it keeps encrypted.");
    const [domain, key] = within(screen.getByRole("list", { name: "Steps to send email with Resend" })).getAllByRole("listitem");
    expect(domain).toHaveTextContent(
      "In Resend, add the domain to send from under Domains, then add the DNS records it gives you where your domain's DNS is, until Resend says it's verified.",
    );
    expect(within(domain!).getByRole("link", { name: "Open Resend's domains" })).toHaveAttribute("href", "https://resend.com/domains");
    expect(key).toHaveTextContent("Under API Keys, create a key with Sending access, and paste it here.");
    expect(within(key!).getByRole("link", { name: "Open Resend's API keys" })).toHaveAttribute("href", "https://resend.com/api-keys");
    expect(keyField()).toHaveAttribute("placeholder", "re_…");
    expect(button("Continue")).toBeDisabled();
    await user.type(keyField(), ` ${RESEND_KEY} `);
    await user.click(button("Continue"));

    await dialog("Choose the From address");
    expect(onEmailChanged).toHaveBeenCalledExactlyOnceWith({ ...NEW_EMAIL, provider: "resend", resendKey: "saved" });
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "The address Ember's email comes from, on the domain you verified in Resend. Email comes under the community's name, unless you put another name before the address.",
    );
    expect(fromField()).toHaveValue("");
    await user.type(fromField(), "  Ember Team   <chat@example.com> ");
    await user.click(button("Continue"));

    const test = await dialog("Send a test email");
    expect(onFromSaved).toHaveBeenCalledExactlyOnceWith("Ember Team <chat@example.com>");
    expect(onAccountChanged).toHaveBeenCalledWith(EMBER);
    expect(test).toHaveAccessibleDescription(
      "Ember is set up to send email, and sends you a test email to check that it arrives. If it doesn't, go back and change what sends it.",
    );
    // It's sent as the step opens.
    expect(await screen.findByText("Sent to ada@example.com. If it isn't in your inbox, look in spam.")).toBeInTheDocument();
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect(asked()).toEqual([
      ["PUT /api/account/resend_api_key", { apiKey: RESEND_KEY }],
      ["PATCH /api/account", { emailFrom: "Ember Team <chat@example.com>" }],
      ["POST /api/account/test_email", undefined],
    ]);
  });

  it("refuses a Resend API key that isn't one without asking, and says why Resend refused one", async () => {
    const refusal = "Resend doesn't take this API key. Copy it again from API Keys in Resend, or make another.";
    serve(NEW_EMAIL, { keySaved: () => Response.json({ error: refusal }, { status: 422 }) });
    const { user, onFailed } = showSetup(NEW_EMAIL);
    await user.click(await screen.findByRole("radio", { name: "Resend" }));
    await user.click(button("Continue"));
    await user.type(await screen.findByRole("textbox", { name: "API key" }), "sk_live_123{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(RESEND_API_KEY_REFUSED);
    expect(keyField()).toHaveAttribute("aria-invalid", "true");
    expect(keyField()).toHaveAccessibleDescription(RESEND_API_KEY_REFUSED);
    expect(asked()).toEqual([]);

    await user.clear(keyField());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(keyField(), `${RESEND_KEY}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.getByRole("dialog", { name: "Send with Resend" })).toBeInTheDocument();
    expect(keyField()).toHaveValue(RESEND_KEY);
    expect(button("Continue")).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("can't be closed while it checks a key, and says Checking…", async () => {
    const answer = held(() => Response.json({ ...NEW_EMAIL, provider: "resend", resendKey: "saved" }));
    serve(NEW_EMAIL, { keySaved: answer.answered });
    const { user, onClose } = showSetup(NEW_EMAIL);
    await user.click(await screen.findByRole("radio", { name: "Resend" }));
    await user.click(button("Continue"));
    await user.type(await screen.findByRole("textbox", { name: "API key" }), `${RESEND_KEY}{Enter}`);
    expect(button("Checking…")).toBeDisabled();
    expect(button("Back")).toBeDisabled();
    expect(button("Close")).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    await answer.answer();
    expect(await dialog("Choose the From address")).toBeInTheDocument();
  });

  it("leaves a failure it can't say itself to the page's alerts", async () => {
    serve(NEW_EMAIL, { keySaved: () => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }) });
    const { user, onFailed } = showSetup(NEW_EMAIL);
    await user.click(await screen.findByRole("radio", { name: "Resend" }));
    await user.click(button("Continue"));
    await user.type(await screen.findByRole("textbox", { name: "API key" }), `${RESEND_KEY}{Enter}`);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can change the workspace")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(button("Continue")).toBeEnabled();
  });

  it("sets up Cloudflare Email Service with Workers Paid and a domain onboarded to Email Sending, saving nothing until the From address", async () => {
    serve(NEW_EMAIL);
    const { user, onClose } = showSetup(NEW_EMAIL);
    await user.click(await screen.findByRole("radio", { name: "Cloudflare Email Service" }));
    await user.click(button("Continue"));

    const cloudflare = await dialog("Send with Cloudflare Email Service");
    expect(cloudflare).toHaveAccessibleDescription("Ember sends email from your Cloudflare account, with this Worker's EMAIL binding.");
    const [plan, domain] = within(screen.getByRole("list", { name: "Steps to send email with Cloudflare" })).getAllByRole("listitem");
    expect(plan).toHaveTextContent(/^Put the Cloudflare account that runs Ember on the Workers Paid plan\. Open Workers plans$/);
    expect(within(plan!).getByRole("link", { name: "Open Workers plans" })).toHaveAttribute("href", WORKERS_PLANS);
    expect(domain).toHaveTextContent(
      "In the Cloudflare dashboard, open Email Service, Email Sending, choose Onboard Domain, and pick a domain on Cloudflare DNS.",
    );
    expect(within(domain!).getByRole("link", { name: "Open Email Sending in the Cloudflare dashboard" })).toHaveAttribute("href", EMAIL_SENDING_DASHBOARD);
    await user.click(button("Continue"));

    await dialog("Choose the From address");
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "The address Ember's email comes from, on the domain you onboarded to Email Sending. Email comes under the community's name, unless you put another name before the address.",
    );
    expect(asked()).toEqual([]);
    // Back goes to Cloudflare's steps, then to the choice, which stays as it was.
    await user.click(button("Back"));
    await dialog("Send with Cloudflare Email Service");
    await user.click(button("Back"));
    await dialog("Set up email");
    expect(choice("Cloudflare Email Service")).toBeChecked();

    await user.click(button("Close"));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("offers Cloudflare Email Service only while the Worker has its EMAIL binding", async () => {
    const email: Email = { ...NEW_EMAIL, provider: null, cloudflare: false };
    serve(email);
    showSetup(email);
    expect(await screen.findByRole("radio", { name: "Cloudflare Email Service" })).toBeDisabled();
    expect(choice("Cloudflare Email Service")).toHaveAccessibleDescription("This Worker has no EMAIL binding, which Cloudflare Email Service sends with.");
    expect(choice("Resend")).toBeEnabled();
  });

  it("keeps the Resend API key Ember has unless another is pasted, and changes only what's changed", async () => {
    const email: Email = { provider: "resend", resendKey: "saved", cloudflare: true, from: "chat@example.com" };
    serve(email);
    const { user, onClose } = showSetup(email);
    expect(await screen.findByRole("radio", { name: "Resend" })).toBeChecked();
    await user.click(button("Continue"));
    await dialog("Send with Resend");
    expect(keyField()).toHaveValue("");
    expect(keyField()).toHaveAccessibleDescription("Ember has a Resend API key already. Paste another to send with it instead.");
    await user.click(button("Continue"));

    await dialog("Choose the From address");
    expect(fromField()).toHaveValue("chat@example.com");
    await user.click(button("Continue"));
    await dialog("Send a test email");
    await screen.findByText("Sent to ada@example.com. If it isn't in your inbox, look in spam.");
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect(asked()).toEqual([["POST /api/account/test_email", undefined]]);
  });

  it("forgets the Resend API key Ember has once Cloudflare Email Service is chosen instead", async () => {
    const email: Email = { provider: "resend", resendKey: "saved", cloudflare: true, from: "chat@example.com" };
    serve(email);
    const { user, onEmailChanged } = showSetup(email);
    await user.click(await screen.findByRole("radio", { name: "Cloudflare Email Service" }));
    await user.click(button("Continue"));
    await dialog("Send with Cloudflare Email Service");
    expect(screen.getByRole("dialog")).toHaveTextContent("Ember will stop sending with Resend, and forget its API key.");
    await user.click(button("Continue"));

    await dialog("Choose the From address");
    expect(onEmailChanged).toHaveBeenCalledExactlyOnceWith({ ...email, provider: "cloudflare", resendKey: null });
    expect(asked()).toEqual([["DELETE /api/account/resend_api_key", undefined]]);
    // Back goes to Cloudflare's steps, which have no key to forget now.
    await user.click(button("Back"));
    await dialog("Send with Cloudflare Email Service");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("forget its API key");
  });

  it("starts at the From address while the deployment's RESEND_API_KEY sends, with nothing to go back to", async () => {
    const email: Email = { provider: "resend", resendKey: "secret", cloudflare: true, from: null };
    serve(email);
    showSetup(email);
    const from = await dialog("Choose the From address");
    expect(within(from).getByRole("heading", { name: "Choose the From address" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("refuses a From address that isn't one, without saving it, until it's typed again", async () => {
    const email: Email = { provider: "resend", resendKey: "secret", cloudflare: true, from: null };
    serve(email);
    const { user, onFromSaved } = showSetup(email);
    await user.type(await screen.findByRole("textbox", { name: "From" }), "Ember{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(EMAIL_FROM_REFUSED);
    expect(fromField()).toHaveAttribute("aria-invalid", "true");
    expect(fromField()).toHaveAccessibleDescription(EMAIL_FROM_REFUSED);
    expect(onFromSaved).not.toHaveBeenCalled();
    expect(asked()).toEqual([]);

    await user.type(fromField(), " <ember@example.com>");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fromField()).toHaveAttribute("aria-invalid", "false");
  });

  it("leaves a From address that failed to save to the page's alerts, keeping what was typed", async () => {
    const email: Email = { provider: "resend", resendKey: "secret", cloudflare: true, from: null };
    serve(email, { fromSaved: () => Response.json({ error: "Not signed in" }, { status: 401 }) });
    const { user, onFailed, onFromSaved } = showSetup(email);
    await user.type(await screen.findByRole("textbox", { name: "From" }), "ember@example.com{Enter}");
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(401, "Not signed in")));
    expect(onFromSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose the From address" })).toBeInTheDocument();
    expect(fromField()).toHaveValue("ember@example.com");
  });

  it("checks that the From address's domain is onboarded to Cloudflare Email Sending once typing stops, then sends the test email", async () => {
    const check = held(() => Response.json({ onboarded: true }));
    serve(NEW_EMAIL, { domainChecked: check.answered });
    const { user, onClose } = await cloudflareFrom();
    expect(domainNote()).toBeEmptyDOMElement();
    await user.type(fromField(), "Ember <ember@Mail.Example.com>");
    await noted("Checking that mail.example.com is onboarded to Cloudflare Email Sending…");
    await check.answer();
    await noted("mail.example.com is onboarded to Cloudflare Email Sending.");
    expect(domainNote()).toHaveClass("text-positive");
    expect(fromField()).toHaveAccessibleDescription("mail.example.com is onboarded to Cloudflare Email Sending.");

    await user.click(button("Continue"));
    await dialog("Send a test email");
    expect(await screen.findByText("Sent to ada@example.com. If it isn't in your inbox, look in spam.")).toBeInTheDocument();
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    // Once, for the domain typed, as typing stopped.
    expect(asked()).toEqual([
      ["POST /api/account/sending_domain_checks", { domain: "mail.example.com" }],
      ["PATCH /api/account", { emailFrom: "Ember <ember@Mail.Example.com>" }],
      ["POST /api/account/test_email", undefined],
    ]);
  });

  it("says a domain isn't onboarded to Email Sending, linking to it, without holding up Continue, and the test email says why it wasn't sent", async () => {
    const refusal =
      "The From address's domain isn't onboarded to Cloudflare Email Service. In the Cloudflare dashboard, open Email Service, Email Sending, and choose Onboard Domain.";
    serve(NEW_EMAIL, { domainChecked: () => Response.json({ onboarded: false }), testSent: () => Response.json({ error: refusal }, { status: 502 }) });
    const { user, onFailed } = await cloudflareFrom();
    await user.type(fromField(), "ember@example.org");
    await noted("example.org isn't onboarded to Cloudflare Email Sending yet, as its DNS doesn't have the records Onboard Domain adds.");
    expect(domainNote()).toHaveClass("text-negative");
    const dashboard = within(domainNote()).getByRole("link", { name: "Open Email Sending in the Cloudflare dashboard" });
    expect(dashboard).toHaveAttribute("href", EMAIL_SENDING_DASHBOARD);
    expect(button("Continue")).toBeEnabled();

    await user.click(button("Continue"));
    await dialog("Send a test email");
    expect(await screen.findByText(refusal)).toHaveClass("text-negative");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says when it couldn't look the domain up, leaving it to the test email, and checks each domain once", async () => {
    serve(NEW_EMAIL, { domainChecked: () => Response.json({ onboarded: null }) });
    const { user } = await cloudflareFrom();
    await user.type(fromField(), "ember@example.net");
    await noted("Ember couldn't look up example.net just now. The test email will say whether Cloudflare sends from it.");
    expect(domainNote()).not.toHaveClass("text-positive", "text-negative");

    // A From address that isn't one says only that.
    await user.clear(fromField());
    await user.type(fromField(), "Ember{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(EMAIL_FROM_REFUSED);
    expect(domainNote()).toBeEmptyDOMElement();
    await user.clear(fromField());
    await user.type(fromField(), "chat@example.net");
    await noted("Ember couldn't look up example.net just now.");
    expect(asked()).toEqual([["POST /api/account/sending_domain_checks", { domain: "example.net" }]]);
  });

  it("checks a domain once while its check is out too, as others are typed and answered", async () => {
    const org = held(() => Response.json({ onboarded: false }));
    const com = held(() => Response.json({ onboarded: true }));
    let checks = 0;
    // The first check is example.org's, and any after it example.com's.
    serve(NEW_EMAIL, { domainChecked: () => (++checks === 1 ? org : com).answered() });
    const { user } = await cloudflareFrom();
    const typeFrom = async (from: string) => {
      await user.clear(fromField());
      await user.type(fromField(), from);
    };
    await typeFrom("ember@example.org");
    await noted("Checking that example.org is onboarded to Cloudflare Email Sending…");
    await typeFrom("ember@example.com");
    await noted("Checking that example.com is onboarded to Cloudflare Email Sending…");
    // Back to a domain it's checking, it says so at once.
    await typeFrom("ember@example.org");
    expect(domainNote()).toHaveTextContent("Checking that example.org is onboarded to Cloudflare Email Sending…");
    await typeFrom("ember@example.com");
    expect(domainNote()).toHaveTextContent("Checking that example.com is onboarded to Cloudflare Email Sending…");

    // Example.org's answer comes first, and example.com's check, still out, isn't asked again, however long it takes.
    await org.answer();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await com.answer();
    await noted("example.com is onboarded to Cloudflare Email Sending.");
    await typeFrom("ember@example.org");
    expect(domainNote()).toHaveTextContent("example.org isn't onboarded to Cloudflare Email Sending yet");
    expect(asked()).toEqual([
      ["POST /api/account/sending_domain_checks", { domain: "example.org" }],
      ["POST /api/account/sending_domain_checks", { domain: "example.com" }],
    ]);
  });

  it("closes with Escape, saying whether Ember can send email then", async () => {
    const email: Email = { provider: "cloudflare", resendKey: null, cloudflare: true, from: "chat@example.com" };
    serve(email);
    const { user, onClose } = showSetup(email);
    await dialog("Set up email");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });
});
