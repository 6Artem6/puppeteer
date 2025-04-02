import fetch from "node-fetch";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import express from "express";
import dotenv from "dotenv";

// Загружаем переменные окружения
dotenv.config();

const app = express();
app.use(cookieParser(process.env.SECRET_KEY));

const EXPRESS_PORT = process.env.EXPRESS_PORT || 3000;
const DEBUG_PORT = process.env.DEBUG_PORT || 9222;

// Middleware для обработки X-Session-ID
app.use((req, res, next) => {
    if (req.originalUrl === "/health") {
        return next();
    }

    // Получаем session ID из заголовков или cookies
    let sessionId = req.get("X-Session-ID") || req.cookies["X-Session-ID"];

    if (!sessionId) {
        // Если сессия не найдена, генерируем новый ID
        sessionId = crypto.randomBytes(16).toString("hex");
        res.cookie("X-Session-ID", sessionId, {
            httpOnly: true,
            sameSite: "Strict",
        });
    }

    // Логируем сессионный ID, URL и параметры запроса
    console.log(`🔄 Using session ID: ${sessionId}`);
    console.log(`🔗 URL: ${req.originalUrl}`);
    console.log(`🔑 Query parameters: ${JSON.stringify(req.query)}`);

    req.sessionID = sessionId;
    res.set("X-Session-ID", sessionId);
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
    res.status(200).send('OK');
});

// Эндпоинт для получения WebSocket URL
app.get("/ws-endpoint", async (req, res) => {
    try {
        const response = await fetch(`http://localhost:${DEBUG_PORT}/json/version`, {
            headers: { Host: "localhost" },
        });
        const data = await response.json();

        console.log("Ответ от Chrome Debugger API:", data);

        if (!data.webSocketDebuggerUrl) {
            throw new Error("webSocketDebuggerUrl not found");
        }

        // Отправляем клиенту X-Session-ID
        res.setHeader("X-Session-ID", req.sessionID);

        // Корректируем WebSocket URL
        let wsUrl = data.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${process.env.BROWSER_HOST}:${DEBUG_PORT}`);

        console.log(`✅ Отправляем клиенту ws-endpoint: ${wsUrl}`);
        res.send(wsUrl);
    } catch (err) {
        console.error("❌ Ошибка получения WebSocket URL:", err);
        res.status(500).send("Ошибка сервера");
    }
});

app.listen(EXPRESS_PORT, () => {
    console.log(`🚀 Express сервер запущен на порту ${EXPRESS_PORT}`);
});
