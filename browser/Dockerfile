FROM node:18-bullseye

WORKDIR /app

# Устанавливаем зависимости
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 libnss3 libxss1 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 \
    libpangocairo-1.0-0 libx11-xcb1 libxcomposite1 libxcursor1 libxi6 libxrandr2 \
    libxtst6 libgtk-3-0 libgbm-dev libxshmfence1 ca-certificates fonts-liberation \
    libappindicator3-1 libgconf-2-4 libvulkan1 xdg-utils \
    dbus net-tools curl wget socat iptables netcat lsof jq supervisor chromium \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Устанавливаем Google Chrome Stable
RUN wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chromium.deb \
    && dpkg -i /tmp/chromium.deb \
    && apt-get install -f -y \
    && rm /tmp/chromium.deb

# Устанавливаем npm зависимости
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npm install -g wscat

COPY ./browser ./browser
COPY ./shared ./shared

# Даем права на выполнение entrypoint.sh
RUN chmod +x browser/entrypoint.sh

EXPOSE 3000
EXPOSE 9222

CMD ["./browser/entrypoint.sh"]
