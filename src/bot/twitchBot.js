const tmi = require('tmi.js');
const storage = require('../services/storage');
const songRequest = require('../services/songRequest');
const ttsService = require('../services/ttsService');

class TwitchBot {
  constructor() {
    this.client = null;
    this.status = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'error'
    this.statusMessage = 'Desconectado';
    this.eventCallbacks = [];
    this.commandCooldowns = new Map();
  }

  onEvent(callback) {
    this.eventCallbacks.push(callback);
  }

  broadcast(event, payload) {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event, payload);
      } catch (err) {
        console.error('Error in TwitchBot broadcast callback:', err);
      }
    }
  }

  async connect() {
    const config = storage.getConfig();
    const twitchCfg = config.twitch;

    if (!twitchCfg.channel) {
      this.status = 'disconnected';
      this.statusMessage = 'Canal no configurado';
      this.broadcast('bot_status', { status: this.status, message: this.statusMessage });
      return { success: false, message: 'Debe especificar el nombre del canal de Twitch.' };
    }

    if (this.client) {
      try {
        await this.disconnect();
      } catch (e) {
        // ignore
      }
    }

    const channelName = twitchCfg.channel.toLowerCase().replace(/^#/, '');
    const botUser = twitchCfg.botUsername ? twitchCfg.botUsername.toLowerCase() : channelName;
    const token = twitchCfg.oauthToken ? (twitchCfg.oauthToken.startsWith('oauth:') ? twitchCfg.oauthToken : `oauth:${twitchCfg.oauthToken}`) : null;

    const tmiOptions = {
      options: { debug: false },
      connection: {
        reconnect: true,
        secure: true
      },
      channels: [channelName]
    };

    // If OAuth token provided, use authenticated bot; otherwise read-only anonymous connection
    if (token && botUser) {
      tmiOptions.identity = {
        username: botUser,
        password: token
      };
    }

    this.status = 'connecting';
    this.statusMessage = `Conectando al canal #${channelName}...`;
    this.broadcast('bot_status', { status: this.status, message: this.statusMessage });

    try {
      this.client = new tmi.Client(tmiOptions);
      this.setupHandlers(channelName);
      await this.client.connect();

      this.status = 'connected';
      this.statusMessage = `Conectado a #${channelName} ${token ? `como @${botUser}` : '(Modo lectura)'}`;
      this.broadcast('bot_status', { status: this.status, message: this.statusMessage, channel: channelName });

      // Sincronizar automáticamente IDs de recompensas de Puntos de Canal con Twitch
      this.syncTwitchRewards();

      // Conectar a EventSub WebSocket para captura en tiempo real de todos los canjes de Puntos de Canal
      if (twitchCfg.userId && twitchCfg.clientId && twitchCfg.oauthToken) {
        this.connectEventSub(twitchCfg.userId, twitchCfg.clientId, twitchCfg.oauthToken);
      }

      return { success: true, message: this.statusMessage };
    } catch (err) {
      this.status = 'error';
      this.statusMessage = `Error de conexión: ${err.message || err}`;
      this.broadcast('bot_status', { status: this.status, message: this.statusMessage });
      console.error('Twitch connection error:', err);
      return { success: false, message: this.statusMessage };
    }
  }

  async syncTwitchRewards() {
    const config = storage.getConfig();
    const twitchCfg = config.twitch || {};
    if (!twitchCfg.oauthToken || !twitchCfg.userId || !twitchCfg.clientId) return;

    try {
      const cleanToken = twitchCfg.oauthToken.replace(/^oauth:/i, '').trim();
      const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${twitchCfg.userId}`, {
        headers: {
          'Client-Id': twitchCfg.clientId,
          'Authorization': `Bearer ${cleanToken}`
        }
      });

      if (res.ok) {
        const data = await res.json();
        const twitchRewards = data.data || [];
        const localRewards = storage.getRewards() || [];
        let updated = false;

        localRewards.forEach(r => {
          const match = twitchRewards.find(tr => tr.title.trim().toLowerCase() === r.rewardName.trim().toLowerCase());
          if (match && r.rewardId !== match.id) {
            r.rewardId = match.id;
            updated = true;
          }
        });

        if (updated) {
          storage.saveRewards(localRewards);
          console.log(`[TwitchBot] ✅ Recompensas de Puntos de Canal vinculadas con Twitch Helix.`);
        }
      }
    } catch (e) {
      console.warn('[TwitchBot] No se pudieron sincronizar recompensas desde Helix:', e.message);
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (e) {
        // ignore
      }
      this.client = null;
    }
    this.status = 'disconnected';
    this.statusMessage = 'Desconectado';
    this.broadcast('bot_status', { status: this.status, message: this.statusMessage });
    return { success: true, message: 'Bot desconectado.' };
  }

  sendMessage(channel, message) {
    if (this.client && this.status === 'connected') {
      try {
        this.client.say(channel, message);
      } catch (err) {
        console.warn('Could not send chat message (maybe read-only token):', err.message);
      }
    }
  }

  setupHandlers(channelName) {
    // Chat Message Handler
    this.client.on('message', async (channel, tags, message, self) => {
      if (self) return;

      const username = tags['display-name'] || tags.username;
      const isMod = tags.mod || tags.badges?.broadcaster === '1';
      const isSub = tags.subscriber || tags.badges?.subscriber !== undefined;
      const userColor = tags.color || '#9146ff';

      // Forward chat message to dashboard & chat overlay
      this.broadcast('chat_message', {
        id: tags.id || Date.now().toString(),
        platform: 'twitch',
        user: username,
        color: userColor,
        message,
        isMod,
        isSub,
        badges: tags.badges || {},
        badgesRaw: tags['badges-raw'] || null,
        emotes: tags.emotes || null,
        roomId: tags['room-id'] || null
      });

      // Bits alert
      if (tags.bits) {
        const bitCount = parseInt(tags.bits, 10);
        this.broadcast('alert', {
          type: 'bits',
          user: username,
          amount: bitCount,
          message
        });

        this.incrementGoalsByType('bits', bitCount);

        // Trigger TTS if bits meet threshold
        const ttsConfig = storage.getConfig().tts;
        if (ttsConfig.enabled && bitCount >= (ttsConfig.minBits || 50)) {
          ttsService.processRequest({
            user: username,
            text: message,
            source: 'bits',
            bits: bitCount
          });
        }
      }

      // Check for Twitch Channel Points Redemptions with user text input (tags['custom-reward-id'])
      const customRewardId = tags['custom-reward-id'];
      if (customRewardId) {
        await this.handleChannelPointRedemption(customRewardId, username, message, '', channel);
        return;
      }

      const trimmed = message.trim();
      const config = storage.getConfig();

      // Check Song Request Command (default !sr or custom prefix)
      const isSrEnabled = config.songRequest && config.songRequest.enabled !== false;
      const srPrefix = (config.songRequest?.prefix || '!sr').toLowerCase();
      if (trimmed.toLowerCase().startsWith(srPrefix)) {
        if (!isSrEnabled) {
          this.sendMessage(channel, `@${username}, el sistema de Song Request está desactivado en este momento.`);
          return;
        }
        const query = trimmed.slice(srPrefix.length).trim();
        if (!query) {
          this.sendMessage(channel, `@${username}, uso: ${srPrefix} <enlace o nombre de canción>`);
          return;
        }

        const result = await songRequest.addSong({
          query,
          requester: username,
          isMod,
          isSub
        });

        this.sendMessage(channel, result.message);
        return;
      }

      // Check !song (current playing)
      if (trimmed.toLowerCase() === '!song' || trimmed.toLowerCase() === '!cancion') {
        if (!isSrEnabled) return;
        const state = songRequest.getState();
        if (state.currentSong) {
          this.sendMessage(channel, `🎶 Sonando ahora: ${state.currentSong.title} (pedida por @${state.currentSong.requester})`);
        } else {
          this.sendMessage(channel, `No hay ninguna canción reproduciéndose en este momento.`);
        }
        return;
      }

      // Check !skip
      if (trimmed.toLowerCase() === '!skip' || trimmed.toLowerCase() === '!saltar') {
        if (!isSrEnabled) return;
        if (isMod) {
          const res = songRequest.skip(username, true);
          this.sendMessage(channel, res.message);
        } else {
          const res = songRequest.voteSkip(username);
          this.sendMessage(channel, res.message);
        }
        return;
      }

      // Check !queue
      if (trimmed.toLowerCase() === '!queue' || trimmed.toLowerCase() === '!cola') {
        if (!isSrEnabled) return;
        const state = songRequest.getState();
        if (state.queue.length === 0) {
          this.sendMessage(channel, `La cola de reproducción está vacía.`);
        } else {
          const nextSongs = state.queue.slice(0, 3).map((s, i) => `#${i + 1} ${s.title}`).join(' | ');
          this.sendMessage(channel, `Próximas: ${nextSongs} (Total en cola: ${state.queue.length})`);
        }
        return;
      }

      // Check !tts command
      const ttsCmd = (config.tts.chatCommand || '!tts').toLowerCase();
      if (config.tts.enabled && config.tts.allowChatCommand && trimmed.toLowerCase().startsWith(ttsCmd)) {
        const ttsText = trimmed.slice(ttsCmd.length).trim();
        if (ttsText) {
          ttsService.processRequest({
            user: username,
            text: ttsText,
            source: 'chat'
          });
        }
        return;
      }

      // Check Custom Commands
      const commands = storage.getCommands();
      const firstWord = trimmed.split(' ')[0].toLowerCase();
      const matchedCmd = commands.find(c => c.enabled && c.name.toLowerCase() === firstWord);

      if (matchedCmd) {
        // Cooldown check
        const now = Date.now();
        const lastUsed = this.commandCooldowns.get(matchedCmd.id) || 0;
        const cooldown = matchedCmd.cooldown !== undefined ? Number(matchedCmd.cooldown) : 5;
        const cooldownMs = cooldown * 1000;

        if (cooldown <= 0 || isMod || (now - lastUsed >= cooldownMs)) {
          this.commandCooldowns.set(matchedCmd.id, now);
          this.sendMessage(channel, matchedCmd.response);
        }
      }
    });

    // Subscriptions
    this.client.on('subscription', (channel, username, method, message, userstate) => {
      this.incrementGoalsByType('subs', 1);
      this.broadcast('alert', {
        type: 'sub',
        user: username,
        tier: method.prime ? 'Prime' : (method.plan ? method.plan / 1000 : '1'),
        message: message || ''
      });
    });

    // Resubscriptions
    this.client.on('resub', (channel, username, months, message, userstate, methods) => {
      this.incrementGoalsByType('subs', 1);
      this.broadcast('alert', {
        type: 'sub',
        user: username,
        tier: methods.prime ? 'Prime' : (methods.plan ? methods.plan / 1000 : '1'),
        months,
        message: message || ''
      });
    });

    // Sub Gifts
    this.client.on('subgift', (channel, username, streakMonths, recipient, methods, userstate) => {
      this.incrementGoalsByType('subs', 1);
      this.broadcast('alert', {
        type: 'sub',
        user: username,
        recipient,
        tier: methods.plan ? methods.plan / 1000 : '1',
        isGift: true
      });
    });

    // Raids
    this.client.on('raided', (channel, username, viewers) => {
      this.broadcast('alert', {
        type: 'raid',
        user: username,
        viewers
      });
    });

    // Host
    this.client.on('hosted', (channel, username, viewers, autohost) => {
      if (!autohost) {
        this.broadcast('alert', {
          type: 'raid',
          user: username,
          viewers
        });
      }
    });

    // Capturar canjes de Puntos de Canal sin entrada de texto vía IRC raw_message / USERNOTICE
    this.client.on('raw_message', (raw) => {
      try {
        if (raw && raw.raw && raw.raw.includes('custom-reward-id=')) {
          const rewardMatch = raw.raw.match(/custom-reward-id=([^;\s]+)/);
          if (rewardMatch) {
            const customRewardId = rewardMatch[1];
            const userMatch = raw.raw.match(/display-name=([^;\s]+)/) || raw.raw.match(/login=([^;\s]+)/);
            const username = userMatch ? decodeURIComponent(userMatch[1]) : (raw.tags?.['display-name'] || raw.tags?.username || 'Espectador');
            const msgMatch = raw.raw.match(/USERNOTICE\s+#[^\s]+\s+:(.*)$/);
            const userMsg = msgMatch ? msgMatch[1] : '';
            this.handleChannelPointRedemption(customRewardId, username, userMsg, '', channelName);
          }
        }
      } catch (e) { }
    });

    this.client.on('usernotice', (msgId, channel, tags, msg) => {
      try {
        const customRewardId = tags?.['custom-reward-id'];
        if (customRewardId) {
          const username = tags['display-name'] || tags.username || 'Espectador';
          this.handleChannelPointRedemption(customRewardId, username, msg || '', '', channelName);
        }
      } catch (e) { }
    });
  }

  /**
   * Procesa la ejecución de un canje de Puntos de Canal (Sonido, TTS, Song Request).
   */
  async handleChannelPointRedemption(customRewardId, username, message = '', rewardTitle = '', channel = '') {
    const dedupeKey = `${customRewardId || rewardTitle}_${username}_${Math.floor(Date.now() / 2500)}`;
    if (this.recentRedemptions && this.recentRedemptions.has(dedupeKey)) return;
    if (!this.recentRedemptions) this.recentRedemptions = new Set();
    this.recentRedemptions.add(dedupeKey);
    setTimeout(() => this.recentRedemptions.delete(dedupeKey), 10000);

    let rewards = storage.getRewards() || [];

    // Si rewards local está vacío, consultar Supabase si está disponible
    if ((!rewards || rewards.length === 0) && storage.supabase) {
      try {
        const streamerId = storage.getStreamerId();
        const { data } = await storage.supabase
          .from('orbibot_settings')
          .select('value')
          .in('streamer_id', [streamerId, 'default'])
          .eq('key', 'channel_points');
        if (data && data.length > 0) {
          const row = data.find(d => Array.isArray(d.value) && d.value.length > 0);
          if (row) {
            rewards = row.value;
            storage.saveRewards(rewards);
          }
        }
      } catch (e) { }
    }

    // 1. Coincidencia por ID de Twitch o título exacto
    let matchedReward = rewards.find(r => r.enabled && (
      (r.rewardId && customRewardId && r.rewardId.toLowerCase() === customRewardId.toLowerCase()) ||
      (r.id && customRewardId && r.id.toLowerCase() === customRewardId.toLowerCase()) ||
      (rewardTitle && r.rewardName && r.rewardName.trim().toLowerCase() === rewardTitle.trim().toLowerCase())
    ));

    // 2. Si no coincide aún, resolver el título por Helix API en vivo
    if (!matchedReward && customRewardId) {
      const config = storage.getConfig();
      const twitchCfg = config.twitch || {};
      if (twitchCfg.oauthToken && twitchCfg.userId && twitchCfg.clientId) {
        try {
          const cleanToken = twitchCfg.oauthToken.replace(/^oauth:/i, '').trim();
          const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${twitchCfg.userId}&id=${customRewardId}`, {
            headers: {
              'Client-Id': twitchCfg.clientId,
              'Authorization': `Bearer ${cleanToken}`
            }
          });
          if (res.ok) {
            const data = await res.json();
            if (data.data && data.data.length > 0) {
              const fetchedTitle = data.data[0].title.trim().toLowerCase();
              matchedReward = rewards.find(r => r.enabled && r.rewardName.trim().toLowerCase() === fetchedTitle);
              if (matchedReward) {
                matchedReward.rewardId = customRewardId;
                storage.saveRewards(rewards);
                console.log(`[TwitchBot] ✅ Recompensa "${matchedReward.rewardName}" vinculada automáticamente con ID ${customRewardId}`);
              }
            }
          }
        } catch (helixErr) {
          console.warn('[TwitchBot] Error al resolver recompensa de Twitch:', helixErr.message);
        }
      }
    }

    if (matchedReward && matchedReward.enabled) {
      console.log(`[TwitchBot] 🎁 Canje procesado: "${matchedReward.rewardName}" (${matchedReward.action}) por @${username}`);
      if (matchedReward.action === 'sound') {
        const soundUrl = matchedReward.soundUrl || '/assets/sounds/airhorn.mp3';
        this.broadcast('alert', {
          type: 'sound',
          user: username,
          soundUrl: soundUrl,
          reward: matchedReward.rewardName || 'Efecto de Sonido',
          message
        });
        return;
      } else if (matchedReward.action === 'tts') {
        const ttsText = (message || '').trim();
        if (ttsText) {
          ttsService.processRequest({
            user: username,
            text: ttsText,
            source: 'channel_points'
          });
        }
        // No emitir alerta visual de widget para canjes de TTS: solo lee el mensaje
        return;
      } else if (matchedReward.action === 'song_request') {
        const srCfg = storage.getConfig().songRequest;
        if (srCfg && srCfg.enabled === false) {
          if (channel) this.sendMessage(channel, `@${username}, el sistema de Song Request está desactivado en este momento.`);
          return;
        }
        const result = await songRequest.addSong({
          query: message,
          requester: username,
          isMod: true,
          isSub: true,
          isPriority: true
        });
        if (channel) this.sendMessage(channel, `🌟 [PUNTOS DE CANAL VIP] @${username} pidió con prioridad: ${result.message}`);
        this.broadcast('alert', {
          type: 'channel_points',
          user: username,
          reward: matchedReward.rewardName || 'Pedir Canción VIP',
          message
        });
        return;
      }
    } else {
      this.broadcast('alert', {
        type: 'channel_points',
        user: username,
        reward: rewardTitle || 'Puntos de Canal',
        message
      });
    }
  }

  /**
   * Conecta a Twitch EventSub WebSocket para capturar todos los canjes de Puntos de Canal en tiempo real.
   */
  connectEventSub(userId, clientId, token) {
    if (this.eventsubWs) {
      try { this.eventsubWs.close(); } catch (e) { }
      this.eventsubWs = null;
    }

    try {
      const WebSocket = require('ws');
      const ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws');
      this.eventsubWs = ws;

      ws.on('open', () => {
        console.log('[TwitchBot] 🟢 Conectado a Twitch EventSub WebSocket (Puntos de Canal en vivo).');
      });

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.metadata && msg.metadata.message_type === 'session_welcome') {
            const sessionId = msg.payload.session.id;
            const cleanToken = token.replace(/^oauth:/i, '').trim();

            const subRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
              method: 'POST',
              headers: {
                'Client-Id': clientId,
                'Authorization': `Bearer ${cleanToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                type: 'channel.channel_points_custom_reward_redemption.add',
                version: '1',
                condition: { broadcaster_user_id: userId },
                transport: {
                  method: 'websocket',
                  session_id: sessionId
                }
              })
            });

            if (subRes.ok) {
              console.log('[TwitchBot] ✅ Suscripción a EventSub de Puntos de Canal exitosa.');
            } else {
              const errData = await subRes.json().catch(() => ({}));
              console.warn('[TwitchBot] EventSub info:', errData.message || subRes.statusText);
            }
          } else if (msg.metadata && msg.metadata.message_type === 'notification') {
            const ev = msg.payload?.event;
            if (ev && ev.reward) {
              this.handleChannelPointRedemption(ev.reward.id, ev.user_name || ev.user_login || 'Espectador', ev.user_input || '', ev.reward.title || '');
            }
          }
        } catch (err) {
          console.warn('[TwitchBot] Error procesando mensaje de EventSub:', err.message);
        }
      });

      ws.on('close', () => {
        if (this.status === 'connected') {
          setTimeout(() => {
            const config = storage.getConfig();
            const tCfg = config.twitch || {};
            if (tCfg.userId && tCfg.clientId && tCfg.oauthToken && this.status === 'connected') {
              this.connectEventSub(tCfg.userId, tCfg.clientId, tCfg.oauthToken);
            }
          }, 5000);
        }
      });

      ws.on('error', (err) => {
        console.warn('[TwitchBot] EventSub WebSocket error:', err.message);
      });
    } catch (e) {
      console.warn('[TwitchBot] EventSub no disponible:', e.message);
    }
  }

  incrementGoalsByType(type, amount = 1) {
    try {
      const goals = storage.getGoals();
      if (!Array.isArray(goals) || goals.length === 0) return;
      let updated = false;
      goals.forEach(g => {
        if (g.enabled !== false && (g.type === type || g.type === type.replace(/s$/, ''))) {
          g.current = (Number(g.current) || 0) + Number(amount);
          updated = true;
          this.broadcast('goal_update', { goalId: g.id, type: g.type, goal: g });
        }
      });
      if (updated) {
        storage.saveGoals(goals);
      }
    } catch(e) {
      console.warn('[TwitchBot] Error al auto-incrementar meta:', e.message);
    }
  }
}

module.exports = new TwitchBot();
