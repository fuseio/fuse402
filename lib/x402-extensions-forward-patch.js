"use strict";

// Workaround for an upstream bug in @x402/core@2.11.0 (latest published as of
// 2026-04-27) that drops declaredExtensions from the verify and settle request
// bodies sent to the CDP facilitator. Without this patch, CDP receives no
// bazaar metadata at verify/settle time, the EXTENSION-RESPONSES header is
// never returned (because there is nothing to respond about), and the
// resource is never indexed in CDP Bazaar — which is exactly the failure
// mode this service has been hitting.
//
// Bug locations in the published @x402/core@2.11.0 tarball:
//
//   src/server/x402ResourceServer.ts:984
//     verifyResult = await facilitatorClient.verify(paymentPayload, requirements);
//   src/server/x402ResourceServer.ts:1192
//     settleResult = await facilitatorClient.settle(paymentPayload, effectiveRequirements);
//
// Both call sites pass only two arguments. The third argument
// (declaredExtensions) sits on the local context but never reaches the
// facilitator client. And HTTPFacilitatorClient.verify / .settle in turn
// only accept (paymentPayload, paymentRequirements) and serialize the body
// as { x402Version, paymentPayload, paymentRequirements } — so even if a
// caller wanted to forward extensions, there is no parameter slot for them.
//
// Upstream is aware of EXTENSION-RESPONSES (httpFacilitatorClient.ts:168-192
// has logExtensionResponsesHeader() that decodes the base64 header and logs
// allowlisted fields like status / rejectedReason / reason / code), but the
// receiving side is dead code today because nothing ever sends extensions
// in the request. The recent changeset .changeset/log-bazaar-extension-
// responses.md confirms this is a half-shipped feature.
//
// Strategy: AsyncLocalStorage threads declaredExtensions through the async
// call chain from x402ResourceServer.verifyPayment / settlePayment all the
// way down to the fetch() call. A narrow fetch wrapper intercepts the POST
// bodies destined for api.cdp.coinbase.com/.../verify and /settle and adds
// a top-level "extensions" field. Every other fetch passes through unchanged.
//
// AsyncLocalStorage was chosen over instance-level stashing on the
// facilitator client (e.g. client.__pendingExtensions = ...) because Node
// processes multiple HTTP requests concurrently between awaits; an
// instance-level field would race across in-flight requests. ALS provides
// per-request context that is concurrency-safe by design.
//
// Why top-level placement of "extensions": the 402 challenge already places
// extensions at the top level of the PaymentRequired response (sibling of
// `accepts`). The verify/settle request is the inverse direction of the same
// handshake, so placing extensions at the top level (sibling of paymentPayload
// and paymentRequirements) is the most natural shape for CDP to accept.
// We deliberately do NOT mutate paymentPayload.extensions — that field
// belongs to the client and means something different (per-payment extension
// data signed by the payer).
//
// The patch is idempotent: calling applyExtensionsForwardPatch() more than
// once is a no-op. This matters for hot-reloading dev environments and for
// the case where multiple modules independently require this patch.
//
// TODO(remove): drop this file once x402-foundation/x402 lands
// https://github.com/x402-foundation/x402/issues (file an issue) — the
// sending side of EXTENSION-RESPONSES — and we bump @x402/core past 2.11.0.

const { AsyncLocalStorage } = require("node:async_hooks");

const _als = new AsyncLocalStorage();
let _patched = false;

/**
 * Apply the extensions-forwarding patch.
 *
 * Idempotent. Must be called before any HTTP request is processed by the
 * x402 middleware. Safe to call before x402 imports happen elsewhere in
 * the program; the patch resolves @x402/core/server itself and patches
 * its prototype, so any subsequently-constructed x402ResourceServer will
 * pick up the patched methods automatically.
 */
function applyExtensionsForwardPatch() {
  if (_patched) return;

  let resourceServerCtor;
  try {
    ({ x402ResourceServer: resourceServerCtor } = require("@x402/core/server"));
  } catch (err) {
    throw new Error(
      "[x402-extensions-forward-patch] Could not load @x402/core/server. " +
        "Is @x402/core installed? Original error: " +
        (err && err.message ? err.message : String(err))
    );
  }

  if (!resourceServerCtor || !resourceServerCtor.prototype) {
    throw new Error(
      "[x402-extensions-forward-patch] @x402/core/server did not export " +
        "x402ResourceServer with a prototype. Has the package layout changed? " +
        "Inspect the installed @x402/core version before reapplying this patch."
    );
  }

  const proto = resourceServerCtor.prototype;

  if (typeof proto.verifyPayment !== "function" || typeof proto.settlePayment !== "function") {
    throw new Error(
      "[x402-extensions-forward-patch] x402ResourceServer.prototype is missing " +
        "verifyPayment or settlePayment. Has the API changed in this @x402/core version?"
    );
  }

  // Save originals so we can re-enter them with the same args; the only thing
  // we add is an ALS frame that carries declaredExtensions down to the fetch
  // layer. The originals' control flow (hooks, retries, error handling) is
  // unchanged.
  const _origVerifyPayment = proto.verifyPayment;
  proto.verifyPayment = function patchedVerifyPayment(
    paymentPayload,
    requirements,
    declaredExtensions,
    transportContext
  ) {
    const store = { extensions: declaredExtensions || {} };
    return _als.run(store, () =>
      _origVerifyPayment.call(this, paymentPayload, requirements, declaredExtensions, transportContext)
    );
  };

  const _origSettlePayment = proto.settlePayment;
  proto.settlePayment = function patchedSettlePayment(
    paymentPayload,
    requirements,
    declaredExtensions,
    transportContext,
    settlementOverrides
  ) {
    const store = { extensions: declaredExtensions || {} };
    return _als.run(store, () =>
      _origSettlePayment.call(
        this,
        paymentPayload,
        requirements,
        declaredExtensions,
        transportContext,
        settlementOverrides
      )
    );
  };

  // Wrap globalThis.fetch. The check is intentionally narrow:
  //
  //   - host must contain "api.cdp.coinbase.com"
  //   - path must end with "/verify" or "/settle"
  //   - method must be POST (case-insensitive)
  //   - body must be a JSON-parseable string or Buffer
  //   - the parsed body must not already have an "extensions" field
  //   - the ALS store must have non-empty extensions
  //
  // Any failure of these conditions leaves the request untouched. We never
  // throw from the wrapper for parsing/serialization issues — diagnostic
  // patches must never be load-bearing for request success.
  const _origFetch = globalThis.fetch;
  if (typeof _origFetch !== "function") {
    throw new Error(
      "[x402-extensions-forward-patch] globalThis.fetch is not a function. " +
        "Are you running on Node.js 18+ or a runtime with a fetch polyfill?"
    );
  }

  globalThis.fetch = async function patchedFetch(input, init) {
    const urlStr =
      typeof input === "string"
        ? input
        : (input && typeof input === "object" && input.url) || String(input);
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const isCdpVerifyOrSettle =
      typeof urlStr === "string" &&
      urlStr.includes("api.cdp.coinbase.com") &&
      (urlStr.endsWith("/verify") || urlStr.endsWith("/settle"));

    if (isCdpVerifyOrSettle && method === "POST" && init && init.body) {
      const ctx = _als.getStore();
      const extensions = ctx && ctx.extensions;
      if (extensions && typeof extensions === "object" && Object.keys(extensions).length > 0) {
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
              const newBody = JSON.stringify(parsed);
              // Clone init so we don't mutate the caller's reference. Headers
              // are deliberately preserved as-is — the wrapper is byte-for-byte
              // transparent except for the body.
              init = { ...init, body: newBody };
            }
          }
        } catch (err) {
          console.warn(
            "[x402-extensions-forward-patch] failed to inject extensions into " +
              urlStr +
              " — request will be sent unmodified. error: " +
              (err && err.message ? err.message : String(err))
          );
        }
      }
    }

    return _origFetch.call(this, input, init);
  };

  _patched = true;
  console.log(
    "[x402-extensions-forward-patch] applied — declaredExtensions will now " +
      "be injected into CDP /verify and /settle request bodies"
  );
}

module.exports = { applyExtensionsForwardPatch };
