require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------------- Cấu hình ----------------
const PORT = process.env.PORT || 3000;
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Read users error:', e); }
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) { console.error('Save users error:', e); }
}

// ---------------- Express middleware ----------------
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: DATA_DIR
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// ---------------- Passport Discord ----------------
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || `${KEEP_ALIVE_URL}/auth/discord/callback`,
  scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
  process.nextTick(() => {
    return done(null, {
      id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      discriminator: profile.discriminator,
      accessToken: accessToken
    });
  });
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const users = readUsers();
  const user = Object.values(users).find(u => u.discordId === id);
  done(null, user || { id });
});

// ---------------- Maps cho selfbot ----------------
const clients = new Map();
const socketClients = new Map();
const voiceSettings = new Map();
const questQueues = new Map();

// ---------------- Keep-alive chống sleep Render ----------------
setInterval(() => {
  axios.get(`${KEEP_ALIVE_URL}/ping`).catch(() => {});
}, 14 * 60 * 1000);

// ---------------- Helpers ----------------
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
  } catch (err) { console.error('Voice join error:', err.message); }
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

// ---------------- Middleware kiểm tra đăng nhập + PIN ----------------
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated() && req.user?.pinVerified) return next();
  res.redirect('/');
}

// ---------------- Auth routes ----------------
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    const discordId = req.user.id;
    const users = readUsers();
    if (users[discordId]) {
      res.redirect(`/?needPin=true&discordId=${discordId}`);
    } else {
      res.redirect(`/?createPin=true&discordId=${discordId}&username=${req.user.username}&avatar=${req.user.avatar}`);
    }
  }
);

app.post('/api/auth/create-pin', (req, res) => {
  const { discordId, pin, username, avatar } = req.body;
  if (!pin || !/^\d{8}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN phải là 8 chữ số' });
  }
  const users = readUsers();
  users[discordId] = {
    discordId,
    username,
    avatar,
    pin: bcrypt.hashSync(pin, 10),
    token: null,
    createdAt: new Date().toISOString()
  };
  saveUsers(users);
  req.login({ ...req.user, pinVerified: true, discordId }, (err) => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    res.json({ success: true, redirect: '/dashboard' });
  });
});

app.post('/api/auth/verify-pin', (req, res) => {
  const { discordId, pin } = req.body;
  if (!discordId || !pin) return res.status(400).json({ error: 'Thiếu thông tin' });
  const users = readUsers();
  const user = users[discordId];
  if (!user) return res.status(404).json({ error: 'Tài khoản không tồn tại' });
  if (!bcrypt.compareSync(pin, user.pin)) {
    return res.status(401).json({ error: 'PIN không đúng' });
  }
  req.login({ ...req.user, pinVerified: true, discordId }, (err) => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    res.json({ success: true, redirect: '/dashboard' });
  });
});

app.post('/api/auth/change-pin', isAuthenticated, (req, res) => {
  const { oldPin, newPin } = req.body;
  const discordId = req.user.discordId;
  const users = readUsers();
  const user = users[discordId];
  if (!bcrypt.compareSync(oldPin, user.pin)) {
    return res.status(401).json({ error: 'PIN cũ không đúng' });
  }
  if (!/^\d{8}$/.test(newPin)) {
    return res.status(400).json({ error: 'PIN mới phải là 8 chữ số' });
  }
  users[discordId].pin = bcrypt.hashSync(newPin, 10);
  saveUsers(users);
  res.json({ success: true, message: 'Đổi PIN thành công' });
});

app.get('/auth/logout', (req, res) => {
  const discordId = req.user?.discordId;
  if (discordId) {
    const users = readUsers();
    if (users[discordId]?.token) cleanupClient(users[discordId].token);
  }
  req.logout(() => res.redirect('/'));
});

app.get('/dashboard', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ---------------- API Selfbot ----------------
app.get('/ping', (req, res) => res.send('ok'));

app.post('/api/save-token', isAuthenticated, (req, res) => {
  const { token } = req.body;
  const discordId = req.user.discordId;
  if (!token) return res.status(400).json({ error: 'Token required' });
  const users = readUsers();
  if (users[discordId]) {
    users[discordId].token = token;
    saveUsers(users);
  }
  res.json({ success: true });
});

app.post('/api/connect', isAuthenticated, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const users = readUsers();
  const discordId = req.user.discordId;
  if (users[discordId]) {
    users[discordId].token = token;
    saveUsers(users);
  }

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
    res.status(401).json({ error: 'Token không hợp lệ hoặc đăng nhập thất bại' });
  }
});

app.post('/api/disconnect', isAuthenticated, (req, res) => {
  const { token } = req.body;
  cleanupClient(token);
  res.json({ success: true });
});

app.post('/api/presence', isAuthenticated, async (req, res) => {
  const { token, ...data } = req.body;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Client not connected' });

  const typeMap = { PLAYING: 0, STREAMING: 1, LISTENING: 2, WATCHING: 3, COMPETING: 5, CUSTOM: 4 };
  try {
    const activity = {
      type: typeMap[data.type?.toUpperCase()] || 0,
      name: data.name || 'Unknown'
    };
    if (data.details) activity.details = data.details;
    if (data.state) activity.state = data.state;
    if (data.applicationId) activity.applicationId = data.applicationId;
    activity.assets = {};
    if (data.largeImageKey) activity.assets.largeImage = data.largeImageKey;
    if (data.largeImageText) activity.assets.largeText = data.largeImageText;
    if (data.smallImageKey) activity.assets.smallImage = data.smallImageKey;
    if (data.smallImageText) activity.assets.smallText = data.smallImageText;
    activity.buttons = [];
    if (data.button1Text && data.button1Url) activity.buttons.push({ label: data.button1Text, url: data.button1Url });
    if (data.button2Text && data.button2Url) activity.buttons.push({ label: data.button2Text, url: data.button2Url });

    await client.user.setActivity(activity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/voice/join', isAuthenticated, async (req, res) => {
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

app.post('/api/voice/leave', isAuthenticated, (req, res) => {
  const { token } = req.body;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Client not connected' });
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

app.get('/api/quests', isAuthenticated, async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Token required' });
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
  const { token, questIds } = req.body;
  const client = clients.get(token);
  if (!client) return res.status(404).json({ error: 'Client not connected' });
  if (!questIds?.length) return res.status(400).json({ error: 'No quest IDs' });

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
          broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'error', message: 'Quest not found' });
          continue;
        }

        const durationMs = (quest.config?.durationMinutes || 5) * 60 * 1000;
        const appId = quest.config?.applicationId;

        broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'accepted' });
        await axios.post(`https://discord.com/api/v9/users/@me/quests/${questId}/accept`, {}, {
          headers: { Authorization: token }
        });

        if (appId) {
          await client.user.setActivity({ type: 0, name: quest.config.title || 'Quest', applicationId: appId });
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
              broadcastToToken(token, { event: 'questProgress', questId, percent: 100, status: 'error', message: 'Claim failed' });
            }
          }
        }, 30000);

        while (!controller.abort && questQueues.get(token) === controller) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (Date.now() - startTime >= durationMs + 5000) break;
        }
        clearInterval(heartbeat);
      } catch (err) {
        broadcastToToken(token, { event: 'questProgress', questId, percent: 0, status: 'error', message: err.message });
      }
    }
    if (questQueues.get(token) === controller) questQueues.delete(token);
    broadcastToToken(token, { event: 'questQueueDone' });
  };

  processQueue().catch(console.error);
  res.json({ success: true, message: 'Bắt đầu xử lý quest' });
});

app.post('/api/quests/stop', isAuthenticated, (req, res) => {
  const { token } = req.body;
  const controller = questQueues.get(token);
  if (controller) {
    controller.abort = true;
    questQueues.delete(token);
    broadcastToToken(token, { event: 'questQueueAborted' });
  }
  res.json({ success: true });
});

// ---------------- WebSocket ----------------
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
        ws.send(JSON.stringify({ event: 'auth', success: false, error: 'Token chưa được kết nối' }));
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

// ---------------- Start server ----------------
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
