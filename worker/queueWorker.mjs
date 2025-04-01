import crypto from "crypto";
import { logToFile } from '../shared/logger.mjs';
import { redisClient } from '../shared/redisClient.mjs';
import { processTask } from './taskProcessor.mjs';


export {
    crypto,
};


async function processQueue(workerId) {
    const queueKey = `worker:${workerId}:queue`;

    while (true) {
        const result = await redisClient.blPop(queueKey, 0);
        if (!result) continue;

        const task = JSON.parse(result?.element);
        await processTask(task);
    }
}

async function registerWorker() {
    const workerId = crypto.randomUUID();
    await redisClient.sAdd('workers:list', workerId);
    await processQueue(workerId);
}


registerWorker().catch(console.error);