import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this.quickFailures = 0;
        this.stopping = false;
        this.restartTimes = [];
    }

    start(load_memory=false, init_message=null, count_id=0) {
        clearTimeout(this.restartTimer);
        this.stopping = false;
        this.count_id = count_id;
        this.running = true;
        const startedAt = Date.now();

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
            windowsHide: true,
        });
        
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);
            
            if (code === 5) {
                console.error('Invalid movement kick: reconnect stopped; inspect the movement diagnostic.');
                return;
            }
            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT' && !this.stopping) {
                this.restartTimes = this.restartTimes.filter(time => Date.now() - time < 5 * 60 * 1000);
                this.restartTimes.push(Date.now());
                if (this.restartTimes.length >= 3) {
                    console.error('Repeated disconnects: auto-reconnect paused after 3 failures in 5 minutes.');
                    return;
                }
                const uptime = Date.now() - startedAt;
                this.quickFailures = uptime < 10000 ? this.quickFailures + 1 : 0;
                if (this.quickFailures >= 5) {
                    console.error('Agent failed to start 5 times in a row; check the error above.');
                    return;
                }
                const delay = uptime < 10000 ? Math.min(1000 * 2 ** (this.quickFailures - 1), 30000) : 1000;
                console.log(`Restarting agent in ${delay} ms...`);
                this.restartTimer = setTimeout(() => {
                    if (!this.stopping) this.start(true, 'Agent process restarted.', count_id);
                }, delay);
            }
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        this.stopping = true;
        clearTimeout(this.restartTimer);
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        this.restartTimes = [];
        this.quickFailures = 0;
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}
