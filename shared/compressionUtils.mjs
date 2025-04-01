import zlib from "zlib";


export {
    zlib
};


/**
 * Сжимает данные в формат gzip и возвращает base64-строку.
 * @param {string} data - Строка, которую нужно сжать.
 * @returns {Promise<string>}
 */
function compressData(data) {
    return new Promise((resolve, reject) => {
        zlib.gzip(data, (err, buffer) => {
            if (err) return reject(err);
            resolve(buffer.toString('base64'));
        });
    });
}

/**
 * Разжимает данные из base64-строки с использованием gzip.
 * @param {string} compressedData - Сжатая строка в формате base64.
 * @returns {Promise<string>}
 */
function decompressData(compressedData) {
    return new Promise((resolve, reject) => {
        const buffer = Buffer.from(compressedData, 'base64');
        zlib.gunzip(buffer, (err, decompressedBuffer) => {
            if (err) return reject(err);
            resolve(decompressedBuffer.toString());
        });
    });
}


export { compressData, decompressData };
