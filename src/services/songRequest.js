const storage = require('./storage');

class SongRequestService {
  constructor() {
    this.queue = [];
    this.history = [];
    this.currentSong = null;
    this.isPlaying = false;
    this.eventListeners = [];
    this.skipVotes = new Set();
  }

  onUpdate(callback) {
    this.eventListeners.push(callback);
  }

  emitUpdate(action, data) {
    for (const listener of this.eventListeners) {
      try {
        listener({ action, data, state: this.getState() });
      } catch (err) {
        console.error('Error in songRequest listener:', err);
      }
    }
  }

  getState() {
    return {
      currentSong: this.currentSong,
      queue: this.queue,
      history: this.history.slice(-10),
      isPlaying: this.isPlaying,
      skipVotesCount: this.skipVotes.size
    };
  }

  extractVideoId(input) {
    if (!input || typeof input !== 'string') return null;
    const str = input.trim();

    // Standard YouTube Watch URL: https://www.youtube.com/watch?v=VIDEO_ID
    const watchMatch = str.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    if (watchMatch && watchMatch[1]) {
      return watchMatch[1];
    }

    // Direct 11 char ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
      return str;
    }

    return null;
  }

  async fetchVideoDetails(videoIdOrQuery) {
    const videoId = this.extractVideoId(videoIdOrQuery);

    if (videoId) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
        const res = await fetch(oembedUrl);
        if (res.ok) {
          const data = await res.json();
          return {
            videoId,
            title: data.title || 'Canción de YouTube',
            author: data.author_name || 'Artista desconocido',
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            durationSeconds: 240, // Estimated when oembed doesn't provide it
            durationFormatted: '4:00'
          };
        }
      } catch (e) {
        console.warn('oEmbed fetch error:', e.message);
      }

      return {
        videoId,
        title: `YouTube Video (${videoId})`,
        author: 'YouTube',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        durationSeconds: 210,
        durationFormatted: '3:30'
      };
    }

    // It's a text query search (e.g. "Daft Punk One More Time")
    // Use YouTube search scraping or fallback search representation
    const searchEncoded = encodeURIComponent(videoIdOrQuery);
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${searchEncoded}`;
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (res.ok) {
        const html = await res.text();
        const idMatches = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/g);
        if (idMatches && idMatches.length > 0) {
          const firstId = idMatches[0].replace('/watch?v=', '');
          return await this.fetchVideoDetails(firstId);
        }
      }
    } catch (e) {
      console.warn('Search scrape error:', e.message);
    }

    // Default fallback if search blocked
    return {
      videoId: 'dQw4w9WgXcQ',
      title: videoIdOrQuery,
      author: 'YouTube Request',
      thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      durationSeconds: 212,
      durationFormatted: '3:32'
    };
  }

  async addSong({ query, requester, isMod = false, isSub = false }) {
    const config = storage.getConfig().songRequest;
    if (!config.enabled) {
      return { success: false, message: 'El sistema de Song Request está desactivado.' };
    }

    // Check user permission level
    if (config.userLevel === 'mod' && !isMod) {
      return { success: false, message: 'Solo moderadores pueden pedir canciones.' };
    }
    if (config.userLevel === 'subs' && !isSub && !isMod) {
      return { success: false, message: 'Solo suscriptores y moderadores pueden pedir canciones.' };
    }

    // Check user limit
    const userSongsInQueue = this.queue.filter(s => s.requester.toLowerCase() === requester.toLowerCase());
    if (userSongsInQueue.length >= (config.maxPerUser || 5) && !isMod) {
      return { success: false, message: `@${requester}, ya alcanzaste tu límite de canciones en cola (${config.maxPerUser}).` };
    }

    const videoDetails = await this.fetchVideoDetails(query);
    if (!videoDetails || !videoDetails.videoId) {
      return { success: false, message: 'No se pudo encontrar o validar la canción solicitada.' };
    }

    // Check duration limit
    const maxSec = (config.maxDurationMinutes || 8) * 60;
    if (videoDetails.durationSeconds > maxSec && !isMod) {
      return { success: false, message: `La canción excede el límite máximo de ${config.maxDurationMinutes} minutos.` };
    }

    const song = {
      id: 'sr-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      videoId: videoDetails.videoId,
      title: videoDetails.title,
      author: videoDetails.author,
      thumbnail: videoDetails.thumbnail,
      durationSeconds: videoDetails.durationSeconds,
      durationFormatted: videoDetails.durationFormatted,
      requester: requester || 'Anónimo',
      requestedAt: new Date().toLocaleTimeString()
    };

    // If nothing is playing, make it current or add to queue
    if (!this.currentSong) {
      this.currentSong = song;
      this.isPlaying = true;
      this.emitUpdate('play', song);
    } else {
      this.queue.push(song);
      this.emitUpdate('queue_add', song);
    }

    return {
      success: true,
      song,
      position: this.currentSong === song ? 0 : this.queue.length,
      message: this.currentSong === song
        ? `▶️ Reproduciendo ahora: ${song.title}`
        : `🎵 Añadida a la cola en posición #${this.queue.length}: ${song.title}`
    };
  }

  skip(byUser = 'Streamer', isMod = false) {
    if (!this.currentSong) {
      return { success: false, message: 'No hay ninguna canción reproduciéndose actualmente.' };
    }

    const skippedSong = this.currentSong;
    this.history.push(skippedSong);
    this.skipVotes.clear();

    if (this.queue.length > 0) {
      this.currentSong = this.queue.shift();
      this.isPlaying = true;
      this.emitUpdate('skip', { skipped: skippedSong, current: this.currentSong });
      return {
        success: true,
        message: `⏭️ Canción saltada. Ahora suena: ${this.currentSong.title}`,
        current: this.currentSong
      };
    } else {
      this.currentSong = null;
      this.isPlaying = false;
      this.emitUpdate('stop', { skipped: skippedSong });
      return {
        success: true,
        message: '⏭️ Canción saltada. La cola está vacía.',
        current: null
      };
    }
  }

  voteSkip(username) {
    if (!this.currentSong) {
      return { success: false, message: 'No hay canciones sonando para votar.' };
    }

    this.skipVotes.add(username.toLowerCase());
    const requiredVotes = 3;

    if (this.skipVotes.size >= requiredVotes) {
      return this.skip(`Voto de la comunidad (${this.skipVotes.size}/${requiredVotes})`, true);
    }

    return {
      success: true,
      message: `🗳️ @${username} ha votado para saltar (${this.skipVotes.size}/${requiredVotes} votos necesarios).`
    };
  }

  removeSong(songId) {
    const index = this.queue.findIndex(s => s.id === songId);
    if (index !== -1) {
      const removed = this.queue.splice(index, 1)[0];
      this.emitUpdate('queue_remove', removed);
      return { success: true, song: removed };
    }
    return { success: false, message: 'Canción no encontrada en la cola.' };
  }

  clearQueue() {
    const count = this.queue.length;
    this.queue = [];
    this.emitUpdate('queue_clear', { count });
    return { success: true, count };
  }

  setCurrent(song) {
    this.currentSong = song;
    this.isPlaying = true;
    this.emitUpdate('play', song);
  }

  setPlayingState(isPlaying) {
    this.isPlaying = isPlaying;
    this.emitUpdate('state_change', { isPlaying });
  }
}

module.exports = new SongRequestService();
