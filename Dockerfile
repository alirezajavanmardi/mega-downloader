FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim
# yt-dlp is installed with pip (not the single binary) so the bgutil PO-token plugin can load.
# Node (already in this image) is used as yt-dlp's JavaScript runtime for YouTube.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" bgutil-ytdlp-pot-provider \
 && ln -s /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/main.js"]
