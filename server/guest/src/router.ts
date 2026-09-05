// A three-route pathname switch standing in for react-router's useParams /
// useSearchParams. The Worker returns this bundle's index.html for every
// /connect/guest/* path, and the page decides from window.location.pathname.
import { useMemo } from "react";

export type Route =
  | { page: "join"; code: string }
  | { page: "room"; code: string }
  | { page: "render"; id: string }
  /** A mod link opened in a browser: it belongs in Producer (#47). */
  | { page: "mod"; code: string }
  | { page: "none" };

export function matchRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  // ["connect", "guest", ...] — or ["connect", "mod", code]
  if (parts[0] === "connect" && parts[1] === "mod" && parts.length === 3) return { page: "mod", code: parts[2] };
  if (parts[0] !== "connect" || parts[1] !== "guest") return { page: "none" };
  if (parts.length === 4 && parts[2] === "room") return { page: "room", code: parts[3] };
  if (parts.length === 4 && parts[2] === "render") return { page: "render", id: parts[3] };
  if (parts.length === 3) return { page: "join", code: parts[2] };
  return { page: "none" };
}

export function useSearchParams(): [URLSearchParams] {
  return useMemo(() => [new URLSearchParams(window.location.search)] as [URLSearchParams], []);
}
