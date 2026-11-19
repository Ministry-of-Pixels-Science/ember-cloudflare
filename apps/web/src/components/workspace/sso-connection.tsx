import { connectSso, disconnectSso } from "@/lib/api";
import { ExternalConnection, type ConnectionProps } from "./external-connection";

// The Single sign-on section of your profile (`ExternalConnection`): while single sign-on is the only
// way in, someone with an account from before connects their account at the provider to it, and signs
// in with the provider from then on.

/** Where `connectSso` says to sign in at the provider. */
const connect = async (currentPassword?: string) => (await connectSso(currentPassword)).ssoConnection;

interface Props extends ConnectionProps {
  /** What the sign-in page calls the provider. */
  name: string;
  /** Whether single sign-on is the only way in, unless you need no account at the provider. */
  ssoOnly: boolean;
}

/** The account at the single sign-on provider you've connected, with Disconnect, or Connect, both named for the provider. */
export function SingleSignOnConnection({ name, ssoOnly, ...props }: Props) {
  return <ExternalConnection id="sso" title="Single sign-on" name={name} only={ssoOnly} connect={connect} disconnect={disconnectSso} {...props} />;
}
