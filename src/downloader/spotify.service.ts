import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TrackInfo {
  title: string;
  artists: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Resolves a Spotify track link to "artist - title".
 * Spotify audio itself is DRM-protected, so we only need metadata to search for the song elsewhere.
 *
 * Strategy:
 *  1. Web API (client credentials), only if credentials are set. Spotify has restricted this for new apps, so it may 403.
 *  2. Fallback: read the public track page (no auth, no credentials needed).
 *  3. Last resort: oEmbed (title only).
 */
@Injectable()
export class SpotifyService {
  private readonly log = new Logger(SpotifyService.name);
  private token?: { value: string; expires: number };

  constructor(private config: ConfigService) {}

  async getTrack(url: string): Promise<TrackInfo> {
    const resolved = await this.resolveShortLink(url);
    const id = resolved.match(/track\/([A-Za-z0-9]+)/)?.[1];
    if (!id) throw new Error('Only Spotify track links are supported right now.');

    if (this.config.get('SPOTIFY_CLIENT_ID') && this.config.get('SPOTIFY_CLIENT_SECRET')) {
      try {
        return await this.fromApi(id);
      } catch (e: any) {
        this.log.warn(`Spotify API failed (${e.message}), falling back to page scrape`);
      }
    }

    try {
      return await this.fromPage(id);
    } catch (e: any) {
      this.log.warn(`Page scrape failed (${e.message}), falling back to oEmbed`);
      return this.fromOEmbed(id);
    }
  }

  private async resolveShortLink(url: string): Promise<string> {
    if (!url.includes('spotify.link')) return url;
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
    return res.url;
  }

  // ---- 1. Web API -------------------------------------------------------

  private async getToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 10_000) return this.token.value;

    const id = this.config.getOrThrow<string>('SPOTIFY_CLIENT_ID');
    const secret = this.config.getOrThrow<string>('SPOTIFY_CLIENT_SECRET');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`auth ${res.status}`);
    const data: any = await res.json();
    this.token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async fromApi(id: string): Promise<TrackInfo> {
    const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
      headers: { Authorization: `Bearer ${await this.getToken()}` },
    });
    if (!res.ok) throw new Error(`api ${res.status}`);
    const t: any = await res.json();
    return { title: t.name, artists: t.artists.map((a: any) => a.name).join(', ') };
  }

  // ---- 2. Public page ---------------------------------------------------

  private async fromPage(id: string): Promise<TrackInfo> {
    const res = await fetch(`https://open.spotify.com/track/${id}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) throw new Error(`page ${res.status}`);
    const html = await res.text();

    // <title>Song Name - song and lyrics by Artist1, Artist2 | Spotify</title>
    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    if (pageTitle) {
      const m = this.decode(pageTitle).match(/^(.+?) - song(?: and lyrics)? by (.+?) \| Spotify$/i);
      if (m) return { title: m[1].trim(), artists: m[2].trim() };
    }

    // Fallback: og:title is the track name, og:description usually contains the artist
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1];
    const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1];
    if (ogTitle) {
      const title = this.decode(ogTitle).trim();
      const artists = ogDesc
        ? this.decode(ogDesc)
            .split('·')
            .map((s) => s.trim())
            .filter((s) => s && s.toLowerCase() !== 'song' && !/^\d{4}$/.test(s) && s !== title)[0] ?? ''
        : '';
      return { title, artists };
    }
    throw new Error('could not parse page');
  }

  // ---- 3. oEmbed (title only) ------------------------------------------

  private async fromOEmbed(id: string): Promise<TrackInfo> {
    const res = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`,
    );
    if (!res.ok) throw new Error(`Could not read this Spotify track (${res.status}).`);
    const data: any = await res.json();
    return { title: data.title, artists: '' };
  }

  private decode(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
}
