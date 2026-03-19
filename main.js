import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const CONFIG_PATH = path.resolve('./config.json');
const PORT = 3000;

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function getConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    try {
      const config = JSON.parse(raw);
      if (typeof config.useNgrok === 'boolean') return config;
    } catch {
      console.log('config.json is invalid, recreating...');
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const useNgrok = (await ask(rl, 'Use ngrok for public hosting? (y/n): ')).toLowerCase() === 'y';
  let authtoken = null;

  if (useNgrok) { 
    authtoken = await ask(rl, 'Enter your ngrok auth token: ');
  }

  rl.close();

  const config = { useNgrok, authtoken };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('Saved to config.json');
  return config;
}

const config = await getConfig();

if (config.useNgrok) {
  if (!config.authtoken || config.authtoken.trim() === '') {
    throw new Error('ngrok auth token is missing. Delete config.json and restart to reconfigure.');
  }

  // Basic format check — ngrok tokens start with 2 and are long strings
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(config.authtoken)) {
    throw new Error(`ngrok auth token looks invalid: "${config.authtoken}". Delete config.json and restart to reconfigure.`);
  }
}

// Only import ngrok if needed
let ngrok = null;
if (config.useNgrok) {
  ngrok = (await import('@ngrok/ngrok')).default;
}

const wss = new WebSocketServer({ port: PORT });

let leader = null;
let state = { video: "", time: 0, paused: false };

const send = (ws, data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(data));
const broadcast = (data, exclude = null) => wss.clients.forEach(c => c !== exclude && send(c, data));

wss.on('connection', (ws) => {
  const isLeader = leader === null;
  if (isLeader) leader = ws;

  console.log(`Client connected as ${isLeader ? 'leader' : 'follower'}`);

  send(ws, { type: 'connection', leader: isLeader });

  if (!isLeader && state.video) {
    send(ws, { type: 'sync', video: state.video, time: state.time, paused: state.paused });
  }

  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw); }
    catch { return; }

    switch (message.type) {
      case 'select_video':
        state.video = message.url;
        state.time = 0;
        state.paused = false;
        console.log('Video selected:', state.video);
        broadcast({ type: 'sync', video: state.video, time: state.time, paused: state.paused }, ws);
        break;

      case 'update_time':
        state.time = message.time;
        // Broadcast so followers get the update immediately via message listener
        broadcast({ type: 'sync_time', time: state.time }, ws);
        break;

      case 'update_paused':
        state.paused = message.paused;
        console.log('Paused:', state.paused);
        broadcast({ type: 'sync_paused', paused: state.paused }, ws);
        break;

      case 'clear_video':
        state.video = null;
        state.time = 0;
        state.paused = false;
        console.log('Video cleared');
        broadcast({ type: 'sync_cleared' }, ws);
        break;

      case 'ping':
        send(ws, { type: 'pong', id: message.id });
        break;

      case 'rtt_report':
        if (ws === leader) {
          send(ws, { type: 'start_delay', delay: message.rtt / 2 });
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log(`${ws === leader ? 'Leader' : 'Follower'} disconnected`);
    if (ws === leader) {
      leader = [...wss.clients][0] ?? null;
      if (leader) {
        send(leader, { type: 'connection', leader: true });
        console.log('Promoted new leader');
      }
    }
  });
});

if (config.useNgrok) {
  try {
    const listener = await ngrok.forward({
      addr: PORT,
      authtoken: config.authtoken
    });

    const url = listener.url().replace('https://', 'ws://');
    console.log(`Socket server running locally on ws://localhost:${PORT}`);
    console.log(`Public ngrok URL: ${url}`);
    console.log(`Join code: ${url.split("//")[1].split(".ngrok-free.app")[0]}`);
  } catch (err) {
    throw new Error(`Failed to start ngrok tunnel: ${err.message}\nYour auth token may be invalid. Delete config.json and restart to reconfigure.`);
  }
} else {
  const { networkInterfaces } = await import('os');
  const nets = networkInterfaces();
  const localIp = Object.values(nets)
    .flat()
    .find(n => n.family === 'IPv4' && !n.internal)?.address || 'localhost';

  console.log(`Socket server running on ws://${localIp}:${PORT}`);
  console.log(`Join code: ${localIp}:${PORT}`);
}