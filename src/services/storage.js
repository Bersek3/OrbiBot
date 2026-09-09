const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

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
    this._streamerId = null; // Cache del streamer_id activo
    this.restoreAudioFiles(this.getCustomSounds());
    this.initSupabase();
  }

  /**
   * Restaura archivos físicos de audio en public/assets/sounds/custom/
   * si están guardados en base64 dentro de custom_sounds.json o Supabase.
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
        if (rawData && typeof rawData === 'string' && rawData.includes(';base64,')) {
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
   * Obtiene el streamer_id actual basándose en el canal de Twitch configurado.
   * Si no hay canal configurado, retorna 'default'.
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
    console.log(`🔑 [Storage] Streamer ID establecido: "${this._streamerId}"`);
  }

  initSupabase() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        this.supabase = createClient(supabaseUrl, supabaseKey, {
          auth: { persistSession: false }
        });
        console.log('🟢 [Supabase] Cliente inicializado correctamente.');
        this.syncFromSupabase();
      } catch (err) {
        console.warn('⚠️ [Supabase] Error al inicializar cliente:', err.message);
      }
    } else {
      console.log('ℹ️ [Storage] Supabase no configurado. Utilizando almacenamiento local JSON.');
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
        // Si la tabla no tiene la columna streamer_id aún, intentar lectura legacy
        if (error.message && error.message.includes('streamer_id')) {
          console.warn('⚠️ [Supabase] La tabla aún no tiene columna "streamer_id". Ejecuta supabase_migration.sql para actualizar.');
          return this.syncFromSupabaseLegacy();
        }
        console.warn('⚠️ [Supabase] Error al sincronizar:', error.message);
        return;
      }

      if (data && data.length > 0) {
        this.isSupabaseReady = true;
        console.log(`✅ [Supabase] ${data.length} configuraciones sincronizadas para streamer "${streamerId}".`);
        data.forEach(item => {
          if (item.key === 'config') writeJSON('config.json', item.value);
          if (item.key === 'commands') writeJSON('commands.json', item.value);
          if (item.key === 'alerts') writeJSON('alerts.json', item.value);
          if (item.key === 'channel_points') writeJSON('channel_points.json', item.value);
          if (item.key === 'goals') writeJSON('goals.json', item.value);
          if (item.key === 'custom_sounds') {
            writeJSON('custom_sounds.json', item.value);
            this.restoreAudioFiles(item.value);
          }
        });
      } else {
        this.isSupabaseReady = true;
        // Verificar si hay datos en 'default' que podríamos migrar
        if (streamerId !== 'default') {
          const migrated = await this.migrateFromDefault(streamerId);
          if (migrated) return;
        }
        // Solo respaldar lo que ya existe localmente, sin sobreescribir con valores duros
        const currentCustomSounds = this.getCustomSounds();
        if (currentCustomSounds && currentCustomSounds.length > 0) {
          await this.syncToSupabase('custom_sounds', currentCustomSounds);
        }
        const currentRewards = this.getRewards();
        if (currentRewards && currentRewards.length > 0) {
          await this.syncToSupabase('channel_points', currentRewards);
        }
        const currentGoals = this.getGoals();
        if (currentGoals && currentGoals.length > 0) {
          await this.syncToSupabase('goals', currentGoals);
        }
        const currentCommands = this.getCommands();
        if (currentCommands && currentCommands.length > 0) {
          await this.syncToSupabase('commands', currentCommands);
        }
      }
    } catch (err) {
      console.warn('⚠️ [Supabase] Error durante la sincronización inicial:', err.message);
    }
  }

  /**
   * Fallback: lee datos del esquema anterior (sin streamer_id) para compatibilidad.
   */
  async syncFromSupabaseLegacy() {
    if (!this.supabase) return;
    try {
      const { data, error } = await this.supabase
        .from('orbibot_settings')
        .select('*');

      if (error) {
        console.warn('⚠️ [Supabase] Nota: La tabla "orbibot_settings" no existe o requiere creación.');
        return;
      }

      if (data && data.length > 0) {
        this.isSupabaseReady = true;
        console.log(`✅ [Supabase] ${data.length} configuraciones sincronizadas (modo legacy).`);
        data.forEach(item => {
          if (item.key === 'config') writeJSON('config.json', item.value);
          if (item.key === 'commands') writeJSON('commands.json', item.value);
          if (item.key === 'alerts') writeJSON('alerts.json', item.value);
          if (item.key === 'channel_points') writeJSON('channel_points.json', item.value);
          if (item.key === 'goals') writeJSON('goals.json', item.value);
          if (item.key === 'custom_sounds') {
            writeJSON('custom_sounds.json', item.value);
            this.restoreAudioFiles(item.value);
          }
        });
      }
    } catch (err) {
      console.warn('⚠️ [Supabase] Error en sincronización legacy:', err.message);
    }
  }

  /**
   * Migra datos del streamer_id 'default' al streamer_id real cuando se autentica.
   */
  async migrateFromDefault(newStreamerId) {
    if (!this.supabase) return false;
    try {
      const { data } = await this.supabase
        .from('orbibot_settings')
        .select('*')
        .eq('streamer_id', 'default');

      if (data && data.length > 0) {
        console.log(`🔄 [Supabase] Migrando ${data.length} registros de "default" a "${newStreamerId}"...`);
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
        console.log(`✅ [Supabase] Migración completada: "default" → "${newStreamerId}".`);
        return true;
      }
    } catch (e) {
      console.warn('⚠️ [Supabase] Error en migración:', e.message);
    }
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
        // Si falla por columna faltante, intentar modo legacy
        if (error.message && error.message.includes('streamer_id')) {
          return this.syncToSupabaseLegacy(key, value);
        }
        if (error.code !== 'PGRST205') {
          console.warn(`⚠️ [Supabase] Error al guardar "${key}" para "${streamerId}":`, error.message);
        }
      } else {
        this.isSupabaseReady = true;
      }
    } catch (err) {
      // Ignorar errores de conexión transitorios
    }
  }

  /**
   * Fallback: guarda sin streamer_id para compatibilidad con esquema anterior.
   */
  async syncToSupabaseLegacy(key, value) {
    if (!this.supabase) return;
    try {
      const { error } = await this.supabase
        .from('orbibot_settings')
        .upsert({
          key,
          value,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

      if (error && error.code !== 'PGRST205') {
        console.warn(`⚠️ [Supabase] Error en guardado legacy "${key}":`, error.message);
      } else {
        this.isSupabaseReady = true;
      }
    } catch (err) {
      // Ignorar errores transitorios
    }
  }

  /**
   * Re-sincroniza toda la data desde Supabase para el streamer actual.
   * Llamar después de cambiar el streamer_id (ej: después de autenticación Twitch).
   */
  async resyncForStreamer(streamerId) {
    this.setStreamerId(streamerId);
    await this.syncFromSupabase();
  }

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
      this.syncToSupabase('config', merged);
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
    this.syncToSupabase('config', cfg);
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

    // Actualizar streamer_id cache si cambió el canal de Twitch
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
    this.syncToSupabase('config', merged);
    return merged;
  }

  getCommands() {
    return readJSON('commands.json', DEFAULT_COMMANDS);
  }

  saveCommands(commands) {
    writeJSON('commands.json', commands);
    this.syncToSupabase('commands', commands);
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
    this.syncToSupabase('alerts', merged);
    return merged;
  }

  getRewards() {
    return readJSON('channel_points.json', []);
  }

  saveRewards(rewards) {
    writeJSON('channel_points.json', rewards || []);
    this.syncToSupabase('channel_points', rewards || []);
    return rewards || [];
  }

  getGoals() {
    const goals = readJSON('goals.json', null);
    if (Array.isArray(goals)) {
      return goals;
    }
    // Si goals.json aún no existe, leer de config.json o retornar array vacío
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
    this.syncToSupabase('goals', list);
    return list;
  }

  getCustomSounds() {
    return readJSON('custom_sounds.json', []);
  }

  saveCustomSounds(sounds) {
    writeJSON('custom_sounds.json', sounds || []);
    this.restoreAudioFiles(sounds);
    this.syncToSupabase('custom_sounds', sounds || []);
    return sounds || [];
  }

  getUsers() {
    return readJSON('users.json', []);
  }

  registerUser(email, password) {
    if (!email || !password) {
      throw new Error('Correo y contraseña son obligatorios.');
    }
    const cleanEmail = email.trim().toLowerCase();
    const users = this.getUsers();
    const existing = users.find(u => u.email.toLowerCase() === cleanEmail);
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
    users.push(newUser);
    writeJSON('users.json', users);
    return { id: newUser.id, email: newUser.email, username: newUser.username };
  }

  loginUser(email, password) {
    if (!email || !password) {
      throw new Error('Correo y contraseña son obligatorios.');
    }
    const cleanEmail = email.trim().toLowerCase();
    const users = this.getUsers();
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const user = users.find(u => u.email.toLowerCase() === cleanEmail && u.passwordHash === hash);
    if (!user) {
      throw new Error('Credenciales inválidas. Por favor verifica tu correo y contraseña.');
    }
    return { id: user.id, email: user.email, username: user.username };
  }
}

module.exports = new StorageService();

