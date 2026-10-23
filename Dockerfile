ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
ARG DEBIAN_MIRROR=http://deb.debian.org

RUN sed -i -E "s|https?://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pil screen ca-certificates curl tar locales fonts-noto-cjk libcap2-bin \
       lib32gcc-s1 lib32stdc++6 libcurl4-gnutls-dev:i386 libcurl3-gnutls \
    && sed -i 's/^# *zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen zh_CN.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# SteamCMD is fetched from Valve; game binaries are installed on demand into the data volume.
RUN mkdir -p /opt/steamcmd /srv/feather /data \
    && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd.tar.gz \
    && tar -xzf /tmp/steamcmd.tar.gz -C /opt/steamcmd \
    && rm /tmp/steamcmd.tar.gz \
    && chown -R node:node /opt/steamcmd /data \
    && setcap cap_net_bind_service=+ep /usr/local/bin/node

WORKDIR /srv/feather
COPY --chown=node:node backend/ backend/
COPY --chown=node:node vendor/ vendor/
COPY --chown=node:node licenses/ licenses/
COPY --chown=node:node assets/ assets/
COPY --chown=node:node index.html backend-client.js wallpaper.mp4 ./

ENV NODE_ENV=production LANG=zh_CN.UTF-8 LANGUAGE=zh_CN:zh LC_ALL=zh_CN.UTF-8 FEATHER_HOST=0.0.0.0 FEATHER_PORT=80 FEATHER_DATA=/data \
    FEATHER_GAME=/data/dst FEATHER_STEAM=/opt/steamcmd FEATHER_PYTHON=python3 HOME=/data TZ=Asia/Shanghai
USER node
EXPOSE 80/tcp 11001-11008/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FEATHER_PORT||80)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/src/server.mjs"]
