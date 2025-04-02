FROM node:18-slim

WORKDIR /app

COPY package.json package-lock.json .
RUN npm ci --omit=dev
RUN npm install -g wscat
RUN apt-get update && apt-get install -y netcat-traditional

# Копируем код
COPY ./worker ./worker
COPY ./shared ./shared

RUN chmod +x ./worker/entrypoint.sh

CMD ["./worker/entrypoint.sh"]