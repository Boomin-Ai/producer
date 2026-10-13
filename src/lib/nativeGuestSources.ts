/** Preserve saved scene keys while binding native media to full identities. */
export function nativeGuestSources<T extends { id: string }>(guests: readonly T[]): Map<string, { guest: T; track: "camera" }> {
  const sources = new Map<string, { guest: T; track: "camera" }>();
  for (const guest of guests) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guest.id)) {
      throw new Error("Native guest identity is invalid.");
    }
    const id = `guest-${guest.id.slice(0, 8)}`;
    if (sources.has(id)) throw new Error("Native guest scene identities collide.");
    sources.set(id, { guest, track: "camera" });
  }
  return sources;
}
