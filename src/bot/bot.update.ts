import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { Action, Command, Ctx, On, Start, Update } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';
import { detectPlatform, extractUrl, Platform } from '../common/url.util';
import { AudioFormat, DownloaderService, DownloadSpec, MediaInfo } from '../downloader/downloader.service';

const HELP =
  'Send me a link from YouTube, SoundCloud, Instagram, Spotify or Apple Music.\n\n' +
  '• YouTube → pick video quality or audio\n' +
  '• SoundCloud → pick from the formats the track offers\n' +
  '• Instagram → video / story\n' +
  '• Spotify, Apple Music → mp3 (matched on YouTube)\n' +
  '• /mp3 <link> → skip the menu and get best-quality mp3';

interface Choice {
  label: string;
  group: 'video' | 'audio';
  spec: DownloadSpec;
}

interface Pending {
  url: string;
  platform: Platform;
  userId: number;
  choices: Choice[];
  expires: number;
}

const MENU_TTL_MS = 15 * 60_000;
const MP3_BEST_BYTES_PER_SEC = 30_000; // ~V0 average
const MP3_128_BYTES_PER_SEC = 16_000;

const fmtSize = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const sizeTag = (b?: number) => (b ? ` · ~${fmtSize(b)}` : '');
const fmtDuration = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

@Update()
export class BotUpdate {
  private readonly log = new Logger(BotUpdate.name);
  private readonly pending = new Map<string, Pending>();

  constructor(private downloader: DownloaderService) {}

  @Start()
  async start(@Ctx() ctx: Context) {
    await ctx.reply(HELP);
  }

  @Command('help')
  async help(@Ctx() ctx: Context) {
    await ctx.reply(HELP);
  }

  @Command('mp3')
  async mp3(@Ctx() ctx: Context) {
    await this.handle(ctx, true);
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const text = (ctx.message as any)?.text ?? '';
    if (text.startsWith('/')) return;
    await this.handle(ctx, false);
  }

  // ---- Incoming link -------------------------------------------------------

  private async handle(ctx: Context, forceMp3: boolean) {
    const text = (ctx.message as any)?.text ?? '';
    const url = extractUrl(text);
    const platform = url ? detectPlatform(url) : null;
    if (!url || !platform) {
      return void ctx.reply('Send a valid YouTube, SoundCloud, Instagram, Spotify or Apple Music link.');
    }

    // No choices to offer: go straight to the download
    if (platform === 'spotify' || platform === 'apple') {
      return this.run(ctx, { url, platform, spec: { kind: 'audio', format: 'mp3', quality: '0' } });
    }
    if (platform === 'instagram') {
      const spec: DownloadSpec = forceMp3 ? { kind: 'audio', format: 'mp3', quality: '0' } : { kind: 'video' };
      return this.run(ctx, { url, platform, spec });
    }
    if (forceMp3) {
      return this.run(ctx, { url, platform, spec: { kind: 'audio', format: 'mp3', quality: '0' } });
    }

    // YouTube / SoundCloud: ask the site what it offers, then let the user choose
    await this.offerChoices(ctx, url, platform);
  }

  private async offerChoices(ctx: Context, url: string, platform: Platform) {
    const status = await ctx.reply('🔎 Reading link…');
    try {
      const info = await this.downloader.getInfo(url, platform);
      if (info.isPlaylist) {
        return void ctx.reply('Playlists and sets are not supported yet. Send a link to a single video or track.');
      }

      const choices = this.buildChoices(platform, info);
      if (!choices.length) {
        return void ctx.reply(
          `😕 Nothing fits under the ${this.downloader.maxMb} MB Telegram upload limit. Try a shorter one.`,
        );
      }

      const token = randomBytes(4).toString('hex');
      this.remember(token, { url, platform, userId: ctx.from!.id, choices, expires: Date.now() + MENU_TTL_MS });

      const head = `${platform === 'youtube' ? '🎬' : '🎵'} ${info.title}${info.duration ? ` · ${fmtDuration(info.duration)}` : ''}`;
      await ctx.reply(`${head}\n\nChoose a format (sizes are estimates):`, Markup.inlineKeyboard(this.layout(choices, token)));
    } catch (e: any) {
      this.log.error(e);
      await ctx.reply(`❌ ${String(e.message ?? e).slice(0, 300)}`);
    } finally {
      await ctx.telegram.deleteMessage(ctx.chat!.id, status.message_id).catch(() => undefined);
    }
  }

  // ---- Menu building -------------------------------------------------------

  private buildChoices(platform: Platform, info: MediaInfo): Choice[] {
    const limit = this.downloader.maxMb * 1024 * 1024;
    const fits = (b?: number) => b === undefined || b <= limit;
    const choices: Choice[] = [];
    const d = info.duration;

    if (platform === 'youtube') {
      for (const v of info.videoOptions) {
        if (v.height < 144 || v.height > this.downloader.maxHeight || !fits(v.approxBytes)) continue;
        choices.push({
          label: `🎬 ${v.height}p${sizeTag(v.approxBytes)}`,
          group: 'video',
          spec: { kind: 'video', height: v.height },
        });
      }
      const mp3Best = d ? d * MP3_BEST_BYTES_PER_SEC : undefined;
      const mp3Small = d ? d * MP3_128_BYTES_PER_SEC : undefined;
      if (fits(mp3Best)) {
        choices.push({ label: `🎵 MP3 best${sizeTag(mp3Best)}`, group: 'audio', spec: { kind: 'audio', format: 'mp3', quality: '0' } });
      }
      if (fits(mp3Small)) {
        choices.push({ label: `🎵 MP3 128k (smaller)${sizeTag(mp3Small)}`, group: 'audio', spec: { kind: 'audio', format: 'mp3', quality: '128K' } });
      }
      if (fits(info.m4aBytes)) {
        choices.push({ label: `🎵 M4A original${sizeTag(info.m4aBytes)}`, group: 'audio', spec: { kind: 'audio', format: 'm4a' } });
      }
      return choices;
    }

    // SoundCloud: only offer formats the track really has (usually 128k mp3, sometimes more)
    const seen = new Map<string, AudioFormat>();
    for (const f of info.audioFormats) {
      const key = `${f.ext}-${Math.round(f.abr ?? 0)}`;
      const prev = seen.get(key);
      const direct = (f.protocol ?? '').startsWith('http');
      if (!prev || (direct && !(prev.protocol ?? '').startsWith('http'))) seen.set(key, f);
    }
    const formats = [...seen.values()].sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0));
    for (const f of formats) {
      if (!fits(f.approxBytes)) continue;
      const kbps = f.abr ? ` ${Math.round(f.abr)}k` : '';
      choices.push({
        label: `🎵 ${f.ext.toUpperCase()}${kbps}${sizeTag(f.approxBytes)}`,
        group: 'audio',
        spec: { kind: 'format', formatId: f.formatId },
      });
    }
    if (!formats.some((f) => f.ext === 'mp3')) {
      choices.push({ label: '🎵 MP3 (converted)', group: 'audio', spec: { kind: 'audio', format: 'mp3', quality: '0' } });
    }
    return choices;
  }

  private layout(choices: Choice[], token: string) {
    const btn = (c: Choice) => Markup.button.callback(c.label, `dl:${token}:${choices.indexOf(c)}`);
    const rows: ReturnType<typeof btn>[][] = [];
    const videos = choices.filter((c) => c.group === 'video');
    for (let i = 0; i < videos.length; i += 2) rows.push(videos.slice(i, i + 2).map(btn));
    for (const c of choices.filter((c) => c.group === 'audio')) rows.push([btn(c)]);
    return rows;
  }

  // ---- Button pressed --------------------------------------------------------

  @Action(/^dl:([a-f0-9]{8}):(\d+)$/)
  async onChoice(@Ctx() ctx: Context) {
    const [, token, idx] = (ctx as any).match as RegExpMatchArray;
    const p = this.pending.get(token);

    if (!p || p.expires < Date.now()) {
      this.pending.delete(token);
      return void ctx.answerCbQuery('This menu expired. Send the link again.', { show_alert: true });
    }
    if (p.userId !== ctx.from?.id) return void ctx.answerCbQuery('This menu belongs to someone else.');

    const choice = p.choices[Number(idx)];
    if (!choice) return void ctx.answerCbQuery('Unknown option.');

    this.pending.delete(token);
    await ctx.answerCbQuery(`Downloading ${choice.label}`);
    await ctx.deleteMessage().catch(() => undefined); // remove the menu
    await this.run(ctx, { url: p.url, platform: p.platform, spec: choice.spec });
  }

  private remember(token: string, p: Pending) {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(token, p);
  }

  // ---- Download + upload -----------------------------------------------------

  private async run(ctx: Context, job: { url: string; platform: Platform; spec: DownloadSpec }) {
    const status = await ctx.reply('⏳ Downloading…');
    let result;
    try {
      await ctx.sendChatAction(job.spec.kind === 'video' ? 'upload_video' : 'upload_voice').catch(() => undefined);
      result = await this.downloader.download(job);

      const limit = this.downloader.maxMb * 1024 * 1024;
      for (const f of result.files) {
        if (f.size > limit) {
          await ctx.reply(`⚠️ ${f.path.split('/').pop()} is larger than ${this.downloader.maxMb} MB, skipped.`);
          continue;
        }
        const source = { source: f.path };
        const ext = extname(f.path).toLowerCase();
        if (ext === '.mp3' || ext === '.m4a') {
          await ctx.replyWithAudio(source, { caption: result.caption });
        } else if (ext === '.mp4') {
          await ctx.replyWithVideo(source, { supports_streaming: true });
        } else {
          await ctx.replyWithDocument(source); // images, opus, wav, ...
        }
      }
    } catch (e: any) {
      this.log.error(e);
      await ctx.reply(`❌ ${String(e.message ?? e).slice(0, 300)}`);
    } finally {
      if (result) await this.downloader.cleanup(result);
      await ctx.telegram.deleteMessage(ctx.chat!.id, status.message_id).catch(() => undefined);
    }
  }
}
