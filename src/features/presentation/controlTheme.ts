import type {CSSProperties} from 'react';
import {evaluate, type RehearsalState} from './rehearsal';
import {isHexColor, type PresentationPackage} from './schema';

function luminance(color: string) {
  const channels = [1, 3, 5].map(offset => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

export function controlThemeStyle(doc: PresentationPackage, state: RehearsalState): CSSProperties | undefined {
  if (!doc.set.controlTheme) return;
  const style: Record<string, string> = {};
  for (const [role, binding] of Object.entries(doc.set.controlTheme)) {
    try {
      const color = evaluate(binding, state, {}, 64, doc.set.tokens);
      if (!isHexColor(color)) continue;
      style[`--set-theme-${role}`] = color;
      if (role === 'primary') {
        // Pick the foreground with the greater contrast against the solid fill.
        style[`--set-theme-${role}-ink`] = luminance(color) > .179 ? '#000000' : '#ffffff';
      }
    } catch { /* A missing runtime color leaves the Producer default in place. */ }
  }
  const surface = style['--set-theme-surface'];
  const ink = style['--set-theme-text'];
  if (surface) {
    const light = luminance(surface) > .179;
    const levels = ink ? [luminance(surface), luminance(ink)].sort((a, b) => b - a) : [];
    if (!ink || (levels[0] + .05) / (levels[1] + .05) < 4.5) {
      style['--set-theme-text'] = light ? '#000000' : '#ffffff';
    }
    style.colorScheme = light ? 'light' : 'dark';
  }
  return style as CSSProperties;
}
