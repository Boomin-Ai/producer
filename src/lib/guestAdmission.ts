/** Select the return transport before admission; native RTC never needs vcam. */
export async function admitGuestThroughTransport(options: {
  nativeRtc: boolean;
  host: boolean;
  virtualCameraOn: boolean;
  virtualCameraInstalled: boolean;
  startVirtualCamera: () => Promise<unknown>;
  admit: () => Promise<unknown>;
}): Promise<void> {
  if (!options.nativeRtc && options.host && !options.virtualCameraOn && options.virtualCameraInstalled) {
    await options.startVirtualCamera().catch(() => {});
  }
  await options.admit();
}

/** A timed-out response may follow a committed revoke. Read authority instead
 * of replaying the mutation or leaving the removed guest on the local stage. */
export async function revokeGuestAndConfirm(options: {
  revoke: () => Promise<unknown>;
  isRemoved: () => Promise<boolean>;
}): Promise<void> {
  try {
    await options.revoke();
  } catch (error) {
    if (!await options.isRemoved().catch(() => false)) throw error;
  }
}
