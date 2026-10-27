import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { TelegrafModule } from 'nestjs-telegraf';
import { BotUpdate } from './bot/bot.update';
import { AppleMusicService } from './downloader/apple.service';
import { DownloaderService } from './downloader/downloader.service';
import { SpotifyService } from './downloader/spotify.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiRoot = config.get<string>('TG_API_ROOT');

        // Fresh connection per request: reused keep-alive sockets go stale during long
        // downloads and fail with "socket hang up" on the next upload.
        const agent = apiRoot?.startsWith('http://')
          ? new HttpAgent({ keepAlive: false })
          : new HttpsAgent({ keepAlive: false });

        return {
          token: config.getOrThrow<string>('BOT_TOKEN'),
          options: {
            // Telegraf aborts handlers after 90s by default; download + conversion can take longer.
            handlerTimeout: 15 * 60_000,
            telegram: { ...(apiRoot ? { apiRoot } : {}), agent },
          },
        };
      },
    }),
  ],
  providers: [BotUpdate, DownloaderService, SpotifyService, AppleMusicService],
})
export class AppModule {}
