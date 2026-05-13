// Smoke test for extensions-forward patch.
//
// Run:  npm test
//
// Strategy: stub the prototype's verifyPayment with a fixture BEFORE
// applying the patch, so the patch wraps the fixture. Then call the
// patched method and inspect what fetch saw inside the resulting
// AsyncLocalStorage frame. This exercises the real ALS-to-fetch handoff
// without faking out the upstream verify pipeline.

import { x402ResourceServer } from "@x402/core/server";

// Loosened view of the constructor's prototype so we can stub
// verifyPayment with a fixture that returns whatever we want (the real
// signature returns a strict PaymentPayload/VerifyResponse, which we
// don't care about for an ALS-handoff test).
type ResourceServerProto = {
  prototype: {
    verifyPayment: (...args: unknown[]) => Promise<unknown>;
  };
};
const Server = x402ResourceServer as unknown as ResourceServerProto;

let pass = 0;
let fail = 0;
function assert(label: string, cond: boolean) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (cond) pass++;
  else fail++;
}

interface Captured {
  url: string;
  body: unknown;
}
let captured: Captured | null = null;

async function main() {
  globalThis.fetch = async function captureFetch(url, init) {
    captured = {
      url:
        typeof url === "string"
          ? url
          : (url && (url as { url?: string }).url) || String(url),
      body: init && init.body,
    };
    return new Response('{"isValid":true,"payer":"0xtest"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  function installCdpFixture() {
    Server.prototype.verifyPayment = async function fixtureVerify(
      ...args: unknown[]
    ) {
      const [paymentPayload, requirements] = args;
      await globalThis.fetch(
        "https://api.cdp.coinbase.com/platform/v2/x402/verify",
        {
          method: "POST",
          body: JSON.stringify({
            x402Version:
              (paymentPayload as { x402Version?: number })?.x402Version,
            paymentPayload,
            paymentRequirements: requirements,
          }),
        },
      );
    };
  }
  installCdpFixture();

  const { applyExtensionsForwardPatch } = await import("./extensions-forward.js");
  applyExtensionsForwardPatch();
  assert("patch applied without throwing", true);

  const fetchAfterFirst = globalThis.fetch;
  applyExtensionsForwardPatch();
  assert(
    "idempotent (second apply is a no-op)",
    globalThis.fetch === fetchAfterFirst,
  );

  captured = null;
  await Server.prototype.verifyPayment.call(
    {},
    { x402Version: 2 },
    { scheme: "exact", network: "eip155:8453" },
    { bazaar: { info: { type: "http" }, schema: { type: "object" } } },
  );
  const body = JSON.parse(String(captured!.body));
  assert("verify body has top-level extensions", body.extensions !== undefined);
  assert(
    "extensions.bazaar present",
    body.extensions && !!body.extensions.bazaar,
  );
  assert(
    "original fields preserved",
    body.x402Version === 2 &&
      body.paymentRequirements &&
      body.paymentRequirements.scheme === "exact",
  );

  captured = null;
  await Server.prototype.verifyPayment.call(
    {},
    { x402Version: 2 },
    { scheme: "exact" },
    {},
  );
  const emptyBody = JSON.parse(String(captured!.body));
  assert(
    "empty extensions: no field added",
    emptyBody.extensions === undefined,
  );

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
