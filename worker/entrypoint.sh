#!/bin/sh
echo "⏳ Ожидание Redis перед запуском воркера..."

until nc -z redis 6379; do
  echo "❌ Redis не доступен. Ждем..."
  sleep 10
done

echo "✅ Redis доступен. Запускаем сервис..."
exec node ./worker/queueWorker.mjs
