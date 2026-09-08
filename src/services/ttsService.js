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

  generateAudioUrl(text, voiceId = 'es_mx_mia') {
    const encoded = encodeURIComponent(text);
    const seVoices = {
      // Español Latino
      es_mx_mia: 'Mia',
      es_us_miguel: 'Miguel',
      es_us_lupe: 'Lupe',
      es_us_penelope: 'Penelope',
      es_001: 'Mia',
      es_female: 'Mia',
      es_male: 'Miguel',
      tiktok_es: 'Mia',

      // Español España / Castellano
      es_es_enrique: 'Enrique',
      es_es_conchita: 'Conchita',
      es_es_lucia: 'Lucia',
      es_002: 'Conchita',

      // English
      en_brian: 'Brian',
      en_emma: 'Emma',
      en_joey: 'Joey',
      en_matthew: 'Matthew',
      en_kendra: 'Kendra',
      en_justin: 'Justin',
      en_russell: 'Russell',
      en_001: 'Brian',
      en_002: 'Emma',
      tiktok_ghostface: 'Brian',

      // Internacionales
      pt_cristiano: 'Cristiano',
      fr_mathieu: 'Mathieu',
      it_giorgio: 'Giorgio',
      de_hans: 'Hans',
      ja_takumi: 'Takumi',
      ja_mizuki: 'Mizuki'
    };

    const seVoice = seVoices[voiceId] || seVoices[voiceId.toLowerCase()] || 'Mia';
    return `https://api.streamelements.com/kappa/v2/speech?voice=${seVoice}&text=${encoded}`;
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

    const voice = voiceOverride || config.voice || 'es_mx_mia';
    const audioUrl = this.generateAudioUrl(cleanText, voice);
    const fallbackUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=es&client=tw-ob`;

    const ttsItem = {
      id: 'tts-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      user: user || 'Anónimo',
      text: cleanText,
      source,
      bits,
      engine: 'audio_stream',
      voice,
      volume: (config.volume || 90) / 100,
      rate: config.rate || 1.0,
      pitch: config.pitch || 1.0,
      audioUrl,
      fallbackUrl,
      timestamp: Date.now()
    };

    this.queue.push(ttsItem);
    this.emitTTS(ttsItem);

    return {
      success: true,
      item: ttsItem
    };
  }

  getVoices() {
    return [
      { id: 'es_mx_mia', name: 'Mia - Español Latino (Femenino)', lang: 'es-MX' },
      { id: 'es_us_miguel', name: 'Miguel - Español Latino (Masculino)', lang: 'es-US' },
      { id: 'es_us_lupe', name: 'Lupe - Español US (Femenino)', lang: 'es-US' },
      { id: 'es_us_penelope', name: 'Penélope - Español Neutro (Femenino)', lang: 'es-US' },
      { id: 'es_es_enrique', name: 'Enrique - Castellano (Masculino Pro)', lang: 'es-ES' },
      { id: 'es_es_conchita', name: 'Conchita - Castellano (Femenino Pro)', lang: 'es-ES' },
      { id: 'es_es_lucia', name: 'Lucía - Castellano (Natural)', lang: 'es-ES' },
      { id: 'en_brian', name: 'Brian - English UK (Voz Meme / Classic)', lang: 'en-GB' },
      { id: 'en_emma', name: 'Emma - English UK (Femenino)', lang: 'en-GB' },
      { id: 'en_joey', name: 'Joey - English US (Masculino)', lang: 'en-US' },
      { id: 'en_matthew', name: 'Matthew - English US (Masculino)', lang: 'en-US' },
      { id: 'en_kendra', name: 'Kendra - English US (Femenino)', lang: 'en-US' },
      { id: 'en_justin', name: 'Justin - English US (Joven)', lang: 'en-US' },
      { id: 'en_russell', name: 'Russell - English Australia', lang: 'en-AU' },
      { id: 'pt_cristiano', name: 'Cristiano - Português', lang: 'pt-BR' },
      { id: 'fr_mathieu', name: 'Mathieu - Français', lang: 'fr-FR' },
      { id: 'it_giorgio', name: 'Giorgio - Italiano', lang: 'it-IT' },
      { id: 'de_hans', name: 'Hans - Deutsch', lang: 'de-DE' },
      { id: 'ja_takumi', name: 'Takumi - 日本語 (Japonés Anime)', lang: 'ja-JP' },
      { id: 'ja_mizuki', name: 'Mizuki - 日本語 (Japonés Femenino)', lang: 'ja-JP' }
    ];
  }
}

module.exports = new TTSService();
