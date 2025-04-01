import { logToFile } from '../shared/logger.mjs';
import { redisClient } from '../shared/redisClient.mjs';


export async function addTaskToQueue(sessionId, task) {
    const sessionKey = `session:${sessionId}:worker`;
    let workerId = await redisClient.get(sessionKey);

    if (!workerId) {
        workerId = await redisClient.sendCommand(['SRANDMEMBER', 'workers:list']);
        if (!workerId) throw new Error('Нет доступных воркеров');
        await redisClient.set(sessionKey, workerId);
    }

    await logToFile("workerId: ", workerId);

    await redisClient.rPush(`worker:${workerId}:queue`, JSON.stringify(task));
    return workerId;
}
