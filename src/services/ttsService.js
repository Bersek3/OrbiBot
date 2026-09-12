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

  normalizeVoice(voiceId) {
    if (!voiceId) return 'es_mx_mia';
    const v = voiceId.toString().toLowerCase().trim().replace(/^[-@/]/, '').replace(/^voice:/, '');
    const aliases = {
      // Lionel Messi (Fish Audio IA)
      messi: 'es_ar_messi',
      lionel_messi: 'es_ar_messi',
      'lionel messi': 'es_ar_messi',
      'leo messi': 'es_ar_messi',
      'leo_messi': 'es_ar_messi',
      leomessi: 'es_ar_messi',
      es_ar_messi: 'es_ar_messi',

      // Direct names
      mia: 'es_mx_mia',
      miguel: 'es_us_miguel',
      lupe: 'es_us_lupe',
      penelope: 'es_us_penelope',
      penélope: 'es_us_penelope',
      enrique: 'es_es_enrique',
      conchita: 'es_es_conchita',
      lucia: 'es_es_lucia',
      lucía: 'es_es_lucia',
      brian: 'en_brian',
      emma: 'en_emma',
      joey: 'en_joey',
      matthew: 'en_matthew',
      kendra: 'en_kendra',
      justin: 'en_justin',
      russell: 'en_russell',
      cristiano: 'pt_cristiano',
      mathieu: 'fr_mathieu',
      giorgio: 'it_giorgio',
      hans: 'de_hans',
      takumi: 'ja_takumi',
      mizuki: 'ja_mizuki',

      // Legacy & IDs
      es_mx_mia: 'es_mx_mia',
      es_us_miguel: 'es_us_miguel',
      es_us_lupe: 'es_us_lupe',
      es_us_penelope: 'es_us_penelope',
      es_es_enrique: 'es_es_enrique',
      es_es_conchita: 'es_es_conchita',
      es_es_lucia: 'es_es_lucia',
      en_brian: 'en_brian',
      en_emma: 'en_emma',
      en_joey: 'en_joey',
      en_matthew: 'en_matthew',
      en_kendra: 'en_kendra',
      en_justin: 'en_justin',
      en_russell: 'en_russell',
      pt_cristiano: 'pt_cristiano',
      fr_mathieu: 'fr_mathieu',
      it_giorgio: 'it_giorgio',
      de_hans: 'de_hans',
      ja_takumi: 'ja_takumi',
      ja_mizuki: 'ja_mizuki',
      es_001: 'es_mx_mia',
      es_female: 'es_mx_mia',
      es_male: 'es_us_miguel',
      es_002: 'es_es_conchita',
      'es-es-standard-a': 'es_es_enrique',
      en_001: 'en_brian',
      en_002: 'en_emma'
    };
    return aliases[v] || v;
  }

  getStreamElementsVoiceName(voiceId) {
    const normalized = this.normalizeVoice(voiceId);
    const map = {
      es_ar_messi: 'Mia',
      es_mx_mia: 'Mia',
      es_us_miguel: 'Miguel',
      es_us_lupe: 'Lupe',
      es_us_penelope: 'Penelope',
      es_es_enrique: 'Enrique',
      es_es_conchita: 'Conchita',
      es_es_lucia: 'Lucia',
      en_brian: 'Brian',
      en_emma: 'Emma',
      en_joey: 'Joey',
      en_matthew: 'Matthew',
      en_kendra: 'Kendra',
      en_justin: 'Justin',
      en_russell: 'Russell',
      pt_cristiano: 'Cristiano',
      fr_mathieu: 'Mathieu',
      it_giorgio: 'Giorgio',
      de_hans: 'Hans',
      ja_takumi: 'Takumi',
      ja_mizuki: 'Mizuki'
    };
    return map[normalized] || 'Mia';
  }

  generateAudioUrl(text, voiceId = 'es_mx_mia') {
    const encoded = encodeURIComponent(text);
    const normalized = this.normalizeVoice(voiceId);
    if (normalized === 'es_ar_messi') {
      return `/api/tts/audio?text=${encoded}&voice=es_ar_messi`;
    }
    const lang = (normalized.split('_')[0] || 'es').toLowerCase();
    return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
  }

  processRequest({ user, text, source = 'chat', bits = 0, voiceOverride = null, channel = null }) {
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

    let rawText = (text || '').trim();
    let selectedVoice = voiceOverride || this.normalizeVoice(config.voice) || 'es_mx_mia';

    // Detección automática de voz en el comando de chat (ej: "!tts messi Hola muchachos" o "!tts miguel Hola streamer")
    if (source === 'chat' && rawText) {
      const parts = rawText.split(/\s+/);
      const possibleVoiceToken = parts[0].toLowerCase().replace(/^[-@/]/, '').replace(/^voice:/, '');
      const detectedVoice = this.normalizeVoice(possibleVoiceToken);
      if (detectedVoice && (detectedVoice === 'es_ar_messi' || detectedVoice.startsWith('es_') || detectedVoice.startsWith('en_') || detectedVoice.startsWith('pt_') || detectedVoice.startsWith('fr_') || detectedVoice.startsWith('it_') || detectedVoice.startsWith('de_') || detectedVoice.startsWith('ja_'))) {
        if (parts.length > 1) {
          selectedVoice = detectedVoice;
          rawText = parts.slice(1).join(' ');
        }
      }
    }

    const cleanText = this.sanitizeText(rawText, config);
    if (!cleanText || cleanText.length < 2) {
      return { success: false, reason: 'Texto vacío o inválido' };
    }

    const audioUrl = this.generateAudioUrl(cleanText, selectedVoice);
    const fallbackUrl = selectedVoice === 'es_ar_messi'
      ? `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=es-AR&client=tw-ob`
      : audioUrl;

    const cleanChannel = channel ? channel.toLowerCase().replace(/^#/, '').trim() : null;
    const ttsItem = {
      id: 'tts-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      channel: cleanChannel,
      room: cleanChannel,
      user: user || 'Anónimo',
      text: cleanText,
      source,
      bits,
      engine: selectedVoice === 'es_ar_messi' ? 'fish_audio' : 'audio_stream',
      voice: selectedVoice,
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
      { id: 'es_ar_messi', name: '⭐ Lionel Messi - IA Fish Audio 🇦🇷', lang: 'es-AR', isAI: true, referenceId: 'e3ded66586764591a457fcdaba8a268b' },
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
