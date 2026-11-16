import { createContext, useContext } from "react";
import type { Account } from "@ember/protocol";

/**
 * The workspace as every page shows it: as the app loaded it, or as the workspace socket or a change
 * made here last said it is. Until it's known, it's as a workspace is before first run.
 */
export const AccountContext = createContext<Account>({ name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true });

export const useAccount = () => useContext(AccountContext);

/**
 * Whether people may turn their camera on in a huddle: they may unless the workspace says not, and one
 * that an older Worker tells of, as while Ember updates, says nothing of cameras.
 */
export const useCamerasAllowed = () => useAccount().huddleCameras !== false;

/** Whether people may share their screen in a huddle, which they may unless the workspace says not, as with their cameras. */
export const useScreensAllowed = () => useAccount().huddleScreens !== false;
