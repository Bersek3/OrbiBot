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

      return { success: true, message: this.statusMessage };
    } catch (err) {
      this.status = 'error';
      this.statusMessage = `Error de conexión: ${err.message || err}`;
      this.broadcast('bot_status', { status: this.status, message: this.statusMessage });
      console.error('Twitch connection error:', err);
      return { success: false, message: this.statusMessage };
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

      // Check for Bits donation in chat message
      if (tags.bits) {
        const bitCount = parseInt(tags.bits, 10);
        this.broadcast('alert', {
          type: 'bits',
          user: username,
          amount: bitCount,
          message
        });

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
        const rewards = storage.getRewards() || [];
        // 1. Buscar coincidencia exacta por rewardId o id
        let matchedReward = rewards.find(r => r.enabled && (
          (r.rewardId && r.rewardId.toLowerCase() === customRewardId.toLowerCase()) ||
          (r.id && r.id.toLowerCase() === customRewardId.toLowerCase())
        ));

        // 2. Si no está vinculado por UUID aún, vincular al primer tipo compatible
        if (!matchedReward) {
          matchedReward = rewards.find(r => r.enabled);
        }

        if (matchedReward && matchedReward.enabled) {
          if (matchedReward.action === 'tts') {
            ttsService.processRequest({
              user: username,
              text: message,
              source: 'channel_points'
            });
            this.broadcast('alert', {
              type: 'channel_points',
              user: username,
              reward: matchedReward.rewardName || 'Voz TTS',
              message
            });
            return;
          } else if (matchedReward.action === 'song_request') {
            const result = await songRequest.addSong({
              query: message,
              requester: username,
              isMod: true,
              isSub: true,
              isPriority: true
            });
            this.sendMessage(channel, `🌟 [PUNTOS DE CANAL VIP] @${username} pidió con prioridad: ${result.message}`);
            this.broadcast('alert', {
              type: 'channel_points',
              user: username,
              reward: matchedReward.rewardName || 'Pedir Canción VIP',
              message
            });
            return;
          } else if (matchedReward.action === 'sound') {
            this.broadcast('alert', {
              type: 'sound',
              user: username,
              soundUrl: matchedReward.soundUrl || '/assets/sounds/airhorn.mp3',
              reward: matchedReward.rewardName || 'Efecto de Sonido',
              message
            });
            return;
          }
        }
      }

      const trimmed = message.trim();
      const config = storage.getConfig();

      // Check Song Request Command (default !sr or custom prefix)
      const srPrefix = (config.songRequest.prefix || '!sr').toLowerCase();
      if (trimmed.toLowerCase().startsWith(srPrefix)) {
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
      this.broadcast('alert', {
        type: 'sub',
        user: username,
        tier: method.prime ? 'Prime' : (method.plan ? method.plan / 1000 : '1'),
        message: message || ''
      });
    });

    // Resubscriptions
    this.client.on('resub', (channel, username, months, message, userstate, methods) => {
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
  }
}

module.exports = new TwitchBot();
