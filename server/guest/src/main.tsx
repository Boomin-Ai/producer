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
