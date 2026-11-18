import { toBase64url, urlsafeDecode64 } from "./encoding";

// Secrets an administrator gives Ember to keep, a Resend API key, a Turnstile widget's secret key, the
// Cloudflare API token Ember AI asks AI Gateway with, the secret of the Realtime SFU app huddles run
// through, the API token of the TURN key their relay goes by, the token a connected app takes and the
// secrets of a Memberful site's custom app and webhook, which the database holds sealed under
// SESSION_SECRET, so that a copy of the database alone doesn't give them away: AES-GCM, under a 256-bit
// key HKDF derives from SESSION_SECRET for what the secret is kept for, with a random nonce each time.
// Sealed, a secret is `v1.`, then its nonce and ciphertext in URL-safe Base64, apart by a dot. One sealed
// under another SESSION_SECRET, or for something else, doesn't open.

/** What a secret is kept for, whose key is derived for it alone. */
export type SealedSecret = "resend-api-key" | "turnstile-secret-key" | "ai-gateway-token" | "sfu-app-secret" | "turn-key-api-token" | "app-token" | "app-sign-in" | "memberful-secrets";

const VERSION = "v1";
/** AES-GCM's nonce, 96 bits, as it's recommended. */
const NONCE_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The key derived last for each purpose, and what from, so that sending many emails derives it once. */
const derived = new Map<SealedSecret, { secret: string; key: Promise<CryptoKey> }>();

/** The AES-GCM key `secret` gives for keeping `purpose`'s secrets. A derivation that fails is tried again next time. */
function keyFor(secret: string, purpose: SealedSecret): Promise<CryptoKey> {
  let known = derived.get(purpose);
  if (known?.secret !== secret) {
    const key = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: encoder.encode("ember sealed secrets"), info: encoder.encode(purpose) },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    key.catch(() => {
      if (derived.get(purpose)?.key === key) derived.delete(purpose);
    });
    known = { secret, key };
    derived.set(purpose, known);
  }
  return known.key;
}

/** `plaintext`, kept for `purpose`, sealed under `secret`. */
export async function seal(secret: string, purpose: SealedSecret, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await keyFor(secret, purpose), encoder.encode(plaintext));
  return `${VERSION}.${toBase64url(nonce)}.${toBase64url(new Uint8Array(ciphertext))}`;
}

/** What `sealed` holds, if `seal` sealed it under `secret` for `purpose`, or else null. */
export async function unseal(secret: string, purpose: SealedSecret, sealed: string): Promise<string | null> {
  const [version, nonceText, ciphertextText, ...rest] = sealed.split(".");
  const nonce = nonceText === undefined ? null : urlsafeDecode64(nonceText);
  const ciphertext = ciphertextText === undefined ? null : urlsafeDecode64(ciphertextText);
  if (version !== VERSION || rest.length > 0 || nonce?.length !== NONCE_BYTES || !ciphertext) return null;
  try {
    return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await keyFor(secret, purpose), ciphertext));
  } catch {
    return null;
  }
}
