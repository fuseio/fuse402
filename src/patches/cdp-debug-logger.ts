// Temporary CDP debug logger.
//
// Wraps globalThis.fetch to log every request to/from api.cdp.coinbase.com.
// The point is to capture the EXTENSION-RESPONSES header on /verify and
// /settle responses, which per Coinbase's docs reports whether bazaar
// discovery metadata was accepted ("processing") or rejected (with a
// reason). HTTPFacilitatorClient calls bare fetch() internally, so patching
// the global resolves at call time and captures every CDP round-trip
// without touching the SDK.
//
// Body cloning + 2KB truncation keeps log volume manageable; nothing
// secret should appear here (CDP API key only goes in the Authorization
// header, which we deliberately do NOT log).
//
// TODO(remove): drop this entire file once the bazaar indexing
// investigation is complete.

export function applyCdpDebugLogger() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr =
      typeof url === "string"
        ? url
        : (url && (url as { url?: string }).url) || String(url);
    const isCdp = urlStr.includes("api.cdp.coinbase.com");

    if (isCdp) {
      try {
        const method = (init && init.method) || "GET";
        console.log("[cdp-debug] →", method, urlStr);
        if (init && init.body) {
          const bodyStr =
            typeof init.body === "string"
              ? init.body
              : JSON.stringify(init.body);
          console.log("[cdp-debug] req body:", bodyStr.slice(0, 2000));
        }
      } catch {
        // never let logging break the request
      }
    }

    const res = await original(url, init);

    if (isCdp) {
      try {
        console.log("[cdp-debug] ←", res.status, urlStr);
        // Dump ALL response headers so we have unambiguous, paste-able
        // evidence of what CDP returned. Confirming header absence
        // requires logging every header, not just expected ones.
        const allHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          allHeaders[k] = v;
        });
        console.log("[cdp-debug] resp headers:", JSON.stringify(allHeaders));

        // Make EXTENSION-RESPONSES presence/absence loud and explicit.
        // Per the bazaar.mdx spec, the value is base64-encoded JSON like
        // {"bazaar":{"status":"processing"}}.
        const extResp = res.headers.get("extension-responses");
        if (extResp) {
          console.log("[cdp-debug] resp extension-responses (raw):", extResp);
          try {
            const decoded = Buffer.from(extResp, "base64").toString("utf8");
            console.log("[cdp-debug] resp extension-responses (decoded):", decoded);
          } catch (e) {
            console.log(
              "[cdp-debug] resp extension-responses (decode failed):",
              (e as Error).message,
            );
          }
        } else {
          console.log("[cdp-debug] resp extension-responses: (absent)");
        }

        const correlationId =
          res.headers.get("correlation-id") ||
          res.headers.get("x-correlation-id");
        if (correlationId) {
          console.log("[cdp-debug] resp correlation-id:", correlationId);
        }
        const clone = res.clone();
        const text = await clone.text();
        console.log("[cdp-debug] resp body:", text.slice(0, 2000));
      } catch {
        // ignore
      }
    }

    return res;
  };
}
