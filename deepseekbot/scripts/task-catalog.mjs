import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('tasks');

async function* jsonFiles(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* jsonFiles(file);
        else if (entry.isFile() && entry.name.endsWith('.json')) yield file;
    }
}

const rows = [];
for await (const file of jsonFiles(root)) {
    let data;
    try {
        data = JSON.parse(await readFile(file, 'utf8'));
    } catch {
        continue;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    for (const [id, task] of Object.entries(data)) {
        if (task && typeof task === 'object' && task.goal !== undefined && task.type) {
            rows.push({ file: path.relative(process.cwd(), file).replaceAll('\\', '/'), id, goal: task.goal });
        }
    }
}
rows.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else for (const row of rows) console.log(`${row.file}\t${row.id}\t${JSON.stringify(row.goal).replaceAll(/\s+/g, ' ').slice(0, 100)}`);
console.error(`${rows.length} task entries`);
