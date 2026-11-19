import { connectMemberful, disconnectMemberful } from "@/lib/api";
import { ExternalConnection, type ConnectionProps } from "./external-connection";

// The Memberful section of your profile (`ExternalConnection`): while Memberful is members only, someone
// with an account from before connects their Memberful account to it, and signs in with Memberful from
// then on.

/** Where `connectMemberful` says to sign in at the Memberful site. */
const connect = async (currentPassword?: string) => (await connectMemberful(currentPassword)).memberfulConnection;

/** The Memberful account you've connected, with Disconnect Memberful, or Connect Memberful. */
export function MemberfulConnection({ membersOnly, ...props }: ConnectionProps & { membersOnly: boolean }) {
  return <ExternalConnection id="memberful" title="Memberful" name="Memberful" only={membersOnly} connect={connect} disconnect={disconnectMemberful} {...props} />;
}
