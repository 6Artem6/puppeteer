import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createClient } from "redis";
import dotenv from "dotenv";
import { promises as dns } from "dns";
import { logToFile } from './logger.mjs';
import { mapsEqual } from './utils.mjs';
import { encryptAndCompress, decryptAndDecompress } from './cryptoUtils.mjs';

export {
    createClient
}

let browser = null; // Переменная для хранения экземпляра браузера Puppeteer

export function getBrowser() {
    return browser;
}

export function setBrowser(instance) {
    browser = instance;
}


// Загружаем переменные окружения
dotenv.config();


const MAX_CONTEXTS = 5;
const MAX_REQUEST_COUNT = 10;
const contextStore = {};

// Создаем глобальный Redis-клиент
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redisClient = createClient({
    url: `redis://${REDIS_HOST}:${REDIS_PORT}`
});

puppeteer.use(StealthPlugin()); // Используем плагин Stealth для обхода детектирования ботов

// Немедленно вызываемая асинхронная функция (IIFE) для подключения к Redis
(async () => {
    try {
        // Проверяем, открыт ли клиент Redis
        if (!redisClient.isOpen) {
            // Подключаемся к Redis, если соединение отсутствует
            await redisClient.connect().catch(console.error);
        }
        await logToFile("✅ Подключено к Redis");
    } catch (err) {
        // Логируем ошибку подключения
        await logToFile("❌ Ошибка подключения к Redis:", err);
    }
})();

// Обработчики событий для Redis
redisClient.on("connect", async () => await logToFile("✅ Подключено к Redis"));
redisClient.on("error", async (err) => await logToFile("❌ Ошибка Redis:", err));

/**
 * Запускает экземпляр браузера.
 * @param {boolean} [force=false] - Если `true`, принудительно перезапускает браузер.
 * @returns {Promise<import('puppeteer').Browser>} - Запущенный браузер.
 */
async function launchBrowserCreate(force = false) {
    const profilePath = path.join(__dirname, "profile");
    if (!browser || force) {
        try {
            await logToFile(`Запускаем браузер в ${profilePath}`);
            browser = await puppeteer.launch({
                headless: "new",
                timeout: 60000,
                protocolTimeout: 180000,
                args: [
                    `--user-data-dir=${profilePath}`, // Используем уникальную директорию профиля
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-accelerated-2d-canvas",
                    "--disable-webgl",
                    "--disable-software-rasterizer",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--disable-extensions",
                    "--disable-features=site-per-process",
                    "--no-first-run",
                    "--mute-audio",
                    "--no-zygote",
                    "--enable-low-res-tiles",
                    "--disable-sync",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-breakpad",
                    "--disable-component-extensions-with-background-pages",
                    "--disable-features=TranslateUI,BlinkGenPropertyTrees",
                    "--disable-ipc-flooding-protection",
                    "--disable-renderer-backgrounding",
                    "--enable-features=NetworkService,NetworkServiceInProcess",
                    "--force-color-profile=srgb",
                    "--hide-scrollbars",
                    "--metrics-recording-only",
                    "--no-pings",
                    "--password-store=basic",
                    "--use-mock-keychain",
                    '--memory-pressure-off',
                    '--max-old-space-size=4096',
                ],
            });
            await logToFile(`Браузер успешно запущен`);
        } catch (error) {
            await logToFile(`Ошибка запуска браузера: ${error.message}`);
        }
    }
    return browser;
}

/**
 * Подключается к удалённому браузеру и создаёт инкогнито-контекст с индивидуальными параметрами.
 *
 * @param {boolean} [force=false] - Если true, принудительно переподключается к браузеру.
 * @param {string|null} [accountId=null] - Идентификатор аккаунта.
 * @returns {Promise<import('puppeteer-core').BrowserContext>} - Инкогнито-контекст с индивидуальными параметрами.
 */
async function launchBrowser(force = false, accountId = null) {
    if (browser && !force) return browser;

    await logToFile(`🔄 Запускаем браузер для accountId: ${accountId}`);

    if (!process.env.BROWSER_HOST) {
        throw new Error("Переменная окружения BROWSER_HOST не установлена");
    }

    try {
        // Получаем sessionId из Redis (для заголовков)
        const sessionId = await getSession(accountId);
        const headers = { "X-Session-ID": sessionId || "", "Host": "localhost" };

        // Получаем IP адрес browser-service из Redis
        let ip = await getBrowserServiceIP();
        if (!ip) {
            await logToFile("ℹ IP не найден в Redis. Запускаем resolveAndSave...");
            ip = await resolveAndSave(process.env.BROWSER_HOST);
            if (!ip) throw new Error("❌ Не удалось получить IP через resolveAndSave");
        }

        const url = `http://${ip}:9222/json/version`;
        await logToFile(`📡 Делаем запрос к ${url}`);

        // Выполняем fetch с ретраями и повторным разрешением DNS каждые 2 неудачные попытки
        const maxAttempts = 10;
        const delay = 2000; // 2 секунды
        let fetchAttempts = 0;
        let response;

        while (fetchAttempts < maxAttempts) {
            try {
                response = await fetch(url, { headers });
                if (response.ok) {
                    break;
                }
                throw new Error(`Ошибка запроса: ${response.status}`);
            } catch (err) {
                fetchAttempts++;
                await logToFile(`❌ Ошибка запроса к browser-service (попытка ${fetchAttempts}): ${err.message}`);

                // Если попытка четная (каждая вторая ошибка) – повторно резолвим имя
                if (fetchAttempts > 2) {
                    await logToFile("🔁 Повторное разрешение имени через nslookup...");
                    ip = await resolveAndSave(process.env.BROWSER_HOST);
                    if (!ip) {
                        await logToFile("❌ resolveAndSave не вернул IP");
                    } else {
                        // Обновляем URL запроса после получения нового IP
                        await logToFile(`✅ Новый IP: ${ip}`);
                    }
                }

                if (fetchAttempts >= maxAttempts) {
                    throw err;
                }
                await logToFile(`🔁 Повтор через ${delay / 1000} сек...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // Если сервер вернул новый sessionId – сохраняем его
        const newSessionId = response.headers.get("X-Session-ID");
        await logToFile(`✅ newSessionId: ${newSessionId}`);

        if (newSessionId && newSessionId !== sessionId) {
            await logToFile(`✅ saveSession: ${accountId} - ${newSessionId}`);
            await saveSession(accountId, newSessionId);
        }

        const { webSocketDebuggerUrl: endpoint } = await response.json();
        if (!endpoint) {
            throw new Error("browser-service не вернул WebSocket URL");
        }

        await logToFile(`✅ Получен WebSocket URL: ${endpoint}`);

        return await connectWithRetries(endpoint);
    } catch (error) {
        await logToFile(`❌ Ошибка launchBrowser: ${error.message}`);
        throw error;
    }
}

/**
 * Подключается к браузеру Puppeteer с повторными попытками.
 * @async
 * @function
 * @param {string} endpoint - WebSocket URL браузера Puppeteer.
 * @param {number} [maxAttempts=10] - Максимальное количество попыток подключения.
 * @param {number} [delay=2000] - Задержка между попытками в миллисекундах.
 * @returns {Promise<import('puppeteer').Browser>} - Объект браузера Puppeteer.
 * @throws {Error} Если все попытки подключения не удались.
 */
async function connectWithRetries(endpoint, maxAttempts = 10, delay = 2000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await logToFile(`🔌 Попытка подключения ${attempt}/${maxAttempts}...`);

            browser = await puppeteer.connect({
                browserWSEndpoint: endpoint,
                defaultViewport: null,
                headless: "new",
                timeout: 60000,
                protocolTimeout: 180000
            });

            await logToFile("🚀 Подключение к браузеру успешно установлено");
            return browser;
        } catch (error) {
            await logToFile(`❌ Ошибка подключения: ${error.message}`);
            if (attempt === maxAttempts) {
                await logToFile("⛔ Достигнут лимит попыток. Остановка.");
                throw error;
            }
            await logToFile(`🔁 Повтор через ${delay / 1000} сек...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

/**
 * Резолвит IP-адрес сервиса по его имени и сохраняет его в Redis.
 * @async
 * @function
 * @param {string} serviceName - Имя сервиса, который нужно резолвить.
 * @returns {Promise<string|null>} - IP-адрес сервиса или `null`, если резолв не удался.
 */
async function resolveAndSave(serviceName) {
    try {
        await logToFile(`🔍 Резолвим ${serviceName}...`);

        const addresses = await dns.lookup(serviceName, { all: true });
        if (!addresses.length) throw new Error("Адрес не найден");

        const ip = addresses[0].address;
        await logToFile(`✅ IP-адрес ${serviceName}: ${ip}`);

        await redisClient.set(`browser-service-ip`, ip);
        await logToFile(`💾 IP сохранён в Redis: ${ip}`);

        return ip;
    } catch (error) {
        await logToFile(`❌ Ошибка резолва ${serviceName}: ${error.message}`);
        return null;
    }
}

/**
 * Получает IP-адрес браузерного сервиса из Redis.
 * @async
 * @function
 * @returns {Promise<string|null>} - IP-адрес браузерного сервиса или `null`, если он не найден.
 */
async function getBrowserServiceIP() {
    return await redisClient.get("browser-service-ip");
}

/**
 * Загружает или создаёт контекст для указанного аккаунта.
 * @param {string} accountId - ID аккаунта.
 * @returns {Promise<{
 *  context: import('puppeteer').BrowserContext,
 *  pagesMap: Map<string, string>,
 *  pageTimeouts: Map<string, NodeJS.Timeout>, timestamp: number,
 *  pagesBusy: Map<string, string>,
 *  pagesLocks: Map<string, string>,
 *  pagesQueue: Map<string, string>,
 *  requestCount: number
 * }>} - Контекст аккаунта.
 */
async function getContext(accountId) {
    const contextId = `ctx:${accountId}`;

    // Если количество контекстов превышает лимит, удаляем самый старый
    if (Object.keys(contextStore).length >= MAX_CONTEXTS) {
        const oldestAccountId = Object.entries(contextStore)
            .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0][0]; // Самый старый контекст

        await logToFile(`Превышен лимит контекстов (${MAX_CONTEXTS}). Удаляем контекст: ${oldestAccountId}`);

        try {
            // Закрываем страницы, если они открыты
            for (const page of contextStore[oldestAccountId].pagesMap.values()) {
                if (page && !page.isClosed()) {
                    await page.close();
                }
            }
            delete contextStore[oldestAccountId];
            await logToFile(`Контекст ${oldestAccountId} очищен`);
        } catch (err) {
            await logToFile(`[ERROR] Ошибка при очистке контекста ${oldestAccountId}: ${err.message}`);
        }
    }

    // Если контекст уже существует, возвращаем его
    if (contextStore[accountId]) {
        const contextData = contextStore[accountId];
        await logToFile(`Используем существующий контекст для accountId: ${accountId}. Запросов: ${contextData.requestCount}`);

        // Обновляем страницы после 10 запросов
        if (contextData.requestCount >= MAX_REQUEST_COUNT) {
            await logToFile(`Достигнуто 10 запросов для контекста ${accountId}, перезапускаем страницы...`);
            try {
                const allPages = await getBrowser().pages(); // Получаем все страницы в браузере
                for (const [key, url] of contextData.pagesMap.entries()) {
                    if (key.endsWith("_targetId")) continue;

                    const page = allPages.find(p => p.url() === url); // Ищем страницу по URL
                    if (page) {
                        await page.close();
                        await logToFile(`Закрыта страница: ${url}`);
                    }
                }
                contextData.pagesMap = new Map(); // Очищаем Map
                contextData.timestamp = Date.now();
                contextData.pagesBusy = new Map(); // Очищаем Map занятости
                contextData.pagesLocks = new Map(); // Очищаем Map занятости
                contextData.pagesQueue = new Map(); // Очищаем Map занятости
                contextData.requestCount = 0;
                await saveContext(contextId, contextData);
            } catch (err) {
                await logToFile(`[ERROR] Ошибка очистки страниц для ${accountId}: ${err.message}`);
            }
        }
        return contextData;
    }

    // Загружаем контекст из Redis, если он существует
    let contextData = await loadContext(contextId);
    if (contextData) {
        await logToFile(`Загружен контекст для accountId: ${accountId} с key: ${contextId}`);

        // Восстанавливаем pagesMap из сохранённых данных (предполагается, что pagesMap сохранялся как массив)
        const restoredPagesMap = new Map(contextData.pagesMap || []);
        // Восстанавливаем страницы, если нужно (код восстановления страниц)
        for (const [key, url] of restoredPagesMap.entries()) {
            if (key.endsWith("_targetId")) continue;
            await logToFile(`[DEBUG] Пересоздаём страницу ${key} для URL: ${url}`);
            try {
                const page = await getBrowser().newPage();
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
                // Обновляем restoredPagesMap для targetId
                restoredPagesMap.set(`${key}_targetId`, page.target()._targetId);
            } catch (err) {
                await logToFile(`[ERROR] Ошибка восстановления страницы ${key}: ${err.message}`);
            }
        }
        contextData.pagesMap = restoredPagesMap;

        // Если pagesBusy отсутствует или не является Map, создаём новую Map
        if (!contextData.pagesBusy || !(contextData.pagesBusy instanceof Map)) {
            contextData.pagesBusy = new Map();
        }
        if (!contextData.pagesMap || !(contextData.pagesMap instanceof Map)) {
            contextData.pagesMap = new Map();
        }
        if (!contextData.pagesQueue || !(contextData.pagesQueue instanceof Map)) {
            contextData.pagesQueue = new Map();
        }

        contextStore[accountId] = contextData;
        await saveContext(contextId, contextData);
        return contextData;
    }

    // Если контекст отсутствует, создаём новый
    await logToFile(`[DEBUG] Создаём новый контекст для accountId: ${accountId}`);
    contextData = {
        context: getBrowser(),
        pagesMap: new Map(),
        pageTimeouts: new Map(),
        pagesBusy: new Map(),
        pagesLocks: new Map(),
        pagesQueue: new Map(),
        timestamp: Date.now(),
        requestCount: 0
    };

    contextStore[accountId] = contextData;
    await saveContext(contextId, contextData);
    await logToFile(`Создан новый контекст для accountId: ${accountId} с key: ${contextId}`);
    return contextData;
}

/**
 * Загружает контекст из Redis.
 * @param {string} contextId - ID контекста.
 * @returns {Promise<void>} - Данные контекста.
 */
async function saveContext(contextId, newContextData) {
    try {
        // Загружаем существующие данные контекста
        let existingData = await loadContext(contextId);

        // Если контекст не существует, создаем пустой контекст
        if (!existingData) {
            existingData = {
                pagesMap: new Map(),
                pageTimeouts: new Map(),
                pagesBusy: new Map(),
                pagesLocks: new Map(),
                pagesQueue: new Map(),
                requestCount: 0,
                timestamp: Date.now()
            };
        }

        // Проверка на изменения контекста
        let contextChanged = false;
        // Сравниваем и обновляем pagesMap, если данные изменились
        if (!mapsEqual(existingData.pagesMap, newContextData.pagesMap)) {
            existingData.pagesMap = new Map(newContextData.pagesMap);
            contextChanged = true;
        }
        // Сравниваем и обновляем pageTimeouts, если данные изменились
        if (!mapsEqual(existingData.pageTimeouts, newContextData.pageTimeouts)) {
            existingData.pageTimeouts = new Map(newContextData.pageTimeouts);
            contextChanged = true;
        }
        // Сравниваем и обновляем pagesBusy, если данные изменились
        if (!mapsEqual(existingData.pagesBusy, newContextData.pagesBusy)) {
            existingData.pagesBusy = new Map(newContextData.pagesBusy);
            contextChanged = true;
        }
        // Сравниваем и обновляем pagesLocks, если данные изменились
        if (!mapsEqual(existingData.pagesLocks, newContextData.pagesLocks)) {
            existingData.pagesLocks = new Map(newContextData.pagesLocks);
            contextChanged = true;
        }
        // Сравниваем и обновляем pagesQueue, если данные изменились
        if (!mapsEqual(existingData.pagesQueue, newContextData.pagesQueue)) {
            existingData.pagesQueue = new Map(newContextData.pagesQueue);
            contextChanged = true;
        }
        // Если данные изменились, обновляем timestamp
        if (existingData.requestCount !== newContextData.requestCount) {
            existingData.requestCount = newContextData.requestCount;
            contextChanged = true;
        }
        // Если данные изменились, обновляем timestamp
        if (existingData.timestamp !== newContextData.timestamp) {
            existingData.timestamp = newContextData.timestamp;
            contextChanged = true;
        }
        // Если нет изменений, не сохраняем в Redis
        if (!contextChanged) {
            await logToFile(`Контекст для ${contextId} не изменился, пропускаем сохранение.`);
            return;
        }

        // Шифруем и сжимаем данные
        const encryptedData = await encryptAndCompress({
            pagesMap: [...existingData.pagesMap],
            pageTimeouts: [...existingData.pageTimeouts],
            pagesBusy: [...existingData.pagesBusy],
            pagesLocks: [...existingData.pagesLocks],
            pagesQueue: [...existingData.pagesQueue],
            requestCount: existingData.requestCount,
            timestamp: existingData.timestamp,
        }, process.env.ENCRYPTION_KEY);

        // Сохраняем в Redis с TTL 24 часа (86400 секунд)
        await redisClient.set(`context:${contextId}`, encryptedData, 'EX', 86400);

        await logToFile(`Контекст сохранён в Redis для ${contextId}`);
    } catch (err) {
        await logToFile(`[ERROR] Ошибка при сохранении контекста для ${contextId}: ${err.message}`);
    }
}

/**
 * Загружает контекст пользователя из Redis.
 * @param {string} contextId - ID контекста в хранилище.
 * @returns {Promise<{
 *  pagesMap: Map<string, string>,
 *  pageTimeouts: Map<string, NodeJS.Timeout>,
 *  timestamp: number
 * } | null>} - Загруженный контекст или `null`, если не найден.
 */
async function loadContext(contextId) {
    const key = `context:${contextId}`;
    const encryptedData = await redisClient.get(key);
    await logToFile('[DEBUG] Данные из Redis для ' + key + ':', encryptedData);

    if (!encryptedData) {
        await logToFile(`[WARN] Контекст ${key} не найден в Redis`);
        return null;
    }

    try {
        const parsedData = await decryptAndDecompress(encryptedData, process.env.ENCRYPTION_KEY);
        const restoredContext = {
            context: getBrowser(),
            pagesMap: new Map(Array.isArray(parsedData.pagesMap) ? parsedData.pagesMap : []),
            pageTimeouts: new Map(),
            pagesBusy: new Map(Array.isArray(parsedData.pagesBusy) ? parsedData.pagesBusy : []),
            pagesLocks: new Map(Array.isArray(parsedData.pagesLocks) ? parsedData.pagesLocks : []),
            pagesQueue: new Map(
                Array.isArray(parsedData.pagesQueue)
                ? parsedData.pagesQueue.map(([key, value]) => [key, value instanceof Promise ? value : Promise.resolve()])
                : []
            ),
            requestCount: typeof parsedData.requestCount === 'number' ? parsedData.requestCount : 0,
            timestamp: typeof parsedData.timestamp === 'number' ? parsedData.timestamp : Date.now(),
        };

        const now = Date.now();
        for (const [key, value] of Object.entries(parsedData.pageTimeouts || {})) {
            if (typeof value !== 'number') {
                continue; // Пропускаем некорректные значения
            }
            if (now >= value) {
                await logToFile(`Удаляем страницу ${key}, так как истек срок`);
                restoredContext.pagesMap.delete(key);
            } else if (!restoredContext.pageTimeouts.has(key)) {
                restoredContext.pageTimeouts.set(
                    key,
                    setTimeout(async () => {
                        await logToFile(`Удаляем страницу ${key} за неактивность`);
                        restoredContext.pagesMap.delete(key);
                        restoredContext.pagesMap.delete(`${key}_targetId`);
                        restoredContext.pageTimeouts.delete(key);
                        restoredContext.pagesBusy.delete(key);
                        restoredContext.pagesLocks.delete(key);
                        restoredContext.pagesQueue.delete(key);
                        restoredContext.requestCount = 0;
                        await saveContext(contextId, restoredContext);
                    }, value - now)
                );
            }
        }
        return restoredContext;
    } catch (err) {
        await logToFile(`[ERROR] Ошибка парсинга JSON для ${key}:`, err);
        return null;
    }
}

/**
 * Обновляет контекст пользователя.
 * @param {string} accountId - ID аккаунта.
 * @returns {Promise<void>}
 */
async function updateContext(accountId) {
    const contextId = `ctx:${accountId}`;

    // Если контекст уже в памяти, не загружаем его заново
    if (contextStore[accountId]) {
        await logToFile(`Контекст для accountId: ${accountId} уже загружен в память.`);
        return;
    }

    // Пытаемся загрузить контекст из Redis
    let loadedContext = await loadContext(contextId);

    // Если контекст не найден в Redis, просто возвращаем
    if (!loadedContext) {
        await logToFile(`[WARN] Контекст для accountId: ${accountId} не найден в Redis`);
        return;
    }

    // Обновляем контекст в памяти
    contextStore[accountId] = loadedContext;

    // Сохраняем актуальный контекст в Redis
    await saveContext(contextId, loadedContext);
    await logToFile(`Контекст обновлён в Redis для accountId: ${accountId}`);
}

/**
 * Удаляет контекст пользователя (страницы, куки и прочие данные).
 * @param {string} account_id - ID аккаунта.
 * @returns {Promise<void>}
 */
async function clearContext(account_id) {
    if (!contextStore[account_id]) return;

    try {
        await logToFile(`Очищаем контекст ${account_id} для повторного использования...`);

        // Закрываем все страницы, но не удаляем сам контекст
        for (const [key, url] of contextStore[account_id].pagesMap.entries()) {
            try {
                const page = await getPageByKey(account_id, key);
                if (page) {
                    await page.close();
                    await logToFile(`Закрыта страница ${key} (${url})`);
                }
            } catch (err) {
                await logToFile(`[ERROR]: Ошибка закрытия страницы ${key}: ${err.message}`);
            }
        }

        // Очищаем, но не удаляем контекст
        contextStore[account_id].pagesMap.clear();
        contextStore[account_id].pageTimeouts.clear();
        contextStore[account_id].timestamp = Date.now();
        contextStore[account_id].pagesBusy.clear();
        contextStore[account_id].pagesLocks.clear();
        contextStore[account_id].pagesQueue.clear();
        contextStore[account_id].requestCount = 0;

        // Обновляем контекст в Redis
        await saveContext(`ctx:${account_id}`, contextStore[account_id]);

        await logToFile(`Контекст ${account_id} очищен и готов к повторному использованию.`);
    } catch (err) {
        await logToFile(`[ERROR]: Ошибка при очистке контекста ${account_id}: ${err.message}`);
    }
}

/**
 * Сохраняет куки из браузерной страницы в Redis в зашифрованном виде.
 * @param {string} account_id - ID аккаунта.
 * @param {import('puppeteer').Page} page - Экземпляр Puppeteer.
 * @param {number} expiry - Время истечения токенов (timestamp).
 * @returns {Promise<void>}
 */
async function saveCookies(account_id, page, expiry) {
    try {
        const cookies = await page.cookies();
        const now = Math.floor(Date.now() / 1000);
        const diff = expiry - now;
        const ttl = diff > 0 ? diff : 1;

        const cookieData = { cookies, expiry };
        const encryptedData = await encryptAndCompress(cookieData, process.env.ENCRYPTION_KEY);

        await redisClient.set(`cookies:${account_id}`, encryptedData, 'EX', ttl);
        await logToFile(`Куки сохранены в Redis для ${account_id} на ${ttl} секунд`);
    } catch (error) {
        await logToFile(`Ошибка сохранения кук в Redis для ${account_id}: ${error.message}`);
    }
}

/**
 * Загружает куки из Redis в браузерную страницу.
 * @param {string} account_id - ID аккаунта.
 * @param {import('puppeteer').Page} page - Экземпляр Puppeteer.
 * @returns {Promise<boolean>} - `true`, если куки успешно загружены, иначе `false`.
 */
async function loadCookies(account_id, page) {
    try {
        const encryptedData = await redisClient.get(`cookies:${account_id}`);
        if (!encryptedData) return false;

        const { cookies } = await decryptAndDecompress(encryptedData, process.env.ENCRYPTION_KEY);
        if (!Array.isArray(cookies) || cookies.length === 0) return false;

        for (const cookie of cookies) {
            try {
                await page.setCookie(cookie);
            } catch (err) {
                await logToFile(`Ошибка установки кук для ${account_id}: ${err.message}`);
            }
        }

        await logToFile(`Куки загружены из Redis для ${account_id}`);
        return true;
    } catch (error) {
        await logToFile(`Ошибка загрузки кук из Redis для ${account_id}: ${error.message}`);
        return false;
    }
}

/**
 * Получает sessionId из Redis для заданного accountId.
 * @param {string|number} accountId - Идентификатор аккаунта.
 * @returns {Promise<string|null>} - sessionId или null, если он не найден.
 */
async function getSession(accountId) {
    return await redisClient.get(`session:${accountId}`);
}

/**
 * Сохраняет sessionId в Redis для заданного accountId.
 * @param {string|number} accountId - Идентификатор аккаунта.
 * @param {string} sessionId - Идентификатор сессии для сохранения.
 * @returns {Promise<void>}
 */
async function saveSession(accountId, sessionId) {
    await redisClient.set(`session:${accountId}`, sessionId, "EX", 60 * 60); // Хранение 1 час
}

/**
 * Получает сохранённое имя пользователя из Redis по accountId и leadId.
 * @param {string|number} accountId - Идентификатор аккаунта.
 * @param {string|number} leadId - Идентификатор лида.
 * @returns {Promise<string|null>} - Имя пользователя или null, если не найдено.
 */
async function getUsername(accountId, leadId) {
    return await redisClient.get(`username:${accountId}:${leadId}`);
}

/**
 * Сохраняет имя пользователя в Redis по accountId и leadId.
 * @param {string|number} accountId - Идентификатор аккаунта.
 * @param {string|number} leadId - Идентификатор лида.
 * @param {string} username - Имя пользователя для сохранения.
 * @returns {Promise<void>}
 */
async function saveUsername(accountId, leadId, username) {
    await redisClient.set(`username:${accountId}:${leadId}`, username);
}


export {
    getContext, saveContext, loadContext, updateContext, clearContext,
    saveCookies, loadCookies, redisClient, contextStore, launchBrowser,
    getUsername, saveUsername
};
