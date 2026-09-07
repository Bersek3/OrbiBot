require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
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
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
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

// User Registration Endpoint
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Correo y contraseña son obligatorios.' });
    }
    const user = storage.registerUser(email, password);
    res.json({
      success: true,
      message: 'Cuenta creada exitosamente. Ahora puedes iniciar sesión.',
      user
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Error al registrar usuario.' });
  }
});

// User Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Correo y contraseña son obligatorios.' });
    }
    const user = storage.loginUser(email, password);
    res.json({
      success: true,
      message: 'Inicio de sesión exitoso.',
      user
    });
  } catch (err) {
    res.status(401).json({ success: false, message: err.message || 'Error al iniciar sesión.' });
  }
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

    // 3. Set streamer_id and re-sync from Supabase for this streamer
    storage.setStreamerId(login);
    await storage.resyncForStreamer(login);

    // 4. Save to storage (now scoped to this streamer's data)
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

    // 5. Connect bot automatically
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

// ================= KICK OAUTH 2.0 INTEGRATION =================
const kickAuthStates = new Map();

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// 1. Initiate Kick OAuth 2.0 flow
app.get('/api/auth/kick/login', (req, res) => {
  const clientId = process.env.KICK_CLIENT_ID || '01M0VT0JC58YQEVGRHM8JFXQX3';
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = `${protocol}://${host}/api/auth/kick/callback`;

  // Store in memory (expires in 10 mins)
  kickAuthStates.set(state, {
    codeVerifier,
    redirectUri,
    createdAt: Date.now()
  });

  // Clean old states
  for (const [k, v] of kickAuthStates.entries()) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) {
      kickAuthStates.delete(k);
    }
  }

  const scopes = encodeURIComponent('user:read channel:read chat:write events:subscribe');
  const authUrl = `https://id.kick.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  res.redirect(authUrl);
});

// 2. Kick OAuth 2.0 Callback handler
app.get('/api/auth/kick/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error || !code) {
    const desc = error_description || error || 'Autorización cancelada por el usuario.';
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error de Autenticación Kick</title>
        <style>
          body { background: #07090e; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #131722; padding: 30px; border-radius: 16px; border: 1px solid #ef4444; max-width: 400px; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }
          button { background: #ef4444; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size: 40px; margin-bottom: 10px;">⚠️</div>
          <h2 style="color: #ef4444; margin: 0 0 10px;">Error al conectar con Kick</h2>
          <p style="color: #cbd5e1; font-size: 14px;">${desc}</p>
          <button onclick="window.close()">Cerrar Ventana</button>
        </div>
        <script>
          const errPayload = { type: 'KICK_AUTH_ERROR', error: '${error || "error"}', desc: '${desc}' };
          if (window.opener) window.opener.postMessage(errPayload, '*');
          localStorage.setItem('orbibot_kick_auth_error', JSON.stringify(errPayload));
          setTimeout(() => window.close(), 3000);
        </script>
      </body>
      </html>
    `);
  }

  const stateData = kickAuthStates.get(state);
  const clientId = process.env.KICK_CLIENT_ID || '01M0VT0JC58YQEVGRHM8JFXQX3';
  const clientSecret = process.env.KICK_CLIENT_SECRET || 'ee10e46fccf83a105e86834973db23cabcad279f33acf48bd4f6b5749884bb20';

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = stateData?.redirectUri || `${protocol}://${host}/api/auth/kick/callback`;

  try {
    // Exchange Code for Access Token
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('redirect_uri', redirectUri);
    params.append('code', code);
    if (stateData?.codeVerifier) {
      params.append('code_verifier', stateData.codeVerifier);
    }

    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('Kick Token Exchange Error:', errText);
      throw new Error(`Error en el intercambio de tokens de Kick: ${tokenRes.status} ${errText}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || '';

    // Fetch User Profile from Kick API
    let channelName = 'streamer';
    let displayName = 'Streamer';
    let profileImage = 'https://kick.com/favicon.ico';
    let userId = '';

    try {
      const userRes = await fetch('https://api.kick.com/public/v1/users', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        const u = (userData.data && userData.data[0]) || userData.data || userData;
        channelName = (u.name || u.username || u.slug || '').toLowerCase();
        displayName = u.name || u.username || channelName;
        profileImage = u.profile_picture || u.avatar || profileImage;
        userId = u.user_id || u.id || '';
      }
    } catch (uErr) {
      console.warn('Kick User Fetch Warning:', uErr.message);
    }

    // Save to configuration
    const kickConfig = {
      channel: channelName,
      username: displayName,
      profile_picture: profileImage,
      userId: String(userId),
      accessToken,
      refreshToken,
      clientId,
      connected: true
    };

    const updated = storage.saveConfig({ kick: kickConfig });
    broadcast('config_updated', updated);

    // Render Success Popup
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Kick Conectado</title>
        <style>
          body { background: #07090e; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #101522; padding: 30px; border-radius: 16px; border: 1px solid #53fc18; max-width: 380px; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }
          .avatar { width: 64px; height: 64px; border-radius: 50%; border: 3px solid #53fc18; margin: 0 auto 12px; }
          button { background: #53fc18; color: #000; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 800; cursor: pointer; margin-top: 15px; width: 100%; }
        </style>
      </head>
      <body>
        <div class="card">
          <img src="${profileImage}" class="avatar" alt="Avatar" onerror="this.src='https://kick.com/favicon.ico'">
          <h2 style="color: #53fc18; margin: 0 0 6px;">¡Kick Conectado!</h2>
          <p style="color: #cbd5e1; font-size: 14px; margin: 0 0 10px;">Canal <strong>@${displayName || channelName}</strong> vinculado con éxito.</p>
          <p style="color: #94a3b8; font-size: 12px;">Cerrando ventana y actualizando tu panel...</p>
          <button onclick="window.close()">Volver al Dashboard</button>
        </div>
        <script>
          const payload = {
            type: 'KICK_AUTH_SUCCESS',
            kick: ${JSON.stringify(kickConfig)},
            timestamp: Date.now()
          };
          localStorage.setItem('orbibot_kick_auth_event', JSON.stringify(payload));
          if (window.opener) {
            try { window.opener.postMessage(payload, '*'); } catch(e) {}
            try { window.opener.focus(); } catch(e) {}
          }
          if (typeof BroadcastChannel !== 'undefined') {
            new BroadcastChannel('orbibot_stream_channel').postMessage(payload);
          }
          setTimeout(() => window.close(), 600);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Kick OAuth Error:', err);
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error Kick OAuth</title>
        <style>
          body { background: #07090e; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #131722; padding: 30px; border-radius: 16px; border: 1px solid #ef4444; max-width: 420px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2 style="color: #ef4444;">Error al conectar con Kick</h2>
          <p style="color: #cbd5e1; font-size: 13px;">${err.message}</p>
          <button onclick="window.close()" style="background: #ef4444; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">Cerrar</button>
        </div>
      </body>
      </html>
    `);
  }
});

// 3. Disconnect Kick
app.post('/api/auth/kick/disconnect', (req, res) => {
  const updated = storage.saveConfig({
    kick: {
      channel: '',
      username: '',
      profile_picture: '',
      userId: '',
      accessToken: '',
      refreshToken: '',
      clientId: process.env.KICK_CLIENT_ID || '01M0VT0JC58YQEVGRHM8JFXQX3',
      connected: false
    }
  });
  broadcast('config_updated', updated);
  res.json({ success: true, message: 'Canal de Kick desvinculado.', config: updated });
});

// Disconnect / Logout
app.post(['/api/bot/disconnect', '/api/auth/logout'], async (req, res) => {
  try {
    if (twitchBot) {
      try { await twitchBot.disconnect(); } catch(e) {}
    }
    storage.setStreamerId('default');
    const updated = storage.saveConfig({
      twitch: {
        channel: '',
        botUsername: '',
        oauthToken: '',
        clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
        connected: false,
        displayName: '',
        profileImage: '',
        userId: ''
      }
    });
    broadcast('config_updated', updated);
    broadcast('bot_status', { status: 'disconnected', channel: '' });
    return res.json({ success: true, message: 'Sesión cerrada exitosamente.', config: updated });
  } catch(err) {
    console.error('Error during disconnect:', err);
    return res.status(500).json({ success: false, message: err.message });
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

app.put('/api/commands/:id', (req, res) => {
  const { id } = req.params;
  const updatedCmd = req.body;
  const commands = storage.getCommands();
  const index = commands.findIndex(c => c.id === id);
  if (index !== -1) {
    commands[index] = { ...commands[index], ...updatedCmd, id };
    storage.saveCommands(commands);
    return res.json({ success: true, commands });
  }
  res.status(404).json({ success: false, message: 'Comando no encontrado.' });
});

// Sound files management
app.get('/api/sounds', (req, res) => {
  try {
    const soundsDir = path.join(__dirname, 'public', 'assets', 'sounds');
    if (!fs.existsSync(soundsDir)) {
      fs.mkdirSync(soundsDir, { recursive: true });
    }
    const files = fs.readdirSync(soundsDir)
      .filter(f => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f))
      .map(f => ({
        name: f,
        url: `/assets/sounds/${f}`
      }));
    res.json(files);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/sounds/upload', (req, res) => {
  try {
    const { name, data } = req.body;
    if (!name || !data) {
      return res.status(400).json({ success: false, message: 'Falta nombre o archivo de audio.' });
    }

    const cleanName = name.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
    const soundsDir = path.join(__dirname, 'public', 'assets', 'sounds');
    if (!fs.existsSync(soundsDir)) {
      fs.mkdirSync(soundsDir, { recursive: true });
    }

    const base64Data = data.replace(/^data:audio\/\w+;base64,/, '').replace(/^data:application\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const targetPath = path.join(soundsDir, cleanName);

    fs.writeFileSync(targetPath, buffer);

    // Sync to docs if present
    const docsDir = path.join(__dirname, 'docs', 'assets', 'sounds');
    if (fs.existsSync(path.join(__dirname, 'docs'))) {
      if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, cleanName), buffer);
    }

    const soundUrl = `/assets/sounds/${cleanName}`;
    res.json({ success: true, name: cleanName, url: soundUrl });
  } catch (err) {
    console.error('Error al subir sonido:', err);
    res.status(500).json({ success: false, message: err.message });
  }
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

// Fetch Twitch Channel Points Custom Rewards from Twitch Helix
app.get('/api/rewards/twitch', async (req, res) => {
  try {
    const config = storage.getConfig();
    const twitchCfg = config.twitch || {};
    if (!twitchCfg.oauthToken || !twitchCfg.userId || !twitchCfg.clientId) {
      return res.status(400).json({ success: false, message: 'Twitch no está autenticado o falta User ID.' });
    }
    const cleanToken = twitchCfg.oauthToken.replace(/^oauth:/i, '').trim();
    const helixRes = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${twitchCfg.userId}`, {
      headers: {
        'Client-Id': twitchCfg.clientId,
        'Authorization': `Bearer ${cleanToken}`
      }
    });
    if (!helixRes.ok) {
      const err = await helixRes.json().catch(() => ({}));
      return res.status(helixRes.status).json({ success: false, message: err.message || 'Error al obtener recompensas de Twitch.' });
    }
    const data = await helixRes.json();
    return res.json({ success: true, rewards: data.data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
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

// Alerts API
app.get('/api/alerts', (req, res) => {
  res.json(storage.getAlerts());
});

app.post('/api/alerts', (req, res) => {
  const alerts = storage.saveAlerts(req.body);
  broadcast('alerts_updated', alerts);
  res.json({ success: true, alerts });
});

// Widget Styles API (used by OBS overlays to load custom styles)
app.get('/api/widget-styles', (req, res) => {
  const config = storage.getConfig();
  res.json(config.widgetStyles || {});
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

  // Keep-Alive / Anti-Sleep System (Render Free Tier duerme a los 15 min de inactividad)
  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (keepAliveUrl) {
    const PING_INTERVAL_MS = 10 * 60 * 1000; // Cada 10 minutos
    console.log(`⚡ [Keep-Alive] Anti-sleep activado para: ${keepAliveUrl} (Intervalo: 10m)`);
    setInterval(async () => {
      try {
        const pingEndpoint = `${keepAliveUrl.replace(/\/$/, '')}/health`;
        const res = await fetch(pingEndpoint);
        if (res.ok) {
          console.log(`⚡ [Keep-Alive] Ping exitoso a ${pingEndpoint} - [${new Date().toISOString()}]`);
        }
      } catch (err) {
        console.warn(`⚠️ [Keep-Alive] Error en auto-ping:`, err.message);
      }
    }, PING_INTERVAL_MS);
  }
});
