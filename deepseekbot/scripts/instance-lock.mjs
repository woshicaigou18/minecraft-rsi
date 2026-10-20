import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';

export function instanceRunning(file) {
    try {
        const { pid } = JSON.parse(readFileSync(file, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) return false;
        process.kill(pid, 0);
        return true;
    } catch (error) { return error.code === 'EPERM'; }
}

export function acquireInstanceLock(file) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(file, 'wx');
            writeFileSync(fd, JSON.stringify({ pid: process.pid }));
            closeSync(fd);
            const release = () => {
                try {
                    if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
                } catch { /* Already released. */ }
            };
            process.once('exit', release);
            return release;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (instanceRunning(file)) return null;
            try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    return null;
}
