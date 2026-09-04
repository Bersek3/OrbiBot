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
  populateWidgetUrls();
  await loadInitialData();
  connectWebSocket();
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

function broadcastEvent(event, data) {
  if (broadcastChannel) {
    try { broadcastChannel.postMessage({ event, data, timestamp: Date.now() }); } catch(e) {}
  }
  try {
    localStorage.setItem('orbibot_last_event', JSON.stringify({ event, data, timestamp: Date.now() }));
  } catch(e) {}
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

  // WebSocket for local backend
  if (location.port) {
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

    appConfig = cfgRes;
    bindConfigToUI(cfgRes);
    renderCommands(cmdRes);
    renderRewards(rwdRes);
    updateSongRequestUI(srRes);
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
  if (!window.tmi) return;
  if (browserTmiClient) {
    try { browserTmiClient.disconnect(); } catch(e) {}
  }

  const channel = twitchData.channel.toLowerCase().replace(/^#/, '');
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

  updateBotStatusUI({ status: 'connecting' });
  browserTmiClient = new window.tmi.Client(opts);

  browserTmiClient.on('connected', () => {
    updateBotStatusUI({ status: 'connected', channel });
    showToast(`Conectado al chat de #${channel} vía navegador`, 'success');
  });

  browserTmiClient.on('message', (ch, tags, message, self) => {
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
      badges: tags.badges || {}
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

  browserTmiClient.connect().catch(e => {
    updateBotStatusUI({ status: 'error' });
    console.error('Browser Twitch IRC error:', e);
  });
}

// ================= UI BINDING =================
function bindConfigToUI(cfg) {
  // Twitch Profile & Connection
  if (cfg.twitch) {
    const isConn = cfg.twitch.connected && (cfg.twitch.channel || cfg.twitch.oauthToken);
    
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
    const dName = cfg.twitch.displayName || cfg.twitch.channel || 'Streamer';
    const login = cfg.twitch.channel || '';

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

    if (document.getElementById('cfgTwitchChannel')) document.getElementById('cfgTwitchChannel').value = cfg.twitch.channel || '';
    if (document.getElementById('cfgTwitchBotUser')) document.getElementById('cfgTwitchBotUser').value = cfg.twitch.botUsername || '';
    if (document.getElementById('cfgTwitchToken')) document.getElementById('cfgTwitchToken').value = cfg.twitch.oauthToken || '';
    if (document.getElementById('cfgTwitchClientId')) {
      document.getElementById('cfgTwitchClientId').value = cfg.twitch.clientId || 'yw1vr664ichms8an2x5lhji58v7ozk';
    }
    document.getElementById('statChannelName').innerText = cfg.twitch.channel ? `#${cfg.twitch.channel}` : 'Ninguno';
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

  if (!botStatus) return;

  const status = botStatus.status;
  dot.className = `status-dot ${status}`;
  text.innerText = status === 'connected' ? 'En Línea' : (status === 'connecting' ? 'Conectando...' : 'Desconectado');

  if (status === 'connected') {
    badge.className = 'btn btn-sm btn-accent';
    badge.innerText = '🟢 Conectado';
    statText.innerText = 'En Línea';
    statText.style.color = 'var(--green-success)';
    quickBtn.innerText = 'Desconectar';
  } else if (status === 'connecting') {
    badge.className = 'btn btn-sm btn-secondary';
    badge.innerText = '🟡 Conectando...';
    statText.innerText = 'Conectando';
    statText.style.color = 'var(--yellow-warn)';
  } else {
    badge.className = 'btn btn-sm btn-danger';
    badge.innerText = '🔴 Desconectado';
    statText.innerText = 'Inactivo';
    statText.style.color = 'var(--red-danger)';
    quickBtn.innerText = 'Conectar';
  }
}

// ================= CHAT LIVE LOG =================
function appendChatMessage(data) {
  const container = document.getElementById('liveChatMessages');
  const row = document.createElement('div');
  row.className = 'chat-msg-row';

  let badge = '';
  if (data.badges?.broadcaster) badge = '<span class="chat-badge" style="background:#ff007f">STREAMER</span>';
  else if (data.isMod) badge = '<span class="chat-badge" style="background:#00f2fe; color:#000">MOD</span>';
  else if (data.isSub) badge = '<span class="chat-badge">SUB</span>';

  row.innerHTML = `
    ${badge}
    <span class="chat-user" style="color: ${data.color || '#9146ff'}">${data.user}:</span>
    <span class="chat-text">${escapeHtml(data.message)}</span>
  `;

  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

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
    requester.innerText = 'Esperando...';
  }

  // Render Queue List
  const queueContainer = document.getElementById('srQueueContainer');
  if (queue.length === 0) {
    queueContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 24px;">No hay canciones en cola actualmente.</div>`;
    return;
  }

  queueContainer.innerHTML = '';
  queue.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.innerHTML = `
      <div class="queue-index">#${idx + 1}</div>
      <img class="queue-thumb" src="${song.thumbnail}" alt="Thumb">
      <div class="queue-info">
        <div class="queue-title">${escapeHtml(song.title)}</div>
        <div class="queue-req">Pedida por @${escapeHtml(song.requester)} • ${song.durationFormatted || '3:30'}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="removeSongFromQueue('${song.id}')" title="Eliminar de la cola">❌</button>
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

function playYouTubeSong(videoId) {
  if (ytPlayer && ytPlayer.loadVideoById) {
    ytPlayer.loadVideoById(videoId);
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

// ================= OBS WIDGET URLs =================
function populateWidgetUrls() {
  const origin = window.location.origin;
  const path = window.location.pathname.replace(/\/index\.html$/i, '').replace(/\/$/, '');
  const baseUrl = `${origin}${path}`;
  document.getElementById('urlAlertsWidget').value = `${baseUrl}/overlays/alerts.html`;
  document.getElementById('urlNowPlayingWidget').value = `${baseUrl}/overlays/nowplaying.html`;
  document.getElementById('urlGoalWidget').value = `${baseUrl}/overlays/goals.html?type=subs`;
  document.getElementById('urlTtsWidget').value = `${baseUrl}/overlays/tts.html`;
  document.getElementById('urlChatWidget').value = `${baseUrl}/overlays/chat.html`;
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
      showToast('¡Copiado al portapapeles!', 'success');
    }).catch(() => {
      showToast('¡Copiado!', 'success');
    });
  }
}

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

  // Immediate multi-channel broadcast (for GitHub Pages & local)
  broadcastEvent('alert', payload);
  showToast(`¡Alerta de ${type.toUpperCase()} disparada! Mírala en OBS.`, 'success');

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
  const text = input.value.trim() || '¡Hola streamer! Este es un mensaje de prueba con Text to Speech.';
  const voice = document.getElementById('cfgTtsVoice').value;

  try {
    const res = await fetch('/api/tts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, user: 'StreamerTest', voice })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Mensaje TTS enviado a la cola de audio', 'success');
      // Local preview speak
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.volume = Number(document.getElementById('cfgTtsVolume').value) / 100;
        u.rate = Number(document.getElementById('cfgTtsRate').value);
        u.pitch = Number(document.getElementById('cfgTtsPitch').value);
        window.speechSynthesis.speak(u);
      }
    } else {
      showToast(data.reason || 'Error en TTS', 'warn');
    }
  } catch (e) {
    showToast('Error al probar TTS', 'error');
  }
}

// ================= GOALS UPDATE =================
async function saveGoalValues(type) {
  let title = '', current = 0, target = 100;
  if (type === 'subs') {
    title = document.getElementById('cfgGoalSubTitle').value;
    current = document.getElementById('cfgGoalSubCurrent').value;
    target = document.getElementById('cfgGoalSubTarget').value;
  } else if (type === 'followers') {
    title = document.getElementById('cfgGoalFollowTitle').value;
    current = document.getElementById('cfgGoalFollowCurrent').value;
    target = document.getElementById('cfgGoalFollowTarget').value;
  } else if (type === 'bits') {
    title = document.getElementById('cfgGoalBitsTitle').value;
    current = document.getElementById('cfgGoalBitsCurrent').value;
    target = document.getElementById('cfgGoalBitsTarget').value;
  }

  try {
    const res = await fetch('/api/goals/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, current, target })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Meta de ${type.toUpperCase()} actualizada`, 'success');
    }
  } catch (e) {
    showToast('Error guardando metas', 'error');
  }
}

// ================= COMMANDS =================
function renderCommands(commands) {
  const tbody = document.getElementById('commandsTableBody');
  tbody.innerHTML = '';

  commands.forEach(cmd => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(cmd.name)}</strong></td>
      <td style="color: #cbd5e1; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(cmd.response)}</td>
      <td><span class="btn btn-secondary btn-sm" style="font-size:11px;">${cmd.cooldown}s</span></td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteCommand('${cmd.id}')">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
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

// ================= REWARDS (PUNTOS DE CANAL) =================
function renderRewards(rewards) {
  const tbody = document.getElementById('rewardsTableBody');
  tbody.innerHTML = '';

  rewards.forEach(r => {
    const tr = document.createElement('tr');
    let actionBadge = `<span class="btn btn-secondary btn-sm">${r.action}</span>`;
    if (r.action === 'tts') actionBadge = `<span class="btn btn-primary btn-sm">Voz TTS</span>`;
    if (r.action === 'song_request') actionBadge = `<span class="btn btn-accent btn-sm">Pedir Canción</span>`;

    tr.innerHTML = `
      <td><strong>${escapeHtml(r.rewardName)}</strong></td>
      <td>${actionBadge}</td>
      <td>${r.cost || 0} pts</td>
      <td><span style="color: var(--green-success);">● Activo</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="showToast('Editando recompensa')">Editar</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ================= SAVE CONFIG =================
async function saveAllConfig() {
  const bannedWords = document.getElementById('cfgTtsBannedWords').value
    .split(',')
    .map(w => w.trim())
    .filter(Boolean);

  const payload = {
    twitch: {
      channel: document.getElementById('cfgTwitchChannel').value.trim(),
      botUsername: document.getElementById('cfgTwitchBotUser').value.trim(),
      oauthToken: document.getElementById('cfgTwitchToken').value.trim()
    },
    songRequest: {
      prefix: document.getElementById('cfgSrPrefix').value.trim() || '!sr',
      userLevel: document.getElementById('cfgSrUserLevel').value,
      maxDurationMinutes: Number(document.getElementById('cfgSrMaxDuration').value) || 8,
      maxPerUser: Number(document.getElementById('cfgSrMaxPerUser').value) || 5,
      enabled: document.getElementById('cfgSrEnabled').checked
    },
    tts: {
      enabled: document.getElementById('cfgTtsEnabled').checked,
      voice: document.getElementById('cfgTtsVoice').value,
      volume: Number(document.getElementById('cfgTtsVolume').value),
      rate: Number(document.getElementById('cfgTtsRate').value),
      pitch: Number(document.getElementById('cfgTtsPitch').value),
      maxLength: Number(document.getElementById('cfgTtsMaxLength').value),
      bannedWords,
      allowChatCommand: document.getElementById('cfgTtsAllowCommand').checked,
      chatCommand: document.getElementById('cfgTtsCommand').value.trim() || '!tts',
      minBits: Number(document.getElementById('cfgTtsMinBits').value) || 50
    }
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      appConfig = data.config;
      document.getElementById('statChannelName').innerText = payload.twitch.channel ? `#${payload.twitch.channel}` : 'Ninguno';
      showToast('Configuración guardada correctamente.', 'success');
    }
  } catch (e) {
    showToast('Error al guardar la configuración.', 'error');
  }
}

// ================= EVENT LISTENERS SETUP =================
function setupEventListeners() {
  // Save global button
  document.getElementById('saveGlobalBtn').addEventListener('click', saveAllConfig);

  // Quick alert test button
  document.getElementById('testAlertQuickBtn').addEventListener('click', () => {
    triggerTestAlert('follower');
  });

  // Connect / Disconnect Twitch
  document.getElementById('btnConnectTwitch').addEventListener('click', async () => {
    await saveAllConfig();
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
    let displayName = user.display_name || user.login || '';
    let avatarUrl = user.profile_image_url || '';
    const token = payload.token || '';

    // If user profile info wasn't included in payload, fetch directly from Twitch
    if (!displayName && token) {
      try {
        const valRes = await fetch('https://id.twitch.tv/oauth2/validate', {
          headers: { 'Authorization': `OAuth ${token}` }
        });
        if (valRes.ok) {
          const valData = await valRes.json();
          displayName = valData.login;
          avatarUrl = 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb60-aee8f1560db5-profile_image-300x300.png';

          try {
            const uRes = await fetch(`https://api.twitch.tv/helix/users?id=${valData.user_id}`, {
              headers: { 'Client-Id': valData.client_id, 'Authorization': `Bearer ${token}` }
            });
            if (uRes.ok) {
              const uData = await uRes.json();
              if (uData.data?.length > 0) {
                displayName = uData.data[0].display_name;
                avatarUrl = uData.data[0].profile_image_url || avatarUrl;
              }
            }
          } catch(e) {}

          const twitchCfg = {
            channel: valData.login,
            botUsername: valData.login,
            oauthToken: token,
            clientId: valData.client_id,
            displayName: displayName,
            profileImage: avatarUrl,
            userId: valData.user_id,
            connected: true
          };
          localStorage.setItem('orbibot_twitch_auth', JSON.stringify(twitchCfg));
          try {
            const cfg = JSON.parse(localStorage.getItem('orbibot_config') || '{}');
            cfg.twitch = { ...(cfg.twitch || {}), ...twitchCfg };
            localStorage.setItem('orbibot_config', JSON.stringify(cfg));
          } catch(e) {}
        }
      } catch(e) {}
    }

    showToast(`🎉 ¡Sesión iniciada con éxito! Bienvenido, @${displayName || 'Streamer'}`, 'success');

    // Submit token to backend if available
    if (token) {
      try {
        await fetch('/api/auth/twitch-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
      } catch (e) {}
    }

    await loadInitialData();
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

  // New Command
  document.getElementById('btnSaveNewCommand').addEventListener('click', async () => {
    const name = document.getElementById('newCmdName').value.trim();
    const response = document.getElementById('newCmdResponse').value.trim();
    const cooldown = Number(document.getElementById('newCmdCooldown').value) || 10;
    const userLevel = document.getElementById('newCmdUserLevel').value;

    if (!name || !response) {
      showToast('Debes ingresar el nombre del comando y su respuesta', 'warn');
      return;
    }

    const formattedName = name.startsWith('!') ? name : `!${name}`;
    const commands = await fetch('/api/commands').then(r => r.json());

    // Check if exists or update
    const existingIdx = commands.findIndex(c => c.name.toLowerCase() === formattedName.toLowerCase());
    const newCmd = {
      id: existingIdx >= 0 ? commands[existingIdx].id : `cmd-${Date.now()}`,
      name: formattedName,
      response,
      cooldown,
      userLevel,
      enabled: true
    };

    if (existingIdx >= 0) {
      commands[existingIdx] = newCmd;
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

    document.getElementById('newCmdName').value = '';
    document.getElementById('newCmdResponse').value = '';
  });

  // Add Reward Dummy Modal
  document.getElementById('btnAddRewardBtn').addEventListener('click', async () => {
    const title = prompt('Nombre de la recompensa en Twitch (debe coincidir con tu panel de Twitch):', 'Pedir Canción VIP');
    if (!title) return;

    const action = prompt('Acción a ejecutar (tts / song_request / sound):', 'song_request');
    if (!action) return;

    const rewards = await fetch('/api/rewards').then(r => r.json());
    rewards.push({
      id: `reward-${Date.now()}`,
      rewardName: title,
      action: action.toLowerCase(),
      cost: 500,
      enabled: true
    });

    const res = await fetch('/api/rewards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rewards)
    });
    const data = await res.json();
    renderRewards(data.rewards);
    showToast('Recompensa vinculada');
  });
}
