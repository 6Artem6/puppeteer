
/**
 * Нормализует URL: удаляет завершающий слэш и приводит к нижнему регистру.
 * @param {string} url - Входной URL.
 * @returns {string} - Нормализованный URL.
 */
function normalizeUrl(url) {
    return url.replace(/\/$/, "").toLowerCase();
}

/**
 * Безопасно сериализует объект в JSON, предотвращая циклические ссылки.
 * @param {any} obj - Объект для сериализации.
 * @returns {string} - JSON-строка.
 */
function safeStringify(obj) {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return; // Пропускаем циклические ссылки
            seen.add(value);
        }
        return value;
    });
}

/**
 * Функция для сравнения двух Map объектов на равенство.
 * @param {Map} map1 - Первая Map коллекция.
 * @param {Map} map2 - Вторая Map коллекция.
 * @returns {boolean} - Результат сравнения.
 */
function mapsEqual(map1, map2) {
    if (map1.size !== map2.size) return false;

    for (let [key, value] of map1) {
        if (!map2.has(key)) return false;
        if (map2.get(key) !== value) return false;
    }

    return true;
}


export { normalizeUrl, safeStringify, mapsEqual };
