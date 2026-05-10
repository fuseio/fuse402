"use strict";

// Smoke test for x402-extensions-forward-patch.
//
// Run from the project root:  node lib/x402-extensions-forward-patch.test.js
//
// Expected output: all assertions print PASS, exit 0.
//
// Strategy: stub the prototype's verifyPayment with a fixture BEFORE
// applying the patch, so the patch wraps the fixture. Then call the
// patched method and inspect what fetch saw inside the resulting
// AsyncLocalStorage frame. This exercises the real ALS-to-fetch handoff
// without faking out the upstream verify pipeline.

const { x402ResourceServer } = require("@x402/core/server");

let pass = 0,
  fail = 0;
function assert(label, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  cond ? pass++ : fail++;
}

async function main() {
  // 1. Install a fetch stub that captures the body it sees.
  let captured = null;
  globalThis.fetch = async function captureFetch(url, init) {
    captured = {
      url: typeof url === "string" ? url : (url && url.url) || String(url),
      body: init && init.body,
    };
    return new Response('{"isValid":true,"payer":"0xtest"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // 2. Replace verifyPayment on the prototype with a fixture that calls fetch.
  //    The patch will wrap THIS fixture when it runs.
  function installCdpFixture() {
    x402ResourceServer.prototype.verifyPayment = async function fixtureVerify(
      paymentPayload,
      requirements
    ) {
      await globalThis.fetch("https://api.cdp.coinbase.com/platform/v2/x402/verify", {
        method: "POST",
        body: JSON.stringify({
          x402Version: paymentPayload.x402Version,
          paymentPayload,
          paymentRequirements: requirements,
        }),
      });
    };
  }
  installCdpFixture();

  // 3. Apply the patch.
  const { applyExtensionsForwardPatch } = require("./x402-extensions-forward-patch");
  applyExtensionsForwardPatch();
  assert("patch applied without throwing", true);

  // 4. Idempotency check.
  const fetchAfterFirst = globalThis.fetch;
  applyExtensionsForwardPatch();
  assert("idempotent (second apply is a no-op)", globalThis.fetch === fetchAfterFirst);

  // 5. Non-empty declaredExtensions → top-level extensions field on the wire.
  captured = null;
  await x402ResourceServer.prototype.verifyPayment.call(
    {},
    { x402Version: 2 },
    { scheme: "exact", network: "eip155:8453" },
    { bazaar: { info: { type: "http" }, schema: { type: "object" } } }
  );
  const body = JSON.parse(captured.body);
  assert("verify body has top-level extensions", body.extensions !== undefined);
  assert("extensions.bazaar present", body.extensions && !!body.extensions.bazaar);
  assert(
    "original fields preserved",
    body.x402Version === 2 &&
      body.paymentRequirements &&
      body.paymentRequirements.scheme === "exact"
  );

  // 6. Empty declaredExtensions → no extensions field added (no noise).
  captured = null;
  await x402ResourceServer.prototype.verifyPayment.call(
    {},
    { x402Version: 2 },
    { scheme: "exact" },
    {}
  );
  const emptyBody = JSON.parse(captured.body);
  assert("empty extensions: no field added", emptyBody.extensions === undefined);

  // 7. Non-CDP URLs are never touched, even with a populated ALS frame.
  x402ResourceServer.prototype.verifyPayment = async function nonCdpFixture() {
    await globalThis.fetch("https://example.org/health", {
      method: "POST",
      body: JSON.stringify({ ping: 1 }),
    });
  };
  // Reapply so the patch's closure-captured _orig points at the new fixture.
  delete require.cache[require.resolve("./x402-extensions-forward-patch")];
  const { applyExtensionsForwardPatch: applyAgain } = require("./x402-extensions-forward-patch");
  applyAgain();
  captured = null;
  await x402ResourceServer.prototype.verifyPayment.call(
    {},
    { x402Version: 2 },
    {},
    { bazaar: { info: { type: "http" } } }
  );
  const nonCdpBody = JSON.parse(captured.body);
  assert("non-CDP URL: extensions NOT injected", nonCdpBody.extensions === undefined);

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
