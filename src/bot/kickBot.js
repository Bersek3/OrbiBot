const WebSocket = require('ws');
const storage = require('../services/storage');

class KickBot {
  constructor() {
    this.ws = null;
    this.status = 'disconnected';
    this.statusMessage = 'Desconectado';
    this.eventCallbacks = [];
    this.pingInterval = null;
    this.reconnectTimeout = null;
    this.currentChannel = '';
    this.chatroomId = null;
  }

  onEvent(callback) {
    this.eventCallbacks.push(callback);
  }

  broadcast(event, payload) {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event, payload);
      } catch (err) {
        console.error('Error in KickBot broadcast callback:', err);
      }
    }
  }

  async getChatroomId(channelName) {
    const clean = (channelName || '').toLowerCase().replace(/^@/, '').trim();
    if (!clean) return null;

    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${clean}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.chatroom && data.chatroom.id) {
          return data.chatroom.id;
        }
        if (data.id) {
          return data.id;
        }
      }
    } catch (e) {
      console.warn(`[KickBot] Fallback fetching chatroom for ${clean}:`, e.message);
    }

    try {
      const res2 = await fetch(`https://kick.com/api/v1/channels/${clean}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2.chatroom && data2.chatroom.id) {
          return data2.chatroom.id;
        }
      }
    } catch (e2) {}

    return null;
  }

  async connect() {
    const config = storage.getConfig();
    const kickCfg = config.kick || {};
    const channelName = (kickCfg.channel || kickCfg.username || '').toLowerCase().replace(/^@/, '').trim();

    if (!channelName || kickCfg.connected === false) {
      this.status = 'disconnected';
      this.statusMessage = 'Canal de Kick no configurado';
      return { success: false, message: 'Canal de Kick no configurado.' };
    }

    if (this.ws) {
      this.disconnect();
    }

    this.currentChannel = channelName;
    this.status = 'connecting';
    this.statusMessage = `Conectando a Kick @${channelName}...`;

    // 1. Resolve chatroom ID
    this.chatroomId = kickCfg.chatroomId || await this.getChatroomId(channelName);

    // Fallback: If chatroomId cannot be fetched via API, use userId if numeric, or channelName
    const targetRoom = this.chatroomId || kickCfg.userId || channelName;

    const pusherUrl = 'wss://ws-us2.pusher.com/app/eb1d5f283081ab659038?protocol=7&client=js&version=7.6.0&flash=false';

    try {
      this.ws = new WebSocket(pusherUrl);

      this.ws.on('open', () => {
        this.status = 'connected';
        this.statusMessage = `Conectado al chat de Kick @${channelName}`;
        console.log(`🟢 [KickBot] Conectado exitosamente al chat de Kick @${channelName} (Room: ${targetRoom})`);

        // Subscribe to chatroom channel
        const subPayload = JSON.stringify({
          event: 'pusher:subscribe',
          data: {
            auth: '',
            channel: `chatrooms.${targetRoom}.v2`
          }
        });
        this.ws.send(subPayload);

        // Also subscribe to channel events (subscriptions, followers, etc.)
        const channelSubPayload = JSON.stringify({
          event: 'pusher:subscribe',
          data: {
            auth: '',
            channel: `channel.${targetRoom}`
          }
        });
        this.ws.send(channelSubPayload);

        // Keep-alive ping
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }
        }, 20000);
      });

      this.ws.on('message', (rawData) => {
        try {
          const packet = JSON.parse(rawData.toString());
          this.handlePusherPacket(packet);
        } catch (err) {
          console.error('[KickBot] Error parsing packet:', err);
        }
      });

      this.ws.on('error', (err) => {
        console.warn('[KickBot] WebSocket error:', err.message);
        this.status = 'error';
        this.statusMessage = err.message;
      });

      this.ws.on('close', (code, reason) => {
        console.log(`🟡 [KickBot] Desconectado (${code}): ${reason || 'Cierre de conexión'}`);
        this.status = 'disconnected';
        this.cleanup();
        this.scheduleReconnect();
      });

      return { success: true, message: `Conectado al chat de Kick @${channelName}` };
    } catch (err) {
      console.error('[KickBot] Error al conectar:', err);
      this.status = 'error';
      this.statusMessage = err.message;
      this.scheduleReconnect();
      return { success: false, message: err.message };
    }
  }

  handlePusherPacket(packet) {
    if (!packet || !packet.event) return;

    if (packet.event === 'App\\Events\\ChatMessageEvent' || packet.event === 'ChatMessageEvent') {
      try {
        const msgData = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
        const sender = msgData.sender || {};
        const username = sender.username || sender.slug || 'KickUser';
        const color = sender.identity?.color || '#53fc18';
        const message = msgData.content || '';
        const badges = sender.identity?.badges || [];

        const isMod = badges.some(b => b.type === 'moderator' || b.type === 'broadcaster');
        const isSub = badges.some(b => b.type === 'subscriber' || b.type === 'sub_gifter');

        const chatPayload = {
          id: msgData.id || `kick-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          platform: 'kick',
          user: username,
          color,
          message,
          isMod,
          isSub,
          badges,
          badgesRaw: null,
          emotes: null
        };

        this.broadcast('chat_message', chatPayload);
      } catch (e) {
        console.error('[KickBot] Error processing chat message:', e);
      }
    } else if (packet.event === 'App\\Events\\SubscriptionEvent' || packet.event === 'App\\Events\\GiftedSubscriptionsEvent') {
      try {
        const subData = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
        const user = subData.username || subData.gifter_username || 'KickUser';
        const months = subData.months || 1;
        this.broadcast('alert', {
          type: 'sub',
          platform: 'kick',
          user,
          months,
          message: `¡Nueva suscripción en Kick (${months} meses)!`
        });
      } catch (e) {}
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    const config = storage.getConfig();
    if (config.kick && config.kick.channel && config.kick.connected) {
      this.reconnectTimeout = setTimeout(() => {
        console.log('🔄 [KickBot] Intentando reconectar chat de Kick...');
        this.connect();
      }, 5000);
    }
  }

  cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.cleanup();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (e) {}
      this.ws = null;
    }
    this.status = 'disconnected';
    this.statusMessage = 'Desconectado';
  }
}

const kickBot = new KickBot();
module.exports = kickBot;
