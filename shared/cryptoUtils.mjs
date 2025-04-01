import crypto from "crypto";
import util from "util";
import zlib from "zlib";
import { safeStringify } from "./utils.mjs";

export {
    crypto,
    util,
    zlib
}

const ALGORITHM = 'aes-256-cbc';
const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);


/**
 * Дешифрует данные, зашифрованные алгоритмом AES-256-CBC.
 * @param {string} encryptedBase64 - Зашифрованная строка в формате Base64.
 * @param {string} encryptionKey - Ключ шифрования.
 * @returns {any} - Расшифрованные данные.
 * @throws {Error} - Если дешифрование не удалось.
 */
function decryptData(encryptedBase64, encryptionKey) {
    let keyBase64 = encryptionKey.trim(); // Убираем лишние пробелы
    if (!keyBase64) {
        throw new Error("ENCRYPTION_KEY не задан");
    }

    // Декодируем ключ из base64 в строку
    let keyString;
    try {
        keyString = Buffer.from(keyBase64, 'base64').toString('utf-8');
    } catch (e) {
        throw new Error("Неверный base64 формат ключа");
    }

    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
    const iv = encryptedBuffer.slice(0, 16);
    const encryptedText = encryptedBuffer.slice(16);

    // Генерируем 32-байтный ключ (SHA-256 хеш от keyString)
    const key = crypto.createHash('sha256').update(keyString).digest();

    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return JSON.parse(decrypted.toString());
    } catch (err) {
        throw new Error("Ошибка декодирования: " + err.message);
    }
}

/**
 * Шифрует и сжимает данные перед сохранением в Redis.
 * @param {any} data - Данные для шифрования (объект или строка).
 * @param {string} encryptionKey - Секретный ключ (строка, обычно из .env).
 * @returns {Promise<string>} - Зашифрованные и сжатые данные в Base64.
 */
async function encryptAndCompress(data, encryptionKey) {
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const jsonData = safeStringify(data);
    const compressedData = await gzip(jsonData); // Сжимаем

    let encrypted = cipher.update(compressedData);
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return Buffer.concat([iv, encrypted]).toString('base64'); // Склеиваем IV + зашифрованные данные
}

/**
 * Расшифровывает и разжимает данные из Redis.
 * @param {string} encryptedBase64 - Зашифрованные и сжатые данные в Base64.
 * @param {string} encryptionKey - Секретный ключ.
 * @returns {Promise<any>} - Расшифрованные данные.
 */
async function decryptAndDecompress(encryptedBase64, encryptionKey) {
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');

    const iv = encryptedBuffer.slice(0, 16); // Первые 16 байт — это IV
    const encrypted = encryptedBuffer.slice(16); // Остальное — зашифрованные данные

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    const decompressedData = await gunzip(decrypted); // Разжимаем

    return JSON.parse(decompressedData.toString()); // Преобразуем в объект
}


export { decryptData, encryptAndCompress, decryptAndDecompress };
