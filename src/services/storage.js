require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { MongoClient } = require('mongodb');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function generateWidgetToken() {
  return 'sec_' + crypto.randomBytes(16).toString('hex');
}

const DEFAULT_CONFIG = {
  security: {
    widgetToken: generateWidgetToken()
  },
  twitch: {
    channel: '',
    botUsername: '',
    oauthToken: '',
    clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
    connected: false
  },
  kick: {
    channel: '',
    username: '',
    profile_picture: '',
    userId: '',
    accessToken: '',
    refreshToken: '',
    clientId: process.env.KICK_CLIENT_ID || '01M0VT0JC58YQEVGRHM8JFXQX3',
    connected: false
  },
  chatPlatforms: {
    twitch: true,
    kick: true
  },
  songRequest: {
    prefix: '!sr',
    enabled: true,
    maxDurationMinutes: 8,
    maxPerUser: 5,
    userLevel: 'all', // all, subs, mod
    volume: 75,
    autoplay: true
  },
  tts: {
    enabled: true,
    engine: 'streamelements', // 'streamelements', 'webspeech', 'google'
    voice: 'es_mx_mia',
    volume: 90,
    rate: 1.0,
    pitch: 1.0,
    minBits: 50,
    allowChatCommand: true,
    chatCommand: '!tts',
    bannedWords: ['nazi', 'hitler', 'racismo', 'tonto'],
    maxLength: 250,
    channelPointsRewardName: 'TTS'
  },
  goals: []
};

const DEFAULT_COMMANDS = [];

const DEFAULT_ALERTS = {
  follower: {
    enabled: true,
    title: 'Nuevo Seguidor',
    message: '¡{user} ahora sigue el canal!',
    sound: '/assets/sounds/campana_alerta.wav',
    duration: 6,
    image: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdWk1YW0yZXpxM3c2NHJreGQxbDduMWVvb3hpZGl2dHVqMm1pMG1jYyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/artj92V8o75VPL7AeQ/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#00f2fe'
  },
  sub: {
    enabled: true,
    title: '¡Nueva Suscripción!',
    message: '¡{user} se ha suscrito al canal! (Nivel {tier})',
    sound: '/assets/sounds/campana_alerta.wav',
    duration: 7,
    image: 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#9146ff'
  },
  bits: {
    enabled: true,
    title: 'Donación de Bits',
    message: '¡{user} ha donado {amount} bits! {message}',
    sound: '/assets/sounds/notificacion_puntos.wav',
    duration: 7,
    image: 'https://media.giphy.com/media/26FPJGjhefSJuaRhu/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#f5a623'
  },
  raid: {
    enabled: true,
    title: '¡Raid Entrante!',
    message: '¡{user} lidera una raid con {viewers} espectadores!',
    sound: '/assets/sounds/airhorn.mp3',
    duration: 8,
    image: 'https://media.giphy.com/media/l41lI4bYmcsPJX9Go/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#ff007f'
  },
  channel_points: {
    enabled: true,
    title: 'Puntos de Canal',
    message: '¡{user} ha canjeado {reward}!',
    sound: '/assets/sounds/notificacion_puntos.wav',
    duration: 6,
    image: 'https://media.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#10b981'
  }
};

const DEFAULT_REWARDS = [];

function readJSON(filename, defaultValue) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
      return defaultValue;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading ${filename}:`, err);
    return defaultValue;
  }
}

function writeJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`Error writing ${filename}:`, err);
    return false;
  }
}

class StorageService {
  constructor() {
    this.supabase = null;
    this.isSupabaseReady = false;

    this.mongoClient = null;
    this.mongoDb = null;
    this.isMongoReady = false;

    this._streamerId = null; // Cache del streamer_id activo
    this.restoreAllMediaFiles();
    
    // Inicializar ambas bases de datos para Doble Respaldo
    this.initSupabase();
    this.initMongoDB();
  }

  /**
   * Restaura todos los archivos multimedia (audios e imágenes) en disco.
   */
  restoreAllMediaFiles() {
    try {
      this.restoreAudioFiles(this.getCustomSounds());
      this.restoreImageFiles(this.getCustomImages());
      this.restoreMediaFromAlertsAndRewards();
    } catch (e) {
      console.warn('⚠️ [Storage] Error al restaurar archivos multimedia:', e.message);
    }
  }

  /**
   * Restaura archivos físicos de audio en public/assets/sounds/custom/
   * si están guardados en base64 dentro de custom_sounds.json o en la nube.
   */
  restoreAudioFiles(sounds) {
    if (!Array.isArray(sounds) || sounds.length === 0) return;
    const publicCustomDir = path.join(__dirname, '..', '..', 'public', 'assets', 'sounds', 'custom');
    const docsCustomDir = path.join(__dirname, '..', '..', 'docs', 'assets', 'sounds', 'custom');

    try {
      if (!fs.existsSync(publicCustomDir)) fs.mkdirSync(publicCustomDir, { recursive: true });
      if (fs.existsSync(path.join(__dirname, '..', '..', 'docs')) && !fs.existsSync(docsCustomDir)) {
        fs.mkdirSync(docsCustomDir, { recursive: true });
      }

      sounds.forEach(s => {
        if (!s || !s.name) return;
        const cleanName = path.basename(s.name).replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
        const rawData = s.data || s.dataUrl;
        if (rawData && typeof rawData === 'string' && (rawData.includes(';base64,') || rawData.startsWith('data:'))) {
          const base64Data = rawData.replace(/^data:[^;]+;base64,/, '');
          try {
            const buffer = Buffer.from(base64Data, 'base64');
            const targetPublic = path.join(publicCustomDir, cleanName);
            if (!fs.existsSync(targetPublic) || fs.statSync(targetPublic).size === 0) {
              fs.writeFileSync(targetPublic, buffer);
              console.log(`🔊 [Storage] Audio restaurado en disco: ${cleanName}`);
            }
            if (fs.existsSync(path.join(__dirname, '..', '..', 'docs'))) {
              const targetDocs = path.join(docsCustomDir, cleanName);
              if (!fs.existsSync(targetDocs) || fs.statSync(targetDocs).size === 0) {
                fs.writeFileSync(targetDocs, buffer);
              }
            }
          } catch (e) {
            console.warn(`⚠️ [Storage] Error al restaurar audio ${cleanName}:`, e.message);
          }
        }
      });
    } catch (err) {
      console.warn('⚠️ [Storage] Error en restoreAudioFiles:', err.message);
    }
  }

  /**
   * Restaura archivos físicos de imagen en public/assets/images/custom/
   */
  restoreImageFiles(images) {
    if (!Array.isArray(images) || images.length === 0) return;
    const publicCustomDir = path.join(__dirname, '..', '..', 'public', 'assets', 'images', 'custom');
    const docsCustomDir = path.join(__dirname, '..', '..', 'docs', 'assets', 'images', 'custom');

    try {
      if (!fs.existsSync(publicCustomDir)) fs.mkdirSync(publicCustomDir, { recursive: true });
      if (fs.existsSync(path.join(__dirname, '..', '..', 'docs')) && !fs.existsSync(docsCustomDir)) {
        fs.mkdirSync(docsCustomDir, { recursive: true });
      }

      images.forEach(img => {
        if (!img || !img.name) return;
        const cleanName = path.basename(img.name).replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
        const rawData = img.data || img.dataUrl;
        if (rawData && typeof rawData === 'string' && (rawData.includes(';base64,') || rawData.startsWith('data:'))) {
          const base64Data = rawData.replace(/^data:[^;]+;base64,/, '');
          try {
            const buffer = Buffer.from(base64Data, 'base64');
            const targetPublic = path.join(publicCustomDir, cleanName);
            if (!fs.existsSync(targetPublic) || fs.statSync(targetPublic).size === 0) {
              fs.writeFileSync(targetPublic, buffer);
              console.log(`🖼️ [Storage] Imagen restaurada en disco: ${cleanName}`);
            }
            if (fs.existsSync(path.join(__dirname, '..', '..', 'docs'))) {
              const targetDocs = path.join(docsCustomDir, cleanName);
              if (!fs.existsSync(targetDocs) || fs.statSync(targetDocs).size === 0) {
                fs.writeFileSync(targetDocs, buffer);
              }
            }
          } catch (e) {
            console.warn(`⚠️ [Storage] Error al restaurar imagen ${cleanName}:`, e.message);
          }
        }
      });
    } catch (err) {
      console.warn('⚠️ [Storage] Error en restoreImageFiles:', err.message);
    }
  }

  /**
   * Extrae y restaura cualquier archivo con data base64 presente en alerts, rewards o widgetStyles
   */
  restoreMediaFromAlertsAndRewards() {
    try {
      // 1. Desde rewards (puntos de canal)
      const rewards = this.getRewards();
      if (Array.isArray(rewards)) {
        rewards.forEach(r => {
          if (r && r.soundUrl && typeof r.soundUrl === 'string' && r.soundUrl.startsWith('data:audio/')) {
            const safeName = `reward_${r.id || 'snd'}.mp3`;
            this.restoreAudioFiles([{ name: safeName, dataUrl: r.soundUrl }]);
          }
        });
      }

      // 2. Desde alerts
      const alerts = this.getAlerts();
      if (alerts && typeof alerts === 'object') {
        Object.keys(alerts).forEach(k => {
          const item = alerts[k];
          if (item && item.sound && typeof item.sound === 'string' && item.sound.startsWith('data:audio/')) {
            const safeName = `alert_${k}.mp3`;
            this.restoreAudioFiles([{ name: safeName, dataUrl: item.sound }]);
          }
          if (item && item.image && typeof item.image === 'string' && item.image.startsWith('data:image/')) {
            const safeName = `alert_${k}.gif`;
            this.restoreImageFiles([{ name: safeName, dataUrl: item.image }]);
          }
        });
      }
    } catch (e) { }
  }

  /**
   * Obtiene el streamer_id actual basándose en el canal de Twitch configurado.
   */
  getStreamerId() {
    if (this._streamerId) return this._streamerId;
    try {
      const cfg = readJSON('config.json', DEFAULT_CONFIG);
      const channel = (cfg.twitch && cfg.twitch.channel) ? cfg.twitch.channel.toLowerCase().replace(/^#/, '').trim() : '';
      return channel || 'default';
    } catch (e) {
      return 'default';
    }
  }

  /**
   * Establece el streamer_id manualmente (al autenticar con Twitch).
   */
  setStreamerId(id) {
    const cleanId = (id || 'default').toLowerCase().replace(/^#/, '').trim();
    this._streamerId = cleanId || 'default';
    console.log(`🔑 [Storage] Streamer ID activo: "${this._streamerId}"`);
  }

  // ================= 🟢 BASE DE DATOS 1: SUPABASE =================
  initSupabase() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        this.supabase = createClient(supabaseUrl, supabaseKey, {
          auth: { persistSession: false }
        });
        console.log('🟢 [Supabase Cloud] Cliente inicializado correctamente.');
        this.syncFromSupabase();
      } catch (err) {
        console.warn('⚠️ [Supabase Cloud] Error al inicializar cliente:', err.message);
      }
    } else {
      console.log('ℹ️ [Storage] Supabase no configurado en .env.');
    }
  }

  async syncFromSupabase() {
    if (!this.supabase) return;
    const streamerId = this.getStreamerId();
    try {
      const { data, error } = await this.supabase
        .from('orbibot_settings')
        .select('*')
        .eq('streamer_id', streamerId);

      if (error) {
        if (error.message && error.message.includes('streamer_id')) {
          return this.syncFromSupabaseLegacy();
        }
        console.warn('⚠️ [Supabase] Error al sincronizar:', error.message);
        return;
      }

      if (data && data.length > 0) {
        this.isSupabaseReady = true;
        console.log(`✅ [Supabase Cloud] ${data.length} configuraciones sincronizadas para streamer "${streamerId}".`);
        data.forEach(item => {
          if (item.key === 'config') writeJSON('config.json', item.value);
          if (item.key === 'commands') writeJSON('commands.json', item.value);
          if (item.key === 'alerts') writeJSON('alerts.json', item.value);
          if (item.key === 'channel_points') writeJSON('channel_points.json', item.value);
          if (item.key === 'goals') writeJSON('goals.json', item.value);
          if (item.key === 'custom_sounds') {
            writeJSON('custom_sounds.json', item.value);
          }
          if (item.key === 'custom_images') {
            writeJSON('custom_images.json', item.value);
          }
        });
        this.restoreAllMediaFiles();
      } else {
        this.isSupabaseReady = true;
        if (streamerId !== 'default') {
          const migrated = await this.migrateFromDefaultSupabase(streamerId);
          if (migrated) return;
        }
        // Respaldar lo local en Supabase
        const sounds = this.getCustomSounds();
        if (sounds && sounds.length > 0) await this.syncToSupabase('custom_sounds', sounds);
        const images = this.getCustomImages();
        if (images && images.length > 0) await this.syncToSupabase('custom_images', images);
        const rwds = this.getRewards();
        if (rwds && rwds.length > 0) await this.syncToSupabase('channel_points', rwds);
        const goals = this.getGoals();
        if (goals && goals.length > 0) await this.syncToSupabase('goals', goals);
        const cmds = this.getCommands();
        if (cmds && cmds.length > 0) await this.syncToSupabase('commands', cmds);
      }
    } catch (err) {
      console.warn('⚠️ [Supabase] Error durante la sincronización inicial:', err.message);
    }
  }

  async syncFromSupabaseLegacy() {
    if (!this.supabase) return;
    try {
      const { data, error } = await this.supabase.from('orbibot_settings').select('*');
      if (!error && data && data.length > 0) {
        this.isSupabaseReady = true;
        data.forEach(item => {
          if (item.key === 'config') writeJSON('config.json', item.value);
          if (item.key === 'commands') writeJSON('commands.json', item.value);
          if (item.key === 'alerts') writeJSON('alerts.json', item.value);
          if (item.key === 'channel_points') writeJSON('channel_points.json', item.value);
          if (item.key === 'goals') writeJSON('goals.json', item.value);
          if (item.key === 'custom_sounds') {
            writeJSON('custom_sounds.json', item.value);
          }
          if (item.key === 'custom_images') {
            writeJSON('custom_images.json', item.value);
          }
        });
        this.restoreAllMediaFiles();
      }
    } catch (err) { }
  }

  async migrateFromDefaultSupabase(newStreamerId) {
    if (!this.supabase) return false;
    try {
      const { data } = await this.supabase
        .from('orbibot_settings')
        .select('*')
        .eq('streamer_id', 'default');

      if (data && data.length > 0) {
        for (const item of data) {
          await this.supabase
            .from('orbibot_settings')
            .upsert({
              streamer_id: newStreamerId,
              key: item.key,
              value: item.value,
              updated_at: new Date().toISOString()
            }, { onConflict: 'streamer_id,key' });
        }
        return true;
      }
    } catch (e) { }
    return false;
  }

  async syncToSupabase(key, value) {
    if (!this.supabase) return;
    const streamerId = this.getStreamerId();
    try {
      const { error } = await this.supabase
        .from('orbibot_settings')
        .upsert({
          streamer_id: streamerId,
          key,
          value,
          updated_at: new Date().toISOString()
        }, { onConflict: 'streamer_id,key' });

      if (error) {
        if (error.message && error.message.includes('streamer_id')) {
          await this.supabase.from('orbibot_settings').upsert({
            key,
            value,
            updated_at: new Date().toISOString()
          }, { onConflict: 'key' });
        }
      } else {
        this.isSupabaseReady = true;
      }
    } catch (err) { }
  }

  // ================= 🍃 BASE DE DATOS 2: MONGODB ATLAS =================
  initMongoDB() {
    let mongoUri = process.env.MONGODB_URI || 'mongodb+srv://Berserk:Bersek%401106%403200@servidor.krd1u.mongodb.net/orbibot?retryWrites=true&w=majority';

    // Formatear correctamente contraseñas con caracteres especiales como @
    if (mongoUri.includes('@') && !mongoUri.includes('%40')) {
      const match = mongoUri.match(/^(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@(.*)$/);
      if (match) {
        mongoUri = `${match[1]}${match[2]}:${encodeURIComponent(match[3])}@${match[4]}`;
      }
    }

    try {
      this.mongoClient = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 8000
      });

      this.mongoClient.connect().then(async () => {
        this.mongoDb = this.mongoClient.db('orbibot');
        this.isMongoReady = true;
        console.log('🍃 [MongoDB Cloud] Base de datos conectada correctamente (Doble Respaldo Activo).');

        try {
          await this.mongoDb.collection('settings').createIndex({ streamer_id: 1, key: 1 }, { unique: true });
          await this.mongoDb.collection('users').createIndex({ email: 1 }, { unique: true });
        } catch (e) { }

        // Sincronizar desde MongoDB
        this.syncFromMongoDB();
      }).catch(err => {
        console.warn('⚠️ [MongoDB Cloud] No se pudo conectar a MongoDB:', err.message);
        this.isMongoReady = false;
      });
    } catch (err) {
      console.warn('⚠️ [MongoDB Cloud] Error de inicialización:', err.message);
      this.isMongoReady = false;
    }
  }

  async syncFromMongoDB() {
    if (!this.isMongoReady || !this.mongoDb) return;
    const streamerId = this.getStreamerId();
    try {
      const records = await this.mongoDb.collection('settings')
        .find({ streamer_id: streamerId })
        .toArray();

      if (records && records.length > 0) {
        console.log(`✅ [MongoDB Cloud] ${records.length} configuraciones sincronizadas para streamer "${streamerId}".`);
        records.forEach(item => {
          if (item.key === 'config') writeJSON('config.json', item.value);
          if (item.key === 'commands') writeJSON('commands.json', item.value);
          if (item.key === 'alerts') writeJSON('alerts.json', item.value);
          if (item.key === 'channel_points') writeJSON('channel_points.json', item.value);
          if (item.key === 'goals') writeJSON('goals.json', item.value);
          if (item.key === 'custom_sounds') {
            writeJSON('custom_sounds.json', item.value);
          }
          if (item.key === 'custom_images') {
            writeJSON('custom_images.json', item.value);
          }
        });
        this.restoreAllMediaFiles();
      } else {
        // Si MongoDB está vacío, respaldar lo actual local en MongoDB
        const currentCustomSounds = this.getCustomSounds();
        if (currentCustomSounds && currentCustomSounds.length > 0) {
          await this.syncToMongoDB('custom_sounds', currentCustomSounds);
        }
        const currentCustomImages = this.getCustomImages();
        if (currentCustomImages && currentCustomImages.length > 0) {
          await this.syncToMongoDB('custom_images', currentCustomImages);
        }
        const currentRewards = this.getRewards();
        if (currentRewards && currentRewards.length > 0) {
          await this.syncToMongoDB('channel_points', currentRewards);
        }
        const currentGoals = this.getGoals();
        if (currentGoals && currentGoals.length > 0) {
          await this.syncToMongoDB('goals', currentGoals);
        }
        const currentCommands = this.getCommands();
        if (currentCommands && currentCommands.length > 0) {
          await this.syncToMongoDB('commands', currentCommands);
        }
        const currentConfig = this.getConfig();
        if (currentConfig) {
          await this.syncToMongoDB('config', currentConfig);
        }
        const currentAlerts = this.getAlerts();
        if (currentAlerts) {
          await this.syncToMongoDB('alerts', currentAlerts);
        }
      }
    } catch (err) {
      console.warn('⚠️ [MongoDB Cloud] Error en sincronización inicial:', err.message);
    }
  }

  async syncToMongoDB(key, value) {
    if (!this.isMongoReady || !this.mongoDb) return;
    const streamerId = this.getStreamerId();
    try {
      await this.mongoDb.collection('settings').updateOne(
        { streamer_id: streamerId, key },
        {
          $set: {
            streamer_id: streamerId,
            key,
            value,
            updated_at: new Date().toISOString()
          }
        },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`⚠️ [MongoDB Cloud] Error al guardar "${key}" para "${streamerId}":`, err.message);
    }
  }

  // ================= ⚡ DOBLE RESPALDO SIMULTÁNEO =================
  /**
   * Envía la información a Supabase AND MongoDB al mismo tiempo en paralelo.
   */
  async syncToCloud(key, value) {
    const promises = [];
    if (this.supabase) {
      promises.push(this.syncToSupabase(key, value));
    }
    if (this.isMongoReady && this.mongoDb) {
      promises.push(this.syncToMongoDB(key, value));
    }
    await Promise.allSettled(promises);
  }

  /**
   * Re-sincroniza toda la data desde ambas nubes para el streamer actual.
   */
  async resyncForStreamer(streamerId) {
    this.setStreamerId(streamerId);
    await Promise.allSettled([
      this.syncFromSupabase(),
      this.syncFromMongoDB()
    ]);
  }

  /**
   * Devuelve el estado de conexión del doble respaldo.
   */
  getBackupStatus() {
    return {
      dualBackupEnabled: true,
      supabase: {
        configured: Boolean(process.env.SUPABASE_URL),
        connected: this.isSupabaseReady,
        name: 'Supabase PostgreSQL'
      },
      mongodb: {
        configured: Boolean(process.env.MONGODB_URI || true),
        connected: this.isMongoReady,
        name: 'MongoDB Atlas'
      },
      local: {
        ready: true,
        name: 'Cache Local JSON'
      },
      streamerId: this.getStreamerId(),
      timestamp: new Date().toISOString()
    };
  }

  // ================= GETTERS Y SETTERS =================
  getConfig() {
    const cfg = readJSON('config.json', DEFAULT_CONFIG);
    let changed = false;
    let security = cfg.security || {};
    if (!security.widgetToken) {
      security.widgetToken = generateWidgetToken();
      changed = true;
    }
    const goals = this.getGoals();
    const merged = {
      ...DEFAULT_CONFIG,
      ...cfg,
      twitch: { ...DEFAULT_CONFIG.twitch, ...(cfg.twitch || {}) },
      songRequest: { ...DEFAULT_CONFIG.songRequest, ...(cfg.songRequest || {}) },
      tts: { ...DEFAULT_CONFIG.tts, ...(cfg.tts || {}) },
      goals,
      security
    };
    if (changed) {
      writeJSON('config.json', merged);
      this.syncToCloud('config', merged);
    }
    return merged;
  }

  regenerateWidgetToken() {
    const cfg = this.getConfig();
    const newToken = generateWidgetToken();
    cfg.security = {
      ...(cfg.security || {}),
      widgetToken: newToken
    };
    writeJSON('config.json', cfg);
    this.syncToCloud('config', cfg);
    return newToken;
  }

  saveConfig(newConfig) {
    const current = this.getConfig();
    const merged = {
      ...current,
      ...newConfig,
      twitch: { ...current.twitch, ...(newConfig.twitch || {}) },
      songRequest: { ...current.songRequest, ...(newConfig.songRequest || {}) },
      tts: { ...current.tts, ...(newConfig.tts || {}) },
      goals: { ...current.goals, ...(newConfig.goals || {}) },
      widgetStyles: { ...(current.widgetStyles || {}), ...(newConfig.widgetStyles || {}) },
      security: { ...current.security, ...(newConfig.security || {}) }
    };

    if (newConfig.twitch) {
      if (newConfig.twitch.channel) {
        const newChannel = newConfig.twitch.channel.toLowerCase().replace(/^#/, '').trim();
        if (newChannel && newChannel !== this._streamerId) {
          this.setStreamerId(newChannel);
        }
      } else if (newConfig.twitch.channel === '') {
        this.setStreamerId('default');
      }
    }

    writeJSON('config.json', merged);
    this.syncToCloud('config', merged);
    return merged;
  }

  getCommands() {
    return readJSON('commands.json', DEFAULT_COMMANDS);
  }

  saveCommands(commands) {
    writeJSON('commands.json', commands);
    this.syncToCloud('commands', commands);
    return commands;
  }

  getAlerts() {
    const alerts = readJSON('alerts.json', DEFAULT_ALERTS);
    const merged = {};
    Object.keys(DEFAULT_ALERTS).forEach(k => {
      merged[k] = { ...DEFAULT_ALERTS[k], ...(alerts[k] || {}) };
    });
    Object.keys(alerts || {}).forEach(k => {
      if (!merged[k]) {
        merged[k] = alerts[k];
      }
    });
    return merged;
  }

  saveAlerts(alerts) {
    const current = this.getAlerts();
    const merged = { ...current };
    if (alerts && typeof alerts === 'object') {
      Object.keys(alerts).forEach(k => {
        if (alerts[k] && typeof alerts[k] === 'object') {
          merged[k] = { ...(current[k] || {}), ...alerts[k] };
        } else {
          merged[k] = alerts[k];
        }
      });
    }
    writeJSON('alerts.json', merged);
    this.restoreMediaFromAlertsAndRewards();
    this.syncToCloud('alerts', merged);
    return merged;
  }

  getRewards() {
    return readJSON('channel_points.json', []);
  }

  saveRewards(rewards) {
    writeJSON('channel_points.json', rewards || []);
    this.restoreMediaFromAlertsAndRewards();
    this.syncToCloud('channel_points', rewards || []);
    return rewards || [];
  }

  getGoals() {
    const goals = readJSON('goals.json', null);
    if (Array.isArray(goals)) {
      return goals;
    }
    const cfg = readJSON('config.json', DEFAULT_CONFIG);
    if (Array.isArray(cfg.goals)) {
      writeJSON('goals.json', cfg.goals);
      return cfg.goals;
    }
    return [];
  }

  saveGoals(goals) {
    const list = Array.isArray(goals) ? goals : [];
    writeJSON('goals.json', list);
    this.syncToCloud('goals', list);
    return list;
  }

  getCustomSounds() {
    return readJSON('custom_sounds.json', []);
  }

  saveCustomSounds(sounds) {
    writeJSON('custom_sounds.json', sounds || []);
    this.restoreAudioFiles(sounds);
    this.syncToCloud('custom_sounds', sounds || []);
    return sounds || [];
  }

  getCustomImages() {
    return readJSON('custom_images.json', []);
  }

  saveCustomImages(images) {
    writeJSON('custom_images.json', images || []);
    this.restoreImageFiles(images);
    this.syncToCloud('custom_images', images || []);
    return images || [];
  }

  getUsers() {
    return readJSON('users.json', []);
  }

  async registerUser(email, password) {
    if (!email || !password) {
      throw new Error('Correo y contraseña son obligatorios.');
    }
    const cleanEmail = email.trim().toLowerCase();
    const users = this.getUsers();

    // 1. Verificar existencia local
    let existing = users.find(u => u.email.toLowerCase() === cleanEmail);

    // 2. Verificar existencia en MongoDB
    if (!existing && this.isMongoReady && this.mongoDb) {
      try {
        const mongoUser = await this.mongoDb.collection('users').findOne({ email: cleanEmail });
        if (mongoUser) existing = mongoUser;
      } catch (e) { }
    }

    if (existing) {
      throw new Error('Ya existe una cuenta registrada con este correo electrónico.');
    }

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const newUser = {
      id: 'usr_' + crypto.randomBytes(8).toString('hex'),
      email: cleanEmail,
      username: cleanEmail.split('@')[0],
      passwordHash: hash,
      createdAt: new Date().toISOString()
    };

    // Respaldo Local
    users.push(newUser);
    writeJSON('users.json', users);

    // Respaldo MongoDB Atlas
    if (this.isMongoReady && this.mongoDb) {
      try {
        await this.mongoDb.collection('users').updateOne(
          { email: cleanEmail },
          { $set: newUser },
          { upsert: true }
        );
        console.log(`🍃 [MongoDB Cloud] Usuario "${cleanEmail}" registrado y respaldado.`);
      } catch (e) {
        console.warn('⚠️ [MongoDB Cloud] Error al guardar usuario:', e.message);
      }
    }

    // Respaldo Supabase
    if (this.supabase) {
      try {
        await this.supabase.from('orbibot_users').upsert({
          id: newUser.id,
          email: cleanEmail,
          username: newUser.username,
          password_hash: hash,
          created_at: newUser.createdAt
        }, { onConflict: 'email' });
      } catch (e) { }
    }

    return { id: newUser.id, email: newUser.email, username: newUser.username };
  }

  async loginUser(email, password) {
    if (!email || !password) {
      throw new Error('Correo y contraseña son obligatorios.');
    }
    const cleanEmail = email.trim().toLowerCase();
    const hash = crypto.createHash('sha256').update(password).digest('hex');

    const users = this.getUsers();
    let user = users.find(u => u.email.toLowerCase() === cleanEmail && u.passwordHash === hash);

    // Si no está en el JSON local, consultar MongoDB Atlas
    if (!user && this.isMongoReady && this.mongoDb) {
      try {
        const mongoUser = await this.mongoDb.collection('users').findOne({ email: cleanEmail, passwordHash: hash });
        if (mongoUser) {
          user = mongoUser;
          // Guardar en copia local
          if (!users.some(u => u.email.toLowerCase() === cleanEmail)) {
            users.push(mongoUser);
            writeJSON('users.json', users);
          }
        }
      } catch (e) { }
    }

    if (!user) {
      throw new Error('Credenciales inválidas. Por favor verifica tu correo y contraseña.');
    }
    return { id: user.id, email: user.email, username: user.username };
  }
}

module.exports = new StorageService();
