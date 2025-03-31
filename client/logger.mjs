import { fileURLToPath } from 'url';
import path from "path";

export {
    path
};


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_FILE = path.join(__dirname, "puppeteer.log");  // Путь к файлу логов

/**
 * Логирует сообщение в консоль и (опционально) в файл
 * @param {...any} messages - Сообщения для логирования
 */
const logToFile = async (...messages) => {
    const logMessage = `${new Date().toISOString()} [INFO]: ${messages.join(" ")}\n`;
    console.log(logMessage); // Выводим сообщение в консоль
    // await fs.appendFile(LOG_FILE, logMessage); // Записываем лог в файл
};


export { logToFile };
