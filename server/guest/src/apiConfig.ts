// The self-hosted server serves these pages itself, so the API is always the
// page's own origin — a guest of a self-hosted host never touches anyone
// else's servers. Signaling sockets are derived from this too (wss:// when the
// page is https://), so there is nothing to configure.
export const CONNECT_API_BASE_URL = `${window.location.origin}/v1/connect`;
