/**
 * Twitch StreamBot & Overlay Toolkit - Dashboard Logic
 */

let appConfig = null;
let ytPlayer = null;
let ytApiReady = false;
let socket = null;

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupRangeInputs();
  setupEventListeners();
  setupAutoSaveListeners();
  populateWidgetUrls();
  await loadInitialData();
  populateWidgetUrls();
  connectWebSocket();
  initDashboardMqtt();
});

// ================= NAVIGATION =================
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const titleEl = document.getElementById('currentTabTitle');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      item.classList.add('active');
      const targetTabId = item.getAttribute('data-tab');
      const targetPane = document.getElementById(targetTabId);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      titleEl.innerText = item.querySelector('span:last-child').innerText;
    });
  });
}

function switchTab(tabId) {
  const navItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (navItem) {
    navItem.click();
  } else {
    const tabPanes = document.querySelectorAll('.tab-pane');
    tabPanes.forEach(p => p.classList.remove('active'));
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
  }
}

// ================= TOAST NOTIFICATIONS =================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warn') icon = '⚠️';

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 3500);
}

// ================= WEBSOCKET & MULTI-CHANNEL REALTIME =================
const broadcastChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('orbibot_stream_channel') : null;
let dashboardMqttClient = null;
let isMqttConnected = false;

function initDashboardMqtt() {
  if (typeof Paho === 'undefined') return;
  const channel = (appConfig?.twitch?.channel || '').toLowerCase().replace(/^#/, '') || 'general';
  const clientId = 'orbi_dash_' + Math.random().toString(36).substring(2, 9);
  try {
    if (dashboardMqttClient) {
      try { dashboardMqttClient.disconnect(); } catch(e) {}
    }
    dashboardMqttClient = new Paho.MQTT.Client('broker.emqx.io', 8084, clientId);
    dashboardMqttClient.onConnectionLost = () => {
      isMqttConnected = false;
      setTimeout(initDashboardMqtt, 4000);
    };
    dashboardMqttClient.connect({
      useSSL: true,
      timeout: 6,
      keepAliveInterval: 30,
      onSuccess: () => {
        isMqttConnected = true;
        console.log('OrbiBot Dashboard conectado a Cloud Relay MQTT (OBS Ready)');
      },
      onFailure: (err) => {
        isMqttConnected = false;
        console.warn('MQTT Connection failed:', err);
        setTimeout(initDashboardMqtt, 6000);
      }
    });
  } catch(e) {
    console.warn('Error creating MQTT client:', e);
  }
}

function broadcastEvent(event, data) {
  const payload = { event, data, timestamp: Date.now() };

  // 1. BroadcastChannel (para pestañas del mismo navegador)
  if (broadcastChannel) {
    try { broadcastChannel.postMessage(payload); } catch(e) {}
  }

  // 2. Storage event
  try {
    localStorage.setItem('orbibot_last_event', JSON.stringify(payload));
  } catch(e) {}

  // 3. Cloud MQTT Relay (para fuentes de navegador OBS Studio)
  if (dashboardMqttClient && isMqttConnected) {
    try {
      const channel = (appConfig?.twitch?.channel || '').toLowerCase().replace(/^#/, '') || 'general';
      const token = getEffectiveWidgetToken();
      const msgStr = JSON.stringify(payload);
      
      // Publicar en tópico privado protegido con token secreto
      if (channel !== 'general' && token) {
        const msgPriv = new Paho.MQTT.Message(msgStr);
        msgPriv.destinationName = `orbibot/${channel}_${token}/events`;
        dashboardMqttClient.send(msgPriv);
      }

      // Publicar también en tópico estándar para compatibilidad
      const msg1 = new Paho.MQTT.Message(msgStr);
      msg1.destinationName = `orbibot/${channel}/events`;
      dashboardMqttClient.send(msg1);

      if (channel !== 'general') {
        const msg2 = new Paho.MQTT.Message(msgStr);
        msg2.destinationName = 'orbibot/general/events';
        dashboardMqttClient.send(msg2);
      }
    } catch(e) {
      console.warn('Error publishing to MQTT relay:', e);
    }
  }

  // 4. Local WebSocket Server (si el backend local node server.js está corriendo)
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
    } catch(e) {}
  }
}

function connectWebSocket() {
  // Listen on BroadcastChannel for multi-tab sync & OAuth callback
  if (broadcastChannel) {
    broadcastChannel.onmessage = (e) => {
      if (e.data) {
        if (e.data.type === 'TWITCH_AUTH_SUCCESS') {
          handleAuthSuccess(e.data);
          return;
        }
        handleSocketMessage(e.data);
      }
    };
  }

  // Storage event listener
  window.addEventListener('storage', (e) => {
    if (e.key === 'orbibot_last_event' && e.newValue) {
      try { handleSocketMessage(JSON.parse(e.newValue)); } catch(err) {}
    }
    if (e.key === 'orbibot_twitch_auth_event' && e.newValue) {
      try {
        const payload = JSON.parse(e.newValue);
        handleAuthSuccess(payload);
      } catch(err) {}
    }
  });

  // WebSocket for backend (works on Render, localhost, or any custom domain; skips only static github.io)
  const isGitHubPages = location.hostname.endsWith('github.io');
  if (!isGitHubPages) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      socket = new WebSocket(`${protocol}//${location.host}`);

      socket.onopen = () => {
        console.log('Connected to StreamBot Server WebSocket');
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleSocketMessage(msg);
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      socket.onclose = () => {
        setTimeout(connectWebSocket, 3000);
      };
    } catch(e) {}
  }
}

function handleSocketMessage(msg) {
  const { event, data } = msg;

  if (event === 'init_state') {
    updateBotStatusUI(data.botStatus);
    updateSongRequestUI(data.srState);
  } else if (event === 'bot_status') {
    updateBotStatusUI(data);
  } else if (event === 'chat_message') {
    appendChatMessage(data);
  } else if (event === 'sr_update') {
    updateSongRequestUI(data.state);
    if (data.action === 'play' && data.data) {
      playYouTubeSong(data.data.videoId);
    }
  } else if (event === 'alert') {
    showToast(`Alerta recibida: ${data.type?.toUpperCase()} de ${data.user}`, 'success');
  } else if (event === 'tts') {
    console.log('TTS triggered:', data);
  }
}

// ================= LOAD DATA =================
async function loadInitialData() {
  try {
    const [cfgRes, cmdRes, rwdRes, srRes] = await Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/commands').then(r => r.json()),
      fetch('/api/rewards').then(r => r.json()),
      fetch('/api/sr/state').then(r => r.json())
    ]);

    // Sync localStorage Twitch auth if present
    const localTwitch = localStorage.getItem('orbibot_twitch_auth');
    let effectiveTwitch = cfgRes.twitch || {};
    if (localTwitch) {
      try {
        const parsed = JSON.parse(localTwitch);
        const chan = (parsed.channel || parsed.login || (parsed.displayName ? parsed.displayName.toLowerCase() : '') || '').replace(/^#/, '');
        if (chan) {
          parsed.channel = chan;
          parsed.connected = true;
          effectiveTwitch = { ...effectiveTwitch, ...parsed };
          cfgRes.twitch = effectiveTwitch;
          if (parsed.oauthToken) {
            fetch('/api/auth/twitch-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: parsed.oauthToken, channel: chan })
            }).catch(() => {});
          }
        }
      } catch(e) {}
    }

    appConfig = cfgRes;
    bindConfigToUI(cfgRes);
    renderCommands(cmdRes);
    renderRewards(rwdRes);
    updateSongRequestUI(srRes);

    if (effectiveTwitch.channel && window.tmi && (!browserTmiClient || browserTmiClient.readyState() !== 'OPEN')) {
      connectInBrowserTwitchBot(effectiveTwitch);
    }
  } catch (err) {
    console.warn('Backend API not reachable. Running in standalone / GitHub Pages mode:', err);
    
    // Load from localStorage or defaults
    const localTwitch = localStorage.getItem('orbibot_twitch_auth');
    const localCfg = localStorage.getItem('orbibot_config');
    const localCmds = localStorage.getItem('orbibot_commands');
    const localRwds = localStorage.getItem('orbibot_rewards');

    let twitchData = localTwitch ? JSON.parse(localTwitch) : {
      channel: '',
      botUsername: '',
      oauthToken: '',
      clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
      connected: false
    };

    const chan = (twitchData.channel || twitchData.login || (twitchData.displayName ? twitchData.displayName.toLowerCase() : '') || '').replace(/^#/, '');
    if (chan) {
      twitchData.channel = chan;
      twitchData.connected = true;
    }

    let cfg = localCfg ? JSON.parse(localCfg) : {
      twitch: twitchData,
      songRequest: { prefix: '!sr', enabled: true, maxDurationMinutes: 8, maxPerUser: 5, userLevel: 'all', volume: 75 },
      tts: { enabled: true, voice: 'es_001', volume: 90, rate: 1.0, pitch: 1.0, maxLength: 250, bannedWords: [], allowChatCommand: true, chatCommand: '!tts', minBits: 50 },
      goals: {
        subs: { title: 'Meta de Suscriptores', current: 12, target: 50, color: '#9146ff' },
        followers: { title: 'Meta de Seguidores', current: 185, target: 300, color: '#00f2fe' },
        bits: { title: 'Meta de Bits', current: 1500, target: 5000, color: '#f5a623' }
      }
    };

    cfg.twitch = { ...cfg.twitch, ...twitchData };
    appConfig = cfg;
    bindConfigToUI(cfg);

    const defaultCommands = [
      { id: '1', name: '!discord', response: '¡Únete a nuestra comunidad de Discord!', cooldown: 10, userLevel: 'all' },
      { id: '2', name: '!redes', response: 'Sígueme en redes sociales: @streamer', cooldown: 10, userLevel: 'all' },
      { id: '3', name: '!bot', response: 'Bot de stream creado con OrbiBot.', cooldown: 10, userLevel: 'all' }
    ];
    renderCommands(localCmds ? JSON.parse(localCmds) : defaultCommands);

    const defaultRewards = [
      { id: '1', rewardName: 'Mensaje con Voz (TTS)', action: 'tts', cost: 500 },
      { id: '2', rewardName: 'Pedir Canción', action: 'song_request', cost: 300 }
    ];
    renderRewards(localRwds ? JSON.parse(localRwds) : defaultRewards);

    updateSongRequestUI({ currentSong: null, queue: [], isPlaying: false });

    // In-browser Twitch IRC connection (if credentials exist)
    if (twitchData.channel && window.tmi) {
      connectInBrowserTwitchBot(twitchData);
    }
  }
}

// In-Browser Twitch Bot for GitHub Pages
let browserTmiClient = null;
function connectInBrowserTwitchBot(twitchData) {
  if (!window.tmi || !twitchData) return;
  const rawChannel = twitchData.channel || twitchData.login || (twitchData.displayName ? twitchData.displayName.toLowerCase() : '');
  const channel = (rawChannel || '').toLowerCase().replace(/^#/, '');
  if (!channel) return;

  if (browserTmiClient) {
    try { browserTmiClient.disconnect(); } catch(e) {}
  }

  const opts = {
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    channels: [channel]
  };

  if (twitchData.oauthToken) {
    const token = twitchData.oauthToken.startsWith('oauth:') ? twitchData.oauthToken : `oauth:${twitchData.oauthToken}`;
    opts.identity = {
      username: twitchData.botUsername || channel,
      password: token
    };
  }

  updateBotStatusUI({ status: 'connecting', channel });

  function setupClient(client) {
    client.on('connected', () => {
      updateBotStatusUI({ status: 'connected', channel });
      const statChan = document.getElementById('statChannelName');
      if (statChan) statChan.innerText = `#${channel}`;
      const notice = document.getElementById('chatStatusNotice');
      if (notice) notice.innerText = `🟢 En línea (#${channel})`;
      const chatContainer = document.getElementById('liveChatMessages');
      if (chatContainer && chatContainer.innerText.includes('Conecta tu canal de Twitch')) {
        chatContainer.innerHTML = `<div class="chat-msg-row" style="color: var(--cyan-accent);"><em>🟢 Conectado al chat de #${channel}. Esperando mensajes...</em></div>`;
      }
      showToast(`Conectado al chat de #${channel}`, 'success');
    });

    client.on('message', (ch, tags, message, self) => {
      if (self) return;
      const username = tags['display-name'] || tags.username;
      const isMod = tags.mod || tags.badges?.broadcaster === '1';
      const isSub = tags.subscriber || tags.badges?.subscriber !== undefined;
      const userColor = tags.color || '#9146ff';

      const chatData = {
        id: tags.id || Date.now().toString(),
        user: username,
        color: userColor,
        message,
        isMod,
        isSub,
        badges: tags.badges || {},
        badgesRaw: tags['badges-raw'] || null,
        emotes: tags.emotes || null,
        roomId: tags['room-id'] || null
      };

      appendChatMessage(chatData);
      broadcastEvent('chat_message', chatData);

      // Bits
      if (tags.bits) {
        const bitCount = parseInt(tags.bits, 10);
        const alertData = { type: 'bits', user: username, amount: bitCount, message };
        broadcastEvent('alert', alertData);
        showToast(`¡${username} donó ${bitCount} bits!`, 'success');
      }
    });
  }

  browserTmiClient = new window.tmi.Client(opts);
  setupClient(browserTmiClient);

  browserTmiClient.connect().catch(e => {
    console.warn('IRC authed connection failed, falling back to anonymous read-only:', e);
    try {
      delete opts.identity;
      browserTmiClient = new window.tmi.Client(opts);
      setupClient(browserTmiClient);
      browserTmiClient.connect().catch(err => {
        updateBotStatusUI({ status: 'connected', channel });
      });
    } catch(err) {
      updateBotStatusUI({ status: 'connected', channel });
    }
  });
}

// ================= UI BINDING =================
function bindConfigToUI(cfg) {
  if (!cfg) return;
  if (!cfg.twitch) {
    try {
      const local = localStorage.getItem('orbibot_twitch_auth');
      if (local) cfg.twitch = JSON.parse(local);
    } catch(e) {}
  }

  // Twitch Profile & Connection
  if (cfg.twitch) {
    const channel = (cfg.twitch.channel || cfg.twitch.login || (cfg.twitch.displayName ? cfg.twitch.displayName.toLowerCase() : '') || '').replace(/^#/, '');
    if (channel) {
      cfg.twitch.channel = channel;
    }
    const isConn = (cfg.twitch.connected || Boolean(cfg.twitch.oauthToken) || Boolean(channel)) && Boolean(channel);
    
    // Header elements
    const topTwitchLoginBtn = document.getElementById('topTwitchLoginBtn');
    const topUserPill = document.getElementById('topUserPill');
    const topUserAvatar = document.getElementById('topUserAvatar');
    const topUserName = document.getElementById('topUserName');

    // Dashboard Hero elements
    const loginHero = document.getElementById('dashboardLoginHero');
    const connectedHero = document.getElementById('dashboardConnectedHero');
    const dashUserAvatar = document.getElementById('dashUserAvatar');
    const dashUserName = document.getElementById('dashUserName');
    const dashUserTag = document.getElementById('dashUserTag');

    const avatar = cfg.twitch.profileImage || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb60-aee8f1560db5-profile_image-300x300.png';
    const dName = cfg.twitch.displayName || channel || 'Streamer';
    const login = channel;

    if (isConn) {
      if (topTwitchLoginBtn) topTwitchLoginBtn.style.display = 'none';
      if (topUserPill) {
        topUserPill.style.display = 'inline-flex';
        if (topUserAvatar) topUserAvatar.src = avatar;
        if (topUserName) topUserName.innerText = `@${login || dName}`;
      }

      if (loginHero) loginHero.style.display = 'none';
      if (connectedHero) {
        connectedHero.style.display = 'block';
        if (dashUserAvatar) dashUserAvatar.src = avatar;
        if (dashUserName) dashUserName.innerText = dName;
        if (dashUserTag) dashUserTag.innerText = `@${login || dName}`;
      }

      updateBotStatusUI({ status: 'connected', channel: login });
    } else {
      if (topTwitchLoginBtn) topTwitchLoginBtn.style.display = 'inline-flex';
      if (topUserPill) topUserPill.style.display = 'none';

      if (loginHero) loginHero.style.display = 'block';
      if (connectedHero) connectedHero.style.display = 'none';

      updateBotStatusUI({ status: 'disconnected' });
    }

    if (document.getElementById('cfgTwitchChannel')) document.getElementById('cfgTwitchChannel').value = channel;
    if (document.getElementById('cfgTwitchBotUser')) document.getElementById('cfgTwitchBotUser').value = cfg.twitch.botUsername || channel;
    if (document.getElementById('cfgTwitchToken')) document.getElementById('cfgTwitchToken').value = cfg.twitch.oauthToken || '';
    if (document.getElementById('cfgTwitchClientId')) {
      document.getElementById('cfgTwitchClientId').value = cfg.twitch.clientId || 'yw1vr664ichms8an2x5lhji58v7ozk';
    }
    if (document.getElementById('statChannelName')) {
      document.getElementById('statChannelName').innerText = channel ? `#${channel}` : 'Ninguno';
    }
    populateWidgetUrls();
  }

  // Song Request
  if (cfg.songRequest) {
    document.getElementById('cfgSrPrefix').value = cfg.songRequest.prefix || '!sr';
    document.getElementById('cfgSrUserLevel').value = cfg.songRequest.userLevel || 'all';
    document.getElementById('cfgSrMaxDuration').value = cfg.songRequest.maxDurationMinutes || 8;
    document.getElementById('cfgSrMaxPerUser').value = cfg.songRequest.maxPerUser || 5;
    document.getElementById('cfgSrEnabled').checked = cfg.songRequest.enabled !== false;
  }

  // TTS
  if (cfg.tts) {
    document.getElementById('cfgTtsEnabled').checked = cfg.tts.enabled !== false;
    document.getElementById('cfgTtsVoice').value = cfg.tts.voice || 'es_001';
    document.getElementById('cfgTtsVolume').value = cfg.tts.volume !== undefined ? cfg.tts.volume : 90;
    document.getElementById('valTtsVolume').innerText = `${document.getElementById('cfgTtsVolume').value}%`;
    document.getElementById('cfgTtsRate').value = cfg.tts.rate || 1.0;
    document.getElementById('valTtsRate').innerText = `${document.getElementById('cfgTtsRate').value}x`;
    document.getElementById('cfgTtsPitch').value = cfg.tts.pitch || 1.0;
    document.getElementById('valTtsPitch').innerText = document.getElementById('cfgTtsPitch').value;
    document.getElementById('cfgTtsMaxLength').value = cfg.tts.maxLength || 250;
    document.getElementById('cfgTtsBannedWords').value = (cfg.tts.bannedWords || []).join(', ');
    document.getElementById('cfgTtsAllowCommand').checked = cfg.tts.allowChatCommand !== false;
    document.getElementById('cfgTtsCommand').value = cfg.tts.chatCommand || '!tts';
    document.getElementById('cfgTtsMinBits').value = cfg.tts.minBits !== undefined ? cfg.tts.minBits : 50;
  }

  // Goals
  if (cfg.goals) {
    if (cfg.goals.subs) {
      document.getElementById('cfgGoalSubTitle').value = cfg.goals.subs.title || 'Meta de Suscriptores';
      document.getElementById('cfgGoalSubCurrent').value = cfg.goals.subs.current || 0;
      document.getElementById('cfgGoalSubTarget').value = cfg.goals.subs.target || 50;
    }
    if (cfg.goals.followers) {
      document.getElementById('cfgGoalFollowTitle').value = cfg.goals.followers.title || 'Meta de Seguidores';
      document.getElementById('cfgGoalFollowCurrent').value = cfg.goals.followers.current || 0;
      document.getElementById('cfgGoalFollowTarget').value = cfg.goals.followers.target || 300;
    }
    if (cfg.goals.bits) {
      document.getElementById('cfgGoalBitsTitle').value = cfg.goals.bits.title || 'Meta de Bits';
      document.getElementById('cfgGoalBitsCurrent').value = cfg.goals.bits.current || 0;
      document.getElementById('cfgGoalBitsTarget').value = cfg.goals.bits.target || 5000;
    }
  }
}

function setupRangeInputs() {
  const vol = document.getElementById('cfgTtsVolume');
  const rate = document.getElementById('cfgTtsRate');
  const pitch = document.getElementById('cfgTtsPitch');

  vol.addEventListener('input', () => { document.getElementById('valTtsVolume').innerText = `${vol.value}%`; });
  rate.addEventListener('input', () => { document.getElementById('valTtsRate').innerText = `${rate.value}x`; });
  pitch.addEventListener('input', () => { document.getElementById('valTtsPitch').innerText = pitch.value; });
}

// ================= BOT STATUS =================
function updateBotStatusUI(botStatus) {
  const dot = document.getElementById('botStatusDot');
  const text = document.getElementById('botStatusText');
  const badge = document.getElementById('twitchConnectionBadge');
  const statText = document.getElementById('statBotStatus');
  const quickBtn = document.getElementById('quickConnectBtn');
  const statChan = document.getElementById('statChannelName');

  let currentChannel = (appConfig?.twitch?.channel || '').replace(/^#/, '');
  if (!currentChannel) {
    try {
      const local = localStorage.getItem('orbibot_twitch_auth');
      if (local) {
        const p = JSON.parse(local);
        currentChannel = (p.channel || p.login || (p.displayName ? p.displayName.toLowerCase() : '') || '').replace(/^#/, '');
      }
    } catch(e) {}
  }

  let status = botStatus?.status || 'disconnected';
  if ((status === 'disconnected' || !status) && currentChannel && (browserTmiClient || appConfig?.twitch?.connected || localStorage.getItem('orbibot_twitch_auth'))) {
    status = 'connected';
  }

  if (dot) dot.className = `status-dot ${status}`;
  if (text) text.innerText = status === 'connected' ? 'En Línea' : (status === 'connecting' ? 'Conectando...' : 'Desconectado');

  if (status === 'connected') {
    if (badge) {
      badge.className = 'btn btn-sm btn-accent';
      badge.innerText = '🟢 Conectado';
    }
    if (statText) {
      statText.innerText = 'En Línea';
      statText.style.color = 'var(--green-success)';
    }
    if (quickBtn) quickBtn.innerText = 'Desconectar';
    if (statChan && currentChannel) statChan.innerText = `#${currentChannel}`;
  } else if (status === 'connecting') {
    if (badge) {
      badge.className = 'btn btn-sm btn-secondary';
      badge.innerText = '🟡 Conectando...';
    }
    if (statText) {
      statText.innerText = 'Conectando';
      statText.style.color = 'var(--yellow-warn)';
    }
    if (quickBtn) quickBtn.innerText = 'Conectando...';
  } else {
    if (badge) {
      badge.className = 'btn btn-sm btn-danger';
      badge.innerText = '🔴 Desconectado';
    }
    if (statText) {
      statText.innerText = 'Inactivo';
      statText.style.color = 'var(--red-danger)';
    }
    if (quickBtn) quickBtn.innerText = 'Conectar';
  }
}

// ================= TWITCH BADGES & EMOTES =================
const DEFAULT_TWITCH_BADGES = {
  broadcaster: {
    title: 'Streamer / Transmisor',
    url: 'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1'
  },
  moderator: {
    title: 'Moderador',
    url: 'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1'
  },
  vip: {
    title: 'VIP',
    url: 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1'
  },
  subscriber: {
    title: 'Suscriptor',
    url: 'https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/1'
  },
  founder: {
    title: 'Fundador',
    url: 'https://static-cdn.jtvnw.net/badges/v1/511b78a9-ab37-472f-9569-457753bbe7d3/1'
  },
  premium: {
    title: 'Prime Gaming',
    url: 'https://static-cdn.jtvnw.net/badges/v1/bbbe0db0-a598-423e-86d0-f9fb98ca1933/1'
  },
  turbo: {
    title: 'Turbo',
    url: 'https://static-cdn.jtvnw.net/badges/v1/bd444ec6-8f34-4bf9-91f4-af1e3428d80f/1'
  },
  partner: {
    title: 'Verificado',
    url: 'https://static-cdn.jtvnw.net/badges/v1/d12a2e27-16f6-41d0-ab77-b780518f00a3/1'
  },
  'artist-badge': {
    title: 'Artista',
    url: 'https://static-cdn.jtvnw.net/badges/v1/4300a897-03dc-4e83-8c0e-c332fee7057f/1'
  },
  'bot-badge': {
    title: 'Bot de Chat',
    url: 'https://static-cdn.jtvnw.net/badges/v1/3ffa9565-c35b-4cad-800b-041e60659cf2/1'
  },
  staff: {
    title: 'Twitch Staff',
    url: 'https://static-cdn.jtvnw.net/badges/v1/d97c37bd-a6f5-4c38-8f57-4e4bef88af34/1'
  },
  admin: {
    title: 'Twitch Admin',
    url: 'https://static-cdn.jtvnw.net/badges/v1/9ef7e029-4cdf-4d4d-a0d5-e2b3fb2583fe/1'
  },
  global_mod: {
    title: 'Moderador Global',
    url: 'https://static-cdn.jtvnw.net/badges/v1/9384c43e-4ce7-4e94-b2a1-b93656896eba/1'
  },
  'glhf-pledge': {
    title: 'GLHF Pledge',
    url: 'https://static-cdn.jtvnw.net/badges/v1/3158e758-3cb4-43c5-94b3-7639810451c5/1'
  },
  'sub-gifter': {
    title: 'Regalador de Suscripciones',
    url: 'https://static-cdn.jtvnw.net/badges/v1/a5ef6c17-2e5b-4d8f-9b80-2779fd722414/1'
  },
  no_video: {
    title: 'Solo Audio',
    url: 'https://static-cdn.jtvnw.net/badges/v1/aef2cd08-f292-42c6-917d-f4728562d49b/1'
  }
};

const channelBadgesCache = {};
const loadedBadgesChannels = new Set();

async function loadChannelBadges(channelIdOrName) {
  if (!channelIdOrName || loadedBadgesChannels.has(channelIdOrName)) return;
  loadedBadgesChannels.add(channelIdOrName);
  try {
    const isId = /^\d+$/.test(channelIdOrName);
    const param = isId ? `id=${channelIdOrName}` : `name=${channelIdOrName.toLowerCase().replace(/^#/, '')}`;
    const res = await fetch(`https://api.ivr.fi/v2/twitch/badges/channel?${param}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach(set => {
          if (!channelBadgesCache[set.set_id]) channelBadgesCache[set.set_id] = {};
          if (Array.isArray(set.versions)) {
            set.versions.forEach(v => {
              channelBadgesCache[set.set_id][v.id] = {
                title: v.title,
                url: v.image_url_1x || v.image_url_2x || v.image_url_4x
              };
            });
          }
        });
      }
    }
  } catch (e) {}
}

function getTwitchBadgeInfo(setId, version) {
  if (channelBadgesCache[setId] && channelBadgesCache[setId][version]) {
    return channelBadgesCache[setId][version];
  }
  if (DEFAULT_TWITCH_BADGES[setId]) {
    return DEFAULT_TWITCH_BADGES[setId];
  }
  return null;
}

function renderTwitchBadges(badgesData, isMod, isSub) {
  let badges = {};
  if (typeof badgesData === 'string') {
    badgesData.split(',').forEach(part => {
      const [k, v] = part.split('/');
      if (k) badges[k] = v || '1';
    });
  } else if (badgesData && typeof badgesData === 'object') {
    badges = badgesData;
  }

  let html = '';
  const badgeOrder = [
    'staff', 'admin', 'global_mod', 'broadcaster', 'moderator',
    'vip', 'founder', 'subscriber', 'artist-badge', 'partner',
    'premium', 'turbo', 'sub-gifter', 'bot-badge', 'glhf-pledge', 'no_video'
  ];

  const processed = new Set();
  for (const key of badgeOrder) {
    if (badges[key] !== undefined) {
      processed.add(key);
      const info = getTwitchBadgeInfo(key, badges[key]);
      if (info) {
        html += `<img class="twitch-badge" src="${info.url}" alt="${escapeHtml(info.title)}" title="${escapeHtml(info.title)}" loading="lazy">`;
      }
    }
  }

  for (const key in badges) {
    if (!processed.has(key)) {
      const info = getTwitchBadgeInfo(key, badges[key]);
      if (info) {
        html += `<img class="twitch-badge" src="${info.url}" alt="${escapeHtml(info.title)}" title="${escapeHtml(info.title)}" loading="lazy">`;
      }
    }
  }

  // Fallback if badges object is empty
  if (!html) {
    if (isMod) {
      const m = DEFAULT_TWITCH_BADGES.moderator;
      html += `<img class="twitch-badge" src="${m.url}" alt="${m.title}" title="${m.title}" loading="lazy">`;
    } else if (isSub) {
      const s = DEFAULT_TWITCH_BADGES.subscriber;
      html += `<img class="twitch-badge" src="${s.url}" alt="${s.title}" title="${s.title}" loading="lazy">`;
    }
  }

  return html;
}

function formatTwitchEmotes(message, emotes) {
  if (!message) return '';
  if (!emotes || typeof emotes !== 'object' || Object.keys(emotes).length === 0) {
    return escapeHtml(message);
  }
  const ranges = [];
  for (const emoteId in emotes) {
    const list = emotes[emoteId];
    if (Array.isArray(list)) {
      list.forEach(range => {
        const parts = range.split('-');
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);
        if (!isNaN(start) && !isNaN(end)) {
          ranges.push({ id: emoteId, start, end });
        }
      });
    }
  }
  if (ranges.length === 0) {
    return escapeHtml(message);
  }
  ranges.sort((a, b) => a.start - b.start);

  let html = '';
  let lastIdx = 0;
  for (const r of ranges) {
    if (r.start > lastIdx) {
      html += escapeHtml(message.slice(lastIdx, r.start));
    }
    const emoteName = message.slice(r.start, r.end + 1);
    html += `<img class="twitch-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0" alt="${escapeHtml(emoteName)}" title="${escapeHtml(emoteName)}" loading="lazy">`;
    lastIdx = r.end + 1;
  }
  if (lastIdx < message.length) {
    html += escapeHtml(message.slice(lastIdx));
  }
  return html;
}

// ================= CHAT LIVE LOG =================
function appendChatMessage(data) {
  const container = document.getElementById('liveChatMessages');
  if (!container) return;

  // Clear initial placeholder notice if present
  const placeholder = container.querySelector('em');
  if (placeholder && placeholder.parentElement && placeholder.parentElement.parentElement === container) {
    container.innerHTML = '';
  }

  if (data.roomId) {
    loadChannelBadges(data.roomId);
  }

  const row = document.createElement('div');
  row.className = 'chat-msg-row';

  const badgeHtml = renderTwitchBadges(data.badges || data.badgesRaw, data.isMod, data.isSub);
  const formattedText = formatTwitchEmotes(data.message, data.emotes);

  row.innerHTML = `
    <span class="chat-badges">${badgeHtml}</span>
    <span class="chat-user" style="color: ${data.color || '#9146ff'}">${escapeHtml(data.user)}:</span>
    <span class="chat-text">${formattedText}</span>
  `;

  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function triggerTestChat() {
  const channel = (appConfig?.twitch?.channel || 'StreamerMaster').replace(/^#/, '');
  const sampleMessages = [
    {
      user: channel,
      color: '#ff007f',
      message: '¡Hola a todos! Bienvenidos al directo Kappa Keepo',
      badges: { broadcaster: '1', subscriber: '12' },
      isMod: true,
      isSub: true,
      emotes: { '25': ['36-40'], '1902': ['42-46'] }
    },
    {
      user: 'Moderador_Pro',
      color: '#00f2fe',
      message: 'Recuerden respetar las reglas del chat y pasarla bien PogChamp',
      badges: { moderator: '1', partner: '1' },
      isMod: true,
      isSub: false,
      emotes: { '88': ['52-59'] }
    },
    {
      user: 'SuperVIP_Fan',
      color: '#ffd700',
      message: '¡Aquí apoyando con suscripción de regalo! <3 LUL',
      badges: { vip: '1', premium: '1', 'sub-gifter': '5' },
      isMod: false,
      isSub: true,
      emotes: { '425618': ['45-47'] }
    },
    {
      user: 'FundadorTier3',
      color: '#a855f7',
      message: '¡Esa canción está brutal! VoHiYo',
      badges: { founder: '0', turbo: '1', 'artist-badge': '1' },
      isMod: false,
      isSub: true,
      emotes: { '81274': ['26-31'] }
    }
  ];

  sampleMessages.forEach((msg, idx) => {
    setTimeout(() => {
      appendChatMessage(msg);
      broadcastEvent('chat_message', msg);
    }, idx * 600);
  });
  showToast('💬 Mensajes de prueba con emblemas originales enviados a OBS y Chat', 'success');
}
window.triggerTestChat = triggerTestChat;

// ================= SONG REQUEST UI & YOUTUBE =================
function updateSongRequestUI(state) {
  if (!state) return;

  const current = state.currentSong;
  const queue = state.queue || [];

  // Update Stats
  document.getElementById('statQueueCount').innerText = queue.length;
  document.getElementById('queueBadgeTotal').innerText = `${queue.length} canciones`;

  // Update Current Song Banner
  const thumb = document.getElementById('srCurrentThumb');
  const title = document.getElementById('srCurrentTitle');
  const author = document.getElementById('srCurrentAuthor');
  const requester = document.getElementById('srCurrentRequester');

  if (current) {
    thumb.src = current.thumbnail || 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
    title.innerText = current.title;
    author.innerText = current.author || 'YouTube';
    requester.innerHTML = `Pedida por: <strong>@${current.requester}</strong> (${current.durationFormatted || '3:30'})`;

    if (ytPlayer && ytApiReady && current.videoId) {
      const currentVideoId = ytPlayer.getVideoData ? ytPlayer.getVideoData().video_id : null;
      if (currentVideoId !== current.videoId) {
        playYouTubeSong(current.videoId);
      }
    }
  } else {
    thumb.src = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
    title.innerText = 'No hay canción sonando';
    author.innerText = 'Pide una canción con !sr en el chat';
    requester.innerText = 'Esperando solicitudes...';
  }

  // Visualizer wave
  const wave = document.getElementById('srMusicWave');
  if (wave) {
    wave.style.display = current ? 'flex' : 'none';
  }

  // Render Queue List
  const queueContainer = document.getElementById('srQueueContainer');
  if (!queueContainer) return;

  if (queue.length === 0) {
    queueContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 36px 20px;">
        <div style="font-size: 32px; margin-bottom: 8px;">🎵</div>
        <div style="font-size: 14px; font-weight: 600; color: var(--text-secondary);">No hay canciones en cola actualmente</div>
        <div style="font-size: 12px; margin-top: 4px;">Tus espectadores pueden usar <code>!sr nombre de la canción</code> en Twitch.</div>
      </div>
    `;
    return;
  }

  queueContainer.innerHTML = '';
  queue.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    const thumbUrl = song.thumbnail || 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
    item.innerHTML = `
      <div class="queue-index">#${idx + 1}</div>
      <img class="queue-thumb" src="${escapeHtml(thumbUrl)}" alt="Thumb">
      <div class="queue-info">
        <div class="queue-title">${escapeHtml(song.title)}</div>
        <div class="queue-req">Pedida por <strong style="color: var(--cyan-accent);">@${escapeHtml(song.requester)}</strong> • ⏱️ ${song.durationFormatted || '3:30'}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeSongFromQueue('${song.id}')" title="Eliminar de la cola">🗑️</button>
    `;
    queueContainer.appendChild(item);
  });
}

// YouTube Player Integration
window.onYouTubeIframeAPIReady = function() {
  ytApiReady = true;
  ytPlayer = new YT.Player('youtubePlayerContainer', {
    height: '100%',
    width: '100%',
    videoId: '',
    playerVars: {
      autoplay: 1,
      controls: 1,
      modestbranding: 1
    },
    events: {
      onReady: (event) => {
        // Player ready
        if (appConfig?.songRequest?.volume !== undefined) {
          event.target.setVolume(appConfig.songRequest.volume);
        }
      },
      onStateChange: (event) => {
        // YT.PlayerState.ENDED is 0
        if (event.data === YT.PlayerState.ENDED) {
          skipCurrentSong();
        }
      }
    }
  });
};

let dashboardAudioMuted = false;

function toggleDashboardAudio() {
  dashboardAudioMuted = !dashboardAudioMuted;
  const btn = document.getElementById('btnSrMuteDashboard');
  if (ytPlayer) {
    if (dashboardAudioMuted) {
      if (ytPlayer.mute) ytPlayer.mute();
      if (btn) {
        btn.innerText = '🔇 Audio Panel: OFF';
        btn.classList.add('btn-danger');
        btn.classList.remove('btn-secondary');
      }
      showToast('Audio de este panel silenciado (ideal si usas audio vía OBS)', 'info');
    } else {
      if (ytPlayer.unMute) ytPlayer.unMute();
      if (btn) {
        btn.innerText = '🔊 Audio Panel: ON';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-secondary');
      }
      showToast('Audio de este panel activado', 'success');
    }
  }
}
window.toggleDashboardAudio = toggleDashboardAudio;

function playYouTubeSong(videoId) {
  if (ytPlayer && ytPlayer.loadVideoById) {
    ytPlayer.loadVideoById(videoId);
    if (dashboardAudioMuted && ytPlayer.mute) {
      ytPlayer.mute();
    }
    ytPlayer.playVideo();
  }
}

async function skipCurrentSong() {
  try {
    const res = await fetch('/api/sr/skip', { method: 'POST' });
    const data = await res.json();
    showToast(data.message || 'Canción saltada');
  } catch (e) {
    showToast('Error saltando canción', 'error');
  }
}

async function removeSongFromQueue(songId) {
  try {
    const res = await fetch('/api/sr/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: songId })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Canción eliminada de la cola');
    }
  } catch (e) {
    showToast('Error al eliminar canción', 'error');
  }
}

// ================= WIDGET SECURITY & PRIVATE TOKENS =================
function getEffectiveWidgetToken() {
  if (appConfig?.security?.widgetToken) {
    return appConfig.security.widgetToken;
  }
  let localToken = localStorage.getItem('orbibot_widget_token');
  if (!localToken) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      localToken = 'sec_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      localToken = 'sec_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    localStorage.setItem('orbibot_widget_token', localToken);
  }
  return localToken;
}

let isTokenVisible = false;
function toggleTokenVisibility() {
  isTokenVisible = !isTokenVisible;
  const input = document.getElementById('cfgWidgetTokenDisplay');
  const btn = document.getElementById('btnToggleTokenVisibility');
  if (input) {
    input.type = isTokenVisible ? 'text' : 'password';
  }
  if (btn) {
    btn.innerText = isTokenVisible ? '🙈' : '👁️';
  }
}
window.toggleTokenVisibility = toggleTokenVisibility;

function copyWidgetToken() {
  const token = getEffectiveWidgetToken();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(token).then(() => {
      showToast('🔒 Token secreto copiado al portapapeles', 'success');
    }).catch(() => {
      showToast('🔒 Token copiado', 'success');
    });
  } else {
    showToast('Token: ' + token, 'info');
  }
}
window.copyWidgetToken = copyWidgetToken;

async function regenerateWidgetTokenUI() {
  if (!confirm('¿Estás seguro de regenerar tu Clave Secreta de Widgets?\n\nTodos los enlaces anteriores dejarán de funcionar y deberás actualizar las URLs de tus fuentes de navegador en OBS Studio.')) {
    return;
  }

  let newToken = '';
  try {
    const res = await fetch('/api/config/widget-token/regenerate', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      newToken = data.widgetToken;
      if (appConfig) {
        if (!appConfig.security) appConfig.security = {};
        appConfig.security.widgetToken = newToken;
      }
    }
  } catch(e) {}

  if (!newToken) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      newToken = 'sec_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      newToken = 'sec_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    if (appConfig) {
      if (!appConfig.security) appConfig.security = {};
      appConfig.security.widgetToken = newToken;
    }
  }

  localStorage.setItem('orbibot_widget_token', newToken);
  populateWidgetUrls();
  showToast('🛡️ ¡Nueva Clave Secreta generada! Enlaces de OBS actualizados.', 'success');
}
window.regenerateWidgetTokenUI = regenerateWidgetTokenUI;

// ================= OBS WIDGET URLs =================
function populateWidgetUrls() {
  const origin = window.location.origin;
  const path = window.location.pathname.replace(/\/index\.html$/i, '').replace(/\/$/, '');
  const baseUrl = `${origin}${path}`;

  let channel = '';
  if (appConfig && appConfig.twitch && appConfig.twitch.channel) {
    channel = appConfig.twitch.channel.trim().toLowerCase().replace(/^#/, '');
  }
  if (!channel) {
    try {
      const localTwitch = localStorage.getItem('orbibot_twitch_auth');
      if (localTwitch) {
        const parsed = JSON.parse(localTwitch);
        if (parsed.channel) channel = parsed.channel.trim().toLowerCase().replace(/^#/, '');
      }
    } catch(e) {}
  }
  if (!channel) {
    const inputCh = document.getElementById('cfgTwitchChannel');
    if (inputCh && inputCh.value) {
      channel = inputCh.value.trim().toLowerCase().replace(/^#/, '');
    }
  }

  const token = getEffectiveWidgetToken();
  const tokenDisplay = document.getElementById('cfgWidgetTokenDisplay');
  if (tokenDisplay) {
    tokenDisplay.value = token;
  }

  const channelParam = channel ? `channel=${encodeURIComponent(channel)}` : '';
  const tokenParam = token ? `token=${encodeURIComponent(token)}` : '';

  const params = [channelParam, tokenParam].filter(Boolean).join('&');
  const qs = params ? `?${params}` : '';
  const goalParams = [channelParam, 'type=subs', tokenParam].filter(Boolean).join('&');
  const goalQs = goalParams ? `?${goalParams}` : '?type=subs';

  const alertsUrl = `${baseUrl}/overlays/alerts.html${qs}`;
  const npUrl = `${baseUrl}/overlays/nowplaying.html${qs}`;
  const goalUrl = `${baseUrl}/overlays/goals.html${goalQs}`;
  const musicPlayerUrl = `${baseUrl}/overlays/music_player.html${qs}`;
  const ttsUrl = `${baseUrl}/overlays/tts.html${qs}`;
  const chatUrl = `${baseUrl}/overlays/chat.html${qs}`;

  if (document.getElementById('urlAlertsWidget')) document.getElementById('urlAlertsWidget').value = alertsUrl;
  if (document.getElementById('urlNowPlayingWidget')) document.getElementById('urlNowPlayingWidget').value = npUrl;
  if (document.getElementById('urlGoalWidget')) document.getElementById('urlGoalWidget').value = goalUrl;
  if (document.getElementById('urlMusicPlayerWidget')) document.getElementById('urlMusicPlayerWidget').value = musicPlayerUrl;
  if (document.getElementById('urlTtsWidget')) document.getElementById('urlTtsWidget').value = ttsUrl;
  if (document.getElementById('urlChatWidget')) document.getElementById('urlChatWidget').value = chatUrl;

  // Actualizar enlaces de vista previa
  if (document.getElementById('btnPreviewAlerts')) document.getElementById('btnPreviewAlerts').href = alertsUrl;
  if (document.getElementById('btnPreviewNowPlaying')) document.getElementById('btnPreviewNowPlaying').href = npUrl;
  if (document.getElementById('btnPreviewGoal')) document.getElementById('btnPreviewGoal').href = goalUrl;
  if (document.getElementById('btnPreviewMusicPlayer')) document.getElementById('btnPreviewMusicPlayer').href = musicPlayerUrl;
  if (document.getElementById('btnPreviewTts')) document.getElementById('btnPreviewTts').href = ttsUrl;
  if (document.getElementById('btnPreviewChat')) document.getElementById('btnPreviewChat').href = chatUrl;

  const appBaseUrl = `${baseUrl}/`;
  if (document.getElementById('displayRedirectUri')) {
    document.getElementById('displayRedirectUri').innerText = appBaseUrl;
  }
  if (document.getElementById('cfgTwitchRedirectUri') && !document.getElementById('cfgTwitchRedirectUri').value) {
    document.getElementById('cfgTwitchRedirectUri').value = appBaseUrl;
  }
}

function copyWidgetUrl(inputId) {
  const el = document.getElementById(inputId);
  if (el) {
    const text = el.value || el.innerText || el.textContent;
    navigator.clipboard.writeText(text).then(() => {
      showToast('🔒 ¡Enlace privado copiado al portapapeles!', 'success');
    }).catch(() => {
      showToast('¡Copiado!', 'success');
    });
  }
}

function toggleWidgetUrlVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input) {
    if (input.type === 'password') {
      input.type = 'text';
      if (btn) btn.innerText = '🙈';
    } else {
      input.type = 'password';
      if (btn) btn.innerText = '👁️';
    }
  }
}
window.toggleWidgetUrlVisibility = toggleWidgetUrlVisibility;

// ================= EVENT TESTS =================
async function triggerTestAlert(type) {
  const payload = {
    type,
    user: 'EspectadorPro',
    amount: type === 'bits' ? 500 : 1,
    viewers: 45,
    tier: '1',
    reward: 'Saludo en Directo',
    message: '¡Excelente directo, crack! Saludos a todos.'
  };

  // Immediate multi-channel broadcast (for OBS Studio & browser)
  broadcastEvent('alert', payload);
  showToast(`¡Alerta de ${type.toUpperCase()} enviada a OBS!`, 'success');

  try {
    await fetch('/api/alert/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

async function triggerTestTTS() {
  const input = document.getElementById('testTtsInput');
  const text = input.value.trim() || '¡Hola streamer! Este es un mensaje de prueba con Text to Speech en OBS.';
  const voice = document.getElementById('cfgTtsVoice').value;
  const volume = Number(document.getElementById('cfgTtsVolume').value) / 100;
  const rate = Number(document.getElementById('cfgTtsRate').value);
  const pitch = Number(document.getElementById('cfgTtsPitch').value);

  const ttsData = {
    user: 'StreamerTest',
    text,
    voice,
    volume,
    rate,
    pitch,
    timestamp: Date.now()
  };

  // Transmitir inmediatamente por MQTT y WebSocket a la fuente de OBS
  broadcastEvent('tts', ttsData);
  showToast('Mensaje TTS enviado a OBS Studio', 'success');

  // Preview local en el navegador
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.volume = volume;
      u.rate = rate;
      u.pitch = pitch;
      window.speechSynthesis.speak(u);
    } catch(e) {}
  }

  try {
    await fetch('/api/tts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, user: 'StreamerTest', voice })
    });
  } catch (e) {}
}

// ================= GOALS UPDATE =================
async function saveGoalValues(type) {
  let title = '', current = 0, target = 100;
  if (type === 'subs') {
    title = document.getElementById('cfgGoalSubTitle').value;
    current = parseInt(document.getElementById('cfgGoalSubCurrent').value, 10) || 0;
    target = parseInt(document.getElementById('cfgGoalSubTarget').value, 10) || 50;
  } else if (type === 'followers') {
    title = document.getElementById('cfgGoalFollowTitle').value;
    current = parseInt(document.getElementById('cfgGoalFollowCurrent').value, 10) || 0;
    target = parseInt(document.getElementById('cfgGoalFollowTarget').value, 10) || 300;
  } else if (type === 'bits') {
    title = document.getElementById('cfgGoalBitsTitle').value;
    current = parseInt(document.getElementById('cfgGoalBitsCurrent').value, 10) || 0;
    target = parseInt(document.getElementById('cfgGoalBitsTarget').value, 10) || 5000;
  }

  // Transmitir a OBS inmediatamente
  broadcastEvent('goals_updated', { type, title, current, target });
  showToast(`Meta de ${type.toUpperCase()} actualizada en OBS`, 'success');

  try {
    await fetch('/api/goals/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, current, target })
    });
  } catch (e) {}
}

// ================= COMMANDS =================
// ================= COMMANDS =================
function renderCommands(commands) {
  const tbody = document.getElementById('commandsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  commands.forEach(cmd => {
    const tr = document.createElement('tr');
    const isZero = cmd.cooldown === 0 || cmd.cooldown === '0';
    const cooldownBadge = isZero 
      ? `<span class="btn btn-sm" style="font-size:11px; background: rgba(0, 242, 254, 0.2); color: var(--cyan-accent); border: 1px solid var(--cyan-accent);">Sin Cooldown (0s)</span>`
      : `<span class="btn btn-secondary btn-sm" style="font-size:11px;">${cmd.cooldown !== undefined ? cmd.cooldown : 10}s</span>`;

    tr.innerHTML = `
      <td><strong>${escapeHtml(cmd.name)}</strong></td>
      <td style="color: #cbd5e1; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(cmd.response)}</td>
      <td>${cooldownBadge}</td>
      <td style="display: flex; gap: 6px;">
        <button class="btn btn-secondary btn-sm" onclick="editCommand('${cmd.id}')" title="Editar comando">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCommand('${cmd.id}')" title="Eliminar">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleNoCooldown(checkbox) {
  const cooldownInput = document.getElementById('newCmdCooldown');
  if (checkbox && cooldownInput) {
    if (checkbox.checked) {
      cooldownInput.value = 0;
      cooldownInput.disabled = true;
    } else {
      if (Number(cooldownInput.value) <= 0) cooldownInput.value = 10;
      cooldownInput.disabled = false;
    }
  }
}

async function editCommand(cmdId) {
  try {
    const commands = await fetch('/api/commands').then(r => r.json());
    const cmd = commands.find(c => c.id === cmdId);
    if (!cmd) return;

    document.getElementById('editCmdId').value = cmd.id;
    document.getElementById('newCmdName').value = cmd.name;
    document.getElementById('newCmdResponse').value = cmd.response;
    const isZero = cmd.cooldown === 0 || cmd.cooldown === '0';
    document.getElementById('newCmdNoCooldown').checked = isZero;
    document.getElementById('newCmdCooldown').value = isZero ? 0 : (cmd.cooldown !== undefined ? cmd.cooldown : 10);
    document.getElementById('newCmdCooldown').disabled = isZero;
    document.getElementById('newCmdUserLevel').value = cmd.userLevel || 'all';

    document.getElementById('cmdFormTitle').innerText = `✏️ Editar Comando (${cmd.name})`;
    document.getElementById('btnSaveNewCommand').innerText = '💾 Actualizar Comando';
    document.getElementById('btnCancelEditCmd').style.display = 'inline-block';

    document.getElementById('newCmdName').focus();
    showToast(`Editando comando ${cmd.name}`, 'info');
  } catch(e) {}
}

function cancelEditCommand() {
  document.getElementById('editCmdId').value = '';
  document.getElementById('newCmdName').value = '';
  document.getElementById('newCmdResponse').value = '';
  document.getElementById('newCmdNoCooldown').checked = false;
  document.getElementById('newCmdCooldown').value = 10;
  document.getElementById('newCmdCooldown').disabled = false;
  document.getElementById('newCmdUserLevel').value = 'all';

  document.getElementById('cmdFormTitle').innerText = '➕ Crear / Editar Comando';
  document.getElementById('btnSaveNewCommand').innerText = 'Guardar Comando';
  document.getElementById('btnCancelEditCmd').style.display = 'none';
}

async function deleteCommand(cmdId) {
  const commands = await fetch('/api/commands').then(r => r.json());
  const filtered = commands.filter(c => c.id !== cmdId);
  const res = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtered)
  });
  const data = await res.json();
  renderCommands(data.commands);
  showToast('Comando eliminado');
}

// ================= REWARDS (PUNTOS DE CANAL) & SOUNDS =================
function renderRewards(rewards) {
  const tbody = document.getElementById('rewardsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  rewards.forEach(r => {
    const tr = document.createElement('tr');
    let actionBadge = `<span class="btn btn-secondary btn-sm">${r.action}</span>`;
    if (r.action === 'tts') actionBadge = `<span class="btn btn-primary btn-sm">🗣️ Voz TTS</span>`;
    if (r.action === 'song_request') actionBadge = `<span class="btn btn-accent btn-sm">🎶 Canción (VIP)</span>`;
    if (r.action === 'sound') actionBadge = `<span class="btn btn-sm" style="background:#f5a623; color:#000;">🔊 Sonido (${r.soundUrl ? r.soundUrl.split('/').pop() : 'Default'})</span>`;

    tr.innerHTML = `
      <td><strong>${escapeHtml(r.rewardName)}</strong></td>
      <td>${actionBadge}</td>
      <td>${r.cost || 0} pts</td>
      <td>
        <button class="btn btn-accent btn-sm" onclick="testReward('${r.id}')" title="Probar en vivo">⚡ Probar</button>
      </td>
      <td style="display: flex; gap: 6px;">
        <button class="btn btn-secondary btn-sm" onclick="editReward('${r.id}')" title="Editar">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteReward('${r.id}')" title="Eliminar">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleRewardForm(show) {
  const form = document.getElementById('rewardFormCard');
  if (!form) return;
  if (show === undefined) {
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  } else {
    form.style.display = show ? 'block' : 'none';
  }
  if (form.style.display === 'block') {
    loadSounds();
  }
}

function handleRewardActionChange(action) {
  const group = document.getElementById('rewardSoundGroup');
  if (group) {
    group.style.display = action === 'sound' ? 'block' : 'none';
  }
}

async function loadSounds() {
  try {
    const sounds = await fetch('/api/sounds').then(r => r.json()).catch(() => []);
    const container = document.getElementById('soundListContainer');
    const select = document.getElementById('rewardSoundSelect');

    if (select) {
      select.innerHTML = '';
      if (sounds.length === 0) {
        select.innerHTML = '<option value="/assets/sounds/airhorn.mp3">airhorn.mp3 (Predeterminado)</option>';
      } else {
        sounds.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.url;
          opt.innerText = s.name;
          select.appendChild(opt);
        });
      }
    }

    if (container) {
      container.innerHTML = '';
      if (sounds.length === 0) {
        container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 20px;">No has subido sonidos aún. ¡Haz clic en <strong>Subir Sonido</strong> arriba!</div>`;
        return;
      }
      sounds.forEach(s => {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px 12px;';
        item.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
            <span style="font-size: 16px;">🔊</span>
            <span style="font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(s.name)}</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary btn-sm" onclick="previewSound('${s.url}')" title="Escuchar sonido">▶️ Escuchar</button>
          </div>
        `;
        container.appendChild(item);
      });
    }
  } catch (e) {
    console.warn('Error loading sounds:', e);
  }
}

function previewSound(url) {
  try {
    const a = new Audio(url);
    a.play().catch(e => showToast('Error al reproducir audio: ' + e.message, 'error'));
  } catch(e) {}
}

async function handleSoundFileUpload(input) {
  if (!input || !input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 15 * 1024 * 1024) {
    showToast('El archivo es demasiado grande (máximo 15MB)', 'error');
    return;
  }

  showToast(`Subiendo ${file.name}...`, 'info');
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const res = await fetch('/api/sounds/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          data: e.target.result
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`¡Sonido ${data.name} subido con éxito!`, 'success');
        await loadSounds();
        if (document.getElementById('rewardSoundSelect')) {
          document.getElementById('rewardSoundSelect').value = data.url;
        }
      } else {
        showToast(`Error: ${data.message || 'No se pudo subir'}`, 'error');
      }
    } catch(err) {
      showToast(`Error al subir sonido: ${err.message}`, 'error');
    }
  };
  reader.readAsDataURL(file);
  input.value = '';
}

async function saveRewardUI() {
  const name = document.getElementById('rewardNameInput').value.trim();
  const action = document.getElementById('rewardActionSelect').value;
  const soundUrl = document.getElementById('rewardSoundSelect')?.value || '/assets/sounds/airhorn.mp3';
  const cost = Number(document.getElementById('rewardCostInput').value) || 100;
  const editId = document.getElementById('editRewardId').value;

  if (!name) {
    showToast('Ingresa el nombre de la recompensa en Twitch', 'warn');
    return;
  }

  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const newReward = {
    id: editId || `reward-${Date.now()}`,
    rewardName: name,
    action,
    soundUrl: action === 'sound' ? soundUrl : null,
    cost,
    enabled: true
  };

  const existingIdx = rewards.findIndex(r => r.id === newReward.id);
  if (existingIdx >= 0) {
    rewards[existingIdx] = newReward;
  } else {
    rewards.push(newReward);
  }

  await fetch('/api/rewards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rewards)
  });

  renderRewards(rewards);
  toggleRewardForm(false);
  document.getElementById('editRewardId').value = '';
  document.getElementById('rewardNameInput').value = '';
  showToast(`Recompensa "${name}" guardada`, 'success');
}

async function editReward(rewardId) {
  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const r = rewards.find(item => item.id === rewardId);
  if (!r) return;

  document.getElementById('editRewardId').value = r.id;
  document.getElementById('rewardNameInput').value = r.rewardName;
  document.getElementById('rewardActionSelect').value = r.action;
  handleRewardActionChange(r.action);
  if (r.soundUrl && document.getElementById('rewardSoundSelect')) {
    document.getElementById('rewardSoundSelect').value = r.soundUrl;
  }
  document.getElementById('rewardCostInput').value = r.cost || 100;
  toggleRewardForm(true);
}

async function deleteReward(rewardId) {
  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const filtered = rewards.filter(r => r.id !== rewardId);
  await fetch('/api/rewards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtered)
  });
  renderRewards(filtered);
  showToast('Recompensa eliminada');
}

async function testReward(rewardId) {
  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const r = rewards.find(item => item.id === rewardId);
  if (!r) return;

  showToast(`Probando canje: ${r.rewardName}...`, 'info');

  if (r.action === 'tts') {
    broadcastEvent('tts', {
      user: 'VisorDePrueba',
      text: `¡Hola streamer! Este es un mensaje de prueba con puntos de canal para ${r.rewardName}`,
      source: 'channel_points',
      audioUrl: `https://api.streamelements.com/kappa/v2/speech?voice=Mia&text=${encodeURIComponent(`¡Hola streamer! Este es un mensaje de prueba con puntos de canal para ${r.rewardName}`)}`
    });
    broadcastEvent('alert', {
      type: 'channel_points',
      user: 'VisorDePrueba',
      reward: r.rewardName,
      message: '¡Probando canje de TTS con puntos!'
    });
  } else if (r.action === 'song_request') {
    await fetch('/api/sr/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Daft Punk One More Time', requester: 'VisorVIP' })
    }).catch(() => {});
    showToast('Canción añadida con prioridad VIP a la cola', 'success');
  } else if (r.action === 'sound') {
    broadcastEvent('alert', {
      type: 'sound',
      user: 'VisorDePrueba',
      reward: r.rewardName,
      soundUrl: r.soundUrl || '/assets/sounds/airhorn.mp3'
    });
    previewSound(r.soundUrl || '/assets/sounds/airhorn.mp3');
  }
}

// ================= AUTO-SAVE SYSTEM =================
let autoSaveTimer = null;
let toastAutoSaveDebounce = null;

function setAutoSaveStatus(status) {
  const dot = document.getElementById('autoSaveDot');
  const text = document.getElementById('autoSaveText');
  const indicator = document.getElementById('autoSaveIndicator');
  if (!dot || !text) return;

  if (status === 'saving') {
    dot.style.background = '#f59e0b';
    dot.style.boxShadow = '0 0 10px rgba(245, 158, 11, 0.8)';
    text.innerText = 'Guardando...';
    if (indicator) indicator.style.borderColor = 'rgba(245, 158, 11, 0.4)';
  } else if (status === 'saved') {
    dot.style.background = '#10b981';
    dot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.8)';
    text.innerText = 'Cambios guardados';
    if (indicator) indicator.style.borderColor = 'rgba(16, 185, 129, 0.3)';

    setTimeout(() => {
      if (text && text.innerText === 'Cambios guardados') {
        text.innerText = 'Autoguardado activo';
        if (indicator) indicator.style.borderColor = 'rgba(255, 255, 255, 0.08)';
      }
    }, 2500);
  } else if (status === 'error') {
    dot.style.background = '#ef4444';
    dot.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.8)';
    text.innerText = 'Error al guardar';
    if (indicator) indicator.style.borderColor = 'rgba(239, 68, 68, 0.4)';
  }
}

function triggerAutoSave(delay = 500, notify = true) {
  setAutoSaveStatus('saving');
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    await saveAllConfig(notify);
  }, delay);
}

function setupAutoSaveListeners() {
  const configInputIds = [
    'cfgTwitchChannel', 'cfgTwitchBotUser', 'cfgTwitchToken', 'cfgTwitchClientId',
    'cfgSrPrefix', 'cfgSrUserLevel', 'cfgSrMaxDuration', 'cfgSrMaxPerUser', 'cfgSrEnabled',
    'cfgTtsEnabled', 'cfgTtsVoice', 'cfgTtsVolume', 'cfgTtsRate', 'cfgTtsPitch',
    'cfgTtsMaxLength', 'cfgTtsBannedWords', 'cfgTtsAllowCommand', 'cfgTtsCommand', 'cfgTtsMinBits'
  ];

  configInputIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.addEventListener('change', () => triggerAutoSave(100, true));
    } else if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => triggerAutoSave(100, true));
    } else if (el.type === 'range') {
      el.addEventListener('input', () => triggerAutoSave(400, true));
      el.addEventListener('change', () => triggerAutoSave(100, true));
    } else {
      el.addEventListener('input', () => triggerAutoSave(600, true));
      el.addEventListener('change', () => triggerAutoSave(100, true));
    }
  });

  // Metas (Goals: Subs, Follows, Bits) auto-save on input and change
  const goalConfigs = [
    { type: 'subs', ids: ['cfgGoalSubTitle', 'cfgGoalSubCurrent', 'cfgGoalSubTarget'] },
    { type: 'followers', ids: ['cfgGoalFollowTitle', 'cfgGoalFollowCurrent', 'cfgGoalFollowTarget'] },
    { type: 'bits', ids: ['cfgGoalBitsTitle', 'cfgGoalBitsCurrent', 'cfgGoalBitsTarget'] }
  ];

  goalConfigs.forEach(g => {
    let goalTimer = null;
    g.ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const onGoalChange = (delay) => {
        setAutoSaveStatus('saving');
        if (goalTimer) clearTimeout(goalTimer);
        goalTimer = setTimeout(() => {
          saveGoalValues(g.type);
          setAutoSaveStatus('saved');
        }, delay);
      };
      el.addEventListener('input', () => onGoalChange(600));
      el.addEventListener('change', () => onGoalChange(100));
    });
  });
}

// ================= SAVE CONFIG =================
async function saveAllConfig(showNotification = true) {
  const bannedWords = (document.getElementById('cfgTtsBannedWords')?.value || '')
    .split(',')
    .map(w => w.trim())
    .filter(Boolean);

  const payload = {
    twitch: {
      channel: document.getElementById('cfgTwitchChannel')?.value.trim() || '',
      botUsername: document.getElementById('cfgTwitchBotUser')?.value.trim() || '',
      oauthToken: document.getElementById('cfgTwitchToken')?.value.trim() || ''
    },
    songRequest: {
      prefix: document.getElementById('cfgSrPrefix')?.value.trim() || '!sr',
      userLevel: document.getElementById('cfgSrUserLevel')?.value || 'all',
      maxDurationMinutes: Number(document.getElementById('cfgSrMaxDuration')?.value) || 8,
      maxPerUser: Number(document.getElementById('cfgSrMaxPerUser')?.value) || 5,
      enabled: Boolean(document.getElementById('cfgSrEnabled')?.checked)
    },
    tts: {
      enabled: Boolean(document.getElementById('cfgTtsEnabled')?.checked),
      voice: document.getElementById('cfgTtsVoice')?.value || 'es-ES-Standard-A',
      volume: Number(document.getElementById('cfgTtsVolume')?.value ?? 80),
      rate: Number(document.getElementById('cfgTtsRate')?.value ?? 1),
      pitch: Number(document.getElementById('cfgTtsPitch')?.value ?? 0),
      maxLength: Number(document.getElementById('cfgTtsMaxLength')?.value ?? 250),
      bannedWords,
      allowChatCommand: Boolean(document.getElementById('cfgTtsAllowCommand')?.checked),
      chatCommand: document.getElementById('cfgTtsCommand')?.value.trim() || '!tts',
      minBits: Number(document.getElementById('cfgTtsMinBits')?.value ?? 50)
    }
  };

  try {
    let cfg = JSON.parse(localStorage.getItem('orbibot_config') || '{}');
    cfg = { ...cfg, ...payload };
    localStorage.setItem('orbibot_config', JSON.stringify(cfg));
    if (payload.twitch.channel) {
      let twAuth = JSON.parse(localStorage.getItem('orbibot_twitch_auth') || '{}');
      twAuth.channel = payload.twitch.channel;
      twAuth.botUsername = payload.twitch.botUsername;
      twAuth.oauthToken = payload.twitch.oauthToken;
      localStorage.setItem('orbibot_twitch_auth', JSON.stringify(twAuth));
    }
  } catch(e) {}

  populateWidgetUrls();
  initDashboardMqtt();

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      appConfig = data.config;
      const statChan = document.getElementById('statChannelName');
      if (statChan) statChan.innerText = payload.twitch.channel ? `#${payload.twitch.channel}` : 'Ninguno';
      setAutoSaveStatus('saved');
      if (showNotification) {
        if (toastAutoSaveDebounce) clearTimeout(toastAutoSaveDebounce);
        toastAutoSaveDebounce = setTimeout(() => {
          showToast('✅ Cambios guardados automáticamente', 'success');
        }, 300);
      }
    }
  } catch (e) {
    setAutoSaveStatus('saved');
    if (showNotification) {
      if (toastAutoSaveDebounce) clearTimeout(toastAutoSaveDebounce);
      toastAutoSaveDebounce = setTimeout(() => {
        showToast('Configuración guardada localmente.', 'info');
      }, 300);
    }
  }
}

// ================= EVENT LISTENERS SETUP =================
function setupEventListeners() {
  // Save global button (si existe)
  const saveBtn = document.getElementById('saveGlobalBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveAllConfig(true));
  }

  // Quick alert test button (si existe)
  const quickAlertBtn = document.getElementById('testAlertQuickBtn');
  if (quickAlertBtn) {
    quickAlertBtn.addEventListener('click', () => {
      triggerTestAlert('follower');
    });
  }

  // Connect / Disconnect Twitch
  document.getElementById('btnConnectTwitch').addEventListener('click', async () => {
    await saveAllConfig(false);
    showToast('Iniciando conexión con Twitch...', 'info');
    try {
      const res = await fetch('/api/bot/connect', { method: 'POST' });
      const data = await res.json();
      showToast(data.message, data.success ? 'success' : 'warn');
    } catch (e) {
      showToast('Error de conexión', 'error');
    }
  });

  document.getElementById('btnDisconnectTwitch').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/bot/disconnect', { method: 'POST' });
      const data = await res.json();
      showToast(data.message);
    } catch (e) {
      showToast('Error al desconectar', 'error');
    }
  });

  // Direct Twitch OAuth Authentication
  let activeAuthPopup = null;

  function getTwitchRedirectUri() {
    const custom = document.getElementById('cfgTwitchRedirectUri')?.value?.trim();
    if (custom) return custom;
    const cleanPath = window.location.pathname.replace(/\/index\.html$/i, '').replace(/\/$/, '');
    return `${window.location.origin}${cleanPath}/`;
  }

  function triggerTwitchOAuthLogin() {
    const customClientId = document.getElementById('cfgTwitchClientId')?.value?.trim();
    const clientId = customClientId || 'yw1vr664ichms8an2x5lhji58v7ozk';
    const redirectUri = getTwitchRedirectUri();
    const scopes = encodeURIComponent('chat:read chat:edit channel:read:redemptions bits:read channel:read:subscriptions');

    const twitchAuthUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${scopes}&state=popup&force_verify=true`;

    const width = 560, height = 750;
    const left = Math.max(0, (window.innerWidth - width) / 2 + window.screenX);
    const top = Math.max(0, (window.innerHeight - height) / 2 + window.screenY);

    showToast('Abriendo ventana segura de inicio de sesión con Twitch...', 'info');

    // Clean any prior auth event or error
    localStorage.removeItem('orbibot_twitch_auth_event');
    localStorage.removeItem('orbibot_twitch_auth_error');

    activeAuthPopup = window.open(twitchAuthUrl, 'TwitchOAuthLogin', `width=${width},height=${height},top=${top},left=${left},status=no,menubar=no,toolbar=no,scrollbars=yes`);
    if (!activeAuthPopup || activeAuthPopup.closed || typeof activeAuthPopup.closed === 'undefined') {
      window.location.href = twitchAuthUrl;
      return;
    }

    let pollCount = 0;
    const authPollInterval = setInterval(async () => {
      pollCount++;

      // 1. Check for success
      const rawEvent = localStorage.getItem('orbibot_twitch_auth_event');
      if (rawEvent) {
        clearInterval(authPollInterval);
        localStorage.removeItem('orbibot_twitch_auth_event');
        try {
          if (activeAuthPopup && !activeAuthPopup.closed) activeAuthPopup.close();
        } catch(e) {}
        activeAuthPopup = null;

        try {
          const payload = JSON.parse(rawEvent);
          await handleAuthSuccess(payload);
        } catch(err) {
          console.error('Error handling auth success payload:', err);
        }
        return;
      }

      // 2. Check for error (e.g. redirect_mismatch)
      const rawError = localStorage.getItem('orbibot_twitch_auth_error');
      if (rawError) {
        clearInterval(authPollInterval);
        localStorage.removeItem('orbibot_twitch_auth_error');
        try {
          const errData = JSON.parse(rawError);
          showToast(`⚠️ Twitch: ${errData.desc || errData.error}`, 'error');
        } catch(e) {}
        return;
      }

      if (pollCount > 600) {
        clearInterval(authPollInterval);
      }
    }, 300);
  }

  // Handle successful OAuth event
  async function handleAuthSuccess(payload) {
    if (activeAuthPopup) {
      try { activeAuthPopup.close(); } catch(e) {}
      activeAuthPopup = null;
    }
    try { window.focus(); } catch(e) {}

    let user = payload.user || payload.data?.user || {};
    const token = (payload.token || payload.oauthToken || '').replace(/^oauth:/i, '').trim();
    let displayName = user.display_name || user.login || '';
    let avatarUrl = user.profile_image_url || '';
    let channelName = (user.login || user.channel || (displayName ? displayName.toLowerCase() : '') || '').replace(/^#/, '');

    // If channelName or displayName is missing, validate token directly with Twitch
    if ((!channelName || !displayName) && token) {
      try {
        const valRes = await fetch('https://id.twitch.tv/oauth2/validate', {
          headers: { 'Authorization': `OAuth ${token}` }
        });
        if (valRes.ok) {
          const valData = await valRes.json();
          channelName = valData.login || channelName;
          displayName = displayName || valData.login;
          if (!avatarUrl) {
            try {
              const uRes = await fetch(`https://api.twitch.tv/helix/users?id=${valData.user_id}`, {
                headers: { 'Client-Id': valData.client_id, 'Authorization': `Bearer ${token}` }
              });
              if (uRes.ok) {
                const uData = await uRes.json();
                if (uData.data?.length > 0) {
                  displayName = uData.data[0].display_name || displayName;
                  avatarUrl = uData.data[0].profile_image_url || avatarUrl;
                }
              }
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    if (!channelName && displayName) {
      channelName = displayName.toLowerCase();
    }

    const twitchCfg = {
      channel: channelName,
      botUsername: channelName,
      oauthToken: token,
      clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
      displayName: displayName || channelName,
      profileImage: avatarUrl || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb60-aee8f1560db5-profile_image-300x300.png',
      userId: user.user_id || '',
      connected: true
    };

    localStorage.setItem('orbibot_twitch_auth', JSON.stringify(twitchCfg));
    try {
      let cfg = JSON.parse(localStorage.getItem('orbibot_config') || '{}');
      cfg.twitch = { ...(cfg.twitch || {}), ...twitchCfg };
      localStorage.setItem('orbibot_config', JSON.stringify(cfg));
    } catch(e) {}

    if (appConfig) {
      appConfig.twitch = { ...(appConfig.twitch || {}), ...twitchCfg };
    } else {
      appConfig = { twitch: twitchCfg };
    }

    showToast(`🎉 ¡Sesión iniciada con éxito! Bienvenido, @${displayName || channelName}`, 'success');

    // Submit token to backend if available
    if (token) {
      try {
        await fetch('/api/auth/twitch-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, channel: channelName })
        });
      } catch (e) {}
    }

    bindConfigToUI(appConfig);
    populateWidgetUrls();
    initDashboardMqtt();

    if (channelName && window.tmi) {
      connectInBrowserTwitchBot(twitchCfg);
    }
  }

  // Twitch Disconnect Account
  async function disconnectTwitchAccount() {
    if (!confirm('¿Deseas cerrar sesión de Twitch y desconectar el bot?')) return;

    try {
      await fetch('/api/bot/disconnect', { method: 'POST' });
    } catch (e) {}

    localStorage.removeItem('orbibot_twitch_auth');
    localStorage.removeItem('orbibot_twitch_auth_event');

    try {
      let cfg = JSON.parse(localStorage.getItem('orbibot_config') || '{}');
      if (cfg.twitch) {
        cfg.twitch.connected = false;
        cfg.twitch.channel = '';
        cfg.twitch.oauthToken = '';
        cfg.twitch.displayName = '';
        cfg.twitch.profileImage = '';
        localStorage.setItem('orbibot_config', JSON.stringify(cfg));
      }
    } catch(e) {}

    if (browserTmiClient) {
      try { browserTmiClient.disconnect(); } catch(e) {}
      browserTmiClient = null;
    }

    showToast('Has cerrado sesión de Twitch.', 'info');
    await loadInitialData();
    populateWidgetUrls();
    initDashboardMqtt();
  }

  // Twitch Login Buttons
  const topLoginBtn = document.getElementById('topTwitchLoginBtn');
  if (topLoginBtn) topLoginBtn.addEventListener('click', triggerTwitchOAuthLogin);

  const heroLoginBtn = document.getElementById('heroTwitchLoginBtn');
  if (heroLoginBtn) heroLoginBtn.addEventListener('click', triggerTwitchOAuthLogin);

  // Twitch Logout Buttons
  const topLogoutBtn = document.getElementById('topLogoutBtn');
  if (topLogoutBtn) topLogoutBtn.addEventListener('click', disconnectTwitchAccount);

  const dashLogoutBtn = document.getElementById('dashLogoutBtn');
  if (dashLogoutBtn) dashLogoutBtn.addEventListener('click', disconnectTwitchAccount);

  // Dashboard quick actions
  const dashGotoObsBtn = document.getElementById('dashGotoObsBtn');
  if (dashGotoObsBtn) dashGotoObsBtn.addEventListener('click', () => switchTab('tab-overlays'));

  const dashGotoSrBtn = document.getElementById('dashGotoSrBtn');
  if (dashGotoSrBtn) dashGotoSrBtn.addEventListener('click', () => switchTab('tab-sr'));

  const dashGotoTtsBtn = document.getElementById('dashGotoTtsBtn');
  if (dashGotoTtsBtn) dashGotoTtsBtn.addEventListener('click', () => switchTab('tab-tts'));

  // Listen for OAuth callback message from popup if opener works
  window.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'TWITCH_AUTH_SUCCESS') {
      await handleAuthSuccess(event.data);
    }
  });

  // Sidebar Quick Connect Button
  const quickConnectBtn = document.getElementById('quickConnectBtn');
  if (quickConnectBtn) {
    quickConnectBtn.addEventListener('click', async () => {
      const isConnected = appConfig?.twitch?.connected && appConfig?.twitch?.channel;
      if (isConnected) {
        disconnectTwitchAccount();
      } else {
        triggerTwitchOAuthLogin();
      }
    });
  }

  // Song Request Controls
  document.getElementById('btnSrSkip').addEventListener('click', skipCurrentSong);
  
  document.getElementById('btnSrClear').addEventListener('click', async () => {
    if (confirm('¿Seguro que deseas vaciar toda la cola de canciones?')) {
      const res = await fetch('/api/sr/clear', { method: 'POST' });
      const data = await res.json();
      showToast(`Cola vaciada (${data.count} canciones eliminadas)`);
    }
  });

  document.getElementById('btnSrAddManual').addEventListener('click', async () => {
    const input = document.getElementById('srManualInput');
    const query = input.value.trim();
    if (!query) return;

    showToast('Buscando y añadiendo canción...', 'info');
    try {
      const res = await fetch('/api/sr/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, requester: 'Streamer' })
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
        input.value = '';
      } else {
        showToast(data.message, 'warn');
      }
    } catch (e) {
      showToast('Error al añadir canción', 'error');
    }
  });

  // TTS Test
  document.getElementById('btnTestTtsPlay').addEventListener('click', triggerTestTTS);

  // Save or Update Command
  document.getElementById('btnSaveNewCommand').addEventListener('click', async () => {
    const name = document.getElementById('newCmdName').value.trim();
    const response = document.getElementById('newCmdResponse').value.trim();
    const noCooldown = document.getElementById('newCmdNoCooldown')?.checked;
    const cooldownVal = Number(document.getElementById('newCmdCooldown').value);
    const cooldown = noCooldown ? 0 : (isNaN(cooldownVal) ? 10 : Math.max(0, cooldownVal));
    const userLevel = document.getElementById('newCmdUserLevel').value;
    const editId = document.getElementById('editCmdId')?.value;

    if (!name || !response) {
      showToast('Debes ingresar el nombre del comando y su respuesta', 'warn');
      return;
    }

    const formattedName = name.startsWith('!') ? name : `!${name}`;
    const commands = await fetch('/api/commands').then(r => r.json());

    const targetIdx = editId 
      ? commands.findIndex(c => c.id === editId)
      : commands.findIndex(c => c.name.toLowerCase() === formattedName.toLowerCase());

    const newCmd = {
      id: targetIdx >= 0 ? commands[targetIdx].id : `cmd-${Date.now()}`,
      name: formattedName,
      response,
      cooldown,
      userLevel,
      enabled: true
    };

    if (targetIdx >= 0) {
      commands[targetIdx] = newCmd;
    } else {
      commands.push(newCmd);
    }

    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commands)
    });
    const data = await res.json();
    renderCommands(data.commands);
    showToast(`Comando ${formattedName} guardado con éxito`, 'success');
    cancelEditCommand();
  });

  // Load custom sounds on startup
  loadSounds();
}
