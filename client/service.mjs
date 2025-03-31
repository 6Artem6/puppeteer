import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import fs from "fs-extra";
import path from "path";
import http from "http";
import crypto from "crypto";
import dotenv from "dotenv";
import { logToFile } from './logger.mjs';
import { normalizeUrl, safeStringify } from './utils.mjs';
import { decryptData } from './cryptoUtils.mjs';
import { compressData, decompressData } from './compressionUtils.mjs';
import {
    getContext, saveContext, loadContext, updateContext, clearContext,
    saveCookies, loadCookies, redisClient, contextStore, launchBrowser,
    getBrowser, setBrowser, getUsername, saveUsername
} from './contextManager.mjs';


export {
    express,
    session,
    puppeteer,
    StealthPlugin,
    bodyParser,
    cookieParser,
    fs,
    path,
    http,
    crypto,
};


// Загружаем переменные окружения
dotenv.config();

const PORT = process.env.PORT || 4000; // Порт прослушивания для приложения

puppeteer.use(StealthPlugin()); // Используем плагин Stealth для обхода детектирования ботов

const app = express();
app.use(bodyParser.json()); // Подключаем парсер JSON для обработки входящих запросов

app.use(cookieParser(process.env.SECRET_KEY)); // ✅ Подключаем cookieParser с секретом для подписанных куков

app.set("trust proxy", 1); // Доверяем заголовкам прокси-сервера для корректного определения IP клиента

const MAX_CONTEXTS = 10; // Максимальное количество контекстов в памяти
const MAX_REQUEST_COUNT = 10; // Максимальное количество запросов к одной странице
const MAX_PAGES_PER_ACCOUNT = 5; // Максимальное количество страниц на один аккаунт

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
 * Отправляет сообщение в лид.
 * @param {Object} params - Параметры запроса.
 * @param {string} params.account_id - ID аккаунта.
 * @param {string} params.base_url - Базовый URL.
 * @param {string} params.access_token - Токен доступа.
 * @param {string} params.refresh_token - Токен обновления.
 * @param {string} params.lead_id - ID лида.
 * @param {string} params.message_text - Текст сообщения.
 * @param {number} params.expiry - Время истечения токенов.
 * @returns {Promise<{ status: number, message: Object }>} - Результат отправки.
 */
async function sendLeadMessage(params) {
    const { account_id, base_url, access_token, refresh_token, lead_id, message_text, expiry } = params;

    let { page, isNew } = await getPage(base_url, account_id, lead_id, expiry);

    if (isNew) {
        await logToFile(`Создана новая страница для ${account_id}`);
        await page.goto(base_url, { waitUntil: 'networkidle2', timeout: 120000 });
        await logToFile(`Главная страница ${base_url} загружена`);
    } else {
        await logToFile(`Используем сохранённую страницу: ${page.url()}`);
    }

    // Проверка и повторная авторизация
    if (!(await handleAuthorization(page, account_id, access_token, refresh_token, expiry))) {
        return { status: 401, message: { status: 'failed_with_token' } };
    }

    // Ждём, если на странице уже идёт работа
    const lockKey = `${account_id}:${lead_id}`;
    while (contextStore[account_id].pagesLocks.get(lockKey)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Открываем чат (2 попытки)
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (isNew) {
            await navigateToLead(page, account_id, lead_id, base_url);
        }

        if (await navigateToChat(page) && await selectRecipient(page, account_id, lead_id)) {
            break;
        }

        if (attempt === 2) {
            return { status: 500, message: { error: 'Не удалось открыть чат или выбрать получателя' } };
        }

        await logToFile(`Ошибка при открытии чата или выборе получателя. Перезагружаем страницу (попытка ${attempt})`);
        await page.reload({ waitUntil: 'networkidle2' });
    }

    // Отправка сообщения
    if (!(await sendMessage(page, message_text))) {
        return { status: 500, message: { error: 'Не удалось отправить сообщение' } };
    }

    await updateRequestCount(account_id);

    return { status: 200, message: { status: 'message_sent' } };
}

/**
 * Повторяет выполнение асинхронной функции в случае ошибки.
 * @param {() => Promise<any>} fn - Функция, которая будет выполняться с ретраями.
 * @param {number} [maxRetries=5] - Максимальное количество попыток.
 * @param {number} [delay=1000] - Базовая задержка между попытками (мс).
 * @returns {Promise<any>} - Результат успешного выполнения `fn`.
 * @throws {Error} - Ошибка, если превышено количество попыток.
 */
async function withRetries(fn, maxRetries = 5, delay = 1000) {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            return await fn();
        } catch (err) {
            attempts++;
            await logToFile(`[ERROR] Ошибка (попытка ${attempts}/${maxRetries}): ${err.message}`);
            await logToFile(`[ERROR] Stack Trace: ${err.stack}`);
            await logToFile(`[ERROR] Полная ошибка: ${safeStringify(err)}`);
            if (attempts >= maxRetries) throw err;
            await new Promise((resolve) => setTimeout(resolve, delay * attempts)); // Экспоненциальная задержка
        }
    }
}

/**
 * Ожидает, пока страница не освободится, и затем выполняет callback.
 * @param {string|number} account_id
 * @param {string|number} lead_id
 * @param {Function} callback
 * @returns {Promise<any>}
 */
async function withPageLock(account_id, lead_id, callback) {
    const key = `${account_id}:${lead_id}`;
    const context = await getContext(account_id);

    // Гарантируем, что в pagesQueue хранятся только Promise
    if (!context.pagesQueue.has(key) || !(context.pagesQueue.get(key) instanceof Promise)) {
        context.pagesQueue.set(key, Promise.resolve());
    }

    const queue = context.pagesQueue.get(key);
    const task = queue.then(async () => {
        const now = Date.now();
        const lockTimestamp = context.pagesBusy.get(key);

        // Если страница занята более 5 минут, сбрасываем блокировку
        if (lockTimestamp && now - lockTimestamp > 5 * 60 * 1000) {
            await logToFile(`[WARN] Страница ${key} была занята более 5 минут. Сбрасываем блокировку.`);
            context.pagesBusy.delete(key);
        }

        // Ждем, пока страница не освободится
        while (context.pagesBusy.has(key)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Устанавливаем блокировку с timestamp
        context.pagesBusy.set(key, Date.now());

        try {
            return await callback();
        } finally {
            context.pagesBusy.delete(key);
        }
    });

    // Обновляем очередь
    context.pagesQueue.set(key, task.catch(() => {}));
    return task;
}

/**
 * Создает новую страницу для аккаунта и лида, настраивает её и сохраняет в контексте.
 *
 * @param {string|number} account_id - Идентификатор аккаунта.
 * @param {string|number} lead_id - Идентификатор лида.
 * @returns {Promise<import('puppeteer').Page>} - Созданная и настроенная страница.
 */
async function createNewPage(account_id, lead_id) {
    // Получаем или создаем контекст для аккаунта
    let accountContext = await getContext(account_id);

    let page;
    try {
        page = await accountContext.context.newPage();
    } catch (err) {
        await logToFile(`[ERROR] Ошибка создания страницы: ${err.message}`);
        // Пересоздаем контекст и пробуем создать страницу повторно
        accountContext.context = getBrowser();
        accountContext.pagesMap = new Map();
        accountContext.pageTimeouts = new Map();
        accountContext.pagesBusy = new Map();
        await updateContext(account_id);
        page = await accountContext.context.newPage();
    }

    // Если страница закрыта, создаем новую
    if (!page || page.isClosed()) {
        await logToFile(`[WARN] Страница для ${account_id} закрыта. Пересоздаём...`);
        page = await accountContext.context.newPage();
    }

    // Переходим на пустую страницу для инициализации
    try {
        await page.goto("about:blank", { waitUntil: "networkidle2", timeout: 15000 });
    } catch (err) {
        await logToFile(`[ERROR] Ошибка навигации: ${err.message}`);
        page = await accountContext.context.newPage();
        await page.goto("about:blank", { waitUntil: "networkidle2", timeout: 15000 });
    }

    // Настраиваем страницу (User-Agent, Interception и т.д.)
    await configurePage(page);

    // Сохраняем информацию о странице в контексте
    const key = `${account_id}:${lead_id}`;
    accountContext.pagesMap.set(key, "about:blank");
    accountContext.pagesMap.set(`${key}_targetId`, page.target()._targetId);
    accountContext.pagesBusy.set(key, false);
    resetPageTimeout(account_id, lead_id, page);
    await updateContext(account_id);

    return page;
}

/**
 * Получает страницу для аккаунта и лида.
 * Если страница уже существует и работает, возвращает её; иначе – создает новую.
 *
 * @param {string} base_url - Базовый URL, используемый для перехода к лиду.
 * @param {string|number} account_id - Идентификатор аккаунта.
 * @param {string|number} lead_id - Идентификатор лида.
 * @returns {Promise<{ page: import('puppeteer').Page, isNew: boolean }>} -
 */
async function getPage(base_url, account_id, lead_id, expiry = -1) {
    const accountContext = await getContext(account_id);
    const pagesMap = accountContext.pagesMap;
    const pageTimeouts = accountContext.pageTimeouts;
    const pagesBusy = accountContext.pagesBusy;
    const pagesLocks = accountContext.pagesLocks;
    const pagesQueue = accountContext.pagesQueue;
    const key = `${account_id}:${lead_id}`;
    let isNew = false;
    let page = await getPageByKey(account_id, key);

    if (page) {
        await logToFile(`[DEBUG] Найдена страница ${key}: ${page.url()}`);
        try {
            if (page.isClosed()) throw new Error("Страница закрыта");
            const isReady = await page.evaluate(() => document.readyState === 'complete');
            if (isReady) {
                await logToFile(`Переиспользуем страницу для ${key}`);
                const cookiesLoaded = await loadCookies(account_id, page);
                if (cookiesLoaded) {
                    await logToFile(`Куки загружены для ${key}`);
                }
                if (pageTimeouts.has(key)) {
                    clearTimeout(pageTimeouts.get(key));
                    pageTimeouts.delete(key);
                }
                resetPageTimeout(account_id, lead_id, page);
                const authExists = await isAuthPage(page);
                if (authExists) {
                    await logToFile(`[WARN]: Требуется повторная авторизация на странице ${key}`);
                    await page.close();
                    pagesMap.delete(key);
                    pagesMap.delete(`${key}_targetId`);
                    pageTimeouts.delete(key);
                    pagesBusy.delete(key);
                    pagesLocks.delete(key);
                    pagesQueue.delete(key);
                    page = null;
                } else {
                    return { page, isNew: false };
                }
            }
        } catch (err) {
            await logToFile(`[WARN]: Страница ${key} недоступна, создаём новую. Ошибка: ${err.message}`);
        }
    } else {
        await logToFile(`[DEBUG] Ключ ${key} отсутствует в pagesMap, создаём новую страницу`);
    }

    // Если достигнуто максимальное количество страниц для аккаунта, переиспользуем старую
    if (pagesMap.size >= MAX_PAGES_PER_ACCOUNT) {
        const oldestKey = pagesMap.keys().next().value;
        let oldestPage = await getPageByKey(account_id, oldestKey);
        if (oldestPage) {
            await logToFile(`Переиспользуем старую страницу ${oldestKey} с обновлением кук`);
            // Обновляем куки на старой странице
            await setAuthCookies(account_id, oldestPage, access_token, refresh_token, expiry);
            await saveCookies(account_id, oldestPage, expiry);
            resetPageTimeout(account_id, lead_id, oldestPage);
            return { page: oldestPage, isNew: false };
        } else {
            pagesMap.delete(key);
            pagesMap.delete(`${key}_targetId`);
            pageTimeouts.delete(key);
            pagesBusy.delete(key);
            pagesLocks.delete(key);
            pagesQueue.delete(key);
        }
    }

    // Если страницы нет или она не пригодна – создаем новую
    await logToFile(`Открываем новую страницу для ${key}`);
    page = await createNewPage(account_id, lead_id);
    const leadUrl = `${base_url}/leads/detail/${lead_id}`;
    await page.goto(leadUrl, { waitUntil: 'domcontentloaded' });
    pagesMap.set(key, leadUrl);
    pagesMap.set(`${key}_targetId`, page.target()._targetId);
    isNew = true;

    const cookiesLoaded = await loadCookies(account_id, page);
    if (cookiesLoaded) {
        await logToFile(`Куки загружены для ${key}`);
    }
    const authExists = await isAuthPage(page);
    if (!authExists) {
        isNew = false;
    }
    resetPageTimeout(account_id, lead_id, page);
    await updateContext(account_id);

    return { page, isNew };
}

/**
 * Настраивает страницу: устанавливает userAgent, перехватывает запросы, отключает кеш и скрывает webdriver.
 *
 * @param {import('puppeteer').Page} page - Объект страницы Puppeteer.
 * @returns {Promise<void>}
 */
async function configurePage(page) {
    page.on('error', async (err) => await logToFile('[Puppeteer] Error:', err));
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    await page.setRequestInterception(true);
    await page.setBypassCSP(true);
    await page.setCacheEnabled(false);
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    page.on("request", request => {
        const url = request.url();
        const resourceType = request.resourceType();
        if (["image", "svg", "media", "audio", "font"].includes(resourceType) || url.startsWith("data:image")) {
            // await logToFile(`[BLOCKED] ${url.substr(0, 100)}`);
            request.abort();
        } else {
            request.continue();
        }
    });
}

/**
 * Получает страницу по ключу из карты страниц.
 * @param {string} account_id - ID аккаунта.
 * @param {string} key - Ключ страницы.
 * @returns {Promise<import('puppeteer').Page | null>} - Страница или `null`, если не найдена.
 */
async function getPageByKey(account_id, key) {
    const accountContext = await getContext(account_id);
    if (!accountContext) {
        await logToFile(`[ERROR] Контекст для accountId ${account_id} не найден`);
        return null;
    }

    if (!accountContext.context) {
        await logToFile(`[ERROR] Контекст Puppeteer для accountId ${account_id} не инициализирован`);
        return null;
    }

    const storedUrl = accountContext.pagesMap.get(key);
    if (!storedUrl) return null;

    await logToFile(`Возвращаем страницу по ключу ${key}...`);
    const pages = await accountContext.context.pages();
    return pages.find(p => normalizeUrl(p.url()) === normalizeUrl(storedUrl)) || null;
}

/**
 * Сбрасывает таймер автоматического закрытия страницы для указанного лида.
 * @param {string} account_id - ID аккаунта.
 * @param {string} lead_id - ID лида.
 * @param {import('puppeteer').Page} page - Экземпляр Puppeteer.
 * @returns {Promise<void>}
 */
async function resetPageTimeout(account_id, lead_id, page) {
    const accountContext = await getContext(account_id);
    const key = `${account_id}:${lead_id}`;

    // Гарантируем существование структур данных
    accountContext.pageTimers ||= new Map();
    accountContext.pageTimeouts ||= new Map();
    accountContext.pagesMap ||= new Map();
    accountContext.pagesBusy ||= new Map();
    accountContext.pagesLocks ||= new Map();
    accountContext.pagesQueue ||= new Map();

    // Удаляем старый таймер, если он был установлен
    if (accountContext.pageTimers.has(key)) {
        clearTimeout(accountContext.pageTimers.get(key));
    }

    // Устанавливаем новый таймаут на 5 минут
    const timeout = setTimeout(async () => {
        await logToFile(`Проверяем неактивность страницы ${key}...`);

        try {
            const pages = await getBrowser().pages();
            if (pages.length <= 1) {
                await logToFile(`Страница ${key} - последняя в браузере, не закрываем.`);
                return;
            }

            await logToFile(`Закрываем страницу ${key} за неактивность`);
            if (!page.isClosed()) {
                await page.close();
            }

            // Удаляем из локального контекста
            accountContext.pagesMap.delete(key);
            accountContext.pagesMap.delete(`${key}_targetId`);
            accountContext.pageTimers.delete(key);
            accountContext.pageTimeouts.delete(key);
            accountContext.pagesBusy.delete(key);
            accountContext.pagesLocks.delete(key);
            accountContext.pagesQueue.delete(key);

            // Обновляем Redis только если остались страницы
            if (accountContext.pagesMap.size > 0 || accountContext.pageTimeouts.size > 0) {
                await saveContext(`ctx:${account_id}`, accountContext);
            } else {
                await redisClient.del(`ctx:${account_id}`);
            }

        } catch (err) {
            await logToFile(`[ERROR]: Ошибка при закрытии страницы ${key}: ${err.message}`);
        }
    }, 5 * 60 * 1000);

    // Обновляем таймеры и сохраняем контекст
    accountContext.pageTimers.set(key, timeout);
    accountContext.pageTimeouts.set(key, Date.now() + 5 * 60 * 1000);
    await saveContext(`ctx:${account_id}`, accountContext);
}

/**
 * Очистка неактивных контекстов (раз в 5 минут)
 */
setInterval(async () => {
    const now = Date.now();
    const allContextIds = Object.keys(contextStore);

    for (const account_id of allContextIds) {
        // Если это единственный контекст – пропускаем удаление
        if (allContextIds.length <= 1) {
            await logToFile(`Контекст ${account_id} является единственным, не удаляем его.`);
            continue;
        }

        if (now - contextStore[account_id].timestamp > 30 * 60 * 1000) {
            await logToFile(`Удаляем контекст ${account_id} (неактивен более 30 минут)`);

            try {
                // Проверяем, что контекст существует, прежде чем пытаться закрыть
                const context = contextStore[account_id];
                if (context) {
                    await context.context.close();
                    await logToFile(`Контекст ${account_id} закрыт`);
                    await clearContext(account_id);
                } else {
                    await logToFile(`[WARN] Контекст ${account_id} уже закрыт или не существует`);
                }
            } catch (err) {
                await logToFile(`[ERROR]: Ошибка при удалении контекста ${account_id}: ${err.message}`);
            }
        }
    }
}, 5 * 60 * 1000);

/**
 * Перезапуск браузера раз в 15 минут.
 * Закрывает неактивные страницы, перезапускает их и восстанавливает контексты.
 */
setInterval(async () => {
    if (!getBrowser()) return;

    await logToFile("Перезапускаем браузерный контекст...");

    await closeInactivePages();
    await restartPagesForAccounts();

}, 15 * 60 * 1000); // Перезапуск каждые 15 минут

/**
 * Закрывает все страницы, которые не заняты.
 */
async function closeInactivePages() {
    try {
        for (const account_id of Object.keys(contextStore)) {
            const context = contextStore[account_id];
            if (!context.pagesMap) continue;

            const now = Date.now();

            for (const key of context.pagesMap.keys()) {
                if (key.endsWith("_targetId")) {
                    await logToFile(`⏩ Пропускаем ключ: ${key}`);
                    continue;
                }

                const lastBusyTimestamp = context.pagesBusy.get(key);

                // Проверяем, занята ли страница более 5 минут
                if (lastBusyTimestamp && now - lastBusyTimestamp > 5 * 60 * 1000) {
                    await logToFile(`🛑 Удаляем занятую страницу: ${key}, так как прошло 5 минут.`);
                    context.pagesMap.delete(key);
                    context.pagesBusy.delete(key);
                    context.pagesLocks.delete(key);
                    context.pagesQueue.delete(key);
                    continue;
                }

                try {
                    const lead_id = extractLeadId(key);
                    if (!lead_id) continue;

                    const page = await getPage(account_id, lead_id);
                    if (page && !page.isClosed()) {
                        await page.close();
                        await logToFile(`Страница ${key} закрыта.`);
                    }
                } catch (err) {
                    await logToFile(`[ERROR] Ошибка закрытия страницы ${key}: ${err.message}`);
                }
            }
        }
    } catch (err) {
        await logToFile(`[ERROR] Ошибка при закрытии страниц: ${err.message}`);
    }
}

/**
 * Перезапускает страницы для всех аккаунтов.
 */
async function restartPagesForAccounts() {
    for (const account_id of Object.keys(contextStore)) {
        await logToFile(`Перезапускаем страницы для ${account_id}`);
        try {
            const savedContext = await loadContext(`ctx:${account_id}`);
            const savedPages = new Map(savedContext.pagesMap || []);
            const savedTimeouts = new Map(savedContext.pageTimeouts || []);

            for (const [key, url] of savedPages.entries()) {
                if (key.endsWith("_targetId") || !isValidUrl(url)) {
                    await logToFile(`[ERROR] Невалидный URL для ${key}: ${url}`);
                    continue;
                }

                try {
                    const page = await getBrowser().newPage();
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

                    pagesMap.set(key, url);
                    pagesMap.set(`${key}_targetId`, page.target()._targetId);

                    if (savedTimeouts.has(key)) {
                        const lead_id = extractLeadId(key);
                        if (lead_id) resetPageTimeout(account_id, lead_id, page);
                    }

                    await logToFile(`Страница ${key} восстановлена`);
                } catch (err) {
                    await logToFile(`[ERROR] Ошибка загрузки ${key}: ${err.message}`);
                }
            }

            contextStore[account_id] = {
                context: getBrowser(),
                pagesMap: new Map(),
                pageTimeouts: savedTimeouts,
                pagesBusy: new Map(),
                pagesLocks: new Map(),
                pagesQueue: new Map(),
                requestCount: 0,
                timestamp: Date.now(),
            };

            await saveContext(`ctx:${account_id}`, contextStore[account_id]);
            await logToFile(`Контекст для ${account_id} обновлён`);
        } catch (err) {
            await logToFile(`[ERROR] Ошибка перезапуска для ${account_id}: ${err.message}`);
        }
    }
}

/**
 * Извлекает lead_id из ключа.
 * @param {string} key - Ключ в формате "accountId_leadId".
 * @returns {string|null} - Возвращает lead_id или null, если формат неверен.
 */
function extractLeadId(key) {
    const keyParts = key.split("_");
    return keyParts.length >= 2 ? keyParts[1] : null;
}

/**
 * Проверяет, является ли строка валидным URL.
 * @param {string} url - Проверяемый URL.
 * @returns {boolean} - true, если URL корректный.
 */
function isValidUrl(url) {
    return typeof url === 'string' && url.startsWith('http');
}

/**
 * Безопасно выполняет клик по элементу.
 * Сначала выполняет серию из 2 попыток. Если они неудачны, перезагружает страницу и повторяет серию ещё 2 раза.
 *
 * @param {import('puppeteer').Page} page - Объект страницы Puppeteer.
 * @param {string} selector - CSS-селектор элемента, по которому необходимо кликнуть.
 * @param {number} [delay=1000] - Задержка (в миллисекундах) после клика перед продолжением.
 * @returns {Promise<boolean>} - Возвращает true, если клик выполнен успешно, иначе false.
 */
async function safeClick(page, selector, delay = 1000) {
    // Первая попытка: без перезагрузки
    if (await attemptClick(page, selector, delay)) {
        return true;
    }
    await logToFile(`attemptClick: Не удалось кликнуть по ${selector} с первой серии попыток, перезагружаем страницу...`);
    try {
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 2000)); // Небольшая задержка после перезагрузки
        return await attemptClick(page, selector, delay);
    } catch (reloadErr) {
        await logToFile(`attemptClick: Ошибка перезагрузки страницы: ${reloadErr.message}`);
        return false;
    }
}

/**
 * Пытается выполнить клик по указанному селектору заданное число раз с экспоненциальной задержкой.
 * Если элемент не найден или клик не удался, делает скриншот ошибки.
 *
 * @param {import('puppeteer').Page} page - Объект страницы Puppeteer.
 * @param {string} selector - CSS-селектор элемента, по которому необходимо кликнуть.
 * @param {number} delay - Задержка (в миллисекундах) после клика при успешном выполнении.
 * @returns {Promise<boolean>} - Возвращает true, если клик выполнен успешно, иначе false.
 */
async function attemptClick(page, selector, delay) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        await page.screenshot({ path: `error_safeClick_${selector}_${attempt}.png` });
        try {
            await logToFile(`safeClick: Попытка ${attempt} клика по ${selector}`);
            // Ждем, пока элемент появится и станет видимым
            await page.waitForSelector(selector, { visible: true, timeout: 5000 });

            // Проверка, что элемент не перекрыт другим объектом
            const isClickable = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const { x, y, width, height } = el.getBoundingClientRect();
                const centerX = x + width / 2;
                const centerY = y + height / 2;
                const topEl = document.elementFromPoint(centerX, centerY);
                return el === topEl;
            }, selector);
            if (!isClickable) {
                throw new Error(`Элемент ${selector} перекрыт другим объектом`);
            }

            // Пытаемся кликнуть
            await page.click(selector);
            await new Promise(resolve => setTimeout(resolve, delay));
            await logToFile(`safeClick: Клик по ${selector} выполнен`);
            return true;
        } catch (err) {
            await logToFile(`safeClick: Ошибка при клике на ${selector}, попытка ${attempt}: ${err.message}`);
            await page.screenshot({ path: `error_safeClick_${selector}_${attempt}.png` });
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
    return false;
}

/**
 * Проверяет, требует ли страница авторизации.
 * @param {import('puppeteer').Page} page - Экземпляр Puppeteer.
 * @returns {Promise<boolean>} - `true`, если страница требует авторизации, иначе `false`.
 */
async function isAuthPage(page) {
    return await Promise.race([
        page.$$('#authentication').then(el => el.length > 0),
        new Promise(resolve => setTimeout(() => resolve(false), 5000))
    ]);
}

/**
 * Устанавливает куки для авторизации на странице.
 * @param {string} account_id - ID аккаунта.
 * @param {import('puppeteer').Page} page - Экземпляр Puppeteer.
 * @param {string} access_token - Токен доступа.
 * @param {string} refresh_token - Токен обновления.
 * @param {number} expiry - Время истечения токенов (timestamp).
 * @returns {Promise<void>}
 */
async function setAuthCookies(account_id, page, access_token, refresh_token, expiry) {
    const domain = 'amocrm.ru';
    try {
        await page.setCookie(
            { name: 'access_token', value: access_token, domain: `.${domain}`, secure: true, expires: expiry },
            { name: 'refresh_token', value: refresh_token, domain: `.${domain}`, secure: true, expires: expiry }
        );
        await logToFile(`Куки установлены для домена ${domain}`);
    } catch (error) {
        await logToFile(`Ошибка установки кук: ${error.message}`);
    }
}

/**
 * Переходит на страницу лида и обновляет контекст.
 * @param {import('puppeteer').Page} page - Экземпляр Puppeteer.
 * @param {string} account_id - ID аккаунта.
 * @param {string} lead_id - ID лида.
 * @param {string} base_url - Базовый URL.
 * @returns {Promise<void>}
 */
async function navigateToLead(page, account_id, lead_id, base_url) {
    try {
        const targetUrl = `${base_url}/leads/detail/${lead_id}`;
        await logToFile(`Переход к лидам: ${targetUrl}`);

        const [response] = await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }), // networkidle2
            page.goto(targetUrl, { waitUntil: 'load', timeout: 15000 })
        ]);

        const currentUrl = await page.url();
        await logToFile(`Навигация завершена. Текущий URL: ${currentUrl}`);

        // Обновляем URL в pagesMap
        const accountContext = await getContext(account_id);
        if (accountContext.pagesMap) {
            accountContext.pagesMap.set(`${account_id}:${lead_id}`, currentUrl);
            await updateContext(account_id);
        }
    } catch (error) {
        await logToFile(`Ошибка перехода к лидам: ${error.message}`);
    }
}

/**
 * Обрабатывает авторизацию на странице: загружает сохранённые куки,
 * выполняет повторный вход (при необходимости) и сохраняет куки.
 *
 * @param {import('puppeteer').Page} page - Объект страницы Puppeteer.
 * @param {string|number} account_id - Идентификатор аккаунта.
 * @param {string} access_token - Токен доступа.
 * @param {string} refresh_token - Токен обновления.
 * @param {number} expiry - Время истечения срока действия токена (в секундах или миллисекундах, зависит от реализации).
 * @returns {Promise<boolean>} - Возвращает true, если авторизация успешна, иначе false.
 */
async function handleAuthorization(page, account_id, access_token, refresh_token, expiry) {
    if (!(await loadCookies(account_id, page))) {
        await setAuthCookies(account_id, page, access_token, refresh_token, expiry);
        await saveCookies(account_id, page, expiry);
        await page.reload({ waitUntil: 'networkidle2' });
        await logToFile(`Страница обновлена после установки кук`);
    }

    if (await isAuthPage(page)) {
        await setAuthCookies(account_id, page, access_token, refresh_token, expiry);
        await saveCookies(account_id, page, expiry);
        await page.reload({ waitUntil: 'networkidle2' });

        if (await isAuthPage(page)) {
            await logToFile(`Ошибка авторизации: требуется вход`);
            return false;
        }
    }
    return true;
}

/**
 * Переходит в чат: проверяет наличие элемента переключателя и, при необходимости, открывает чат.
 *
 * @param {import('puppeteer').Page} page - Объект страницы Puppeteer.
 * @returns {Promise<boolean>} - Возвращает true, если чат успешно открыт, иначе false.
 */
async function navigateToChat(page) {
    const isNotesVisible = await page.evaluate(() => document.querySelector(".notes-wrapper") !== null);
    await logToFile(`notes-wrapper виден: ${isNotesVisible}`);
    await new Promise(resolve => setTimeout(resolve, 500));

    const switcherText = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : "";
    }, '.feed-compose-switcher');

    if (switcherText !== "Чат") {
        await new Promise(resolve => setTimeout(resolve, 5000));

        if (!(await safeClick(page, '.feed-compose-switcher', 15000))) {
            return false;
        }

        await logToFile(`Ожидаем появления кнопки чата`);
        await page.waitForSelector('[data-id="chat"]', { timeout: 15000 });

        if (!(await safeClick(page, '[data-id="chat"]', 15000))) {
            return false;
        }
    }
    return true;
}

/**
 * Выбирает пользователя и получателя для отправки сообщения.
 * Если имя пользователя уже сохранено в кэше и совпадает с текущим, клики пропускаются.
 *
 * @param {import('puppeteer').Page} page - Объект страницы Puppeteer.
 * @param {string|number} account_id - Идентификатор аккаунта.
 * @param {string|number} lead_id - Идентификатор лида.
 * @returns {Promise<boolean>} - Возвращает true, если пользователь и получатель выбраны успешно, иначе false.
 */
async function selectRecipient(page, account_id, lead_id) {
    const userSelector = '.feed-compose-user__name';
    const recipientSelector = '.multisuggest__suggest-item';
    const cacheKey = `username:${account_id}:${lead_id}`;

    await logToFile(`Ожидаем появления пользователя`);
    const userElement = await page.waitForSelector(userSelector, { timeout: 15000 }).catch(() => null);
    if (!userElement) {
        await logToFile(`Не найден пользовательский элемент: ${userSelector}`);
        return false;
    }

    // Получаем текст из элемента пользователя
    const userText = await page.$eval(userSelector, el => el.innerText.trim());
    const cachedUsername = await getUsername(account_id, lead_id);
    if (cachedUsername && cachedUsername === userText) {
        await logToFile(`Пользователь уже выбран.`);
        return true;
    }

    // Если имя не совпадает или отсутствует в кэше, выполняем клики для выбора пользователя
    if (!(await safeClick(page, userSelector, 15000))) {
        return false;
    }

    await logToFile(`Ожидаем появления получателя`);
    const recipientElement = await page.waitForSelector(recipientSelector, { timeout: 15000 }).catch(() => null);
    if (!recipientElement) {
        await logToFile(`Не найден элемент получателя: ${recipientSelector}`);
        return false;
    }
    if (!(await safeClick(page, recipientSelector, 15000))) {
        return false;
    }

    // После выбора, сохраняем имя выбранного пользователя в кэш
    const selectedUser = await page.$eval(userSelector, el => el.innerText.trim());
    await saveUsername(account_id, lead_id, selectedUser);
    await logToFile(`Выбран пользователь "${selectedUser}" сохранён в кэше с ключом ${cacheKey}`);

    return true;
}

/**
 * Вводит сообщение в div[contenteditable="true"] и отправляет его.
 *
 * @param {import('puppeteer').Page} page - Объект страницы Puppeteer.
 * @param {string} message_text - Текст сообщения для отправки.
 * @returns {Promise<boolean>} - Возвращает true, если сообщение отправлено, иначе false.
 */
async function sendMessage(page, message_text) {
    await logToFile(`Ожидаем появления поля ввода сообщения`);

    const success = await page.evaluate(async (message_text) => {
        const inputSelector = '.feed-compose__message';
        const buttonSelector = '.feed-note__button';

        // Ожидание появления поля ввода
        const inputField = document.querySelector(inputSelector);
        if (!inputField) {
            await logToFile(`Поле ввода не найдено: ${inputSelector}`);
            return false;
        }

        // Активируем поле ввода (через click, так как focus не всегда срабатывает)
        inputField.click();

        // Очищаем поле (через selection + delete)
        const range = document.createRange();
        range.selectNodeContents(inputField);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete');

        // Вставляем текст с помощью insertText
        document.execCommand('insertText', false, message_text);

        // Проверяем, что текст действительно вставился
        if (inputField.innerText.trim() !== message_text) {
            await logToFile(`Текст введён некорректно`);
            return false;
        }

        // Прокручиваем кнопку в видимую область
        const sendButton = document.querySelector(buttonSelector);
        if (!sendButton) {
            await logToFile(`Кнопка отправки не найдена: ${buttonSelector}`);
            return false;
        }
        sendButton.scrollIntoView({ behavior: "smooth", block: "center" });

        // Кликаем по кнопке
        sendButton.click();
        return true;
    }, message_text);

    if (!success) {
        await logToFile(`Не удалось отправить сообщение`);
        return false;
    }

    await logToFile(`Сообщение отправлено успешно`);
    return true;
}

/**
 * Обновляет счётчик запросов для аккаунта в контекстном хранилище и сохраняет обновлённый контекст.
 *
 * @param {string|number} account_id - Идентификатор аккаунта.
 * @returns {Promise<void>}
 */
async function updateRequestCount(account_id) {
    if (contextStore[account_id]) {
        contextStore[account_id].requestCount = (contextStore[account_id].requestCount || 0) + 1;
        await saveContext(`ctx:${account_id}`, contextStore[account_id]);
        await logToFile(`Обновлённый счётчик запросов для ${account_id}: ${contextStore[account_id].requestCount}`);
    }
}

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

    if (!getBrowser()) {
        await logToFile(`Браузер не инициализирован, перезапускаем...`);
        await launchBrowser(false, account_id);
    }
    if (!getBrowser()) {
        throw new Error("Не удалось инициализировать браузер");
    }

    var status, message;
    try {
        const result = await withPageLock(account_id, lead_id, async () =>
            withRetries(() => sendLeadMessage({
                account_id, base_url, access_token, refresh_token, lead_id, message_text, expiry
            }))
        );
        var { status, message } = result;
    } catch (error) {
        await logToFile(`[ERROR] Ошибка отправки сообщения: ${error.message}`);
        var status = 500;
        var message = { error: "Failed to send message after retries" };
    }

    const totalTime = Date.now() - startTime;
    await logToFile(`[DEBUG] Время выполнения: ${totalTime} мс`);
    return res.status(status).json(message);
});

/**
 * Запускает сервер Puppeteer-сервиса.
 * @constant {number} PORT - Порт сервера.
 * @returns {Promise<void>}
 */
app.listen(PORT, '0.0.0.0', async () => {
    await logToFile(`Puppeteer service running on port ${PORT}`)
});
