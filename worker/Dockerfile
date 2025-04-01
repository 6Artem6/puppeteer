FROM node:18-slim

RUN apt-get update && apt-get install -y netcat-traditional

WORKDIR /app

COPY package.json package-lock.json .
RUN npm ci --omit=dev

# Копируем код
COPY ./worker ./worker
COPY ./shared ./shared

RUN chmod +x ./worker/entrypoint.sh

CMD ["./worker/entrypoint.sh"]