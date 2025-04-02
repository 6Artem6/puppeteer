import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import http from "http";
import dotenv from "dotenv";
import { logToFile } from '../shared/logger.mjs';
import { normalizeUrl, safeStringify } from '../shared/utils.mjs';
import { decryptData } from '../shared/cryptoUtils.mjs';
import { compressData, decompressData } from '../shared/compressionUtils.mjs';
import { addTaskToQueue } from './taskQueue.mjs';


export {
    express,
    session,
    puppeteer,
    StealthPlugin,
    bodyParser,
    cookieParser,
    http,
};


// Загружаем переменные окружения
dotenv.config();

const PORT = process.env.PORT || 4000; // Порт прослушивания для приложения

puppeteer.use(StealthPlugin()); // Используем плагин Stealth для обхода детектирования ботов

const app = express();
app.use(bodyParser.json()); // Подключаем парсер JSON для обработки входящих запросов

app.use(cookieParser(process.env.SECRET_KEY)); // ✅ Подключаем cookieParser с секретом для подписанных куков

app.set("trust proxy", 1); // Доверяем заголовкам прокси-сервера для корректного определения IP клиента


const server = http.createServer(app);
server.keepAliveTimeout = 120000; // Таймаут Keep-Alive соединений
server.headersTimeout = 120000; // Таймаут заголовков HTTP-запросов
server.maxConnections = 100000; // Максимальное количество одновременных подключений к серверу

let sessionId;

// Middleware для обработки X-Session-ID
app.use(async (req, res, next) => {
    req.sessionID = req.get("X-Session-ID") || req.cookies["X-Session-ID"];

    if (!req.sessionID) {
        await logToFile("❌ Нет X-Session-ID, но мы доверяем балансировке Traefik.");
        return res.status(400).send("Missing X-Session-ID");
    }

    await logToFile(`🔄 Using session ID from Traefik: ${req.sessionID}`);
    sessionId = req.sessionID;
    next();
});

/**
 * Проверка состояния сервиса.
 * @route GET /health
 * @param {Request} req - Экземпляр запроса.
 * @param {Response} res - Экземпляр ответа.
 * @returns {void}
 */
app.get('/health', async (req, res) => {
    await logToFile(`health - OK`);
    res.status(200).send('OK');
});

/**
 * Маршрут для отправки сообщения в лид.
 * @route POST /send-lead-message
 * @param {Request} req - Экземпляр запроса.
 * @param {Response} res - Экземпляр ответа.
 * @returns {Promise<Response>} - Ответ с результатом отправки.
 */
app.post('/send-lead-message', async (req, res) => {
    const startTime = Date.now();

    if (!req.body.data) {
        return res.status(400).json({ error: 'Missing data' });
    }

    const decryptedData = decryptData(req.body.data, process.env.ENCRYPTION_KEY);
    await logToFile(`Параметры расшифрованы.`);

    if (!decryptedData) {
        return res.status(400).json({ error: 'Error decryption' });
    }
    const { account_id, base_url, access_token, refresh_token, lead_id, message_text, expiry } = decryptedData;
    await logToFile(`Проверка параметров.`);
    if (!account_id || !base_url || !access_token || !refresh_token || !lead_id || !message_text || !expiry) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    await logToFile(`Параметры в порядке.`);

    const task = { account_id, base_url, access_token, refresh_token, lead_id, message_text, expiry };

    const workerId = await addTaskToQueue(sessionId, task);
    return res.status(200).json({ status: 'queued', sessionId, workerId });
});

/**
 * Запускает сервер Puppeteer-сервиса.
 * @constant {number} PORT - Порт сервера.
 * @returns {Promise<void>}
 */
app.listen(PORT, '0.0.0.0', async () => {
    await logToFile(`Puppeteer service running on port ${PORT}`)
});
