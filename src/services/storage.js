const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_CONFIG = {
  twitch: {
    channel: '',
    botUsername: '',
    oauthToken: '',
    clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
    connected: false
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
    engine: 'webspeech', // 'webspeech', 'tiktok', 'google'
    voice: 'es_001',
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
  goals: {
    subs: { title: 'Meta de Suscriptores', current: 12, target: 50, color: '#9146ff' },
    followers: { title: 'Meta de Seguidores', current: 185, target: 300, color: '#00f2fe' },
    bits: { title: 'Meta de Bits', current: 1500, target: 5000, color: '#f5a623' }
  }
};

const DEFAULT_COMMANDS = [
  {
    id: 'cmd-1',
    name: '!discord',
    response: '¡Únete a nuestra comunidad de Discord oficial! https://discord.gg/streamer',
    enabled: true,
    cooldown: 10,
    userLevel: 'all'
  },
  {
    id: 'cmd-2',
    name: '!redes',
    response: 'Sígueme en redes sociales: Twitter @streamer | Instagram @streamer | TikTok @streamer',
    enabled: true,
    cooldown: 10,
    userLevel: 'all'
  },
  {
    id: 'cmd-3',
    name: '!comandos',
    response: 'Comandos disponibles: !sr <cancion>, !song, !skip, !queue, !redes, !discord, !bot',
    enabled: true,
    cooldown: 15,
    userLevel: 'all'
  },
  {
    id: 'cmd-4',
    name: '!bot',
    response: 'Bot de Twitch desarrollado con Antigravity para una experiencia de stream interactiva.',
    enabled: true,
    cooldown: 10,
    userLevel: 'all'
  }
];

const DEFAULT_ALERTS = {
  follower: {
    enabled: true,
    title: 'Nuevo Seguidor',
    message: '¡{user} ahora sigue el canal!',
    sound: '/assets/sounds/follow.mp3',
    duration: 6,
    image: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdWk1YW0yZXpxM3c2NHJreGQxbDduMWVvb3hpZGl2dHVqMm1pMG1jYyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/artj92V8o75VPL7AeQ/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#00f2fe'
  },
  sub: {
    enabled: true,
    title: '¡Nueva Suscripción!',
    message: '¡{user} se ha suscrito al canal! (Nivel {tier})',
    sound: '/assets/sounds/sub.mp3',
    duration: 7,
    image: 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#9146ff'
  },
  bits: {
    enabled: true,
    title: 'Donación de Bits',
    message: '¡{user} ha donado {amount} bits! {message}',
    sound: '/assets/sounds/bits.mp3',
    duration: 7,
    image: 'https://media.giphy.com/media/26FPJGjhefSJuaRhu/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#f5a623'
  },
  raid: {
    enabled: true,
    title: '¡Raid Entrante!',
    message: '¡{user} lidera una raid con {viewers} espectadores!',
    sound: '/assets/sounds/raid.mp3',
    duration: 8,
    image: 'https://media.giphy.com/media/l41lI4bYmcsPJX9Go/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#ff007f'
  },
  channel_points: {
    enabled: true,
    title: 'Puntos de Canal',
    message: '¡{user} ha canjeado {reward}!',
    sound: '/assets/sounds/points.mp3',
    duration: 6,
    image: 'https://media.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif',
    textColor: '#ffffff',
    accentColor: '#10b981'
  }
};

const DEFAULT_REWARDS = [
  {
    id: 'reward-1',
    rewardName: 'Mensaje con Voz (TTS)',
    action: 'tts',
    cost: 500,
    enabled: true
  },
  {
    id: 'reward-2',
    rewardName: 'Pedir Canción',
    action: 'song_request',
    cost: 300,
    enabled: true
  },
  {
    id: 'reward-3',
    rewardName: 'Sonido Corneta / Airhorn',
    action: 'sound',
    soundUrl: '/assets/sounds/airhorn.mp3',
    cost: 150,
    enabled: true
  }
];

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
  getConfig() {
    const cfg = readJSON('config.json', DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, ...cfg, twitch: { ...DEFAULT_CONFIG.twitch, ...(cfg.twitch || {}) }, songRequest: { ...DEFAULT_CONFIG.songRequest, ...(cfg.songRequest || {}) }, tts: { ...DEFAULT_CONFIG.tts, ...(cfg.tts || {}) }, goals: { ...DEFAULT_CONFIG.goals, ...(cfg.goals || {}) } };
  }

  saveConfig(newConfig) {
    const current = this.getConfig();
    const merged = {
      ...current,
      ...newConfig,
      twitch: { ...current.twitch, ...(newConfig.twitch || {}) },
      songRequest: { ...current.songRequest, ...(newConfig.songRequest || {}) },
      tts: { ...current.tts, ...(newConfig.tts || {}) },
      goals: { ...current.goals, ...(newConfig.goals || {}) }
    };
    writeJSON('config.json', merged);
    return merged;
  }

  getCommands() {
    return readJSON('commands.json', DEFAULT_COMMANDS);
  }

  saveCommands(commands) {
    writeJSON('commands.json', commands);
    return commands;
  }

  getAlerts() {
    const alerts = readJSON('alerts.json', DEFAULT_ALERTS);
    return { ...DEFAULT_ALERTS, ...alerts };
  }

  saveAlerts(alerts) {
    writeJSON('alerts.json', alerts);
    return alerts;
  }

  getRewards() {
    return readJSON('channel_points.json', DEFAULT_REWARDS);
  }

  saveRewards(rewards) {
    writeJSON('channel_points.json', rewards);
    return rewards;
  }
}

module.exports = new StorageService();
