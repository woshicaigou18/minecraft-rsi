import assert from 'node:assert/strict';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import { serverProxy } from '../src/agent/mindserver_proxy.js';

const http = createServer();
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const io = new Server(http);
let registrations = 0, logins = 0, latest;
io.on('connection', socket => {
    latest = socket;
    socket.on('get-settings', (name, reply) => reply({ settings: {} }));
    socket.on('connect-agent-process', () => registrations++);
    socket.on('login-agent', () => logins++);
});
const waitFor = async condition => {
    const deadline = Date.now() + 5000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('reconnect timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
try {
    await serverProxy.connect('reconnect-test', http.address().port);
    serverProxy.setAgent({ name: 'reconnect-test', bot: { _client: { state: 'play' } },
        cleanKill() { assert.fail('management disconnect must not exit Minecraft'); } });
    await waitFor(() => registrations === 1);
    latest.conn.close(); // transport interruption, while Minecraft remains connected
    await waitFor(() => registrations === 2 && logins === 1);
    assert.equal(serverProxy.connected, true);
    console.log('A management transport drop reconnects and restores identity without killing the Minecraft player.');
} finally {
    serverProxy.getSocket()?.disconnect();
    await new Promise(resolve => io.close(resolve));
    http.close();
}
