import type { Channel } from '../../lib/ipc';

export function acceptsTextOnly(channel: Channel) {
  return channel.platform.toLowerCase() === 'threads' || channel.capabilities?.media?.required === false;
}
export function captionLimit(channel: Channel) {
  return channel.capabilities?.text?.maxChars ?? (channel.platform.toLowerCase() === 'threads' ? 500 : 2200);
}
export function validatePostTarget(channel: Channel, text: string, hasMedia: boolean): string | null {
  if (!hasMedia && !acceptsTextOnly(channel)) return `${channel.display_name} needs an image or video.`;
  if (!hasMedia && !text.trim()) return 'Write your post before publishing.';
  if (Array.from(text).length > captionLimit(channel)) return `The post is too long for ${channel.display_name}.`;
  return null;
}
