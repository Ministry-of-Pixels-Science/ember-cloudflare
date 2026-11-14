import { useCallback, useEffect, useRef, useState } from "react";
import { EMAIL_SIGN_UP_PATH, INVITATION_PATH, NAVIGATION_SLOTS, PASSWORD_RESET_PATH, SIGN_UP_PATH, TRANSFER_PATH, type Account, type Bootstrap, type Me, type NewWorkspace } from "@ember/protocol";
import { OUTSIDE_AUTHORIZE_PATH } from "@ember/protocol/outside";
import { FlashProvider } from "@/components/flash";
import { EmailSignUpPage } from "@/components/email-sign-up-page";
import { InvitationPage } from "@/components/invitation-page";
import { JoinPage } from "@/components/join-page";
import { OutsideConnectPage } from "@/components/outside-connect-page";
import { PasswordResetPage } from "@/components/password-reset-page";
import { SetupPage } from "@/components/setup-page";
import { SignInPage } from "@/components/sign-in-page";
import { TransferPage } from "@/components/transfer-page";
import { Workspace, loadPageAhead } from "@/components/workspace/workspace";
import { AccountContext } from "@/hooks/use-account";
import { useAccountLogo } from "@/hooks/use-account-logo";
import { useCustomStyles } from "@/hooks/use-custom-styles";
import { PushProvider } from "@/hooks/use-push";
import { openRoomSocketAhead } from "@/hooks/use-room";
import { joinCodeFromPath, navigate, useIsAt, useJoinRoute } from "@/hooks/use-route";
import { useSelectOnEntry } from "@/hooks/use-select-on-entry";
import { dropWorkspacePreloads, fetchBootstrap, forgetStoredSession, signOut } from "@/lib/api";
import { followAppearance } from "@/lib/appearance";
import { moveTo, movesTo } from "@/lib/custom-domain";
import { replaceInstallPromptsFor } from "@/lib/install-prompt";
import { loadPage } from "@/lib/page";
import { unsubscribeFromPush } from "@/lib/push";
import { forgetReturnPath, rememberThisPage, takeReturnPath } from "@/lib/return-path";

const MAX_RETRY_MS = 15_000;
/** Where the Set up Ember page is. */
const SETUP_PATH = "/first_run";
/** Where the sign-in page is. */
const SIGN_IN_PATH = "/session/new";

const isSameAccount = (a: Account, b: Account) =>
  a.name === b.name &&
  a.tagline === b.tagline &&
  a.hideTranslationButtons === b.hideTranslationButtons &&
  a.customStyles === b.customStyles &&
  a.restrictRoomCreation === b.restrictRoomCreation &&
  a.logo === b.logo &&
  a.customDomain === b.customDomain &&
  a.joinLink === b.joinLink &&
  a.openSignUp === b.openSignUp &&
  a.memberfulJoin === b.memberfulJoin &&
  a.memberfulSignIn === b.memberfulSignIn &&
  a.emailDomainSignUp === b.emailDomainSignUp &&
  a.emailDomains.length === b.emailDomains.length &&
  a.emailDomains.every((domain, index) => domain === b.emailDomains[index]) &&
  NAVIGATION_SLOTS.every((slot) => a.navigationIcons[slot] === b.navigationIcons[slot]) &&
  a.huddles === b.huddles;

export function App() {
  // Undefined until the server says whether Ember is set up.
  const [workspace, setWorkspace] = useState<Omit<Bootstrap, "user">>();
  const [me, setMe] = useState<Me | null>(null);
  // The sign-in page opens even for someone who's signed in, and so does resetting a password.
  const atSignIn = useIsAt(SIGN_IN_PATH);
  const atPasswordReset = useIsAt(PASSWORD_RESET_PATH);
  const joinCode = useJoinRoute();
  const atSignUp = useIsAt(SIGN_UP_PATH);
  const atInvitation = useIsAt(INVITATION_PATH);
  const atEmailSignUp = useIsAt(EMAIL_SIGN_UP_PATH);
  const atTransfer = useIsAt(TRANSFER_PATH);
  const atOutsideConnect = useIsAt(OUTSIDE_AUTHORIZE_PATH);
  const signingOut = useRef(false);
  // Before any page has fields, so even one focused as it opens is selected.
  useSelectOnEntry();

  // Every page keeps up with the device and other tabs, rail or not.
  useEffect(() => followAppearance(), []);
  // And has the workspace's custom CSS and logo, once they're known, which is before any page shows.
  useCustomStyles(workspace?.account.customStyles ?? "", me?.administrator === true);
  useAccountLogo(workspace?.account.logo ?? null);

  useEffect(() => {
    forgetStoredSession();
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let letGoOfRoom = () => {};
    const ask = (attempt: number) =>
      fetchBootstrap().then(
        ({ user, ...workspace }) => {
          if (stopped) return;
          // A page opened at any address but Ember's custom domain moves there before anything shows.
          const { customDomain } = workspace.account;
          if (movesTo(customDomain)) return void moveTo(customDomain);
          replaceInstallPromptsFor(workspace.platform);
          const atSetup = location.pathname === SETUP_PATH;
          // Until Ember is set up, every page is setup's, which says what it takes where it isn't open.
          if (workspace.setup === "pending" && !atSetup) return loadPage(SETUP_PATH);
          if (workspace.setup === "complete" && atSetup) history.replaceState(history.state, "", "/");
          // The join page is for someone signed out, and sends anyone else home, as do open sign-up's, an
          // invitation's and Email domain's, whose links' secrets leave the address as they go.
          const { pathname } = location;
          const atJoin = joinCodeFromPath(pathname) !== null || pathname === SIGN_UP_PATH || pathname === INVITATION_PATH || pathname === EMAIL_SIGN_UP_PATH;
          if (user && atJoin) navigate("/", { replace: true });
          const signingIn = pathname === SIGN_IN_PATH || pathname === PASSWORD_RESET_PATH;
          // Someone signed out goes to sign in, and comes back here afterwards. A sign-in link signs them in itself.
          if (workspace.setup === "complete" && !user && !signingIn && !atJoin && location.pathname !== TRANSFER_PATH) {
            // What the page preloaded with the session that has ended is no use once they've signed in.
            dropWorkspacePreloads();
            rememberThisPage();
            navigate(SIGN_IN_PATH, { replace: true });
          }
          // Someone signed in has come back already, as signing in with Memberful opens that page itself.
          if (user && !signingIn && location.pathname !== TRANSFER_PATH) forgetReturnPath();
          // The room the page shows connects now, while the workspace loads, rather than once it shows.
          if (user && workspace.setup === "complete") letGoOfRoom = openRoomSocketAhead(location.pathname);
          setMe(user);
          setWorkspace(workspace);
        },
        () => {
          // Being offline, say, tells us nothing about the session, so ask again.
          if (!stopped) retry = setTimeout(() => void ask(attempt + 1), Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt));
        },
      );
    // A page few visits need loads while Ember says who's signed in, rather than once the workspace shows.
    void loadPageAhead(location.pathname);
    void ask(0);
    return () => {
      stopped = true;
      clearTimeout(retry);
      letGoOfRoom();
    };
  }, []);

  const signedIn = useCallback((user: Me) => {
    if (location.pathname === SIGN_IN_PATH) navigate(takeReturnPath() ?? "/", { replace: true });
    setMe(user);
  }, []);
  // The session ended, or another tab signed this browser in as someone else. Signing in again starts
  // afresh, and comes back to this page.
  const sessionChanged = useCallback((user: Me | null) => {
    if (user) return setMe(user);
    // Signing out here goes to sign in itself, whether the rooms close their sockets before or after
    // it's answered.
    if (signingOut.current) return;
    rememberThisPage();
    loadPage(SIGN_IN_PATH);
  }, []);
  // A sign-out that doesn't reach the server leaves this browser signed in; one that does goes to sign
  // in, from where signing in again goes home. It settles with whether it did. First, the browser stops
  // taking pushes, whether or not signing out goes on to work.
  const signOutHere = useCallback(() => {
    signingOut.current = true;
    return unsubscribeFromPush().then(signOut).then(
      () => {
        forgetReturnPath();
        loadPage(SIGN_IN_PATH);
        return true;
      },
      () => {
        signingOut.current = false;
        return false;
      },
    );
  }, []);
  // Someone who joins goes home, signed in.
  const joined = useCallback((user: Me) => {
    navigate("/", { replace: true });
    setMe(user);
  }, []);
  const setUp = useCallback(({ user }: NewWorkspace) => {
    setMe(user);
    setWorkspace((workspace) => workspace && { ...workspace, setup: "complete" });
  }, []);
  // Every page shows the workspace as its settings last loaded or saved it, or the workspace socket last
  // said it is, which it says again each time it connects.
  const accountChanged = useCallback(
    (account: Account) => setWorkspace((workspace) => workspace && (isSameAccount(workspace.account, account) ? workspace : { ...workspace, account })),
    [],
  );

  // Not flashing yet, so a flash the last page left shows on this one once it's known.
  if (workspace === undefined) return <main aria-busy="true" className="min-h-dvh bg-surface" />;
  // A sign-in link signs in whoever opens it, even someone signed in as someone else.
  const showsWorkspace = workspace.setup === "complete" && me !== null && !atSignIn && !atPasswordReset && !atTransfer && !atOutsideConnect;
  const page = () => {
    if (workspace.setup === "pending") return <SetupPage placeholders={workspace.setupPlaceholders} access={workspace.setupAccess} onSetUp={setUp} />;
    if (atTransfer) return <TransferPage />;
    // An AI app's request to connect is answered on a page of its own, by someone signed in: anyone else signs in first, and comes back to it.
    if (atOutsideConnect && me !== null) return <OutsideConnectPage me={me} workspace={workspace} />;
    // Someone else's workspace starts afresh, with their own rooms and sockets.
    if (showsWorkspace)
      return (
        <PushProvider key={me.id} vapidPublicKey={workspace.vapidPublicKey} platform={workspace.platform}>
          <Workspace
            me={me}
            workspaceName={workspace.account.name}
            onAccountChanged={accountChanged}
            onSignOut={signOutHere}
            onSessionChanged={sessionChanged}
          />
        </PushProvider>
      );
    if (atInvitation) return <InvitationPage workspace={workspace} onJoined={joined} />;
    if (atEmailSignUp) return <EmailSignUpPage workspace={workspace} onJoined={joined} />;
    if (joinCode !== null || atSignUp) return <JoinPage workspace={workspace} joinCode={joinCode} onJoined={joined} />;
    if (atPasswordReset) return <PasswordResetPage workspace={workspace} />;
    return <SignInPage workspace={workspace} onSignedIn={signedIn} />;
  };
  // Keyed by who's signed in, so whoever signs in, or in another tab, doesn't see the last page's flash.
  return (
    <AccountContext value={workspace.account}>
      <FlashProvider key={showsWorkspace ? me.id : "signed out"} workspace={showsWorkspace}>
        {page()}
      </FlashProvider>
    </AccountContext>
  );
}
