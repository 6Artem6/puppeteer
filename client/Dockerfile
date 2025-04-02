FROM node:18-slim

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package.json package-lock.json .
RUN npm ci --omit=dev
RUN npm install -g wscat

# Копируем код
COPY ./client ./client
COPY ./shared ./shared

EXPOSE 4000

CMD ["node", "./client/service.mjs"]
