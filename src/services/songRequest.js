const storage = require('./storage');

class SongRequestService {
  constructor() {
    this.sessions = new Map();
    this.eventListeners = [];
  }

  getSession(channelOrUser = 'default') {
    const key = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        queue: [],
        history: [],
        currentSong: null,
        isPlaying: false,
        skipVotes: new Set()
      });
    }
    return this.sessions.get(key);
  }

  onUpdate(callback) {
    this.eventListeners.push(callback);
  }

  emitUpdate(action, data, channelOrUser = 'default') {
    const key = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const state = this.getState(key);
    for (const listener of this.eventListeners) {
      try {
        listener({ action, data, channel: key, streamer: key, state });
      } catch (err) {
        console.error('Error in songRequest listener:', err);
      }
    }
  }

  getState(channelOrUser = 'default') {
    const session = this.getSession(channelOrUser);
    return {
      channel: (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default',
      currentSong: session.currentSong,
      queue: session.queue,
      history: session.history.slice(-10),
      isPlaying: session.isPlaying,
      skipVotesCount: session.skipVotes.size
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
            durationSeconds: 240,
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

    // Text search scraping
    const searchEncoded = encodeURIComponent(videoIdOrQuery);
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${searchEncoded}`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        }
      });
      if (res.ok) {
        const html = await res.text();
        const jsonMatches = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
        let foundId = null;
        if (jsonMatches && jsonMatches.length > 0) {
          for (const m of jsonMatches) {
            const clean = m.replace(/"videoId":"|"/g, '');
            if (clean && clean.length === 11) {
              foundId = clean;
              break;
            }
          }
        }

        if (!foundId) {
          const idMatches = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/g);
          if (idMatches && idMatches.length > 0) {
            foundId = idMatches[0].replace('/watch?v=', '');
          }
        }

        if (foundId) {
          return await this.fetchVideoDetails(foundId);
        }
      }
    } catch (e) {
      console.warn('Search scrape error:', e.message);
    }

    return null;
  }

  async addSong({ channel = 'default', query, requester, isMod = false, isSub = false, isPriority = false }) {
    const cleanChan = (channel || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const session = this.getSession(cleanChan);

    let config = { enabled: true, userLevel: 'all', maxPerUser: 5, maxDurationMinutes: 8 };
    try {
      const storedCfg = storage.getConfig();
      if (storedCfg && storedCfg.songRequest) config = storedCfg.songRequest;
    } catch(e) {}

    if (config.enabled === false) {
      return { success: false, message: 'El sistema de Song Request está desactivado.' };
    }

    const cleanQuery = (query || '').trim();
    if (!cleanQuery) {
      return { success: false, message: 'Debes indicar el nombre o enlace de una canción.' };
    }

    // Check user permission level (bypassed if priority/channel points)
    if (!isPriority) {
      if (config.userLevel === 'mod' && !isMod) {
        return { success: false, message: 'Solo moderadores pueden pedir canciones.' };
      }
      if (config.userLevel === 'subs' && !isSub && !isMod) {
        return { success: false, message: 'Solo suscriptores y moderadores pueden pedir canciones.' };
      }

      const userSongsInQueue = session.queue.filter(s => s.requester && s.requester.toLowerCase() === (requester || '').toLowerCase());
      if (userSongsInQueue.length >= (config.maxPerUser || 5) && !isMod) {
        return { success: false, message: `@${requester}, ya alcanzaste tu límite de canciones en cola (${config.maxPerUser}).` };
      }
    }

    const videoDetails = await this.fetchVideoDetails(cleanQuery);
    if (!videoDetails || !videoDetails.videoId) {
      return { success: false, message: `No se pudo encontrar la canción "${cleanQuery}" en YouTube.` };
    }

    const maxSec = (config.maxDurationMinutes || 8) * 60;
    if (videoDetails.durationSeconds > maxSec && !isMod && !isPriority) {
      return { success: false, message: `La canción excede el límite máximo de ${config.maxDurationMinutes} minutos.` };
    }

    const song = {
      id: 'sr-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      channel: cleanChan,
      videoId: videoDetails.videoId,
      title: videoDetails.title,
      author: videoDetails.author,
      thumbnail: videoDetails.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&auto=format&fit=crop&q=80',
      durationSeconds: videoDetails.durationSeconds,
      durationFormatted: videoDetails.durationFormatted,
      requester: requester || 'Anónimo',
      isPriority: !!isPriority,
      requestedAt: new Date().toLocaleTimeString()
    };

    if (!session.currentSong) {
      session.currentSong = song;
      session.isPlaying = true;
      this.emitUpdate('play', song, cleanChan);
    } else if (isPriority) {
      const lastPriorityIdx = session.queue.map(s => !!s.isPriority).lastIndexOf(true);
      if (lastPriorityIdx === -1) {
        session.queue.unshift(song);
      } else {
        session.queue.splice(lastPriorityIdx + 1, 0, song);
      }
      this.emitUpdate('queue_add', song, cleanChan);
    } else {
      session.queue.push(song);
      this.emitUpdate('queue_add', song, cleanChan);
    }

    const position = session.currentSong === song ? 0 : (session.queue.indexOf(song) + 1);
    return {
      success: true,
      song,
      position,
      message: session.currentSong === song
        ? `▶️ Reproduciendo ahora: ${song.title}`
        : (isPriority
            ? `🌟 [PRIORIDAD VIP] Próxima en sonar (Puesto #${position} en cola): ${song.title}`
            : `🎵 Añadida a la cola en posición #${position}: ${song.title}`)
    };
  }

  skip(channelOrUser = 'default', byUser = 'Streamer', isMod = false) {
    const cleanChan = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const session = this.getSession(cleanChan);

    if (!session.currentSong) {
      return { success: false, message: 'No hay ninguna canción reproduciéndose actualmente.' };
    }

    const skippedSong = session.currentSong;
    session.history.push(skippedSong);
    session.skipVotes.clear();

    if (session.queue.length > 0) {
      session.currentSong = session.queue.shift();
      session.isPlaying = true;
      this.emitUpdate('skip', { skipped: skippedSong, current: session.currentSong }, cleanChan);
      return {
        success: true,
        message: `⏭️ Canción saltada. Ahora suena: ${session.currentSong.title}`,
        current: session.currentSong
      };
    } else {
      session.currentSong = null;
      session.isPlaying = false;
      this.emitUpdate('stop', { skipped: skippedSong }, cleanChan);
      return {
        success: true,
        message: '⏭️ Canción saltada. La cola está vacía.',
        current: null
      };
    }
  }

  voteSkip(channelOrUser = 'default', username = 'viewer') {
    const cleanChan = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const session = this.getSession(cleanChan);

    if (!session.currentSong) {
      return { success: false, message: 'No hay canciones sonando para votar.' };
    }

    session.skipVotes.add((username || '').toLowerCase());
    const requiredVotes = 3;

    if (session.skipVotes.size >= requiredVotes) {
      return this.skip(cleanChan, `Voto de la comunidad (${session.skipVotes.size}/${requiredVotes})`, true);
    }

    return {
      success: true,
      message: `🗳️ @${username} ha votado para saltar (${session.skipVotes.size}/${requiredVotes} votos necesarios).`
    };
  }

  removeSong(channelOrUser = 'default', songId) {
    const cleanChan = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const session = this.getSession(cleanChan);

    const index = session.queue.findIndex(s => s.id === songId);
    if (index !== -1) {
      const removed = session.queue.splice(index, 1)[0];
      this.emitUpdate('queue_remove', removed, cleanChan);
      return { success: true, song: removed };
    }
    return { success: false, message: 'Canción no encontrada en la cola.' };
  }

  clearQueue(channelOrUser = 'default') {
    const cleanChan = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const session = this.getSession(cleanChan);

    const count = session.queue.length;
    session.queue = [];
    this.emitUpdate('queue_clear', { count }, cleanChan);
    return { success: true, count };
  }

  setCurrent(channelOrUser = 'default', song) {
    const cleanChan = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const session = this.getSession(cleanChan);

    session.currentSong = song;
    session.isPlaying = true;
    this.emitUpdate('play', song, cleanChan);
  }

  setPlayingState(channelOrUser = 'default', isPlaying) {
    const cleanChan = (channelOrUser || 'default').toLowerCase().replace(/^#/, '').trim() || 'default';
    const session = this.getSession(cleanChan);

    session.isPlaying = isPlaying;
    this.emitUpdate('state_change', { isPlaying }, cleanChan);
  }
}

module.exports = new SongRequestService();
