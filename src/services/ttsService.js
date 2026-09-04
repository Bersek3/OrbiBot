const storage = require('./storage');

class TTSService {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.eventListeners = [];
  }

  onTTS(callback) {
    this.eventListeners.push(callback);
  }

  emitTTS(payload) {
    for (const listener of this.eventListeners) {
      try {
        listener(payload);
      } catch (err) {
        console.error('Error dispatching TTS listener:', err);
      }
    }
  }

  sanitizeText(text, config) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text.trim();

    // Limit length
    const maxLength = config.maxLength || 250;
    if (cleaned.length > maxLength) {
      cleaned = cleaned.substring(0, maxLength);
    }

    // Filter banned words
    const banned = config.bannedWords || [];
    for (const word of banned) {
      if (!word.trim()) continue;
      const regex = new RegExp(`\\b${word.trim()}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '***');
    }

    // Clean dangerous characters / script tags
    cleaned = cleaned.replace(/[<>]/g, '');

    return cleaned;
  }

  processRequest({ user, text, source = 'chat', bits = 0, voiceOverride = null }) {
    const config = storage.getConfig().tts;
    if (!config.enabled) {
      return { success: false, reason: 'TTS está deshabilitado en la configuración' };
    }

    // Verification for chat commands
    if (source === 'chat' && !config.allowChatCommand) {
      return { success: false, reason: 'El comando de chat para TTS está desactivado' };
    }

    // Verification for bits
    if (source === 'bits' && bits < (config.minBits || 0)) {
      return { success: false, reason: `Bits insuficientes para TTS (mínimo: ${config.minBits})` };
    }

    const cleanText = this.sanitizeText(text, config);
    if (!cleanText || cleanText.length < 2) {
      return { success: false, reason: 'Texto vacío o inválido' };
    }

    const ttsItem = {
      id: 'tts-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      user: user || 'Anónimo',
      text: cleanText,
      source,
      bits,
      engine: config.engine || 'webspeech',
      voice: voiceOverride || config.voice || 'es_001',
      volume: (config.volume || 90) / 100,
      rate: config.rate || 1.0,
      pitch: config.pitch || 1.0,
      audioUrl: null,
      timestamp: Date.now()
    };

    // If Google TTS engine is chosen, prepare audio URL
    if (ttsItem.engine === 'google') {
      const encoded = encodeURIComponent(cleanText);
      ttsItem.audioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=es&client=tw-ob`;
    }

    this.queue.push(ttsItem);
    this.emitTTS(ttsItem);

    return {
      success: true,
      item: ttsItem
    };
  }

  getVoices() {
    return [
      { id: 'es_001', name: 'Español Latino (Estándar)', lang: 'es-MX' },
      { id: 'es_002', name: 'Español España (Castellano)', lang: 'es-ES' },
      { id: 'es_female', name: 'Español Femenino', lang: 'es-ES' },
      { id: 'es_male', name: 'Español Masculino', lang: 'es-MX' },
      { id: 'en_001', name: 'English (US Male)', lang: 'en-US' },
      { id: 'en_002', name: 'English (US Female)', lang: 'en-US' },
      { id: 'tiktok_es', name: 'TikTok Español', lang: 'es' },
      { id: 'tiktok_ghostface', name: 'TikTok Ghostface (Voz Scream)', lang: 'en' }
    ];
  }
}

module.exports = new TTSService();
