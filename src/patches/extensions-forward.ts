// Workaround for an upstream bug in @x402/core@2.11.0 that drops
// declaredExtensions from the verify and settle request bodies sent to the
// CDP facilitator. Without this patch, CDP receives no bazaar metadata at
// verify/settle time, the EXTENSION-RESPONSES header is never returned,
// and the resource is never indexed in CDP Bazaar.
//
// Bug locations in the published @x402/core@2.11.0 tarball:
//   src/server/x402ResourceServer.ts:984
//     verifyResult = await facilitatorClient.verify(paymentPayload, requirements);
//   src/server/x402ResourceServer.ts:1192
//     settleResult = await facilitatorClient.settle(paymentPayload, effectiveRequirements);
// Both call sites drop the third argument. HTTPFacilitatorClient in turn
// only accepts (paymentPayload, paymentRequirements) and serializes the
// body as { x402Version, paymentPayload, paymentRequirements }.
//
// Strategy: AsyncLocalStorage threads declaredExtensions through the
// async call chain from x402ResourceServer.verifyPayment/settlePayment
// down to fetch(). A narrow fetch wrapper intercepts the POST bodies for
// /verify and /settle and adds a top-level "extensions" field. Every
// other fetch passes through unchanged.
//
// Top-level placement of "extensions": the 402 challenge already places
// extensions at the top level of the PaymentRequired response (sibling of
// `accepts`). The verify/settle request is the inverse direction of the
// same handshake, so placing extensions at the top level (sibling of
// paymentPayload and paymentRequirements) is the most natural shape for
// CDP to accept. paymentPayload.extensions is NOT mutated — that field
// belongs to the client.
//
// Idempotent: calling applyExtensionsForwardPatch() more than once is a
// no-op. Important for hot-reloading dev environments and the case where
// multiple modules independently require this patch.
//
// TODO(remove): drop this file once @x402/core lands the upstream fix and
// we bump past 2.11.0.

import { AsyncLocalStorage } from "node:async_hooks";

import { x402ResourceServer } from "@x402/core/server";

interface ExtensionsStore {
  extensions: Record<string, unknown>;
}

const als = new AsyncLocalStorage<ExtensionsStore>();
let patched = false;

type PatchableProto = {
  verifyPayment?: (...args: unknown[]) => Promise<unknown>;
  settlePayment?: (...args: unknown[]) => Promise<unknown>;
};

export function applyExtensionsForwardPatch() {
  if (patched) return;

  const ctor = x402ResourceServer as unknown as
    | { prototype: PatchableProto }
    | undefined;
  if (!ctor || !ctor.prototype) {
    throw new Error(
      "[x402-extensions-forward-patch] @x402/core/server did not export " +
        "x402ResourceServer with a prototype. Has the package layout changed?",
    );
  }
  const proto = ctor.prototype;
  if (
    typeof proto.verifyPayment !== "function" ||
    typeof proto.settlePayment !== "function"
  ) {
    throw new Error(
      "[x402-extensions-forward-patch] verifyPayment/settlePayment missing on prototype",
    );
  }

  const origVerify = proto.verifyPayment;
  proto.verifyPayment = function patchedVerifyPayment(
    this: unknown,
    ...args: unknown[]
  ) {
    const declaredExtensions = args[2] as Record<string, unknown> | undefined;
    const store: ExtensionsStore = { extensions: declaredExtensions || {} };
    return als.run(store, () => origVerify.call(this, ...args));
  };

  const origSettle = proto.settlePayment;
  proto.settlePayment = function patchedSettlePayment(
    this: unknown,
    ...args: unknown[]
  ) {
    const declaredExtensions = args[2] as Record<string, unknown> | undefined;
    const store: ExtensionsStore = { extensions: declaredExtensions || {} };
    return als.run(store, () => origSettle.call(this, ...args));
  };

  // Wrap globalThis.fetch. The check is narrow: only CDP verify/settle
  // POSTs with a JSON body, only when the ALS store has non-empty
  // extensions and the body has no extensions field yet. Any failure
  // leaves the request untouched — diagnostic patches must never be
  // load-bearing for request success.
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== "function") {
    throw new Error(
      "[x402-extensions-forward-patch] globalThis.fetch is not a function. " +
        "Are you running on Node.js 18+ or a runtime with a fetch polyfill?",
    );
  }

  globalThis.fetch = async function patchedFetch(input, init) {
    const urlStr =
      typeof input === "string"
        ? input
        : (input && typeof input === "object" && (input as { url?: string }).url) ||
          String(input);
    const method = (
      (init && init.method) ||
      (input && (input as { method?: string }).method) ||
      "GET"
    ).toUpperCase();
    const isCdpVerifyOrSettle =
      typeof urlStr === "string" &&
      urlStr.includes("api.cdp.coinbase.com") &&
      (urlStr.endsWith("/verify") || urlStr.endsWith("/settle"));

    if (isCdpVerifyOrSettle && method === "POST" && init && init.body) {
      const ctx = als.getStore();
      const extensions = ctx && ctx.extensions;
      if (
        extensions &&
        typeof extensions === "object" &&
        Object.keys(extensions).length > 0
      ) {
        try {
          const bodyStr =
            typeof init.body === "string"
              ? init.body
              : Buffer.isBuffer(init.body)
                ? init.body.toString("utf8")
                : null;
          if (bodyStr !== null) {
            const parsed = JSON.parse(bodyStr);
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed) &&
              parsed.extensions === undefined
            ) {
              parsed.extensions = extensions;
              init = { ...init, body: JSON.stringify(parsed) };
            }
          }
        } catch (err) {
          console.warn(
            "[x402-extensions-forward-patch] failed to inject extensions into " +
              urlStr +
              " — request will be sent unmodified. error: " +
              (err as Error).message,
          );
        }
      }
    }

    return origFetch.call(this, input, init);
  };

  patched = true;
  console.log(
    "[x402-extensions-forward-patch] applied — declaredExtensions will now " +
      "be injected into CDP /verify and /settle request bodies",
  );
}
