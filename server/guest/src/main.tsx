import { createRoot } from "react-dom/client";
import { matchRoute } from "./router";
import GuestJoinPage from "./GuestJoinPage";
import GuestRoomPage from "./GuestRoomPage";
import GuestRenderPage from "./GuestRenderPage";

function App() {
  const route = matchRoute(window.location.pathname);
  switch (route.page) {
    case "join": return <GuestJoinPage code={route.code} />;
    case "room": return <GuestRoomPage code={route.code} />;
    case "render": return <GuestRenderPage id={route.id} />;
    case "mod":
      // A control seat lives in Producer, not in a tab: the app reads the
      // code off this URL and talks to /v1/connect/mod/:code itself.
      return (
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#0a0a0b", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ width: "min(560px, 100%)" }}>
            <h1 style={{ margin: "6px 0 12px", fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>You're a mod for this room</h1>
            <p style={{ color: "#8b8b93", fontSize: 14, lineHeight: 1.5 }}>
              Open Producer → your account menu → <b>Open a mod link…</b> and paste this page's address.
              You'll get the roster and the scene list: admit, stage, order, remove, and cut scenes. You never appear on the set.
            </p>
            <code style={{ display: "block", marginTop: 12, padding: 10, background: "#151517", borderRadius: 8, fontSize: 12, wordBreak: "break-all" }}>{window.location.href}</code>
          </div>
        </div>
      );
    case "none":
      return (
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          <div style={{ width: "min(560px, 100%)" }}>
            <h1 style={{ margin: "6px 0 20px", fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>Nothing here</h1>
            <p style={{ color: "#8b8b93", fontSize: 14, lineHeight: 1.5 }}>Ask whoever invited you for a fresh link.</p>
          </div>
        </div>
      );
  }
}

createRoot(document.getElementById("root")!).render(<App />);
