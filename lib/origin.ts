import { config } from "./config";

const first = (v: string | null): string => (v ?? "").split(",")[0].trim();

function proto(h: Headers, dflt: "http" | "https"): "http" | "https" {
  const p = first(h.get("x-forwarded-proto")).toLowerCase();
  return p === "http" || p === "https" ? p : dflt;
}

/**
 * The one rule for where this app lives, used for every link it hands out:
 * 1. BAB_PUBLIC_ORIGIN when set;
 * 2. else, with BAB_TRUST_PROXY on, the forwarded host (proto defaults to https);
 * 3. else the Host header (proto from x-forwarded-proto, default http).
 * Without trust a forged X-Forwarded-Host never reaches a link. With no host at all it throws.
 */
export function publicOrigin(h: Headers): string {
  const cfg = config();
  if (cfg.network.publicOrigin) return cfg.network.publicOrigin;
  if (cfg.proxy.trustForwarded) {
    const fwd = first(h.get("x-forwarded-host"));
    if (fwd) return `${proto(h, "https")}://${fwd}`;
  }
  const host = first(h.get("host"));
  if (host) return `${proto(h, "http")}://${host}`;
  throw new Error("publicOrigin: no Host header");
}
