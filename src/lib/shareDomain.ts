/** Public link branding is independent of the API endpoint and media path. */
export type ShareDomain = "producer.dev" | "boomin.ai";
export const PREF_SHARE_DOMAIN = "share_link_domain";
export const DEFAULT_SHARE_DOMAIN: ShareDomain = "producer.dev";
export function shareDomain(value: string | null | undefined): ShareDomain {
  return value === "boomin.ai" ? value : DEFAULT_SHARE_DOMAIN;
}

export function audienceShareUrl(domain: ShareDomain, path: string): string {
  if (!/^\/[A-Za-z0-9_-]+\/audience\/[a-z0-9-]+$/.test(path)) throw new Error("Invalid audience address.");
  return `https://${domain}${path}`;
}

/** Preserve the capability and query/hash; neither pretty names nor changing
 * domains should mint another invitation or rotate a working guest door. */
export function guestShareUrl(domain: ShareDomain, path: string, original: string): string {
  if (!/^\/[A-Za-z0-9_-]+\/guest\/[a-z0-9-]+$/.test(path)) throw new Error("Invalid guest address.");
  const url = new URL(original);
  if (url.protocol !== "https:" || !["boomin.ai", "producer.dev", "www.boomin.ai", "www.producer.dev"].includes(url.hostname))
    throw new Error("This guest link does not belong to the Boomin network.");
  const parts = url.pathname.split("/").filter(Boolean);
  const code = parts[parts.length - 1] ?? "";
  if (!/^(gr_|gi_)[A-Za-z0-9_-]{16,120}$/.test(code)) throw new Error("This guest link has no valid invitation code.");
  return `https://${domain}${path}/${code}${url.search}${url.hash}`;
}
