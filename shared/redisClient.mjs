import { createClient } from "redis";
import { logToFile } from './logger.mjs';

// Настройки Redis
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

export const redisClient = createClient({
    url: `redis://${REDIS_HOST}:${REDIS_PORT}`
});

// Функция для подключения к Redis с тайм-аутом при ошибке
async function connectWithRetry() {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
            await logToFile("✅ Подключено к Redis");
        }
    } catch (err) {
        await logToFile("❌ Ошибка подключения к Redis:", err);
    }
}

// Запускаем подключение
connectWithRetry();

// Обработчики событий для Redis
redisClient.on("error", async (err) => {
    await logToFile("❌ Ошибка Redis:", err);
});
