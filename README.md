# ⚡ OrbiBot - Twitch Bot Suite & OBS Overlays

Plataforma todo-en-uno para streamers de Twitch con panel de control web en tiempo real, cliente IRC para chat, sistema de Song Request con reproductor integrado, Text-to-Speech (TTS) con moderación, puntos de canal y 5 widgets transparentes listos para OBS Studio.

![OrbiBot Banner](https://raw.githubusercontent.com/Bersek3/OrbiBot/main/public/assets/preview.png)

---

## 🚀 Características Principales

### 🟣 1. Conexión Directa con Twitch (OAuth 1-Clic)
- Conexión segura oficial mediante OAuth2.
- Detección automática del canal, nombre de usuario y foto de perfil oficial.
- Conexión al chat en tiempo real para leer mensajes, responder comandos y detectar eventos.

### 🎵 2. Song Request (SR) Avanzado
- Prefijo personalizable (`!sr`, `!cancion`, `!pedir`, etc.).
- Búsqueda automática de YouTube y extracción de metadatos.
- Reproductor de YouTube integrado en el panel con reproducción secuencial automática.
- Comandos de chat: `!sr <canción>`, `!song` (actual), `!skip` (saltar/votar), `!queue` (ver lista).
- Límites de duración, canciones por usuario y niveles de permisos (Todos, Subs o Mods).

### 🗣️ 3. Text-To-Speech (TTS) con Moderación
- Múltiples voces en español (Latino, Castellano, Femenino, Masculino) y voces de TikTok.
- Control de volumen, velocidad, tono y longitud máxima de mensaje.
- Censura automática de palabras prohibidas (`***`).
- Disparadores por comando de chat (`!tts`), donaciones de Bits o Puntos de Canal.
- Fuente de navegador dedicada para OBS que reproduce los audios en stream.

### 📺 4. 5 Widgets Transparentes para OBS Studio
Copia y pega la URL en una fuente de **Navegador (Browser Source)** en OBS:
1. **Alert Box**: `http://localhost:3000/overlays/alerts.html` (Followers, Subs, Bits, Raids, Puntos de canal con efectos sonoros y visuales).
2. **Now Playing**: `http://localhost:3000/overlays/nowplaying.html` (Carátula, título, solicitante y ecualizador animado).
3. **Goal Bar**: `http://localhost:3000/overlays/goals.html?type=subs` (Metas de Subs, Followers o Bits con barras de neón).
4. **TTS Audio Player**: `http://localhost:3000/overlays/tts.html` (Receptor de audio para sintetizar la voz en stream).
5. **Chat Overlay**: `http://localhost:3000/overlays/chat.html` (Chat flotante translúcido con insignias de streamer, mod y sub).

### ⭐ 5. Puntos de Canal y Comandos Personalizados
- Vincula recompensas de puntos de canal para activar TTS, pedir música o reproducir sonidos.
- Creador y gestor visual de comandos de chat (`!discord`, `!redes`, etc.) con cooldowns configurables.

---

## 📦 Instalación y Puesta en Marcha

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/Bersek3/OrbiBot.git
   cd OrbiBot
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Iniciar el servidor:**
   ```bash
   npm start
   ```

4. **Abrir el Panel de Control:**
   Accede en tu navegador a:
   👉 **http://localhost:3000**

---

## 🛠️ Tecnologías Utilizadas

- **Backend**: Node.js, Express, WebSockets (`ws`), `tmi.js` (Twitch IRC), Fetch API (Twitch Helix).
- **Frontend**: HTML5, CSS3 Glassmorphism moderno (Variables CSS, animaciones fluidas), JavaScript Vanilla reactivo.
- **APIs**: Twitch OAuth2, Twitch Helix API, YouTube IFrame API, Web Audio API, Web Speech API.

---

Desarrollado para la comunidad de streaming.
