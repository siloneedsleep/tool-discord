require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) { console.error('Read error:', e); }
  return {};
}

function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {}
}

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// Passport
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || `${KEEP_ALIVE_URL}/auth/discord/callback`,
  scope: ['identify', 'rpc', 'rpc.activities.write']
}, (accessToken, refreshToken, profile, done) => {
  return done(null, {
    id: profile.id,
    username: profile.username,
    avatar: profile.avatar,
    discriminator: profile.discriminator,
    accessToken: accessToken
  });
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const users = readUsers();
  done(null, users[id] || { id });
});

// Maps
const clients = new Map();
const socketClients = new Map();
const voiceSettings = new Map();
const questQueues = new Map();

// Keep-alive
setInterval(() => { axios.get(`${KEEP_ALIVE_URL}/ping`).catch(() => {}); }, 14 * 60 * 1000);

// Helpers
function broadcastToToken(token, data) {
  const sockets = socketClients.get(token);
  if (sockets) {
    const msg = JSON.stringify(data);
    sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  }
}

function cleanupClient(token) {
  const client = clients.get(token);
  if (client) { try { client.destroy(); } catch(e) {} clients.delete(token); }
  const vs = voiceSettings.get(token);
  if (vs?.reconnectTimeout) clearTimeout(vs.reconnectTimeout);
  voiceSettings.delete(token);
  const q = questQueues.get(token);
  if (q) q.abort = true;
  questQueues.delete(token);
}

async function joinVoiceChannel(client, token, channelId, selfMute, selfDeaf) {
  try {
    if (!client.voice) return;
    await client.voice.join(channelId, { selfMute, selfDeaf });
    voiceSettings.set(token, { channelId, selfMute, selfDeaf, reconnectTimeout: null });
  } catch (err) { console.error('Voice error:', err.message); }
}

function setupClientEvents(client, token) {
  client.on('ready', async () => {
    const vs = voiceSettings.get(token);
    if (vs?.channelId && client.voice && !client.voice.channelId) {
      await joinVoiceChannel(client, token, vs.channelId, vs.selfMute, vs.selfDeaf);
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    const vs = voiceSettings.get(token);
    if (!vs?.channelId) return;
    if (oldState.channelId && !newState.channelId && oldState.channelId === vs.channelId) {
      if (vs.reconnectTimeout) clearTimeout(vs.reconnectTimeout);
      vs.reconnectTimeout = setTimeout(() => {
        if (clients.has(token) && voiceSettings.get(token)?.channelId === vs.channelId) {
          joinVoiceChannel(client, token, vs.channelId, vs.selfMute, vs.selfDeaf);
        }
      }, 5000);
    }
  });

  client.on('error', (err) => console.error('Client error:', err.message));
}

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// Auth Routes
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
  const users = readUsers();
  if (!users[req.user.id]) {
    users[req.user.id] = {
      id: req.user.id,
      username: req.user.username,
      avatar: req.user.avatar,
      accessToken: req.user.accessToken,
      userToken: null,
      createdAt: new Date().toISOString()
    };
    saveUsers(users);
  } else {
    users[req.user.id].accessToken = req.user.accessToken;
    saveUsers(users);
  }
  res.redirect('/dashboard');
});

app.get('/auth/logout', (req, res) => {
  const user = req.user;
  if (user?.userToken) cleanupClient(user.userToken);
  req.logout(() => res.redirect('/'));
});

app.get('/dashboard', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API: Lấy thông tin user
app.get('/api/user', isAuthenticated, (req, res) => {
  const users = readUsers();
  const user = users[req.user.id];
  res.json({
    username: user?.username || req.user.username,
    avatar: user?.avatar || req.user.avatar,
    hasUserToken: !!user?.userToken,
    isSafeMode: !user?.userToken
  });
});

// API: Kết nối User Token (full power)
app.post('/api/connect-usertoken', isAuthenticated, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const users = readUsers();
  const client = new Client({ checkUpdate: false });

  try {
    await client.login(token);
    const user = client.user;

    // Lưu token vào database
    users[req.user.id].userToken = token;
    saveUsers(users);

    // Setup selfbot
    clients.set(token, client);
    setupClientEvents(client, token);

    res.json({ success: true, username: user.username, avatarURL: user.displayAvatarURL({ dynamic: true }) });
  } catch (err) {
    try { client.destroy(); } catch(e) {}
    res.status(401).json({ error: 'Token không hợp lệ' });
  }
});

// API: Disconnect User Token
app.post('/api/disconnect-usertoken', isAuthenticated, (req, res) => {
  const users = readUsers();
  const user = users[req.user.id];
  if (user?.userToken) {
    cleanupClient(user.userToken);
    user.userToken = null;
    saveUsers(users);
  }
  res.json({ success: true });
});

// API: Presence an toàn (Access Token)
app.post('/api/presence-safe', isAuthenticated, async (req, res) => {
  const { type, name, details, state } = req.body;
  const accessToken = req.user.accessToken;
  const typeMap = { PLAYING: 0, STREAMING: 1, LISTENING: 2, WATCHING: 3, COMPETING: 5 };

  try {
    await axios.patch('https://discord.com/api/v9/users/@me/settings', {
      custom_status: { text: state || '', emoji_name: null }
    }, { headers: { Authorization: `Bearer ${accessToken}` } });

    await axios.post('https://discord.com/api/v9/oauth2/applications/@me/rpc', {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: 1,
        activity: {
          type: typeMap[type?.toUpperCase()] || 0,
          name: name || 'Unknown',
          details: details || '',
          state: state || ''
        }
      },
      nonce: Date.now().toString()
    }, { headers: { Authorization: `Bearer ${accessToken}` } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Không thể cập nhật presence' });
  }
});

// API: Presence Full (User Token)
app.post('/api/presence-full', isAuthenticated, async (req, res) => {
  const { type, name, details, state, applicationId, largeImageKey, largeImageText, smallImageKey, smallImageText, button1Text, button1Url, button2Text, button2Url } = req.body;
  const users = readUsers();
  const token = users[req.user.id]?.userToken;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Chưa kết nối User Token' });

  const typeMap = { PLAYING: 0, STREAMING: 1, LISTENING: 2, WATCHING: 3, COMPETING: 5, CUSTOM: 4 };

  try {
    const activity = {
      type: typeMap[type?.toUpperCase()] || 0,
      name: name || 'Unknown'
    };
    if (details) activity.details = details;
    if (state) activity.state = state;
    if (applicationId) activity.applicationId = applicationId;
    activity.assets = {};
    if (largeImageKey) activity.assets.largeImage = largeImageKey;
    if (largeImageText) activity.assets.largeText = largeImageText;
    if (smallImageKey) activity.assets.smallImage = smallImageKey;
    if (smallImageText) activity.assets.smallText = smallImageText;
    activity.buttons = [];
    if (button1Text && button1Url) activity.buttons.push({ label: button1Text, url: button1Url });
    if (button2Text && button2Url) activity.buttons.push({ label: button2Text, url: button2Url });

    await client.user.setActivity(activity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Voice (chỉ User Token)
app.post('/api/voice/join', isAuthenticated, async (req, res) => {
  const { channelId, selfMute = false, selfDeaf = false } = req.body;
  const users = readUsers();
  const token = users[req.user.id]?.userToken;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Cần kết nối User Token' });

  try {
    await joinVoiceChannel(client, token, channelId, selfMute, selfDeaf);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/voice/leave', isAuthenticated, (req, res) => {
  const users = readUsers();
  const token = users[req.user.id]?.userToken;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Cần kết nối User Token' });

  try {
    if (client.voice) client.voice.leave();
    const vs = voiceSettings.get(token);
    if (vs?.reconnectTimeout) clearTimeout(vs.reconnectTimeout);
    voiceSettings.delete(token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quest (chỉ User Token)
app.get('/api/quests', isAuthenticated, async (req, res) => {
  const users = readUsers();
  const token = users[req.user.id]?.userToken;
  if (!token) return res.status(404).json({ error: 'Cần kết nối User Token' });

  try {
    const resp = await axios.get('https://discord.com/api/v9/users/@me/quests', {
      headers: { Authorization: token }
    });
    const quests = resp.data.quests || [];
    const available = quests.filter(q => q.userStatus !== 'CLAIMED').map(q => ({
      id: q.id,
      name: q.config?.title || 'Unnamed',
      gamePublisher: q.config?.gamePublisher || 'Unknown',
      questType: q.config?.questType || 'UNKNOWN',
      durationMinutes: q.config?.durationMinutes || 0,
      applicationId: q.config?.applicationId || null,
      status: q.userStatus
    }));
    res.json(available);
  } catch (err) {
    res.status(500).json({ error: 'Không lấy được quest' });
  }
});

app.post('/api/quests/start', isAuthenticated, async (req, res) => {
  const users = readUsers();
  const token = users[req.user.id]?.userToken;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Cần kết nối User Token' });

  const { questIds } = req.body;
  if (!questIds?.length) return res.status(400).json({ error: 'Chưa chọn quest' });

  const old = questQueues.get(token);
  if (old) old.abort = true;

  const controller = { abort: false };
  questQueues.set(token, controller);

  const processQueue = async () => {
    for (const questId of questIds) {
      if (controller.abort) break;
      try {
        const questRes = await axios.get('https://discord.com/api/v9/users/@me/quests', {
          headers: { Authorization: token }
        });
        const quest = (questRes.data.quests || []).find(q => q.id === questId);
        if (!quest) {
          broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'error' });
          continue;
        }

        const durationMs = (quest.config?.durationMinutes || 5) * 60 * 1000;
        broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'accepted' });

        await axios.post(`https://discord.com/api/v9/users/@me/quests/${questId}/accept`, {}, {
          headers: { Authorization: token }
        });

        if (quest.config?.applicationId) {
          await client.user.setActivity({ type: 0, name: quest.config.title || 'Quest', applicationId: quest.config.applicationId });
        }

        const startTime = Date.now();
        const heartbeat = setInterval(async () => {
          if (controller.abort) { clearInterval(heartbeat); return; }
          const elapsed = Date.now() - startTime;
          const percent = Math.min(100, Math.round((elapsed / durationMs) * 100));
          broadcastToToken(token, { event: 'questProgress', questId, percent, status: 'in_progress' });

          try {
            await axios.post(`https://discord.com/api/v9/users/@me/quests/${questId}/heartbeat`, {
              stream_key: null
            }, { headers: { Authorization: token } });
          } catch (e) {}

          if (elapsed >= durationMs) {
            clearInterval(heartbeat);
            broadcastToToken(token, { event: 'questProgress', questId, percent: 100, status: 'claiming' });
            try {
              await axios.post(`https://discord.com/api/v9/users/@me/quests/${questId}/claim`, {}, {
                headers: { Authorization: token }
              });
              broadcastToToken(token, { event: 'questProgress', questId, percent: 100, status: 'completed' });
            } catch (claimErr) {
              broadcastToToken(token, { event: 'questProgress', questId, percent: 100, status: 'error' });
            }
          }
        }, 30000);

        while (!controller.abort && questQueues.get(token) === controller) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (Date.now() - startTime >= durationMs + 5000) break;
        }
        clearInterval(heartbeat);
      } catch (err) {
        broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'error' });
      }
    }
    if (questQueues.get(token) === controller) questQueues.delete(token);
    broadcastToToken(token, { event: 'questQueueDone' });
  };

  processQueue().catch(console.error);
  res.json({ success: true });
});

app.post('/api/quests/stop', isAuthenticated, (req, res) => {
  const users = readUsers();
  const token = users[req.user.id]?.userToken;
  const controller = questQueues.get(token);
  if (controller) {
    controller.abort = true;
    questQueues.delete(token);
    broadcastToToken(token, { event: 'questQueueAborted' });
  }
  res.json({ success: true });
});

// WebSocket
wss.on('connection', (ws) => {
  let wsToken = null;

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    if (data.event === 'auth') {
      const token = data.token;
      if (clients.has(token)) {
        wsToken = token;
        if (!socketClients.has(token)) socketClients.set(token, new Set());
        socketClients.get(token).add(ws);
        ws.send(JSON.stringify({ event: 'auth', success: true }));
      } else {
        ws.send(JSON.stringify({ event: 'auth', success: false }));
      }
    }
  });

  ws.on('close', () => {
    if (wsToken && socketClients.has(wsToken)) {
      socketClients.get(wsToken).delete(ws);
      if (socketClients.get(wsToken).size === 0) socketClients.delete(wsToken);
    }
  });
});

app.get('/ping', (req, res) => res.send('ok'));
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
