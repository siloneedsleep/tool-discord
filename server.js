const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

// ---------------- Maps & Config ----------------
const clients = new Map();           // token -> Discord Client
const socketClients = new Map();     // token -> Set<WebSocket>
const voiceSettings = new Map();     // token -> { channelId, selfMute, selfDeaf, reconnectTimeout }
const questQueues = new Map();       // token -> { abort: false, running: Promise }

const PORT = process.env.PORT || 3000;
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ---------------- Keep-alive (chống sleep Render free) ----------------
setInterval(() => {
  axios.get(`${KEEP_ALIVE_URL}/ping`).catch(() => {});
}, 14 * 60 * 1000);

// ---------------- Helper Functions ----------------
function broadcastToToken(token, data) {
  const sockets = socketClients.get(token);
  if (sockets) {
    const message = JSON.stringify(data);
    sockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    });
  }
}

function cleanupClient(token) {
  const client = clients.get(token);
  if (client) {
    try { client.destroy(); } catch(e) {}
    clients.delete(token);
  }
  // Clear voice reconnect
  const voice = voiceSettings.get(token);
  if (voice && voice.reconnectTimeout) clearTimeout(voice.reconnectTimeout);
  voiceSettings.delete(token);
  // Abort quest queue
  const queue = questQueues.get(token);
  if (queue) queue.abort = true;
  questQueues.delete(token);
}

// ---------------- Voice Reconnect Logic ----------------
async function joinVoiceChannel(client, token, channelId, selfMute, selfDeaf) {
  try {
    if (!client.voice) return;
    await client.voice.join(channelId, { selfMute, selfDeaf });
    voiceSettings.set(token, { channelId, selfMute, selfDeaf, reconnectTimeout: null });
    console.log(`[Voice] ${client.user.tag} joined ${channelId}`);
  } catch (err) {
    console.error(`[Voice] Join error:`, err.message);
  }
}

function setupClientEvents(client, token) {
  client.on('ready', async () => {
    console.log(`[Client] ${client.user.tag} ready`);
    // Auto-rejoin voice if configured
    const vs = voiceSettings.get(token);
    if (vs && vs.channelId && client.voice && !client.voice.channelId) {
      await joinVoiceChannel(client, token, vs.channelId, vs.selfMute, vs.selfDeaf);
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    const vs = voiceSettings.get(token);
    if (!vs || !vs.channelId) return;
    // If we were in our target channel and now we are disconnected
    if (oldState.channelId && !newState.channelId && oldState.channelId === vs.channelId) {
      console.log(`[Voice] Disconnected, scheduling reconnect in 5s`);
      if (vs.reconnectTimeout) clearTimeout(vs.reconnectTimeout);
      vs.reconnectTimeout = setTimeout(async () => {
        if (clients.has(token) && voiceSettings.get(token)?.channelId === vs.channelId) {
          await joinVoiceChannel(client, token, vs.channelId, vs.selfMute, vs.selfDeaf);
        }
      }, 5000);
    }
  });

  client.on('error', (err) => {
    console.error(`[Client] ${token.slice(0, 10)}... Error:`, err.message);
  });
}

// ---------------- API Routes ----------------
app.get('/ping', (req, res) => res.send('ok'));

// Kết nối token
app.post('/api/connect', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  // Nếu đã có client đang hoạt động, xóa trước
  if (clients.has(token)) cleanupClient(token);

  const client = new Client({ checkUpdate: false });
  clients.set(token, client);
  setupClientEvents(client, token);

  try {
    await client.login(token);
    const user = client.user;
    res.json({
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatarURL: user.displayAvatarURL({ dynamic: true })
    });
  } catch (err) {
    cleanupClient(token);
    res.status(401).json({ error: 'Invalid token or login failed' });
  }
});

// Ngắt kết nối token
app.post('/api/disconnect', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  cleanupClient(token);
  res.json({ success: true });
});

// Cập nhật Rich Presence
app.post('/api/presence', async (req, res) => {
  const { token, ...data } = req.body;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Client not connected' });

  const typeMap = {
    PLAYING: 0,
    STREAMING: 1,
    LISTENING: 2,
    WATCHING: 3,
    COMPETING: 5,
    CUSTOM: 4
  };

  try {
    const activity = {
      type: typeMap[data.type?.toUpperCase()] || 0,
      name: data.name || 'Unknown'
    };
    if (data.details) activity.details = data.details;
    if (data.state) activity.state = data.state;
    if (data.applicationId) activity.applicationId = data.applicationId;

    // Assets
    activity.assets = {};
    if (data.largeImageKey) activity.assets.largeImage = data.largeImageKey;
    if (data.largeImageText) activity.assets.largeText = data.largeImageText;
    if (data.smallImageKey) activity.assets.smallImage = data.smallImageKey;
    if (data.smallImageText) activity.assets.smallText = data.smallImageText;

    // Buttons
    activity.buttons = [];
    if (data.button1Text && data.button1Url) {
      activity.buttons.push({ label: data.button1Text, url: data.button1Url });
    }
    if (data.button2Text && data.button2Url) {
      activity.buttons.push({ label: data.button2Text, url: data.button2Url });
    }

    await client.user.setActivity(activity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Voice: Join
app.post('/api/voice/join', async (req, res) => {
  const { token, channelId, selfMute = false, selfDeaf = false } = req.body;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Client not connected' });
  if (!channelId) return res.status(400).json({ error: 'Channel ID required' });

  try {
    await joinVoiceChannel(client, token, channelId, selfMute, selfDeaf);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Voice: Leave
app.post('/api/voice/leave', (req, res) => {
  const { token } = req.body;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Client not connected' });

  try {
    if (client.voice) client.voice.leave();
    const vs = voiceSettings.get(token);
    if (vs && vs.reconnectTimeout) clearTimeout(vs.reconnectTimeout);
    voiceSettings.delete(token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lấy danh sách Quests
app.get('/api/quests', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const response = await axios.get('https://discord.com/api/v9/users/@me/quests', {
      headers: { Authorization: token }
    });
    const quests = response.data.quests || [];
    // Lọc những quest chưa nhận thưởng (userStatus != 'CLAIMED')
    const available = quests.filter(q => q.userStatus !== 'CLAIMED').map(q => ({
      id: q.id,
      name: q.config?.title || 'Unnamed Quest',
      description: q.config?.description || '',
      gamePublisher: q.config?.gamePublisher || 'Unknown',
      questType: q.config?.questType || 'UNKNOWN',
      durationMinutes: q.config?.durationMinutes || 0,
      applicationId: q.config?.applicationId || null,
      status: q.userStatus
    }));
    res.json(available);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quests' });
  }
});

// Bắt đầu auto quest
app.post('/api/quests/start', async (req, res) => {
  const { token, questIds } = req.body;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Client not connected' });
  if (!questIds || !questIds.length) return res.status(400).json({ error: 'No quest IDs' });

  // Hủy queue cũ nếu đang chạy
  const oldQueue = questQueues.get(token);
  if (oldQueue) oldQueue.abort = true;

  const controller = { abort: false };
  questQueues.set(token, controller);

  // Chạy bất đồng bộ
  const processQueue = async () => {
    for (const questId of questIds) {
      if (controller.abort) break;
      try {
        // Fetch quest info để lấy duration & applicationId
        const questRes = await axios.get(`https://discord.com/api/v9/users/@me/quests`, {
          headers: { Authorization: token }
        });
        const quest = (questRes.data.quests || []).find(q => q.id === questId);
        if (!quest) {
          broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'error', message: 'Quest not found' });
          continue;
        }

        const durationMs = (quest.config?.durationMinutes || 5) * 60 * 1000;
        const appId = quest.config?.applicationId;

        // Accept quest
        broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'accepted' });
        await axios.post(`https://discord.com/api/v9/users/@me/quests/${questId}/accept`, {}, {
          headers: { Authorization: token }
        });

        // Set presence để giả lập đang chơi game
        if (appId) {
          await client.user.setActivity({
            type: 0, // PLAYING
            name: quest.config.title || 'Quest Game',
            applicationId: appId
          });
        }

        // Bắt đầu heartbeat loop
        const startTime = Date.now();
        const heartbeatInterval = setInterval(async () => {
          if (controller.abort) {
            clearInterval(heartbeatInterval);
            return;
          }
          const elapsed = Date.now() - startTime;
          const percent = Math.min(100, Math.round((elapsed / durationMs) * 100));
          broadcastToToken(token, { event: 'questProgress', questId, percent, status: 'in_progress' });

          // Gửi heartbeat
          try {
            await axios.post(`https://discord.com/api/v9/users/@me/quests/${questId}/heartbeat`, {
              stream_key: null
            }, { headers: { Authorization: token } });
          } catch (e) {
            console.error(`Heartbeat error: ${e.message}`);
          }

          // Khi đủ thời gian -> claim
          if (elapsed >= durationMs) {
            clearInterval(heartbeatInterval);
            broadcastToToken(token, { event: 'questProgress', questId, percent: 100, status: 'claiming' });
            try {
              await axios.post(`https://discord.com/api/v9/users/@me/quests/${questId}/claim`, {}, {
                headers: { Authorization: token }
              });
              broadcastToToken(token, { event: 'questProgress', questId, percent: 100, status: 'completed' });
            } catch (claimErr) {
              broadcastToToken(token, { event: 'questProgress', questId, percent: 100, status: 'error', message: 'Claim failed' });
            }
          }
        }, 30000); // heartbeat mỗi 30s

        // Đợi cho đến khi claim hoặc abort
        while (!controller.abort && questQueues.get(token) === controller) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (Date.now() - startTime >= durationMs + 5000) break; // đảm bảo thoát
        }
        clearInterval(heartbeatInterval);

      } catch (err) {
        broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'error', message: err.message });
      }
    }
    // Xóa controller nếu vẫn là của chúng ta
    if (questQueues.get(token) === controller) questQueues.delete(token);
    broadcastToToken(token, { event: 'questQueueDone' });
  };

  processQueue().catch(console.error);
  res.json({ success: true, message: 'Quest queue started' });
});

// Hủy quest queue
app.post('/api/quests/stop', (req, res) => {
  const { token } = req.body;
  const controller = questQueues.get(token);
  if (controller) {
    controller.abort = true;
    questQueues.delete(token);
    broadcastToToken(token, { event: 'questQueueAborted' });
  }
  res.json({ success: true });
});

// ---------------- WebSocket Handling ----------------
wss.on('connection', (ws) => {
  let wsToken = null;

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    if (data.event === 'auth') {
      const token = data.token;
      if (clients.has(token)) {
        wsToken = token;
        if (!socketClients.has(token)) socketClients.set(token, new Set());
        socketClients.get(token).add(ws);
        ws.send(JSON.stringify({ event: 'auth', success: true }));
        console.log(`[WS] Authenticated for ${token.slice(0, 10)}...`);
      } else {
        ws.send(JSON.stringify({ event: 'auth', success: false, error: 'Token not connected' }));
      }
    }
  });

  ws.on('close', () => {
    if (wsToken && socketClients.has(wsToken)) {
      socketClients.get(wsToken).delete(ws);
      if (socketClients.get(wsToken).size === 0) socketClients.delete(wsToken);
    }
  });

  ws.on('error', console.error);
});

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
