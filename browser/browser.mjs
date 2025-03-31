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
    let sessionId = req.get("X-Session-ID") || req.cookies["X-Session-ID"];

    if (!sessionId) {
        sessionId = crypto.randomBytes(16).toString("hex");
        res.cookie("X-Session-ID", sessionId, {
            httpOnly: true,
            sameSite: "Strict",
        });
    }

    console.log(`🔄 Using session ID: ${sessionId}`);
    req.sessionID = sessionId;
    res.set("X-Session-ID", sessionId);
    next();
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
        let wsUrl = data.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://browser-service:${DEBUG_PORT}`);

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
