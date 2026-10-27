import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { Limiter } from '../common/limiter';
import { Platform } from '../common/url.util';
import { AppleMusicService } from './apple.service';
import { SpotifyService } from './spotify.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DownloadSpec =
  | { kind: 'video'; height?: number }
  | { kind: 'audio'; format: 'mp3' | 'm4a'; quality?: string } // quality: '0' (best) or e.g. '128K'
  | { kind: 'format'; formatId: string }; // an exact format the site really offers (SoundCloud)

export interface DownloadJob {
  url: string;
  platform: Platform;
  spec: DownloadSpec;
}

export interface DownloadResult {
  dir: string;
  files: { path: string; size: number }[];
  caption?: string;
}

export interface VideoOption {
  height: number;
  approxBytes?: number;
}

export interface AudioFormat {
  formatId: string;
  ext: string;
  abr?: number;
  approxBytes?: number;
  protocol?: string;
}

export interface MediaInfo {
  title: string;
  duration?: number;
  isPlaylist: boolean;
  videoOptions: VideoOption[];
  audioFormats: AudioFormat[];
  m4aBytes?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bytesOf = (f: any): number | undefined => f?.filesize ?? f?.filesize_approx ?? undefined;

/** Turns yt-dlp's JSON into just the choices the bot needs to show. */
function parseInfo(j: any): MediaInfo {
  const isPlaylist = j._type === 'playlist' || Array.isArray(j.entries);
  const formats: any[] = Array.isArray(j.formats) ? j.formats : [];

  const audioOnly = formats.filter(
    (f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none' && !/preview/i.test(f.format_id ?? ''),
  );

  const bestM4a = audioOnly.filter((f) => f.ext === 'm4a').sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];
  const m4aBytes = bytesOf(bestM4a);

  // Group video formats by resolution (min side, so vertical Shorts show as 1080p, not 1920p)
  const byRes = new Map<number, any[]>();
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none' || !f.height) continue;
    const res = Math.min(f.width ?? f.height, f.height);
    byRes.set(res, [...(byRes.get(res) ?? []), f]);
  }
  const videoOptions: VideoOption[] = [...byRes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([height, fs]) => {
      // HLS sizes are wildly overestimated, so prefer plain https formats and H.264 (what we download)
      const direct = fs.filter((f) => !String(f.protocol).includes('m3u8'));
      const pool = direct.length ? direct : fs;
      const pick = pool.find((f) => String(f.vcodec).startsWith('avc1') && bytesOf(f)) ?? pool.find((f) => bytesOf(f));
      const v = bytesOf(pick);
      return { height, approxBytes: v !== undefined ? v + (m4aBytes ?? 0) : undefined };
    });

  const audioFormats: AudioFormat[] = audioOnly.map((f) => ({
    formatId: f.format_id,
    ext: f.ext,
    abr: f.abr ?? f.tbr ?? undefined,
    approxBytes: bytesOf(f),
    protocol: f.protocol,
  }));

  return {
    title: j.title ?? 'Untitled',
    duration: typeof j.duration === 'number' ? j.duration : undefined,
    isPlaylist,
    videoOptions,
    audioFormats,
    m4aBytes,
  };
}

/** Turns raw yt-dlp errors into short messages that make sense to the person using the bot. */
function friendlyError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('sign in to confirm') || s.includes('not a bot'))
    return 'YouTube is asking for verification. The bot admin needs to add or refresh cookies (see README).';
  if (s.includes('login required') || s.includes('rate-limit reached') || s.includes('empty media response'))
    return 'Instagram needs a logged-in session for this link. The bot admin needs to add or refresh cookies.';
  if (s.includes('private video') || s.includes('this video is private')) return 'This video is private.';
  if (s.includes('video unavailable') || s.includes('not available')) return 'This video is unavailable.';
  if (s.includes('larger than max-filesize') || s.includes('file is larger'))
    return 'The file is larger than the upload limit.';
  if (s.includes('unsupported url')) return 'This link is not supported.';
  const last = stderr.trim().split('\n').pop() ?? 'unknown error';
  return last.replace(/^ERROR:\s*/, '');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class DownloaderService implements OnModuleInit {
  private readonly log = new Logger(DownloaderService.name);
  private readonly limiter: Limiter;
  private readonly infoLimiter = new Limiter(4);

  constructor(
    private config: ConfigService,
    private spotify: SpotifyService,
    private apple: AppleMusicService,
  ) {
    this.limiter = new Limiter(Number(config.get('MAX_CONCURRENT') ?? 2));
  }

  get maxMb(): number {
    return Number(this.config.get('TG_MAX_MB') ?? 50);
  }

  get maxHeight(): number {
    return Number(this.config.get('MAX_VIDEO_HEIGHT') ?? 1080);
  }

  /** Logs what the bot will actually use, so a missing/ignored cookies file is obvious at startup. */
  async onModuleInit() {
    const version = await new Promise<string>((res) =>
      execFile('yt-dlp', ['--version'], (err, out) => res(err ? 'NOT FOUND' : out.trim())),
    );
    this.log.log(`yt-dlp: ${version}`);
    if (version === 'NOT FOUND') this.log.error('yt-dlp is not installed or not on PATH');

    const file = this.config.get<string>('YTDLP_COOKIES');
    const browser = this.config.get<string>('YTDLP_COOKIES_FROM_BROWSER');
    if (file) {
      const abs = resolvePath(file);
      if (!existsSync(abs)) {
        this.log.error(`YTDLP_COOKIES is set but the file does not exist: ${abs} (cwd: ${process.cwd()})`);
      } else {
        const text = await readFile(abs, 'utf8');
        const lines = text.split('\n').filter((l) => (l.trim() && !l.startsWith('#')) || l.startsWith('#HttpOnly_'));
        const yt = lines.filter((l) => l.includes('youtube.com')).length;
        const ig = lines.filter((l) => l.includes('instagram.com')).length;
        const login = lines.some((l) => /\t(SID|SAPISID|__Secure-3PSID|LOGIN_INFO)\t/.test(l));
        this.log.log(`cookies: ${abs} (${yt} youtube.com, ${ig} instagram.com entries)`);
        if (!login) this.log.warn('cookies file has NO YouTube login cookies (SID/SAPISID/...). It is a logged-out export.');
      }
    } else if (browser) {
      this.log.log(`cookies: from browser "${browser}"`);
    } else {
      this.log.warn('No cookies configured (YTDLP_COOKIES). YouTube will likely block a server IP.');
    }
    this.log.log(`PO-token provider: ${this.config.get('YTDLP_POT_BASE_URL') || 'not configured'}`);
    this.log.log(`proxy: ${this.config.get('YTDLP_PROXY') ? 'configured' : 'none'}`);
  }

  // ---- 1. Ask the site what it really offers (qualities, sizes) ----------

  async getInfo(url: string, platform: Platform): Promise<MediaInfo> {
    return this.infoLimiter.run(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dlinfo-'));
      try {
        const args = await this.baseArgs(dir, platform);
        args.push('-J', '--no-playlist', '--flat-playlist', '--', url);
        const out = await this.runYtDlp(args, 90_000);
        const json = JSON.parse(out);
        if (json.is_live) throw new Error('Live streams are not supported.');
        return parseInfo(json);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  // ---- 2. Download -------------------------------------------------------

  async download(job: DownloadJob): Promise<DownloadResult> {
    let { url, spec } = job;
    const { platform } = job;
    let caption: string | undefined;

    // Spotify / Apple Music: read the metadata, then find the audio on YouTube
    if (platform === 'spotify' || platform === 'apple') {
      const track = platform === 'spotify' ? await this.spotify.getTrack(url) : await this.apple.getTrack(url);
      caption = track.artists ? `${track.artists} - ${track.title}` : track.title;
      url = `ytsearch1:${caption} audio`;
      if (spec.kind !== 'audio') spec = { kind: 'audio', format: 'mp3', quality: '0' };
    }

    return this.limiter.run(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dlbot-'));
      try {
        const args = await this.baseArgs(dir, platform);
        args.push('-o', join(dir, '%(title).60B [%(id)s].%(ext)s'));
        // Instagram posts/stories can contain several items, so only skip playlists elsewhere
        if (platform !== 'instagram') args.push('--no-playlist');

        switch (spec.kind) {
          case 'video':
            // H.264/AAC mp4 so Telegram plays it inline; res:N = "best up to N"
            args.push('-S', `res:${spec.height ?? 720},vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4');
            break;
          case 'audio':
            if (spec.format === 'm4a') {
              args.push('-f', 'ba[ext=m4a]/ba', '-x', '--audio-format', 'm4a', '--embed-metadata');
            } else {
              args.push('-x', '--audio-format', 'mp3', '--audio-quality', spec.quality ?? '0', '--embed-metadata');
            }
            break;
          case 'format':
            args.push('-f', spec.formatId, '--embed-metadata');
            break;
        }
        args.push('--max-filesize', `${this.maxMb}M`, '--', url);

        await this.runYtDlp(args, 10 * 60_000);

        const names = (await readdir(dir)).filter(
          (n) => !n.endsWith('.part') && !n.endsWith('.json') && n !== 'cookies.txt',
        );
        if (!names.length) throw new Error('Nothing was downloaded (the file may exceed the size limit).');
        const files = await Promise.all(
          names.sort().map(async (n) => {
            const path = join(dir, n);
            return { path, size: (await stat(path)).size };
          }),
        );
        return { dir, files, caption };
      } catch (e) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw e;
      }
    });
  }

  async cleanup(result: DownloadResult) {
    await rm(result.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---- yt-dlp plumbing ---------------------------------------------------

  /** Auth, proxy and YouTube-specific options shared by info and download calls. */
  private async baseArgs(dir: string, platform: Platform): Promise<string[]> {
    const args = ['--no-warnings', '--no-progress', '--restrict-filenames'];

    // Prefer an exported cookies.txt. Copied per job because yt-dlp rewrites the file,
    // and parallel jobs sharing one file (or a read-only Docker mount) would clash.
    const cookiesFile = this.config.get<string>('YTDLP_COOKIES');
    const browser = this.config.get<string>('YTDLP_COOKIES_FROM_BROWSER');
    if (cookiesFile && existsSync(resolvePath(cookiesFile))) {
      const copy = join(dir, 'cookies.txt');
      await copyFile(resolvePath(cookiesFile), copy);
      args.push('--cookies', copy);
    } else if (browser) {
      args.push('--cookies-from-browser', browser); // local development only
    }

    const proxy = this.config.get<string>('YTDLP_PROXY');
    if (proxy) args.push('--proxy', proxy);

    // Spotify / Apple Music are resolved through a YouTube search, so they need the same YouTube setup
    if (platform === 'youtube' || platform === 'spotify' || platform === 'apple') {
      const runtime = this.config.get<string>('YTDLP_JS_RUNTIME') ?? 'node';
      if (runtime) args.push('--js-runtimes', runtime);

      const remote = this.config.get<string>('YTDLP_REMOTE_COMPONENTS');
      if (remote) args.push('--remote-components', remote);

      // bgutil "proof of origin" token provider (separate container, see docker-compose.yml)
      const pot = this.config.get<string>('YTDLP_POT_BASE_URL');
      if (pot) args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${pot}`);
    }
    return args;
  }

  private runYtDlp(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);

      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not start yt-dlp: ${e.message}`));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        this.log.error(stderr || `yt-dlp exited with code ${code} (timeout?)`); // full error stays in the logs
        reject(new Error(stderr ? friendlyError(stderr) : 'The download timed out.'));
      });
    });
  }
}
