export type Platform = 'instagram' | 'youtube' | 'soundcloud' | 'spotify' | 'apple';

const URL_RE = /https?:\/\/[^\s]+/i;

export function extractUrl(text: string): string | null {
  return text.match(URL_RE)?.[0] ?? null;
}

export function detectPlatform(raw: string): Platform | null {
  let host: string;
  try {
    host = new URL(raw).hostname.replace(/^www\.|^m\./, '');
  } catch {
    return null;
  }
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (['youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return 'youtube';
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return 'soundcloud';
  if (host === 'open.spotify.com' || host === 'spotify.link') return 'spotify';
  if (host === 'music.apple.com') return 'apple';
  return null;
}
