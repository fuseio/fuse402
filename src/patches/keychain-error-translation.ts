// Tempo MPP error-translation patch.
//
// Background: when mppx verifies a `tempo/charge` credential, it submits the
// client-signed TempoTransaction to Tempo's node via
// `eth_sendRawTransactionSync`. If the chain accepts the transaction, the
// payment is valid; if it rejects, mppx returns a generic 402
// `paymentauth.org/problems/verification-failed` to the client.
//
// One specific failure mode is high-volume and undiagnosable from the
// generic response: a client's access key is recognised cloud-side by the
// tempo-wallet service (so `tempo wallet whoami` returns ready=true with a
// spending limit) but isn't authorised in the Account Keychain precompile
// (deployed at 0xAAAAAAAA00000000000000000000000000000000) for that wallet.
// When a TempoTransaction signed with a Keychain-variant signature reaches
// the protocol, it extracts the access key's keyId, looks it up in the
// precompile, and rejects with:
//
//   keychain validation failed: AccountKeychainError(KeyNotFound(KeyNotFound))
//
// The recoverable cause is that the wallet's root key (typically a passkey)
// never produced a valid `key_authorization` for this access key — either
// the inline KeyAuthorization on the failing transaction didn't carry a
// valid root-key signature, or an out-of-band `wallet_authorizeAccessKey`
// call was expected and skipped. mppx logs the underlying error internally
// but only surfaces the generic verification-failed problem. Clients can't
// distinguish "wrong amount" / "expired challenge" / "bad signature" /
// "access key not authorised on-chain" — every cause flattens to the same
// 402, and the one recoverable case (re-run `tempo wallet login`, complete
// the passkey authorisation prompt) gets lost in the noise.
//
// Strategy: install a fetch wrapper that watches POSTs to Tempo's RPC for
// `eth_sendRawTransactionSync` calls. When the response carries the
// `AccountKeychainError(KeyNotFound)` signal, stash the detection in an
// AsyncLocalStorage frame the dual-pay middleware reads after mppx's
// `compose()` returns. The middleware then overrides the 402 problem
// body with a vendor-specific problem type that tells the client what to
// do. Every other failure mode is untouched and continues to surface as
// the existing generic verification-failed.
//
// This patch is purely additive: it never lets payments through that
// mppx would have rejected, never alters request bodies, and degrades
// to a no-op if mppx ever changes its verification path away from
// `eth_sendRawTransactionSync`. The middleware override only fires when
// the ALS flag is set, so absent that detection the existing response
// flows unchanged.
//
// Idempotent: calling applyKeychainErrorTranslationPatch() more than once
// is a no-op. Important for hot-reloading dev environments.
//
// References:
//   - Account Keychain spec:
//     https://docs.tempo.xyz/protocol/transactions/AccountKeychain
//   - Access key authorisation guide:
//     https://docs.tempo.xyz/guide/use-accounts/authorize-access-keys
//   - TempoTransaction (type 0x76) spec:
//     https://docs.tempo.xyz/protocol/transactions/spec-tempo-transaction

import { AsyncLocalStorage } from "node:async_hooks";

export interface KeychainErrorStore {
  detected: boolean;
  details?: string;
}

export const keychainErrorAls = new AsyncLocalStorage<KeychainErrorStore>();

let patched = false;

/**
 * Cheap pre-check that a URL looks like a Tempo JSON-RPC endpoint. Matches
 * the canonical hostnames the wallet and the deployment both target
 * (`rpc.tempo.xyz`, `rpc.mainnet.tempo.xyz`, etc.). Parses the URL so a
 * suffix-lookalike hostname (e.g. `rpc.tempo.xyz.evil.example`) can't
 * masquerade as a Tempo RPC and trigger error translation against a body
 * an attacker controls.
 */
function isTempoRpcUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Accept apex tempo.xyz and any subdomain that starts with `rpc.` and
  // ends at `tempo.xyz`. The first label must be exactly `rpc`, not
  // `rpc-something`, to avoid the same suffix-lookalike concern.
  if (host === "rpc.tempo.xyz") return true;
  if (host.endsWith(".tempo.xyz") && host.startsWith("rpc.")) return true;
  return false;
}

/**
 * Returns true if the response body carries Tempo's enshrined keychain
 * "key not registered" signal. We match on substring rather than parsed
 * JSON to be robust to whitespace / RPC framing changes; the strings are
 * specific enough that false positives are vanishingly unlikely.
 */
function isKeychainKeyNotFound(body: string): boolean {
  return body.includes("AccountKeychainError") && body.includes("KeyNotFound");
}

export function applyKeychainErrorTranslationPatch() {
  if (patched) return;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error(
      "[keychain-error-translation-patch] globalThis.fetch is not a function. " +
        "Are you running on Node.js 18+ or a runtime with a fetch polyfill?",
    );
  }

  globalThis.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch.call(this, input, init);

    // Bail on anything that isn't a Tempo RPC call. This keeps the
    // response-clone+read off the hot path for every CDP/blockscout/defillama
    // round-trip the server makes.
    const urlStr =
      typeof input === "string"
        ? input
        : (input && typeof input === "object" && (input as { url?: string }).url) ||
          String(input);
    if (!isTempoRpcUrl(urlStr)) return response;

    const method = (
      (init && init.method) ||
      (input && (input as { method?: string }).method) ||
      "GET"
    ).toUpperCase();
    if (method !== "POST") return response;

    // Confirm this is an eth_sendRawTransactionSync — Tempo RPC sees many
    // method calls during verification (eth_estimateGas, eth_chainId, etc.)
    // and only the broadcast carries the keychain validation.
    if (init && init.body) {
      let isSendRawTx = false;
      try {
        const bodyStr =
          typeof init.body === "string"
            ? init.body
            : Buffer.isBuffer(init.body)
              ? init.body.toString("utf8")
              : null;
        if (bodyStr) {
          isSendRawTx = bodyStr.includes("eth_sendRawTransactionSync");
        }
      } catch {
        // Streaming/unreadable body — skip.
      }
      if (!isSendRawTx) return response;
    } else {
      return response;
    }

    // Clone before reading: the caller (mppx, via viem) needs the original
    // response body intact.
    const store = keychainErrorAls.getStore();
    if (!store) return response;
    try {
      const text = await response.clone().text();
      if (isKeychainKeyNotFound(text)) {
        store.detected = true;
        try {
          const parsed = JSON.parse(text);
          const errMsg = parsed?.error?.message;
          if (typeof errMsg === "string") {
            store.details = errMsg;
          }
        } catch {
          // Best-effort: detection still flagged even without parsed details.
        }
      }
    } catch (err) {
      console.warn(
        "[keychain-error-translation-patch] failed to inspect Tempo RPC response " +
          "from " +
          urlStr +
          " — falling back to generic verification-failed response. error: " +
          (err as Error).message,
      );
    }

    return response;
  };

  patched = true;
  console.log(
    "[keychain-error-translation-patch] applied — Tempo RPC AccountKeychainError " +
      "responses will be surfaced to clients as actionable problem details",
  );
}
