import { io } from 'socket.io-client';

const socket = io('http://localhost:8080', { timeout: 5000, reconnection: false });
const timeout = setTimeout(() => {
    console.error('MindServer state request timed out.');
    socket.close();
    process.exitCode = 1;
}, 7000);

socket.on('connect', () => socket.emit('listen-to-agents'));
socket.once('state-update', (states) => {
    clearTimeout(timeout);
    if (Object.keys(states).length === 0) console.log('No agents are currently in game.');
    for (const [name, state] of Object.entries(states)) {
        console.log(`${name}: gamemode=${state?.gameplay?.gamemode ?? 'unknown'}, action=${state?.action?.current ?? 'unknown'}, position=${JSON.stringify(state?.gameplay?.position ?? null)}`);
    }
    socket.close();
});
socket.on('connect_error', (error) => {
    clearTimeout(timeout);
    console.error(`MindServer unavailable: ${error.message}`);
    socket.close();
    process.exitCode = 1;
});
