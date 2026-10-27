# Telegram Downloader Bot (NestJS)

| Link | What you get |
|---|---|
| YouTube | Menu: video at every available quality (with size estimates), or MP3 / MP3 128k / M4A |
| SoundCloud | Menu: the formats that track really offers (usually 128k MP3) |
| Instagram | Video / story |
| Spotify, Apple Music | MP3, matched on YouTube (these services are DRM-protected, so there is no direct download) |

`/mp3 <link>` skips the menu and returns the best-quality MP3.

## Run on a server (Docker)
```bash
cp .env.example .env          # fill BOT_TOKEN
touch cookies.txt             # replace with the real file, see below. Must exist before starting
docker compose up -d --build
docker compose logs -f bot    # check the startup lines: yt-dlp version, cookies, PO-token provider
```
Rebuild now and then (`docker compose build --no-cache && docker compose up -d`): YouTube changes constantly and yt-dlp releases fixes every few weeks.

## YouTube on a server
YouTube treats server IPs as suspicious and answers "Sign in to confirm you're not a bot". There are three layers, from cheapest to most reliable. **No setup is guaranteed**; datacenter IPs are blocked often.

1. **Logged-in cookies (required).** You can't log in on a headless server, so export them on your own computer and upload the file.
   1. Use a throwaway Google account.
   2. In Firefox open `about:profiles`, create a new profile (e.g. `ytbot`), launch it, log in to youtube.com (and instagram.com if you want stories), then **quit that profile**. Don't open YouTube in it again, because a session in active use gets its cookies rotated and the exported ones die.
   3. Run `./scripts/export-cookies.sh firefox:ytbot`. It writes `cookies.txt` with only YouTube/Google/Instagram cookies and lists which login cookies it found. If it says "none", the login didn't stick.
   4. Upload it: `scp cookies.txt user@your-server:/path/to/dl-bot/cookies.txt`, then `docker compose restart bot`.
   Cookies expire: when you see "YouTube is asking for verification" again, repeat.
2. **PO-token provider (included).** `docker-compose.yml` starts `brainicism/bgutil-ytdlp-pot-provider` next to the bot, and yt-dlp uses it automatically. It lowers the number of bot checks but doesn't stop all of them on a flagged IP.
3. **Residential proxy (the strongest fix).** If your server's IP is flagged, set `YTDLP_PROXY=http://user:pass@host:port`. Running the bot from a home connection (e.g. a Raspberry Pi) works for the same reason.

## Notes
- Instagram stories and some reels need the logged-in cookies as well. One `cookies.txt` can hold both sites.
- SoundCloud's choices come from what the track actually offers. Most tracks only have 128 kbps, so don't expect a 320k option.
- Spotify / Apple Music links: single songs only. The audio comes from a YouTube match, so it may not be the exact master.
- 50 MB upload limit on the public Bot API. Run a local Bot API server and set `TG_API_ROOT` and `TG_MAX_MB=2000` for large files.
- Use only for content you have the right to download. These platforms' terms generally restrict downloading.
