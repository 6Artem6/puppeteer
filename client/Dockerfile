FROM node:18-slim

WORKDIR /app

# Устанавливаем все необходимые зависимости для Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libxss1 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libpangocairo-1.0-0 libxcomposite1 libxcursor1 \
    libxi6 libxrandr2 libxtst6 libgtk-3-0 libxshmfence1 \
    libasound2 libdrm2 libgbm1 fonts-liberation libappindicator3-1 \
    ca-certificates xdg-utils net-tools curl \
    && rm -rf /var/lib/apt/lists/*

# Копируем package.json и устанавливаем зависимости
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npm install -g wscat

# Копируем код
COPY ./client ./client
COPY ./shared ./shared

EXPOSE 4000

CMD ["node", "./client/service.mjs"]
