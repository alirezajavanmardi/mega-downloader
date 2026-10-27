import { Injectable } from '@nestjs/common';
import { TrackInfo } from './spotify.service';

/**
 * Apple Music audio is DRM-protected, so like Spotify we only read the metadata
 * (via Apple's free public iTunes Lookup API, no key needed) and find the song elsewhere.
 *
 * Supported links:
 *   https://music.apple.com/us/album/some-album/123456789?i=987654321   (track inside an album)
 *   https://music.apple.com/us/song/some-song/987654321
 */
@Injectable()
export class AppleMusicService {
  async getTrack(url: string): Promise<TrackInfo> {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const country = /^[a-z]{2}$/i.test(parts[0] ?? '') ? parts[0].toLowerCase() : 'us';

    const id = u.searchParams.get('i') ?? (parts.includes('song') ? parts[parts.length - 1] : null);
    if (!id || !/^\d+$/.test(id)) {
      throw new Error('Send a link to a single Apple Music song (not an album or playlist).');
    }

    const res = await fetch(`https://itunes.apple.com/lookup?id=${id}&country=${country}`);
    if (!res.ok) throw new Error(`Apple Music lookup failed (${res.status}).`);
    const data: any = await res.json();
    const item = data.results?.find((r: any) => r.trackName && r.artistName);
    if (!item) throw new Error('Could not find this song on Apple Music.');
    return { title: item.trackName, artists: item.artistName };
  }
}
