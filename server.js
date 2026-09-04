require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const cors = require('cors');

const storage = require('./src/services/storage');
const twitchBot = require('./src/bot/twitchBot');
const songRequest = require('./src/services/songRequest');
const ttsService = require('./src/services/ttsService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Render Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), botStatus: twitchBot.status });
});

// Set of connected WebSocket clients
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);

  // Send initial state to newly connected client
  const initialState = {
    event: 'init_state',
    data: {
      botStatus: { status: twitchBot.status, message: twitchBot.statusMessage },
      srState: songRequest.getState(),
      goals: storage.getConfig().goals,
      alerts: storage.getAlerts()
    }
  };
  ws.send(JSON.stringify(initialState));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleClientMessage(ws, data);
    } catch (err) {
      console.error('Invalid WebSocket message received:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcast(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// Connect internal services to WebSocket broadcaster
twitchBot.onEvent((event, payload) => {
  broadcast(event, payload);
});

songRequest.onUpdate((payload) => {
  broadcast('sr_update', payload);
});

ttsService.onTTS((payload) => {
  broadcast('tts', payload);
});

function handleClientMessage(ws, message) {
  if (message.action === 'ping') {
    ws.send(JSON.stringify({ event: 'pong' }));
  }
}

// ================= API ROUTES =================

// Status
app.get('/api/status', (req, res) => {
  res.json({
    bot: {
      status: twitchBot.status,
      message: twitchBot.statusMessage
    },
    songRequest: songRequest.getState(),
    config: storage.getConfig(),
    activeClients: clients.size
  });
});

// Config
app.get('/api/config', (req, res) => {
  res.json(storage.getConfig());
});

app.post('/api/config', (req, res) => {
  const updated = storage.saveConfig(req.body);
  broadcast('config_updated', updated);
  res.json({ success: true, config: updated });
});

// Regenerate Widget Secret Token
app.post('/api/config/widget-token/regenerate', (req, res) => {
  const newToken = storage.regenerateWidgetToken();
  const cfg = storage.getConfig();
  broadcast('config_updated', cfg);
  res.json({ success: true, widgetToken: newToken, config: cfg });
});

// Bot Control
app.post('/api/bot/connect', async (req, res) => {
  const result = await twitchBot.connect();
  res.json(result);
});

app.post('/api/bot/disconnect', async (req, res) => {
  const result = await twitchBot.disconnect();
  storage.saveConfig({
    twitch: { connected: false }
  });
  broadcast('config_updated', storage.getConfig());
  res.json(result);
});

// Direct Twitch OAuth Token Validation & Connection
app.post('/api/auth/twitch-token', async (req, res) => {
  try {
    let { token, clientId } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token no proporcionado.' });
    }

    const cleanToken = token.replace(/^oauth:/i, '').trim();

    // 1. Validate token with Twitch
    const validateRes = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: {
        'Authorization': `OAuth ${cleanToken}`
      }
    });

    if (!validateRes.ok) {
      const errData = await validateRes.json().catch(() => ({}));
      return res.status(401).json({
        success: false,
        message: `Token inválido o expirado: ${errData.message || validateRes.statusText}`
      });
    }

    const valData = await validateRes.json();
    const effectiveClientId = clientId || valData.client_id;
    const login = valData.login;
    const userId = valData.user_id;

    let displayName = login;
    let profileImage = 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb60-aee8f1560db5-profile_image-300x300.png';

    // 2. Fetch User Profile from Twitch Helix API
    try {
      const userRes = await fetch(`https://api.twitch.tv/helix/users?id=${userId}`, {
        headers: {
          'Client-Id': effectiveClientId,
          'Authorization': `Bearer ${cleanToken}`
        }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        if (userData.data && userData.data.length > 0) {
          displayName = userData.data[0].display_name;
          profileImage = userData.data[0].profile_image_url || profileImage;
        }
      }
    } catch (helixErr) {
      console.warn('Helix user fetch warning:', helixErr.message);
    }

    // 3. Save to storage
    const updated = storage.saveConfig({
      twitch: {
        channel: login,
        botUsername: login,
        oauthToken: cleanToken,
        clientId: effectiveClientId,
        displayName,
        profileImage,
        userId,
        connected: true
      }
    });

    // 4. Connect bot automatically
    const connectResult = await twitchBot.connect();

    broadcast('config_updated', updated);

    return res.json({
      success: true,
      user: {
        login,
        display_name: displayName,
        profile_image_url: profileImage,
        user_id: userId
      },
      botResult: connectResult,
      message: `¡Conectado exitosamente como @${displayName}!`
    });
  } catch (err) {
    console.error('Error handling Twitch OAuth token:', err);
    return res.status(500).json({ success: false, message: `Error interno: ${err.message}` });
  }
});

// Commands
app.get('/api/commands', (req, res) => {
  res.json(storage.getCommands());
});

app.post('/api/commands', (req, res) => {
  const commands = storage.saveCommands(req.body);
  res.json({ success: true, commands });
});

// Alerts
app.get('/api/alerts', (req, res) => {
  res.json(storage.getAlerts());
});

app.post('/api/alerts', (req, res) => {
  const alerts = storage.saveAlerts(req.body);
  broadcast('alerts_updated', alerts);
  res.json({ success: true, alerts });
});

// Channel Points Rewards
app.get('/api/rewards', (req, res) => {
  res.json(storage.getRewards());
});

app.post('/api/rewards', (req, res) => {
  const rewards = storage.saveRewards(req.body);
  res.json({ success: true, rewards });
});

// Song Request API
app.get('/api/sr/state', (req, res) => {
  res.json(songRequest.getState());
});

app.post('/api/sr/add', async (req, res) => {
  const { query, requester } = req.body;
  const result = await songRequest.addSong({
    query,
    requester: requester || 'Streamer',
    isMod: true,
    isSub: true
  });
  res.json(result);
});

app.post('/api/sr/skip', (req, res) => {
  const result = songRequest.skip('Streamer', true);
  res.json(result);
});

app.post('/api/sr/remove', (req, res) => {
  const { id } = req.body;
  const result = songRequest.removeSong(id);
  res.json(result);
});

app.post('/api/sr/clear', (req, res) => {
  const result = songRequest.clearQueue();
  res.json(result);
});

app.post('/api/sr/playback-state', (req, res) => {
  const { isPlaying } = req.body;
  songRequest.setPlayingState(isPlaying);
  res.json({ success: true });
});

// TTS API
app.get('/api/tts/voices', (req, res) => {
  res.json(ttsService.getVoices());
});

app.post('/api/tts/test', (req, res) => {
  const { text, user, voice } = req.body;
  const result = ttsService.processRequest({
    user: user || 'Streamer',
    text: text || '¡Hola! Este es un mensaje de prueba del sistema de TTS.',
    source: 'test',
    voiceOverride: voice
  });
  res.json(result);
});

// Test Alert Trigger (Follow, Sub, Bits, Raid, Points)
app.post('/api/alert/test', (req, res) => {
  const { type, user, amount, viewers, message, tier, reward } = req.body;
  const alertData = {
    type: type || 'follower',
    user: user || 'UsuarioDePrueba',
    amount: amount || 100,
    viewers: viewers || 25,
    tier: tier || '1',
    reward: reward || 'Recompensa Épica',
    message: message || '¡Un saludo enorme para el mejor stream!'
  };

  broadcast('alert', alertData);

  // If testing TTS through points or bits
  if (type === 'bits' || type === 'channel_points') {
    ttsService.processRequest({
      user: alertData.user,
      text: alertData.message,
      source: type,
      bits: alertData.amount
    });
  }

  res.json({ success: true, alert: alertData });
});

// Goals API
app.post('/api/goals/update', (req, res) => {
  const { type, current, target, title, color } = req.body;
  const config = storage.getConfig();
  if (config.goals && config.goals[type]) {
    if (current !== undefined) config.goals[type].current = Number(current);
    if (target !== undefined) config.goals[type].target = Number(target);
    if (title !== undefined) config.goals[type].title = title;
    if (color !== undefined) config.goals[type].color = color;

    storage.saveConfig({ goals: config.goals });
    broadcast('goal_update', { type, goal: config.goals[type] });
  }
  res.json({ success: true, goals: storage.getConfig().goals });
});

// Auto-connect bot if credentials are saved and enabled
const initialConfig = storage.getConfig();
if (initialConfig.twitch && initialConfig.twitch.channel && initialConfig.twitch.connected) {
  twitchBot.connect().then(() => {
    console.log(`Bot reconectado automáticamente al canal #${initialConfig.twitch.channel}`);
  }).catch(e => {
    console.warn('No se pudo reconectar automáticamente el bot:', e.message);
  });
}

server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Panel de Twitch Bot ejecutándose en:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`=========================================`);
});
