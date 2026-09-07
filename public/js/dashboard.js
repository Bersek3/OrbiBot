/**
 * Twitch StreamBot & Overlay Toolkit - Dashboard Logic
 */

let appConfig = null;
let ytPlayer = null;
let ytApiReady = false;
let socket = null;

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', async () => {
  initSupabaseAuth();
  initLandingPage();
  setupNavigation();
  setupRangeInputs();
  setupEventListeners();
  setupAutoSaveListeners();
  populateWidgetUrls();
  await loadInitialData();
  populateWidgetUrls();
  connectWebSocket();
  initDashboardMqtt();
  updatePlatformLinkingUI();
});

// ================= SUPABASE AUTH & CONFIGURATION =================
const SUPABASE_URL = 'https://pzrlfuzjkwkrnmqkoaue.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_L6kzW0ZtGyfl6mvKevDX0Q_6G0DCGDP';
let supabaseClient = null;

function initSupabaseAuth() {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    try {
      supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      console.log('🟢 [Supabase Client] Inicializado en el frontend.');

      // 1. Escuchar cambios de autenticación (ej: regreso exitoso de Google OAuth)
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        console.log('🔐 [Supabase Auth Event]:', event, session?.user?.email);
        if (session && session.user) {
          const userObj = {
            id: session.user.id,
            email: session.user.email,
            username: session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email.split('@')[0],
            avatar: session.user.user_metadata?.avatar_url || session.user.user_metadata?.picture || '',
            provider: session.user.app_metadata?.provider || 'supabase',
            loggedInAt: Date.now()
          };
          setUserSession(userObj);
          closeAuthModal();
          updatePlatformLinkingUI();
        } else if (event === 'SIGNED_OUT') {
          clearUserSession();
        }
      });

      // 2. Verificar sesión actual al cargar
      supabaseClient.auth.getSession().then(({ data: { session } }) => {
        if (session && session.user) {
          const userObj = {
            id: session.user.id,
            email: session.user.email,
            username: session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email.split('@')[0],
            avatar: session.user.user_metadata?.avatar_url || session.user.user_metadata?.picture || '',
            provider: session.user.app_metadata?.provider || 'supabase',
            loggedInAt: Date.now()
          };
          setUserSession(userObj);
          updatePlatformLinkingUI();
        }
      });
    } catch (e) {
      console.warn('⚠️ [Supabase Client] Error al inicializar:', e);
    }
  }
}

// ================= USER AUTHENTICATION & SESSION MANAGEMENT =================
function getUserSession() {
  try {
    const raw = localStorage.getItem('orbibot_user_session');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setUserSession(user) {
  try {
    localStorage.setItem('orbibot_user_session', JSON.stringify(user));
    updateAuthUI();
  } catch (e) {
    console.error('Error saving user session:', e);
  }
}

function clearUserSession() {
  localStorage.removeItem('orbibot_user_session');
  updateAuthUI();
}

function updateAuthUI() {
  const session = getUserSession();
  const authAccountPill = document.getElementById('authAccountPill');
  const authAccountEmail = document.getElementById('authAccountEmail');

  if (session && session.email) {
    if (authAccountPill) authAccountPill.style.display = 'inline-flex';
    if (authAccountEmail) authAccountEmail.textContent = session.email;
  } else {
    if (authAccountPill) authAccountPill.style.display = 'none';
  }
}

// Open Auth Modal
function openAuthModal(initialTab = 'login') {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  
  // Clear any existing alert
  const alertBox = document.getElementById('authAlertBox');
  if (alertBox) {
    alertBox.style.display = 'none';
    alertBox.innerHTML = '';
  }

  modal.style.display = 'flex';
  switchAuthTab(initialTab);
  
  // Close when clicking overlay backdrop
  modal.onclick = function(e) {
    if (e.target === modal) {
      closeAuthModal();
    }
  };
}

// Close Auth Modal
function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.style.display = 'none';
}

// Switch between Login and Register Tabs
function switchAuthTab(tab) {
  const loginBtn = document.getElementById('authTabLoginBtn');
  const registerBtn = document.getElementById('authTabRegisterBtn');
  const loginForm = document.getElementById('authLoginForm');
  const registerForm = document.getElementById('authRegisterForm');
  const mainTitle = document.getElementById('authModalMainTitle');
  const subtitle = document.getElementById('authModalSubtitle');
  const alertBox = document.getElementById('authAlertBox');

  if (alertBox) {
    alertBox.style.display = 'none';
    alertBox.innerHTML = '';
  }

  if (tab === 'register') {
    if (loginBtn) loginBtn.classList.remove('active');
    if (registerBtn) registerBtn.classList.add('active');
    if (loginForm) loginForm.style.display = 'none';
    if (registerForm) registerForm.style.display = 'flex';
    if (mainTitle) mainTitle.textContent = 'Crear Cuenta';
    if (subtitle) subtitle.textContent = 'Crea tu cuenta gratis en Supabase para acceder al panel.';
    const emailInput = document.getElementById('authRegEmail');
    if (emailInput) setTimeout(() => emailInput.focus(), 50);
  } else {
    if (registerBtn) registerBtn.classList.remove('active');
    if (loginBtn) loginBtn.classList.add('active');
    if (registerForm) registerForm.style.display = 'none';
    if (loginForm) loginForm.style.display = 'flex';
    if (mainTitle) mainTitle.textContent = 'Iniciar Sesión';
    if (subtitle) subtitle.textContent = 'Accede a tu panel de control, widgets y overlays en la nube.';
    const emailInput = document.getElementById('authLoginEmail');
    if (emailInput) setTimeout(() => emailInput.focus(), 50);
  }
}

// Show alert message in Auth Modal
function showAuthAlert(type, message) {
  const alertBox = document.getElementById('authAlertBox');
  if (!alertBox) return;
  alertBox.className = `auth-alert-box ${type}`;
  alertBox.innerHTML = (type === 'error' ? '⚠️ ' : (type === 'info' ? 'ℹ️ ' : '✅ ')) + message;
  alertBox.style.display = 'block';
}

// Google Sign-In with Supabase
async function signInWithGoogle() {
  showAuthAlert('info', 'Redirigiendo a Google OAuth...');
  if (!supabaseClient) {
    initSupabaseAuth();
  }
  if (!supabaseClient) {
    showAuthAlert('error', 'El cliente de Supabase no está listo. Verifica tu conexión.');
    return;
  }

  try {
    const cleanOrigin = window.location.origin;
    const cleanPath = window.location.pathname.replace(/\/index\.html$/i, '').replace(/\/$/, '');
    const redirectUrl = `${cleanOrigin}${cleanPath}/`;

    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl
      }
    });

    if (error) {
      throw error;
    }
  } catch (err) {
    console.error('Error al conectar con Google:', err);
    showAuthAlert('error', 'Error con Google OAuth: ' + (err.message || 'Verifica la configuración del proveedor Google en Supabase.'));
  }
}

// Handler for when user clicks "Panel de Control"
function handleDashboardNavClick(targetTab = 'tab-dashboard') {
  const session = getUserSession();
  if (session && session.email) {
    // User already authenticated -> direct access to dashboard
    showDashboardView(targetTab);
  } else {
    // User not authenticated -> open login modal
    openAuthModal('login');
  }
}

// Handle Register Form Submission with Supabase
async function handleAuthRegisterSubmit(event) {
  event.preventDefault();
  const emailInput = document.getElementById('authRegEmail');
  const emailConfirmInput = document.getElementById('authRegEmailConfirm');
  const passwordInput = document.getElementById('authRegPassword');
  const passwordConfirmInput = document.getElementById('authRegPasswordConfirm');
  const submitBtn = document.getElementById('authRegSubmitBtn');

  const email = emailInput ? emailInput.value.trim() : '';
  const emailConfirm = emailConfirmInput ? emailConfirmInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';
  const passwordConfirm = passwordConfirmInput ? passwordConfirmInput.value : '';

  // 1. Validate fields presence
  if (!email || !emailConfirm || !password || !passwordConfirm) {
    showAuthAlert('error', 'Por favor completa todos los campos del formulario.');
    return;
  }

  // 2. Validate Email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    showAuthAlert('error', 'Por favor ingresa un correo electrónico válido.');
    return;
  }

  // 3. Validate Email Double Matching (2 veces)
  if (email.toLowerCase() !== emailConfirm.toLowerCase()) {
    showAuthAlert('error', 'Los correos electrónicos ingresados no coinciden. Por favor verifícalos.');
    if (emailConfirmInput) emailConfirmInput.focus();
    return;
  }

  // 4. Validate Password length
  if (password.length < 6) {
    showAuthAlert('error', 'La contraseña debe tener un mínimo de 6 caracteres.');
    if (passwordInput) passwordInput.focus();
    return;
  }

  // 5. Validate Password Double Matching (2 veces)
  if (password !== passwordConfirm) {
    showAuthAlert('error', 'Las contraseñas ingresadas no coinciden. Por favor verifícalas.');
    if (passwordConfirmInput) passwordConfirmInput.focus();
    return;
  }

  // Disable button and show spinner
  if (submitBtn) {
    submitBtn.disabled = true;
    const spinner = submitBtn.querySelector('.auth-btn-spinner');
    if (spinner) spinner.style.display = 'inline-block';
  }

  try {
    if (supabaseClient) {
      const { data, error } = await supabaseClient.auth.signUp({
        email: email.toLowerCase(),
        password: password
      });

      if (error) {
        const msg = error.message.toLowerCase();
        if (msg.includes('already') || msg.includes('exists') || msg.includes('registered') || msg.includes('identity')) {
          throw new Error('Este correo ya está registrado (posiblemente iniciado con Google). Por favor inicia sesión con Google o usa tu contraseña.');
        }
        throw error;
      }

      // Check if identities are empty (Supabase returns empty identities array when user already exists)
      if (data?.user?.identities && data.user.identities.length === 0) {
        throw new Error('Este correo ya se encuentra registrado (iniciado previamente con Google o contraseña). Por favor inicia sesión.');
      }

      // Reset register form
      if (emailInput) emailInput.value = '';
      if (emailConfirmInput) emailConfirmInput.value = '';
      if (passwordInput) passwordInput.value = '';
      if (passwordConfirmInput) passwordConfirmInput.value = '';

      showAuthAlert('success', '¡Cuenta creada exitosamente en Supabase! Ya puedes iniciar sesión.');

      setTimeout(() => {
        switchAuthTab('login');
        const loginEmailInput = document.getElementById('authLoginEmail');
        if (loginEmailInput) {
          loginEmailInput.value = email;
          const loginPassInput = document.getElementById('authLoginPassword');
          if (loginPassInput) setTimeout(() => loginPassInput.focus(), 100);
        }
      }, 1200);
    } else {
      // Backend fallback
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Error al registrar.');

      showAuthAlert('success', '¡Cuenta creada exitosamente! Ya puedes iniciar sesión.');
      setTimeout(() => switchAuthTab('login'), 1200);
    }
  } catch (err) {
    showAuthAlert('error', err.message || 'Ocurrió un error al registrar.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      const spinner = submitBtn.querySelector('.auth-btn-spinner');
      if (spinner) spinner.style.display = 'none';
    }
  }
}

// Handle Login Form Submission with Supabase
async function handleAuthLoginSubmit(event) {
  event.preventDefault();
  const emailInput = document.getElementById('authLoginEmail');
  const passwordInput = document.getElementById('authLoginPassword');
  const submitBtn = document.getElementById('authLoginSubmitBtn');

  const email = emailInput ? emailInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!email || !password) {
    showAuthAlert('error', 'Por favor ingresa tu correo y contraseña.');
    return;
  }

  // Disable button and show spinner
  if (submitBtn) {
    submitBtn.disabled = true;
    const spinner = submitBtn.querySelector('.auth-btn-spinner');
    if (spinner) spinner.style.display = 'inline-block';
  }

  try {
    if (supabaseClient) {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: email.toLowerCase(),
        password: password
      });

      if (error) {
        const msg = error.message.toLowerCase();
        if (msg.includes('invalid') || msg.includes('credentials')) {
          throw new Error('Credenciales inválidas. Si te registraste con Google, pulsa el botón "Continuar con Google".');
        }
        throw error;
      }

      const sessionData = {
        id: data.user.id,
        email: data.user.email,
        username: data.user.user_metadata?.full_name || data.user.user_metadata?.name || data.user.email.split('@')[0],
        avatar: data.user.user_metadata?.avatar_url || '',
        provider: 'supabase',
        loggedInAt: Date.now()
      };
      setUserSession(sessionData);

      showAuthAlert('success', `¡Bienvenido ${sessionData.username}!`);
      setTimeout(() => {
        closeAuthModal();
        showDashboardView('tab-dashboard');
      }, 500);
    } else {
      // Backend fallback
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Credenciales inválidas.');

      setUserSession(data.user);
      showAuthAlert('success', `¡Bienvenido!`);
      setTimeout(() => {
        closeAuthModal();
        showDashboardView('tab-dashboard');
      }, 500);
    }
  } catch (err) {
    showAuthAlert('error', err.message || 'Error al iniciar sesión.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      const spinner = submitBtn.querySelector('.auth-btn-spinner');
      if (spinner) spinner.style.display = 'none';
    }
  }
}

// Handle Logout
async function handleAuthLogout() {
  if (supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch (e) {
      console.warn('Error signing out of Supabase:', e);
    }
  }
  clearUserSession();
  showToast('Has cerrado tu sesión de OrbiBot Cloud.', 'info');
  showLandingView();
}

// ================= PLATFORM LINKING (TWITCH & KICK IN DASHBOARD) =================
function updatePlatformLinkingUI() {
  const session = getUserSession();
  const userLoggedInEmail = document.getElementById('userLoggedInEmail');
  if (userLoggedInEmail && session) {
    userLoggedInEmail.textContent = session.email || session.username || 'Sesión activa';
  }

  // 1. Twitch Status
  const isTwitchConn = isStreamerLoggedIn();
  const twitchChannel = (appConfig?.twitch?.channel || '').toLowerCase().replace(/^#/, '');
  const twitchStatusText = document.getElementById('dashTwitchStatusText');
  const twitchStatusBadge = document.getElementById('dashTwitchStatusBadge');
  const twitchDiscView = document.getElementById('dashTwitchDisconnectedView');
  const twitchConnView = document.getElementById('dashTwitchConnectedView');
  const dashUserName = document.getElementById('dashUserName');
  const dashUserAvatar = document.getElementById('dashUserAvatar');

  if (isTwitchConn && twitchChannel) {
    if (twitchStatusText) twitchStatusText.textContent = `@${twitchChannel} sincronizado`;
    if (twitchStatusBadge) {
      twitchStatusBadge.textContent = '● Conectado';
      twitchStatusBadge.style.background = 'rgba(145, 70, 255, 0.2)';
      twitchStatusBadge.style.color = '#c4b5fd';
      twitchStatusBadge.style.border = '1px solid rgba(145, 70, 255, 0.4)';
    }
    if (twitchDiscView) twitchDiscView.style.display = 'none';
    if (twitchConnView) twitchConnView.style.display = 'flex';
    if (dashUserName) dashUserName.textContent = `@${twitchChannel}`;
    
    // Get stored avatar if available
    const authData = localStorage.getItem('orbibot_twitch_auth');
    if (authData && dashUserAvatar) {
      try {
        const parsed = JSON.parse(authData);
        if (parsed.profile_image_url) dashUserAvatar.src = parsed.profile_image_url;
      } catch(e) {}
    }
  } else {
    if (twitchStatusText) twitchStatusText.textContent = 'No conectado';
    if (twitchStatusBadge) {
      twitchStatusBadge.textContent = '● Desconectado';
      twitchStatusBadge.style.background = 'rgba(255,255,255,0.08)';
      twitchStatusBadge.style.color = '#94a3b8';
      twitchStatusBadge.style.border = 'none';
    }
    if (twitchDiscView) twitchDiscView.style.display = 'flex';
    if (twitchConnView) twitchConnView.style.display = 'none';
  }

  // 2. Kick Status
  const kickChannel = (appConfig?.kick?.channel || localStorage.getItem('orbibot_kick_channel') || '').toLowerCase().replace(/^@/, '').trim();
  const isKickConn = Boolean(kickChannel && (appConfig?.kick?.connected !== false));
  const kickStatusText = document.getElementById('dashKickStatusText');
  const kickStatusBadge = document.getElementById('dashKickStatusBadge');
  const kickDiscView = document.getElementById('dashKickDisconnectedView');
  const kickConnView = document.getElementById('dashKickConnectedView');
  const dashKickChannelName = document.getElementById('dashKickChannelName');

  if (isKickConn && kickChannel) {
    if (kickStatusText) kickStatusText.textContent = `@${kickChannel} sincronizado`;
    if (kickStatusBadge) {
      kickStatusBadge.textContent = '● Conectado';
      kickStatusBadge.style.background = 'rgba(83, 252, 24, 0.2)';
      kickStatusBadge.style.color = '#53fc18';
      kickStatusBadge.style.border = '1px solid rgba(83, 252, 24, 0.4)';
    }
    if (kickDiscView) kickDiscView.style.display = 'none';
    if (kickConnView) kickConnView.style.display = 'flex';
    if (dashKickChannelName) dashKickChannelName.textContent = `@${kickChannel}`;
  } else {
    if (kickStatusText) kickStatusText.textContent = 'No conectado';
    if (kickStatusBadge) {
      kickStatusBadge.textContent = '● Desconectado';
      kickStatusBadge.style.background = 'rgba(255,255,255,0.08)';
      kickStatusBadge.style.color = '#94a3b8';
      kickStatusBadge.style.border = 'none';
    }
    if (kickDiscView) kickDiscView.style.display = 'flex';
    if (kickConnView) kickConnView.style.display = 'none';
  }
}

async function handleLinkKickSubmit() {
  const input = document.getElementById('dashKickChannelInput');
  const channel = input ? input.value.trim().toLowerCase().replace(/^@/, '') : '';
  if (!channel) {
    showToast('Ingresa el nombre de tu canal en Kick.', 'warning');
    if (input) input.focus();
    return;
  }

  if (!appConfig) appConfig = {};
  appConfig.kick = { channel, connected: true };
  localStorage.setItem('orbibot_kick_channel', channel);

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kick: appConfig.kick })
    });
  } catch (e) {}

  showToast(`Canal de Kick @${channel} vinculado exitosamente.`, 'success');
  updatePlatformLinkingUI();
}

async function handleUnlinkKick() {
  if (!appConfig) appConfig = {};
  appConfig.kick = { channel: '', connected: false };
  localStorage.removeItem('orbibot_kick_channel');

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kick: appConfig.kick })
    });
  } catch (e) {}

  showToast('Canal de Kick desvinculado.', 'info');
  updatePlatformLinkingUI();
}

// Export auth functions to window
window.initSupabaseAuth = initSupabaseAuth;
window.signInWithGoogle = signInWithGoogle;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.handleDashboardNavClick = handleDashboardNavClick;
window.handleAuthRegisterSubmit = handleAuthRegisterSubmit;
window.handleAuthLoginSubmit = handleAuthLoginSubmit;
window.handleAuthLogout = handleAuthLogout;
window.getUserSession = getUserSession;
window.updatePlatformLinkingUI = updatePlatformLinkingUI;
window.handleLinkKickSubmit = handleLinkKickSubmit;
window.handleUnlinkKick = handleUnlinkKick;

// ================= VIEW SWITCHER (LANDING VS DASHBOARD) =================
function showLandingView() {
  const landingView = document.getElementById('landingView');
  const dashboardView = document.getElementById('dashboardAppView');
  if (landingView) landingView.style.display = 'flex';
  if (dashboardView) dashboardView.style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showDashboardView(targetTab = 'tab-dashboard') {
  const landingView = document.getElementById('landingView');
  const dashboardView = document.getElementById('dashboardAppView');
  if (landingView) landingView.style.display = 'none';
  if (dashboardView) dashboardView.style.display = 'flex';
  if (targetTab) {
    switchTab(targetTab);
  }
}
window.showLandingView = showLandingView;
window.showDashboardView = showDashboardView;

function initLandingPage() {
  updateAuthUI();

  // Navigation & CTA buttons on Landing
  const landingNavDashboardBtn = document.getElementById('landingNavDashboardBtn');
  if (landingNavDashboardBtn) {
    landingNavDashboardBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleDashboardNavClick('tab-dashboard');
    });
  }

  const landingNavLoginBtn = document.getElementById('landingNavLoginBtn');
  if (landingNavLoginBtn) landingNavLoginBtn.addEventListener('click', () => openAuthModal('login'));

  const landingHeroLoginBtn = document.getElementById('landingHeroLoginBtn');
  if (landingHeroLoginBtn) landingHeroLoginBtn.addEventListener('click', triggerTwitchOAuthLogin);

  const landingHeroDashboardBtn = document.getElementById('landingHeroDashboardBtn');
  if (landingHeroDashboardBtn) {
    landingHeroDashboardBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleDashboardNavClick('tab-dashboard');
    });
  }

  const landingBottomLoginBtn = document.getElementById('landingBottomLoginBtn');
  if (landingBottomLoginBtn) landingBottomLoginBtn.addEventListener('click', () => openAuthModal('login'));

  // Return to Home Buttons
  const sidebarGoHomeBtn = document.getElementById('sidebarGoHomeBtn');
  if (sidebarGoHomeBtn) sidebarGoHomeBtn.addEventListener('click', showLandingView);

  const topGoHomeBtn = document.getElementById('topGoHomeBtn');
  if (topGoHomeBtn) topGoHomeBtn.addEventListener('click', showLandingView);

  // FAQ Accordion
  document.querySelectorAll('.landing-faq-question').forEach(q => {
    q.addEventListener('click', () => {
      const item = q.parentElement;
      const isActive = item.classList.contains('active');
      document.querySelectorAll('.landing-faq-item').forEach(i => i.classList.remove('active'));
      if (!isActive) item.classList.add('active');
    });
  });

  // Check URL Hash on load
  const hash = window.location.hash;
  const session = getUserSession();
  if (session && (hash === '#dashboard' || hash.startsWith('#tab-'))) {
    const tabName = hash.startsWith('#tab-') ? hash.substring(1) : 'tab-dashboard';
    showDashboardView(tabName);
  } else {
    showLandingView();
  }
}

// ================= NAVIGATION =================
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const titleEl = document.getElementById('currentTabTitle');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      item.classList.add('active');
      const targetTabId = item.getAttribute('data-tab');
      const targetPane = document.getElementById(targetTabId);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      titleEl.innerText = item.querySelector('span:last-child').innerText;
    });
  });
}

function switchTab(tabId) {
  const navItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (navItem) {
    navItem.click();
  } else {
    const tabPanes = document.querySelectorAll('.tab-pane');
    tabPanes.forEach(p => p.classList.remove('active'));
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
  }
}

// ================= TOAST NOTIFICATIONS =================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warn') icon = '⚠️';

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 3500);
}

// ================= WEBSOCKET & MULTI-CHANNEL REALTIME =================
const broadcastChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('orbibot_stream_channel') : null;
let dashboardMqttClient = null;
let isMqttConnected = false;

function isStreamerLoggedIn() {
  const channel = (appConfig?.twitch?.channel || '').toLowerCase().replace(/^#/, '');
  const isConn = (appConfig?.twitch?.connected || Boolean(localStorage.getItem('orbibot_twitch_auth'))) && Boolean(channel);
  return isConn;
}

function initDashboardMqtt() {
  if (typeof Paho === 'undefined') return;
  const channel = (appConfig?.twitch?.channel || '').toLowerCase().replace(/^#/, '');
  const isConn = isStreamerLoggedIn();

  if (!isConn || !channel) {
    if (dashboardMqttClient) {
      try { dashboardMqttClient.disconnect(); } catch(e) {}
      dashboardMqttClient = null;
    }
    isMqttConnected = false;
    return;
  }

  const clientId = 'orbi_dash_' + Math.random().toString(36).substring(2, 9);
  try {
    if (dashboardMqttClient) {
      try { dashboardMqttClient.disconnect(); } catch(e) {}
    }
    dashboardMqttClient = new Paho.MQTT.Client('broker.emqx.io', 8084, clientId);
    dashboardMqttClient.onConnectionLost = () => {
      isMqttConnected = false;
      setTimeout(initDashboardMqtt, 4000);
    };
    dashboardMqttClient.connect({
      useSSL: true,
      timeout: 6,
      keepAliveInterval: 30,
      onSuccess: () => {
        isMqttConnected = true;
        console.log(`🟢 OrbiBot Dashboard conectado a Cloud Relay MQTT (#${channel})`);
      },
      onFailure: (err) => {
        isMqttConnected = false;
        console.warn('MQTT Connection failed:', err);
        setTimeout(initDashboardMqtt, 6000);
      }
    });
  } catch(e) {
    console.warn('Error creating MQTT client:', e);
  }
}

function broadcastEvent(event, data) {
  const channel = (appConfig?.twitch?.channel || '').toLowerCase().replace(/^#/, '');
  const isConn = isStreamerLoggedIn();

  // Si no hay sesión iniciada, no enviar eventos a OBS
  if (!isConn || !channel) {
    console.warn('[Broadcast] Sesión cerrada o canal no configurado. Evento no transmitido.');
    return;
  }

  const payload = { event, data, channel, timestamp: Date.now() };

  // 1. BroadcastChannel (para pestañas del mismo navegador)
  if (broadcastChannel) {
    try { broadcastChannel.postMessage(payload); } catch(e) {}
  }

  // 2. Storage event
  try {
    localStorage.setItem('orbibot_last_event', JSON.stringify(payload));
  } catch(e) {}

  // 3. Cloud MQTT Relay (para OBS Studio del streamer específico)
  if (dashboardMqttClient && isMqttConnected) {
    try {
      const token = getEffectiveWidgetToken();
      const msgStr = JSON.stringify(payload);
      
      // Publicar en tópico privado protegido con token secreto
      if (token) {
        const msgPriv = new Paho.MQTT.Message(msgStr);
        msgPriv.destinationName = `orbibot/${channel}_${token}/events`;
        dashboardMqttClient.send(msgPriv);
      }

      // Publicar en tópico del canal
      const msg1 = new Paho.MQTT.Message(msgStr);
      msg1.destinationName = `orbibot/${channel}/events`;
      dashboardMqttClient.send(msg1);
    } catch(e) {
      console.warn('Error publishing to MQTT relay:', e);
    }
  }

  // 4. Local WebSocket Server (si el backend local node server.js está corriendo)
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
    } catch(e) {}
  }
}

function connectWebSocket() {
  // Listen on BroadcastChannel for multi-tab sync & OAuth callback
  if (broadcastChannel) {
    broadcastChannel.onmessage = (e) => {
      if (e.data) {
        if (e.data.type === 'TWITCH_AUTH_SUCCESS') {
          handleAuthSuccess(e.data);
          return;
        }
        handleSocketMessage(e.data);
      }
    };
  }

  // Storage event listener
  window.addEventListener('storage', (e) => {
    if (e.key === 'orbibot_last_event' && e.newValue) {
      try { handleSocketMessage(JSON.parse(e.newValue)); } catch(err) {}
    }
    if (e.key === 'orbibot_twitch_auth_event' && e.newValue) {
      try {
        const payload = JSON.parse(e.newValue);
        handleAuthSuccess(payload);
      } catch(err) {}
    }
  });

  // WebSocket for backend (works on Render, localhost, or any custom domain; skips only static github.io)
  const isGitHubPages = location.hostname.endsWith('github.io');
  if (!isGitHubPages) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      socket = new WebSocket(`${protocol}//${location.host}`);

      socket.onopen = () => {
        console.log('Connected to StreamBot Server WebSocket');
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleSocketMessage(msg);
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      socket.onclose = () => {
        setTimeout(connectWebSocket, 3000);
      };
    } catch(e) {}
  }
}

function handleSocketMessage(msg) {
  const { event, data } = msg;

  if (event === 'init_state') {
    updateBotStatusUI(data.botStatus);
    updateSongRequestUI(data.srState);
  } else if (event === 'bot_status') {
    updateBotStatusUI(data);
  } else if (event === 'chat_message') {
    appendChatMessage(data);
  } else if (event === 'sr_update') {
    updateSongRequestUI(data.state);
    if (data.action === 'play' && data.data) {
      playYouTubeSong(data.data.videoId);
    }
  } else if (event === 'alert') {
    showToast(`Alerta recibida: ${data.type?.toUpperCase()} de ${data.user}`, 'success');
  } else if (event === 'tts') {
    console.log('TTS triggered:', data);
  }
}

// ================= LOAD DATA =================
async function loadInitialData() {
  try {
    const [cfgRes, cmdRes, rwdRes, srRes] = await Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/commands').then(r => r.json()),
      fetch('/api/rewards').then(r => r.json()),
      fetch('/api/sr/state').then(r => r.json())
    ]);

    // Sync localStorage Twitch auth if present
    const localTwitch = localStorage.getItem('orbibot_twitch_auth');
    let effectiveTwitch = cfgRes.twitch || {};
    if (localTwitch) {
      try {
        const parsed = JSON.parse(localTwitch);
        const chan = (parsed.channel || parsed.login || (parsed.displayName ? parsed.displayName.toLowerCase() : '') || '').replace(/^#/, '');
        if (chan) {
          parsed.channel = chan;
          parsed.connected = true;
          effectiveTwitch = { ...effectiveTwitch, ...parsed };
          cfgRes.twitch = effectiveTwitch;
          if (parsed.oauthToken) {
            fetch('/api/auth/twitch-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: parsed.oauthToken, channel: chan })
            }).catch(() => {});
          }
        }
      } catch(e) {}
    }

    appConfig = cfgRes;
    bindConfigToUI(cfgRes);
    renderCommands(cmdRes);
    renderRewards(rwdRes);
    updateSongRequestUI(srRes);

    if (effectiveTwitch.channel && window.tmi && (!browserTmiClient || browserTmiClient.readyState() !== 'OPEN')) {
      connectInBrowserTwitchBot(effectiveTwitch);
    }
  } catch (err) {
    console.warn('Backend API not reachable. Running in standalone / GitHub Pages mode:', err);
    
    // Load from localStorage or defaults
    const localTwitch = localStorage.getItem('orbibot_twitch_auth');
    const localCfg = localStorage.getItem('orbibot_config');
    const localCmds = localStorage.getItem('orbibot_commands');
    const localRwds = localStorage.getItem('orbibot_rewards');

    let twitchData = localTwitch ? JSON.parse(localTwitch) : {
      channel: '',
      botUsername: '',
      oauthToken: '',
      clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
      connected: false
    };

    const chan = (twitchData.channel || twitchData.login || (twitchData.displayName ? twitchData.displayName.toLowerCase() : '') || '').replace(/^#/, '');
    if (chan) {
      twitchData.channel = chan;
      twitchData.connected = true;
    }

    let cfg = localCfg ? JSON.parse(localCfg) : {
      twitch: twitchData,
      songRequest: { prefix: '!sr', enabled: true, maxDurationMinutes: 8, maxPerUser: 5, userLevel: 'all', volume: 75 },
      tts: { enabled: true, voice: 'es_001', volume: 90, rate: 1.0, pitch: 1.0, maxLength: 250, bannedWords: [], allowChatCommand: true, chatCommand: '!tts', minBits: 50 },
      goals: {
        subs: { title: 'Meta de Suscriptores', current: 12, target: 50, color: '#9146ff' },
        followers: { title: 'Meta de Seguidores', current: 185, target: 300, color: '#00f2fe' },
        bits: { title: 'Meta de Bits', current: 1500, target: 5000, color: '#f5a623' }
      }
    };

    cfg.twitch = { ...cfg.twitch, ...twitchData };
    appConfig = cfg;
    bindConfigToUI(cfg);

    const defaultCommands = [
      { id: '1', name: '!discord', response: '¡Únete a nuestra comunidad de Discord!', cooldown: 10, userLevel: 'all' },
      { id: '2', name: '!redes', response: 'Sígueme en redes sociales: @streamer', cooldown: 10, userLevel: 'all' },
      { id: '3', name: '!bot', response: 'Bot de stream creado con OrbiBot.', cooldown: 10, userLevel: 'all' }
    ];
    renderCommands(localCmds ? JSON.parse(localCmds) : defaultCommands);

    const defaultRewards = [
      { id: '1', rewardName: 'Mensaje con Voz (TTS)', action: 'tts', cost: 500 },
      { id: '2', rewardName: 'Pedir Canción', action: 'song_request', cost: 300 }
    ];
    renderRewards(localRwds ? JSON.parse(localRwds) : defaultRewards);

    updateSongRequestUI({ currentSong: null, queue: [], isPlaying: false });

    // In-browser Twitch IRC connection (if credentials exist)
    if (twitchData.channel && window.tmi) {
      connectInBrowserTwitchBot(twitchData);
    }
  }
}

// In-Browser Twitch Bot for GitHub Pages
let browserTmiClient = null;
function connectInBrowserTwitchBot(twitchData) {
  if (!window.tmi || !twitchData) return;
  const rawChannel = twitchData.channel || twitchData.login || (twitchData.displayName ? twitchData.displayName.toLowerCase() : '');
  const channel = (rawChannel || '').toLowerCase().replace(/^#/, '');
  if (!channel) return;

  if (browserTmiClient) {
    try { browserTmiClient.disconnect(); } catch(e) {}
  }

  const opts = {
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    channels: [channel]
  };

  if (twitchData.oauthToken) {
    const token = twitchData.oauthToken.startsWith('oauth:') ? twitchData.oauthToken : `oauth:${twitchData.oauthToken}`;
    opts.identity = {
      username: twitchData.botUsername || channel,
      password: token
    };
  }

  updateBotStatusUI({ status: 'connecting', channel });

  function setupClient(client) {
    client.on('connected', () => {
      updateBotStatusUI({ status: 'connected', channel });
      const statChan = document.getElementById('statChannelName');
      if (statChan) statChan.innerText = `#${channel}`;
      const notice = document.getElementById('chatStatusNotice');
      if (notice) notice.innerText = `🟢 En línea (#${channel})`;
      const chatContainer = document.getElementById('liveChatMessages');
      if (chatContainer && chatContainer.innerText.includes('Conecta tu canal de Twitch')) {
        chatContainer.innerHTML = `<div class="chat-msg-row" style="color: var(--cyan-accent);"><em>🟢 Conectado al chat de #${channel}. Esperando mensajes...</em></div>`;
      }
      showToast(`Conectado al chat de #${channel}`, 'success');
    });

    client.on('message', (ch, tags, message, self) => {
      if (self) return;
      const username = tags['display-name'] || tags.username;
      const isMod = tags.mod || tags.badges?.broadcaster === '1';
      const isSub = tags.subscriber || tags.badges?.subscriber !== undefined;
      const userColor = tags.color || '#9146ff';

      const chatData = {
        id: tags.id || Date.now().toString(),
        user: username,
        color: userColor,
        message,
        isMod,
        isSub,
        badges: tags.badges || {},
        badgesRaw: tags['badges-raw'] || null,
        emotes: tags.emotes || null,
        roomId: tags['room-id'] || null
      };

      appendChatMessage(chatData);
      broadcastEvent('chat_message', chatData);

      // Bits
      if (tags.bits) {
        const bitCount = parseInt(tags.bits, 10);
        const alertData = { type: 'bits', user: username, amount: bitCount, message };
        broadcastEvent('alert', alertData);
        showToast(`¡${username} donó ${bitCount} bits!`, 'success');
      }
    });
  }

  browserTmiClient = new window.tmi.Client(opts);
  setupClient(browserTmiClient);

  browserTmiClient.connect().catch(e => {
    console.warn('IRC authed connection failed, falling back to anonymous read-only:', e);
    try {
      delete opts.identity;
      browserTmiClient = new window.tmi.Client(opts);
      setupClient(browserTmiClient);
      browserTmiClient.connect().catch(err => {
        updateBotStatusUI({ status: 'connected', channel });
      });
    } catch(err) {
      updateBotStatusUI({ status: 'connected', channel });
    }
  });
}

// ================= UI BINDING =================
function bindConfigToUI(cfg) {
  if (!cfg) return;
  if (!cfg.twitch) {
    try {
      const local = localStorage.getItem('orbibot_twitch_auth');
      if (local) cfg.twitch = JSON.parse(local);
    } catch(e) {}
  }

  // Twitch Profile & Connection
  if (cfg.twitch) {
    const channel = (cfg.twitch.channel || cfg.twitch.login || (cfg.twitch.displayName ? cfg.twitch.displayName.toLowerCase() : '') || '').replace(/^#/, '');
    if (channel) {
      cfg.twitch.channel = channel;
    }
    const isConn = (cfg.twitch.connected || Boolean(cfg.twitch.oauthToken) || Boolean(channel)) && Boolean(channel);
    
    // Header elements
    const topTwitchLoginBtn = document.getElementById('topTwitchLoginBtn');
    const topUserPill = document.getElementById('topUserPill');
    const topUserAvatar = document.getElementById('topUserAvatar');
    const topUserName = document.getElementById('topUserName');

    // Dashboard Hero elements
    const loginHero = document.getElementById('dashboardLoginHero');
    const connectedHero = document.getElementById('dashboardConnectedHero');
    const dashUserAvatar = document.getElementById('dashUserAvatar');
    const dashUserName = document.getElementById('dashUserName');
    const dashUserTag = document.getElementById('dashUserTag');

    const avatar = cfg.twitch.profileImage || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb60-aee8f1560db5-profile_image-300x300.png';
    const dName = cfg.twitch.displayName || channel || 'Streamer';
    const login = channel;

    if (isConn) {
      if (topTwitchLoginBtn) topTwitchLoginBtn.style.display = 'none';
      if (topUserPill) {
        topUserPill.style.display = 'inline-flex';
        if (topUserAvatar) topUserAvatar.src = avatar;
        if (topUserName) topUserName.innerText = `@${login || dName}`;
      }

      if (loginHero) loginHero.style.display = 'none';
      if (connectedHero) {
        connectedHero.style.display = 'block';
        if (dashUserAvatar) dashUserAvatar.src = avatar;
        if (dashUserName) dashUserName.innerText = dName;
        if (dashUserTag) dashUserTag.innerText = `@${login || dName}`;
      }

      updateBotStatusUI({ status: 'connected', channel: login });
    } else {
      if (topTwitchLoginBtn) topTwitchLoginBtn.style.display = 'inline-flex';
      if (topUserPill) topUserPill.style.display = 'none';

      if (loginHero) loginHero.style.display = 'block';
      if (connectedHero) connectedHero.style.display = 'none';

      updateBotStatusUI({ status: 'disconnected' });
    }

    if (document.getElementById('cfgTwitchChannel')) document.getElementById('cfgTwitchChannel').value = channel;
    if (document.getElementById('cfgTwitchBotUser')) document.getElementById('cfgTwitchBotUser').value = cfg.twitch.botUsername || channel;
    if (document.getElementById('cfgTwitchToken')) document.getElementById('cfgTwitchToken').value = cfg.twitch.oauthToken || '';
    if (document.getElementById('cfgTwitchClientId')) {
      document.getElementById('cfgTwitchClientId').value = cfg.twitch.clientId || 'yw1vr664ichms8an2x5lhji58v7ozk';
    }
    if (document.getElementById('statChannelName')) {
      document.getElementById('statChannelName').innerText = channel ? `#${channel}` : 'Ninguno';
    }
    populateWidgetUrls();
  }

  // Song Request
  if (cfg.songRequest) {
    document.getElementById('cfgSrPrefix').value = cfg.songRequest.prefix || '!sr';
    document.getElementById('cfgSrUserLevel').value = cfg.songRequest.userLevel || 'all';
    document.getElementById('cfgSrMaxDuration').value = cfg.songRequest.maxDurationMinutes || 8;
    document.getElementById('cfgSrMaxPerUser').value = cfg.songRequest.maxPerUser || 5;
    document.getElementById('cfgSrEnabled').checked = cfg.songRequest.enabled !== false;
  }

  // TTS
  if (cfg.tts) {
    document.getElementById('cfgTtsEnabled').checked = cfg.tts.enabled !== false;
    document.getElementById('cfgTtsVoice').value = cfg.tts.voice || 'es_001';
    document.getElementById('cfgTtsVolume').value = cfg.tts.volume !== undefined ? cfg.tts.volume : 90;
    document.getElementById('valTtsVolume').innerText = `${document.getElementById('cfgTtsVolume').value}%`;
    document.getElementById('cfgTtsRate').value = cfg.tts.rate || 1.0;
    document.getElementById('valTtsRate').innerText = `${document.getElementById('cfgTtsRate').value}x`;
    document.getElementById('cfgTtsPitch').value = cfg.tts.pitch || 1.0;
    document.getElementById('valTtsPitch').innerText = document.getElementById('cfgTtsPitch').value;
    document.getElementById('cfgTtsMaxLength').value = cfg.tts.maxLength || 250;
    document.getElementById('cfgTtsBannedWords').value = (cfg.tts.bannedWords || []).join(', ');
    document.getElementById('cfgTtsAllowCommand').checked = cfg.tts.allowChatCommand !== false;
    document.getElementById('cfgTtsCommand').value = cfg.tts.chatCommand || '!tts';
    document.getElementById('cfgTtsMinBits').value = cfg.tts.minBits !== undefined ? cfg.tts.minBits : 50;
  }

  // Goals
  if (cfg.goals) {
    if (cfg.goals.subs) {
      document.getElementById('cfgGoalSubTitle').value = cfg.goals.subs.title || 'Meta de Suscriptores';
      document.getElementById('cfgGoalSubCurrent').value = cfg.goals.subs.current || 0;
      document.getElementById('cfgGoalSubTarget').value = cfg.goals.subs.target || 50;
    }
    if (cfg.goals.followers) {
      document.getElementById('cfgGoalFollowTitle').value = cfg.goals.followers.title || 'Meta de Seguidores';
      document.getElementById('cfgGoalFollowCurrent').value = cfg.goals.followers.current || 0;
      document.getElementById('cfgGoalFollowTarget').value = cfg.goals.followers.target || 300;
    }
    if (cfg.goals.bits) {
      document.getElementById('cfgGoalBitsTitle').value = cfg.goals.bits.title || 'Meta de Bits';
      document.getElementById('cfgGoalBitsCurrent').value = cfg.goals.bits.current || 0;
      document.getElementById('cfgGoalBitsTarget').value = cfg.goals.bits.target || 5000;
    }
  }
}

function setupRangeInputs() {
  const vol = document.getElementById('cfgTtsVolume');
  const rate = document.getElementById('cfgTtsRate');
  const pitch = document.getElementById('cfgTtsPitch');

  vol.addEventListener('input', () => { document.getElementById('valTtsVolume').innerText = `${vol.value}%`; });
  rate.addEventListener('input', () => { document.getElementById('valTtsRate').innerText = `${rate.value}x`; });
  pitch.addEventListener('input', () => { document.getElementById('valTtsPitch').innerText = pitch.value; });
}

// ================= BOT STATUS =================
function updateBotStatusUI(botStatus) {
  const dot = document.getElementById('botStatusDot');
  const text = document.getElementById('botStatusText');
  const badge = document.getElementById('twitchConnectionBadge');
  const statText = document.getElementById('statBotStatus');
  const quickBtn = document.getElementById('quickConnectBtn');
  const statChan = document.getElementById('statChannelName');

  let currentChannel = (appConfig?.twitch?.channel || '').replace(/^#/, '');
  if (!currentChannel) {
    try {
      const local = localStorage.getItem('orbibot_twitch_auth');
      if (local) {
        const p = JSON.parse(local);
        currentChannel = (p.channel || p.login || (p.displayName ? p.displayName.toLowerCase() : '') || '').replace(/^#/, '');
      }
    } catch(e) {}
  }

  const isConnected = Boolean(currentChannel && (appConfig?.twitch?.connected || browserTmiClient || localStorage.getItem('orbibot_twitch_auth')));
  let status = botStatus?.status || (isConnected ? 'connected' : 'disconnected');
  if (!isConnected) {
    status = 'disconnected';
  }

  if (dot) dot.className = `status-dot ${status}`;
  if (text) text.innerText = status === 'connected' ? 'En Línea' : (status === 'connecting' ? 'Conectando...' : 'Desconectado');

  if (status === 'connected') {
    if (badge) {
      badge.className = 'btn btn-sm btn-accent';
      badge.innerText = '🟢 Conectado';
    }
    if (statText) {
      statText.innerText = 'En Línea';
      statText.style.color = 'var(--green-success)';
    }
    if (quickBtn) {
      quickBtn.innerText = 'Desconectar';
      quickBtn.className = 'btn btn-danger btn-sm';
    }
    if (statChan && currentChannel) statChan.innerText = `#${currentChannel}`;
  } else if (status === 'connecting') {
    if (badge) {
      badge.className = 'btn btn-sm btn-secondary';
      badge.innerText = '🟡 Conectando...';
    }
    if (statText) {
      statText.innerText = 'Conectando';
      statText.style.color = 'var(--yellow-warn)';
    }
    if (quickBtn) {
      quickBtn.innerText = 'Conectando...';
      quickBtn.className = 'btn btn-secondary btn-sm';
    }
    if (statChan) statChan.innerText = currentChannel ? `#${currentChannel}` : 'Ninguno';
  } else {
    if (badge) {
      badge.className = 'btn btn-sm btn-danger';
      badge.innerText = '🔴 Desconectado';
    }
    if (statText) {
      statText.innerText = 'Inactivo';
      statText.style.color = 'var(--red-danger)';
    }
    if (quickBtn) {
      quickBtn.innerText = 'Iniciar Sesión';
      quickBtn.className = 'btn btn-primary btn-sm';
    }
    if (statChan) statChan.innerText = 'Ninguno';
  }
}

// ================= TWITCH BADGES & EMOTES =================
const DEFAULT_TWITCH_BADGES = {
  broadcaster: {
    title: 'Streamer / Transmisor',
    url: 'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1'
  },
  moderator: {
    title: 'Moderador',
    url: 'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1'
  },
  vip: {
    title: 'VIP',
    url: 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1'
  },
  subscriber: {
    title: 'Suscriptor',
    url: 'https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/1'
  },
  founder: {
    title: 'Fundador',
    url: 'https://static-cdn.jtvnw.net/badges/v1/511b78a9-ab37-472f-9569-457753bbe7d3/1'
  },
  premium: {
    title: 'Prime Gaming',
    url: 'https://static-cdn.jtvnw.net/badges/v1/bbbe0db0-a598-423e-86d0-f9fb98ca1933/1'
  },
  turbo: {
    title: 'Turbo',
    url: 'https://static-cdn.jtvnw.net/badges/v1/bd444ec6-8f34-4bf9-91f4-af1e3428d80f/1'
  },
  partner: {
    title: 'Verificado',
    url: 'https://static-cdn.jtvnw.net/badges/v1/d12a2e27-16f6-41d0-ab77-b780518f00a3/1'
  },
  'artist-badge': {
    title: 'Artista',
    url: 'https://static-cdn.jtvnw.net/badges/v1/4300a897-03dc-4e83-8c0e-c332fee7057f/1'
  },
  'bot-badge': {
    title: 'Bot de Chat',
    url: 'https://static-cdn.jtvnw.net/badges/v1/3ffa9565-c35b-4cad-800b-041e60659cf2/1'
  },
  staff: {
    title: 'Twitch Staff',
    url: 'https://static-cdn.jtvnw.net/badges/v1/d97c37bd-a6f5-4c38-8f57-4e4bef88af34/1'
  },
  admin: {
    title: 'Twitch Admin',
    url: 'https://static-cdn.jtvnw.net/badges/v1/9ef7e029-4cdf-4d4d-a0d5-e2b3fb2583fe/1'
  },
  global_mod: {
    title: 'Moderador Global',
    url: 'https://static-cdn.jtvnw.net/badges/v1/9384c43e-4ce7-4e94-b2a1-b93656896eba/1'
  },
  'glhf-pledge': {
    title: 'GLHF Pledge',
    url: 'https://static-cdn.jtvnw.net/badges/v1/3158e758-3cb4-43c5-94b3-7639810451c5/1'
  },
  'sub-gifter': {
    title: 'Regalador de Suscripciones',
    url: 'https://static-cdn.jtvnw.net/badges/v1/a5ef6c17-2e5b-4d8f-9b80-2779fd722414/1'
  },
  no_video: {
    title: 'Solo Audio',
    url: 'https://static-cdn.jtvnw.net/badges/v1/aef2cd08-f292-42c6-917d-f4728562d49b/1'
  }
};

const channelBadgesCache = {};
const loadedBadgesChannels = new Set();

async function loadChannelBadges(channelIdOrName) {
  if (!channelIdOrName || loadedBadgesChannels.has(channelIdOrName)) return;
  loadedBadgesChannels.add(channelIdOrName);
  try {
    const isId = /^\d+$/.test(channelIdOrName);
    const param = isId ? `id=${channelIdOrName}` : `name=${channelIdOrName.toLowerCase().replace(/^#/, '')}`;
    const res = await fetch(`https://api.ivr.fi/v2/twitch/badges/channel?${param}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach(set => {
          if (!channelBadgesCache[set.set_id]) channelBadgesCache[set.set_id] = {};
          if (Array.isArray(set.versions)) {
            set.versions.forEach(v => {
              channelBadgesCache[set.set_id][v.id] = {
                title: v.title,
                url: v.image_url_1x || v.image_url_2x || v.image_url_4x
              };
            });
          }
        });
      }
    }
  } catch (e) {}
}

function getTwitchBadgeInfo(setId, version) {
  if (channelBadgesCache[setId] && channelBadgesCache[setId][version]) {
    return channelBadgesCache[setId][version];
  }
  if (DEFAULT_TWITCH_BADGES[setId]) {
    return DEFAULT_TWITCH_BADGES[setId];
  }
  return null;
}

function renderTwitchBadges(badgesData, isMod, isSub) {
  let badges = {};
  if (typeof badgesData === 'string') {
    badgesData.split(',').forEach(part => {
      const [k, v] = part.split('/');
      if (k) badges[k] = v || '1';
    });
  } else if (badgesData && typeof badgesData === 'object') {
    badges = badgesData;
  }

  let html = '';
  const badgeOrder = [
    'staff', 'admin', 'global_mod', 'broadcaster', 'moderator',
    'vip', 'founder', 'subscriber', 'artist-badge', 'partner',
    'premium', 'turbo', 'sub-gifter', 'bot-badge', 'glhf-pledge', 'no_video'
  ];

  const processed = new Set();
  for (const key of badgeOrder) {
    if (badges[key] !== undefined) {
      processed.add(key);
      const info = getTwitchBadgeInfo(key, badges[key]);
      if (info) {
        html += `<img class="twitch-badge" src="${info.url}" alt="${escapeHtml(info.title)}" title="${escapeHtml(info.title)}" loading="lazy">`;
      }
    }
  }

  for (const key in badges) {
    if (!processed.has(key)) {
      const info = getTwitchBadgeInfo(key, badges[key]);
      if (info) {
        html += `<img class="twitch-badge" src="${info.url}" alt="${escapeHtml(info.title)}" title="${escapeHtml(info.title)}" loading="lazy">`;
      }
    }
  }

  // Fallback if badges object is empty
  if (!html) {
    if (isMod) {
      const m = DEFAULT_TWITCH_BADGES.moderator;
      html += `<img class="twitch-badge" src="${m.url}" alt="${m.title}" title="${m.title}" loading="lazy">`;
    } else if (isSub) {
      const s = DEFAULT_TWITCH_BADGES.subscriber;
      html += `<img class="twitch-badge" src="${s.url}" alt="${s.title}" title="${s.title}" loading="lazy">`;
    }
  }

  return html;
}

function formatTwitchEmotes(message, emotes) {
  if (!message) return '';
  if (!emotes || typeof emotes !== 'object' || Object.keys(emotes).length === 0) {
    return escapeHtml(message);
  }
  const ranges = [];
  for (const emoteId in emotes) {
    const list = emotes[emoteId];
    if (Array.isArray(list)) {
      list.forEach(range => {
        const parts = range.split('-');
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);
        if (!isNaN(start) && !isNaN(end)) {
          ranges.push({ id: emoteId, start, end });
        }
      });
    }
  }
  if (ranges.length === 0) {
    return escapeHtml(message);
  }
  ranges.sort((a, b) => a.start - b.start);

  let html = '';
  let lastIdx = 0;
  for (const r of ranges) {
    if (r.start > lastIdx) {
      html += escapeHtml(message.slice(lastIdx, r.start));
    }
    const emoteName = message.slice(r.start, r.end + 1);
    html += `<img class="twitch-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0" alt="${escapeHtml(emoteName)}" title="${escapeHtml(emoteName)}" loading="lazy">`;
    lastIdx = r.end + 1;
  }
  if (lastIdx < message.length) {
    html += escapeHtml(message.slice(lastIdx));
  }
  return html;
}

// ================= CHAT LIVE LOG =================
function appendChatMessage(data) {
  const container = document.getElementById('liveChatMessages');
  if (!container) return;

  // Clear initial placeholder notice if present
  const placeholder = container.querySelector('em');
  if (placeholder && placeholder.parentElement && placeholder.parentElement.parentElement === container) {
    container.innerHTML = '';
  }

  if (data.roomId) {
    loadChannelBadges(data.roomId);
  }

  const row = document.createElement('div');
  row.className = 'chat-msg-row';

  const badgeHtml = renderTwitchBadges(data.badges || data.badgesRaw, data.isMod, data.isSub);
  const formattedText = formatTwitchEmotes(data.message, data.emotes);

  row.innerHTML = `
    <span class="chat-badges">${badgeHtml}</span>
    <span class="chat-user" style="color: ${data.color || '#9146ff'}">${escapeHtml(data.user)}:</span>
    <span class="chat-text">${formattedText}</span>
  `;

  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function triggerTestChat() {
  if (!isStreamerLoggedIn()) {
    showToast('⚠️ Debes iniciar sesión con tu cuenta de Twitch para probar el Chat en OBS.', 'warn');
    return;
  }
  const channel = (appConfig?.twitch?.channel || 'StreamerMaster').replace(/^#/, '');
  const sampleMessages = [
    {
      user: channel,
      color: '#ff007f',
      message: '¡Hola a todos! Bienvenidos al directo Kappa Keepo',
      badges: { broadcaster: '1', subscriber: '12' },
      isMod: true,
      isSub: true,
      emotes: { '25': ['36-40'], '1902': ['42-46'] }
    },
    {
      user: 'Moderador_Pro',
      color: '#00f2fe',
      message: 'Recuerden respetar las reglas del chat y pasarla bien PogChamp',
      badges: { moderator: '1', partner: '1' },
      isMod: true,
      isSub: false,
      emotes: { '88': ['52-59'] }
    },
    {
      user: 'SuperVIP_Fan',
      color: '#ffd700',
      message: '¡Aquí apoyando con suscripción de regalo! <3 LUL',
      badges: { vip: '1', premium: '1', 'sub-gifter': '5' },
      isMod: false,
      isSub: true,
      emotes: { '425618': ['45-47'] }
    },
    {
      user: 'FundadorTier3',
      color: '#a855f7',
      message: '¡Esa canción está brutal! VoHiYo',
      badges: { founder: '0', turbo: '1', 'artist-badge': '1' },
      isMod: false,
      isSub: true,
      emotes: { '81274': ['26-31'] }
    }
  ];

  sampleMessages.forEach((msg, idx) => {
    setTimeout(() => {
      appendChatMessage(msg);
      broadcastEvent('chat_message', msg);
    }, idx * 600);
  });
  showToast('💬 Mensajes de prueba con emblemas originales enviados a OBS y Chat', 'success');
}
window.triggerTestChat = triggerTestChat;

// ================= SONG REQUEST UI & YOUTUBE =================
function updateSongRequestUI(state) {
  if (!state) return;

  const current = state.currentSong;
  const queue = state.queue || [];

  // Update Stats
  document.getElementById('statQueueCount').innerText = queue.length;
  document.getElementById('queueBadgeTotal').innerText = `${queue.length} canciones`;

  // Update Current Song Banner
  const thumb = document.getElementById('srCurrentThumb');
  const title = document.getElementById('srCurrentTitle');
  const author = document.getElementById('srCurrentAuthor');
  const requester = document.getElementById('srCurrentRequester');

  if (current) {
    thumb.src = current.thumbnail || 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
    title.innerText = current.title;
    author.innerText = current.author || 'YouTube';
    requester.innerHTML = `Pedida por: <strong>@${current.requester}</strong> (${current.durationFormatted || '3:30'})`;

    if (ytPlayer && ytApiReady && current.videoId) {
      const currentVideoId = ytPlayer.getVideoData ? ytPlayer.getVideoData().video_id : null;
      if (currentVideoId !== current.videoId) {
        playYouTubeSong(current.videoId);
      }
    }
  } else {
    thumb.src = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
    title.innerText = 'No hay canción sonando';
    author.innerText = 'Pide una canción con !sr en el chat';
    requester.innerText = 'Esperando solicitudes...';
  }

  // Visualizer wave
  const wave = document.getElementById('srMusicWave');
  if (wave) {
    wave.style.display = current ? 'flex' : 'none';
  }

  // Render Queue List
  const queueContainer = document.getElementById('srQueueContainer');
  if (!queueContainer) return;

  if (queue.length === 0) {
    queueContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 36px 20px;">
        <div style="font-size: 32px; margin-bottom: 8px;">🎵</div>
        <div style="font-size: 14px; font-weight: 600; color: var(--text-secondary);">No hay canciones en cola actualmente</div>
        <div style="font-size: 12px; margin-top: 4px;">Tus espectadores pueden usar <code>!sr nombre de la canción</code> en Twitch.</div>
      </div>
    `;
    return;
  }

  queueContainer.innerHTML = '';
  queue.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    const thumbUrl = song.thumbnail || 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
    item.innerHTML = `
      <div class="queue-index">#${idx + 1}</div>
      <img class="queue-thumb" src="${escapeHtml(thumbUrl)}" alt="Thumb">
      <div class="queue-info">
        <div class="queue-title">${escapeHtml(song.title)}</div>
        <div class="queue-req">Pedida por <strong style="color: var(--cyan-accent);">@${escapeHtml(song.requester)}</strong> • ⏱️ ${song.durationFormatted || '3:30'}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeSongFromQueue('${song.id}')" title="Eliminar de la cola">🗑️</button>
    `;
    queueContainer.appendChild(item);
  });
}

// YouTube Player Integration
window.onYouTubeIframeAPIReady = function() {
  ytApiReady = true;
  ytPlayer = new YT.Player('youtubePlayerContainer', {
    height: '100%',
    width: '100%',
    videoId: '',
    playerVars: {
      autoplay: 1,
      controls: 1,
      modestbranding: 1
    },
    events: {
      onReady: (event) => {
        // Player ready
        if (appConfig?.songRequest?.volume !== undefined) {
          event.target.setVolume(appConfig.songRequest.volume);
        }
      },
      onStateChange: (event) => {
        // YT.PlayerState.ENDED is 0
        if (event.data === YT.PlayerState.ENDED) {
          skipCurrentSong();
        }
      }
    }
  });
};

let dashboardAudioMuted = false;

function toggleDashboardAudio() {
  dashboardAudioMuted = !dashboardAudioMuted;
  const btn = document.getElementById('btnSrMuteDashboard');
  if (ytPlayer) {
    if (dashboardAudioMuted) {
      if (ytPlayer.mute) ytPlayer.mute();
      if (btn) {
        btn.innerText = '🔇 Audio Panel: OFF';
        btn.classList.add('btn-danger');
        btn.classList.remove('btn-secondary');
      }
      showToast('Audio de este panel silenciado (ideal si usas audio vía OBS)', 'info');
    } else {
      if (ytPlayer.unMute) ytPlayer.unMute();
      if (btn) {
        btn.innerText = '🔊 Audio Panel: ON';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-secondary');
      }
      showToast('Audio de este panel activado', 'success');
    }
  }
}
window.toggleDashboardAudio = toggleDashboardAudio;

function playYouTubeSong(videoId) {
  if (ytPlayer && ytPlayer.loadVideoById) {
    ytPlayer.loadVideoById(videoId);
    if (dashboardAudioMuted && ytPlayer.mute) {
      ytPlayer.mute();
    }
    ytPlayer.playVideo();
  }
}

async function skipCurrentSong() {
  try {
    const res = await fetch('/api/sr/skip', { method: 'POST' });
    const data = await res.json();
    showToast(data.message || 'Canción saltada');
  } catch (e) {
    showToast('Error saltando canción', 'error');
  }
}

async function removeSongFromQueue(songId) {
  try {
    const res = await fetch('/api/sr/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: songId })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Canción eliminada de la cola');
    }
  } catch (e) {
    showToast('Error al eliminar canción', 'error');
  }
}

// ================= WIDGET SECURITY & PRIVATE TOKENS =================
function getEffectiveWidgetToken() {
  if (appConfig?.security?.widgetToken) {
    return appConfig.security.widgetToken;
  }
  let localToken = localStorage.getItem('orbibot_widget_token');
  if (!localToken) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      localToken = 'sec_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      localToken = 'sec_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    localStorage.setItem('orbibot_widget_token', localToken);
  }
  return localToken;
}

let isTokenVisible = false;
function toggleTokenVisibility() {
  isTokenVisible = !isTokenVisible;
  const input = document.getElementById('cfgWidgetTokenDisplay');
  const btn = document.getElementById('btnToggleTokenVisibility');
  if (input) {
    input.type = isTokenVisible ? 'text' : 'password';
  }
  if (btn) {
    btn.innerText = isTokenVisible ? '🙈' : '👁️';
  }
}
window.toggleTokenVisibility = toggleTokenVisibility;

function copyWidgetToken() {
  const token = getEffectiveWidgetToken();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(token).then(() => {
      showToast('🔒 Token secreto copiado al portapapeles', 'success');
    }).catch(() => {
      showToast('🔒 Token copiado', 'success');
    });
  } else {
    showToast('Token: ' + token, 'info');
  }
}
window.copyWidgetToken = copyWidgetToken;

async function regenerateWidgetTokenUI() {
  if (!confirm('¿Estás seguro de regenerar tu Clave Secreta de Widgets?\n\nTodos los enlaces anteriores dejarán de funcionar y deberás actualizar las URLs de tus fuentes de navegador en OBS Studio.')) {
    return;
  }

  let newToken = '';
  try {
    const res = await fetch('/api/config/widget-token/regenerate', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      newToken = data.widgetToken;
      if (appConfig) {
        if (!appConfig.security) appConfig.security = {};
        appConfig.security.widgetToken = newToken;
      }
    }
  } catch(e) {}

  if (!newToken) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      newToken = 'sec_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      newToken = 'sec_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    if (appConfig) {
      if (!appConfig.security) appConfig.security = {};
      appConfig.security.widgetToken = newToken;
    }
  }

  localStorage.setItem('orbibot_widget_token', newToken);
  populateWidgetUrls();
  showToast('🛡️ ¡Nueva Clave Secreta generada! Enlaces de OBS actualizados.', 'success');
}
window.regenerateWidgetTokenUI = regenerateWidgetTokenUI;

// ================= OBS WIDGET URLs =================
function populateWidgetUrls() {
  const origin = window.location.origin;
  const path = window.location.pathname.replace(/\/index\.html$/i, '').replace(/\/$/, '');
  const baseUrl = `${origin}${path}`;

  let channel = '';
  if (appConfig && appConfig.twitch && appConfig.twitch.channel) {
    channel = appConfig.twitch.channel.trim().toLowerCase().replace(/^#/, '');
  }
  if (!channel) {
    try {
      const localTwitch = localStorage.getItem('orbibot_twitch_auth');
      if (localTwitch) {
        const parsed = JSON.parse(localTwitch);
        if (parsed.channel) channel = parsed.channel.trim().toLowerCase().replace(/^#/, '');
      }
    } catch(e) {}
  }
  if (!channel) {
    const inputCh = document.getElementById('cfgTwitchChannel');
    if (inputCh && inputCh.value) {
      channel = inputCh.value.trim().toLowerCase().replace(/^#/, '');
    }
  }

  const token = getEffectiveWidgetToken();
  const tokenDisplay = document.getElementById('cfgWidgetTokenDisplay');
  if (tokenDisplay) {
    tokenDisplay.value = token;
  }

  const channelParam = channel ? `channel=${encodeURIComponent(channel)}` : '';
  const tokenParam = token ? `token=${encodeURIComponent(token)}` : '';

  const params = [channelParam, tokenParam].filter(Boolean).join('&');
  const qs = params ? `?${params}` : '';
  const goalParams = [channelParam, 'type=subs', tokenParam].filter(Boolean).join('&');
  const goalQs = goalParams ? `?${goalParams}` : '?type=subs';

  const alertsUrl = `${baseUrl}/overlays/alerts.html${qs}`;
  const npUrl = `${baseUrl}/overlays/nowplaying.html${qs}`;
  const goalUrl = `${baseUrl}/overlays/goals.html${goalQs}`;
  const musicPlayerUrl = `${baseUrl}/overlays/music_player.html${qs}`;
  const ttsUrl = `${baseUrl}/overlays/tts.html${qs}`;
  const chatUrl = `${baseUrl}/overlays/chat.html${qs}`;

  if (document.getElementById('urlAlertsWidget')) document.getElementById('urlAlertsWidget').value = alertsUrl;
  if (document.getElementById('urlNowPlayingWidget')) document.getElementById('urlNowPlayingWidget').value = npUrl;
  if (document.getElementById('urlGoalWidget')) document.getElementById('urlGoalWidget').value = goalUrl;
  if (document.getElementById('urlMusicPlayerWidget')) document.getElementById('urlMusicPlayerWidget').value = musicPlayerUrl;
  if (document.getElementById('urlTtsWidget')) document.getElementById('urlTtsWidget').value = ttsUrl;
  if (document.getElementById('urlChatWidget')) document.getElementById('urlChatWidget').value = chatUrl;

  // Actualizar enlaces de vista previa
  if (document.getElementById('btnPreviewAlerts')) document.getElementById('btnPreviewAlerts').href = alertsUrl;
  if (document.getElementById('btnPreviewNowPlaying')) document.getElementById('btnPreviewNowPlaying').href = npUrl;
  if (document.getElementById('btnPreviewGoal')) document.getElementById('btnPreviewGoal').href = goalUrl;
  if (document.getElementById('btnPreviewMusicPlayer')) document.getElementById('btnPreviewMusicPlayer').href = musicPlayerUrl;
  if (document.getElementById('btnPreviewTts')) document.getElementById('btnPreviewTts').href = ttsUrl;
  if (document.getElementById('btnPreviewChat')) document.getElementById('btnPreviewChat').href = chatUrl;

  const appBaseUrl = `${baseUrl}/`;
  if (document.getElementById('displayRedirectUri')) {
    document.getElementById('displayRedirectUri').innerText = appBaseUrl;
  }
  if (document.getElementById('cfgTwitchRedirectUri') && !document.getElementById('cfgTwitchRedirectUri').value) {
    document.getElementById('cfgTwitchRedirectUri').value = appBaseUrl;
  }
}

function copyWidgetUrl(inputId) {
  const el = document.getElementById(inputId);
  if (el) {
    const text = el.value || el.innerText || el.textContent;
    navigator.clipboard.writeText(text).then(() => {
      showToast('🔒 ¡Enlace privado copiado al portapapeles!', 'success');
    }).catch(() => {
      showToast('¡Copiado!', 'success');
    });
  }
}

function toggleWidgetUrlVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input) {
    if (input.type === 'password') {
      input.type = 'text';
      if (btn) btn.innerText = '🙈';
    } else {
      input.type = 'password';
      if (btn) btn.innerText = '👁️';
    }
  }
}
window.toggleWidgetUrlVisibility = toggleWidgetUrlVisibility;

// ================= EVENT TESTS =================
async function triggerTestAlert(type) {
  if (!isStreamerLoggedIn()) {
    showToast('⚠️ Debes iniciar sesión con tu cuenta de Twitch para probar las alertas en OBS Studio.', 'warn');
    return;
  }
  const payload = {
    type,
    user: 'EspectadorPro',
    amount: type === 'bits' ? 500 : 1,
    viewers: 45,
    tier: '1',
    reward: 'Saludo en Directo',
    message: '¡Excelente directo, crack! Saludos a todos.'
  };

  // Immediate multi-channel broadcast (for OBS Studio & browser)
  broadcastEvent('alert', payload);
  showToast(`¡Alerta de ${type.toUpperCase()} enviada a OBS Studio!`, 'success');

  try {
    await fetch('/api/alert/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

async function triggerTestTTS() {
  if (!isStreamerLoggedIn()) {
    showToast('⚠️ Debes iniciar sesión con tu cuenta de Twitch para probar TTS en OBS Studio.', 'warn');
    return;
  }
  const input = document.getElementById('testTtsInput');
  const text = (input ? input.value.trim() : '') || '¡Hola streamer! Este es un mensaje de prueba con Text to Speech en OBS.';
  const voice = document.getElementById('cfgTtsVoice')?.value || 'es_001';
  const volume = Number(document.getElementById('cfgTtsVolume')?.value || 90) / 100;
  const rate = Number(document.getElementById('cfgTtsRate')?.value || 1.0);
  const pitch = Number(document.getElementById('cfgTtsPitch')?.value || 1.0);

  const ttsData = {
    user: 'StreamerTest',
    text,
    voice,
    volume,
    rate,
    pitch,
    timestamp: Date.now()
  };

  // Transmitir inmediatamente por MQTT y WebSocket a la fuente de OBS
  broadcastEvent('tts', ttsData);
  showToast('Mensaje TTS enviado a OBS Studio', 'success');

  // Preview local en el navegador
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.volume = volume;
      u.rate = rate;
      u.pitch = pitch;
      window.speechSynthesis.speak(u);
    } catch(e) {}
  }

  try {
    await fetch('/api/tts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, user: 'StreamerTest', voice })
    });
  } catch (e) {}
}

// ================= GOALS UPDATE =================
async function saveGoalValues(type) {
  let title = '', current = 0, target = 100;
  if (type === 'subs') {
    title = document.getElementById('cfgGoalSubTitle').value;
    current = parseInt(document.getElementById('cfgGoalSubCurrent').value, 10) || 0;
    target = parseInt(document.getElementById('cfgGoalSubTarget').value, 10) || 50;
  } else if (type === 'followers') {
    title = document.getElementById('cfgGoalFollowTitle').value;
    current = parseInt(document.getElementById('cfgGoalFollowCurrent').value, 10) || 0;
    target = parseInt(document.getElementById('cfgGoalFollowTarget').value, 10) || 300;
  } else if (type === 'bits') {
    title = document.getElementById('cfgGoalBitsTitle').value;
    current = parseInt(document.getElementById('cfgGoalBitsCurrent').value, 10) || 0;
    target = parseInt(document.getElementById('cfgGoalBitsTarget').value, 10) || 5000;
  }

  // Transmitir a OBS inmediatamente
  broadcastEvent('goals_updated', { type, title, current, target });
  showToast(`Meta de ${type.toUpperCase()} actualizada en OBS`, 'success');

  try {
    await fetch('/api/goals/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, current, target })
    });
  } catch (e) {}
}

// ================= COMMANDS =================
// ================= COMMANDS =================
function renderCommands(commands) {
  const tbody = document.getElementById('commandsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  commands.forEach(cmd => {
    const tr = document.createElement('tr');
    const isZero = cmd.cooldown === 0 || cmd.cooldown === '0';
    const cooldownBadge = isZero 
      ? `<span class="btn btn-sm" style="font-size:11px; background: rgba(0, 242, 254, 0.2); color: var(--cyan-accent); border: 1px solid var(--cyan-accent);">Sin Cooldown (0s)</span>`
      : `<span class="btn btn-secondary btn-sm" style="font-size:11px;">${cmd.cooldown !== undefined ? cmd.cooldown : 10}s</span>`;

    tr.innerHTML = `
      <td><strong>${escapeHtml(cmd.name)}</strong></td>
      <td style="color: #cbd5e1; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(cmd.response)}</td>
      <td>${cooldownBadge}</td>
      <td style="display: flex; gap: 6px;">
        <button class="btn btn-secondary btn-sm" onclick="editCommand('${cmd.id}')" title="Editar comando">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCommand('${cmd.id}')" title="Eliminar">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleNoCooldown(checkbox) {
  const cooldownInput = document.getElementById('newCmdCooldown');
  if (checkbox && cooldownInput) {
    if (checkbox.checked) {
      cooldownInput.value = 0;
      cooldownInput.disabled = true;
    } else {
      if (Number(cooldownInput.value) <= 0) cooldownInput.value = 10;
      cooldownInput.disabled = false;
    }
  }
}

async function editCommand(cmdId) {
  try {
    const commands = await fetch('/api/commands').then(r => r.json());
    const cmd = commands.find(c => c.id === cmdId);
    if (!cmd) return;

    document.getElementById('editCmdId').value = cmd.id;
    document.getElementById('newCmdName').value = cmd.name;
    document.getElementById('newCmdResponse').value = cmd.response;
    const isZero = cmd.cooldown === 0 || cmd.cooldown === '0';
    document.getElementById('newCmdNoCooldown').checked = isZero;
    document.getElementById('newCmdCooldown').value = isZero ? 0 : (cmd.cooldown !== undefined ? cmd.cooldown : 10);
    document.getElementById('newCmdCooldown').disabled = isZero;
    document.getElementById('newCmdUserLevel').value = cmd.userLevel || 'all';

    document.getElementById('cmdFormTitle').innerText = `✏️ Editar Comando (${cmd.name})`;
    document.getElementById('btnSaveNewCommand').innerText = '💾 Actualizar Comando';
    document.getElementById('btnCancelEditCmd').style.display = 'inline-block';

    document.getElementById('newCmdName').focus();
    showToast(`Editando comando ${cmd.name}`, 'info');
  } catch(e) {}
}

function cancelEditCommand() {
  document.getElementById('editCmdId').value = '';
  document.getElementById('newCmdName').value = '';
  document.getElementById('newCmdResponse').value = '';
  document.getElementById('newCmdNoCooldown').checked = false;
  document.getElementById('newCmdCooldown').value = 10;
  document.getElementById('newCmdCooldown').disabled = false;
  document.getElementById('newCmdUserLevel').value = 'all';

  document.getElementById('cmdFormTitle').innerText = '➕ Crear / Editar Comando';
  document.getElementById('btnSaveNewCommand').innerText = 'Guardar Comando';
  document.getElementById('btnCancelEditCmd').style.display = 'none';
}

async function deleteCommand(cmdId) {
  const commands = await fetch('/api/commands').then(r => r.json());
  const filtered = commands.filter(c => c.id !== cmdId);
  const res = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtered)
  });
  const data = await res.json();
  renderCommands(data.commands);
  showToast('Comando eliminado');
}

// ================= REWARDS (PUNTOS DE CANAL) & SOUNDS =================
function renderRewards(rewards) {
  const tbody = document.getElementById('rewardsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  rewards.forEach(r => {
    const tr = document.createElement('tr');
    let actionBadge = `<span class="btn btn-secondary btn-sm">${r.action}</span>`;
    if (r.action === 'tts') actionBadge = `<span class="btn btn-primary btn-sm">🗣️ Voz TTS</span>`;
    if (r.action === 'song_request') actionBadge = `<span class="btn btn-accent btn-sm">🎶 Canción (VIP)</span>`;
    if (r.action === 'sound') actionBadge = `<span class="btn btn-sm" style="background:#f5a623; color:#000;">🔊 Sonido (${r.soundUrl ? r.soundUrl.split('/').pop() : 'Default'})</span>`;

    tr.innerHTML = `
      <td><strong>${escapeHtml(r.rewardName)}</strong></td>
      <td>${actionBadge}</td>
      <td>
        <button class="btn btn-accent btn-sm" onclick="testReward('${r.id}')" title="Probar en vivo">⚡ Probar</button>
      </td>
      <td style="display: flex; gap: 6px;">
        <button class="btn btn-secondary btn-sm" onclick="editReward('${r.id}')" title="Editar">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteReward('${r.id}')" title="Eliminar">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function syncTwitchRewardsUI() {
  showToast('Obteniendo recompensas de tu canal de Twitch...', 'info');
  try {
    let twRewards = [];
    const config = appConfig || JSON.parse(localStorage.getItem('orbibot_config') || '{}');
    const twitchCfg = config.twitch || {};

    // 1. Intentar obtener a través del backend
    try {
      const res = await fetch('/api/rewards/twitch');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.rewards) {
          twRewards = data.rewards;
        }
      }
    } catch(e) {}

    // 2. Si no hubo backend o estamos en frontend puro, consultar Twitch Helix con el token
    if (twRewards.length === 0 && twitchCfg.oauthToken && twitchCfg.userId) {
      try {
        const cleanToken = twitchCfg.oauthToken.replace(/^oauth:/i, '').trim();
        const helixRes = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${twitchCfg.userId}`, {
          headers: {
            'Client-Id': twitchCfg.clientId || 'yw1vr664ichms8an2x5lhji58v7ozk',
            'Authorization': `Bearer ${cleanToken}`
          }
        });
        if (helixRes.ok) {
          const helixData = await helixRes.json();
          twRewards = helixData.data || [];
        }
      } catch(e) {}
    }

    if (twRewards.length > 0) {
      const datalist = document.getElementById('twitchRewardsDatalist');
      if (datalist) {
        datalist.innerHTML = '';
        twRewards.forEach(tr => {
          const opt = document.createElement('option');
          opt.value = tr.title;
          datalist.appendChild(opt);
        });
      }

      // Sincronizar automáticamente IDs de las recompensas ya configuradas
      const localRewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
      let updated = false;
      localRewards.forEach(r => {
        const match = twRewards.find(tr => tr.title.trim().toLowerCase() === r.rewardName.trim().toLowerCase());
        if (match && r.rewardId !== match.id) {
          r.rewardId = match.id;
          updated = true;
        }
      });

      if (updated) {
        await fetch('/api/rewards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(localRewards)
        });
        renderRewards(localRewards);
      }

      showToast(`¡${twRewards.length} recompensas de Twitch vinculadas correctamente!`, 'success');
    } else {
      showToast('No se encontraron recompensas en Twitch o el bot no está autenticado.', 'warn');
    }
  } catch (err) {
    showToast(`Error al sincronizar: ${err.message}`, 'error');
  }
}

function toggleRewardForm(show) {
  const form = document.getElementById('rewardFormCard');
  if (!form) return;
  if (show === undefined) {
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  } else {
    form.style.display = show ? 'block' : 'none';
  }
  if (form.style.display === 'block') {
    loadSounds();
    syncTwitchRewardsUI();
  }
}

function handleRewardActionChange(action) {
  const group = document.getElementById('rewardSoundGroup');
  if (group) {
    group.style.display = action === 'sound' ? 'block' : 'none';
  }
}

async function loadSounds() {
  try {
    const sounds = await fetch('/api/sounds').then(r => r.json()).catch(() => []);
    const container = document.getElementById('soundListContainer');
    const select = document.getElementById('rewardSoundSelect');

    if (select) {
      select.innerHTML = '';
      if (sounds.length === 0) {
        select.innerHTML = '<option value="/assets/sounds/airhorn.mp3">airhorn.mp3 (Predeterminado)</option>';
      } else {
        sounds.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.url;
          opt.innerText = s.name;
          select.appendChild(opt);
        });
      }
    }

    if (container) {
      container.innerHTML = '';
      if (sounds.length === 0) {
        container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 20px;">No has subido sonidos aún. ¡Haz clic en <strong>Subir Sonido</strong> arriba!</div>`;
        return;
      }
      sounds.forEach(s => {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px 12px;';
        item.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
            <span style="font-size: 16px;">🔊</span>
            <span style="font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(s.name)}</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary btn-sm" onclick="previewSound('${s.url}')" title="Escuchar sonido">▶️ Escuchar</button>
          </div>
        `;
        container.appendChild(item);
      });
    }
  } catch (e) {
    console.warn('Error loading sounds:', e);
  }
}

function previewSound(url) {
  try {
    const a = new Audio(url);
    a.play().catch(e => showToast('Error al reproducir audio: ' + e.message, 'error'));
  } catch(e) {}
}

async function handleSoundFileUpload(input) {
  if (!input || !input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 15 * 1024 * 1024) {
    showToast('El archivo es demasiado grande (máximo 15MB)', 'error');
    return;
  }

  showToast(`Subiendo ${file.name}...`, 'info');
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const res = await fetch('/api/sounds/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          data: e.target.result
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`¡Sonido ${data.name} subido con éxito!`, 'success');
        await loadSounds();
        if (document.getElementById('rewardSoundSelect')) {
          document.getElementById('rewardSoundSelect').value = data.url;
        }
      } else {
        showToast(`Error: ${data.message || 'No se pudo subir'}`, 'error');
      }
    } catch(err) {
      showToast(`Error al subir sonido: ${err.message}`, 'error');
    }
  };
  reader.readAsDataURL(file);
  input.value = '';
}

async function saveRewardUI() {
  const name = document.getElementById('rewardNameInput').value.trim();
  const action = document.getElementById('rewardActionSelect').value;
  const soundUrl = document.getElementById('rewardSoundSelect')?.value || '/assets/sounds/airhorn.mp3';
  const editId = document.getElementById('editRewardId').value;

  if (!name) {
    showToast('Ingresa el nombre de la recompensa en Twitch', 'warn');
    return;
  }

  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const newReward = {
    id: editId || `reward-${Date.now()}`,
    rewardName: name,
    action,
    soundUrl: action === 'sound' ? soundUrl : null,
    enabled: true
  };

  const existingIdx = rewards.findIndex(r => r.id === newReward.id);
  if (existingIdx >= 0) {
    rewards[existingIdx] = newReward;
  } else {
    rewards.push(newReward);
  }

  await fetch('/api/rewards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rewards)
  });

  renderRewards(rewards);
  toggleRewardForm(false);
  document.getElementById('editRewardId').value = '';
  document.getElementById('rewardNameInput').value = '';
  showToast(`Recompensa "${name}" guardada`, 'success');
}

async function editReward(rewardId) {
  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const r = rewards.find(item => item.id === rewardId);
  if (!r) return;

  document.getElementById('editRewardId').value = r.id;
  document.getElementById('rewardNameInput').value = r.rewardName;
  document.getElementById('rewardActionSelect').value = r.action;
  handleRewardActionChange(r.action);
  if (r.soundUrl && document.getElementById('rewardSoundSelect')) {
    document.getElementById('rewardSoundSelect').value = r.soundUrl;
  }
  toggleRewardForm(true);
}

async function deleteReward(rewardId) {
  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const filtered = rewards.filter(r => r.id !== rewardId);
  await fetch('/api/rewards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtered)
  });
  renderRewards(filtered);
  showToast('Recompensa eliminada');
}

async function testReward(rewardId) {
  const rewards = await fetch('/api/rewards').then(r => r.json()).catch(() => []);
  const r = rewards.find(item => item.id === rewardId);
  if (!r) return;

  showToast(`Probando canje: ${r.rewardName}...`, 'info');

  if (r.action === 'tts') {
    broadcastEvent('tts', {
      user: 'VisorDePrueba',
      text: `¡Hola streamer! Este es un mensaje de prueba con puntos de canal para ${r.rewardName}`,
      source: 'channel_points',
      audioUrl: `https://api.streamelements.com/kappa/v2/speech?voice=Mia&text=${encodeURIComponent(`¡Hola streamer! Este es un mensaje de prueba con puntos de canal para ${r.rewardName}`)}`
    });
    broadcastEvent('alert', {
      type: 'channel_points',
      user: 'VisorDePrueba',
      reward: r.rewardName,
      message: '¡Probando canje de TTS con puntos!'
    });
  } else if (r.action === 'song_request') {
    await fetch('/api/sr/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Daft Punk One More Time', requester: 'VisorVIP' })
    }).catch(() => {});
    showToast('Canción añadida con prioridad VIP a la cola', 'success');
  } else if (r.action === 'sound') {
    broadcastEvent('alert', {
      type: 'sound',
      user: 'VisorDePrueba',
      reward: r.rewardName,
      soundUrl: r.soundUrl || '/assets/sounds/airhorn.mp3'
    });
    previewSound(r.soundUrl || '/assets/sounds/airhorn.mp3');
  }
}

// ================= AUTO-SAVE SYSTEM =================
let autoSaveTimer = null;
let toastAutoSaveDebounce = null;

function setAutoSaveStatus(status) {
  const dot = document.getElementById('autoSaveDot');
  const text = document.getElementById('autoSaveText');
  const indicator = document.getElementById('autoSaveIndicator');
  if (!dot || !text) return;

  if (status === 'saving') {
    dot.style.background = '#f59e0b';
    dot.style.boxShadow = '0 0 10px rgba(245, 158, 11, 0.8)';
    text.innerText = 'Guardando...';
    if (indicator) indicator.style.borderColor = 'rgba(245, 158, 11, 0.4)';
  } else if (status === 'saved') {
    dot.style.background = '#10b981';
    dot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.8)';
    text.innerText = 'Cambios guardados';
    if (indicator) indicator.style.borderColor = 'rgba(16, 185, 129, 0.3)';

    setTimeout(() => {
      if (text && text.innerText === 'Cambios guardados') {
        text.innerText = 'Autoguardado activo';
        if (indicator) indicator.style.borderColor = 'rgba(255, 255, 255, 0.08)';
      }
    }, 2500);
  } else if (status === 'error') {
    dot.style.background = '#ef4444';
    dot.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.8)';
    text.innerText = 'Error al guardar';
    if (indicator) indicator.style.borderColor = 'rgba(239, 68, 68, 0.4)';
  }
}

function triggerAutoSave(delay = 500, notify = true) {
  setAutoSaveStatus('saving');
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    await saveAllConfig(notify);
  }, delay);
}

function setupAutoSaveListeners() {
  const configInputIds = [
    'cfgTwitchChannel', 'cfgTwitchBotUser', 'cfgTwitchToken', 'cfgTwitchClientId',
    'cfgSrPrefix', 'cfgSrUserLevel', 'cfgSrMaxDuration', 'cfgSrMaxPerUser', 'cfgSrEnabled',
    'cfgTtsEnabled', 'cfgTtsVoice', 'cfgTtsVolume', 'cfgTtsRate', 'cfgTtsPitch',
    'cfgTtsMaxLength', 'cfgTtsBannedWords', 'cfgTtsAllowCommand', 'cfgTtsCommand', 'cfgTtsMinBits'
  ];

  configInputIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.addEventListener('change', () => triggerAutoSave(100, true));
    } else if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => triggerAutoSave(100, true));
    } else if (el.type === 'range') {
      el.addEventListener('input', () => triggerAutoSave(400, true));
      el.addEventListener('change', () => triggerAutoSave(100, true));
    } else {
      el.addEventListener('input', () => triggerAutoSave(600, true));
      el.addEventListener('change', () => triggerAutoSave(100, true));
    }
  });

  // Metas (Goals: Subs, Follows, Bits) auto-save on input and change
  const goalConfigs = [
    { type: 'subs', ids: ['cfgGoalSubTitle', 'cfgGoalSubCurrent', 'cfgGoalSubTarget'] },
    { type: 'followers', ids: ['cfgGoalFollowTitle', 'cfgGoalFollowCurrent', 'cfgGoalFollowTarget'] },
    { type: 'bits', ids: ['cfgGoalBitsTitle', 'cfgGoalBitsCurrent', 'cfgGoalBitsTarget'] }
  ];

  goalConfigs.forEach(g => {
    let goalTimer = null;
    g.ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const onGoalChange = (delay) => {
        setAutoSaveStatus('saving');
        if (goalTimer) clearTimeout(goalTimer);
        goalTimer = setTimeout(() => {
          saveGoalValues(g.type);
          setAutoSaveStatus('saved');
        }, delay);
      };
      el.addEventListener('input', () => onGoalChange(600));
      el.addEventListener('change', () => onGoalChange(100));
    });
  });
}

// ================= SAVE CONFIG =================
async function saveAllConfig(showNotification = true) {
  const bannedWords = (document.getElementById('cfgTtsBannedWords')?.value || '')
    .split(',')
    .map(w => w.trim())
    .filter(Boolean);

  const payload = {
    twitch: {
      channel: document.getElementById('cfgTwitchChannel')?.value.trim() || '',
      botUsername: document.getElementById('cfgTwitchBotUser')?.value.trim() || '',
      oauthToken: document.getElementById('cfgTwitchToken')?.value.trim() || ''
    },
    songRequest: {
      prefix: document.getElementById('cfgSrPrefix')?.value.trim() || '!sr',
      userLevel: document.getElementById('cfgSrUserLevel')?.value || 'all',
      maxDurationMinutes: Number(document.getElementById('cfgSrMaxDuration')?.value) || 8,
      maxPerUser: Number(document.getElementById('cfgSrMaxPerUser')?.value) || 5,
      enabled: Boolean(document.getElementById('cfgSrEnabled')?.checked)
    },
    tts: {
      enabled: Boolean(document.getElementById('cfgTtsEnabled')?.checked),
      voice: document.getElementById('cfgTtsVoice')?.value || 'es-ES-Standard-A',
      volume: Number(document.getElementById('cfgTtsVolume')?.value ?? 80),
      rate: Number(document.getElementById('cfgTtsRate')?.value ?? 1),
      pitch: Number(document.getElementById('cfgTtsPitch')?.value ?? 0),
      maxLength: Number(document.getElementById('cfgTtsMaxLength')?.value ?? 250),
      bannedWords,
      allowChatCommand: Boolean(document.getElementById('cfgTtsAllowCommand')?.checked),
      chatCommand: document.getElementById('cfgTtsCommand')?.value.trim() || '!tts',
      minBits: Number(document.getElementById('cfgTtsMinBits')?.value ?? 50)
    }
  };

  try {
    let cfg = JSON.parse(localStorage.getItem('orbibot_config') || '{}');
    cfg = { ...cfg, ...payload };
    localStorage.setItem('orbibot_config', JSON.stringify(cfg));
    if (payload.twitch.channel) {
      let twAuth = JSON.parse(localStorage.getItem('orbibot_twitch_auth') || '{}');
      twAuth.channel = payload.twitch.channel;
      twAuth.botUsername = payload.twitch.botUsername;
      twAuth.oauthToken = payload.twitch.oauthToken;
      localStorage.setItem('orbibot_twitch_auth', JSON.stringify(twAuth));
    }
  } catch(e) {}

  populateWidgetUrls();
  initDashboardMqtt();

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      appConfig = data.config;
      const statChan = document.getElementById('statChannelName');
      if (statChan) statChan.innerText = payload.twitch.channel ? `#${payload.twitch.channel}` : 'Ninguno';
      setAutoSaveStatus('saved');
      if (showNotification) {
        if (toastAutoSaveDebounce) clearTimeout(toastAutoSaveDebounce);
        toastAutoSaveDebounce = setTimeout(() => {
          showToast('✅ Cambios guardados automáticamente', 'success');
        }, 300);
      }
    }
  } catch (e) {
    setAutoSaveStatus('saved');
    if (showNotification) {
      if (toastAutoSaveDebounce) clearTimeout(toastAutoSaveDebounce);
      toastAutoSaveDebounce = setTimeout(() => {
        showToast('Configuración guardada localmente.', 'info');
      }, 300);
    }
  }
}

// ================= EVENT LISTENERS SETUP =================
function setupEventListeners() {
  // Save global button (si existe)
  const saveBtn = document.getElementById('saveGlobalBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveAllConfig(true));
  }

  // Quick alert test button (si existe)
  const quickAlertBtn = document.getElementById('testAlertQuickBtn');
  if (quickAlertBtn) {
    quickAlertBtn.addEventListener('click', () => {
      triggerTestAlert('follower');
    });
  }

  // Connect / Disconnect Twitch
  document.getElementById('btnConnectTwitch').addEventListener('click', async () => {
    await saveAllConfig(false);
    showToast('Iniciando conexión con Twitch...', 'info');
    try {
      const res = await fetch('/api/bot/connect', { method: 'POST' });
      const data = await res.json();
      showToast(data.message, data.success ? 'success' : 'warn');
    } catch (e) {
      showToast('Error de conexión', 'error');
    }
  });

  document.getElementById('btnDisconnectTwitch').addEventListener('click', () => {
    openLogoutModal();
  });

  // Direct Twitch OAuth Authentication
  let activeAuthPopup = null;

  function getTwitchRedirectUri() {
    const custom = document.getElementById('cfgTwitchRedirectUri')?.value?.trim();
    if (custom) return custom;
    const cleanPath = window.location.pathname.replace(/\/index\.html$/i, '').replace(/\/$/, '');
    return `${window.location.origin}${cleanPath}/`;
  }

  function triggerTwitchOAuthLogin() {
    const customClientId = document.getElementById('cfgTwitchClientId')?.value?.trim();
    const clientId = customClientId || 'yw1vr664ichms8an2x5lhji58v7ozk';
    const redirectUri = getTwitchRedirectUri();
    const scopes = encodeURIComponent('chat:read chat:edit channel:read:redemptions bits:read channel:read:subscriptions');

    const twitchAuthUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${scopes}&state=popup&force_verify=true`;

    const width = 560, height = 750;
    const left = Math.max(0, (window.innerWidth - width) / 2 + window.screenX);
    const top = Math.max(0, (window.innerHeight - height) / 2 + window.screenY);

    showToast('Abriendo ventana segura de inicio de sesión con Twitch...', 'info');

    // Clean any prior auth event or error
    localStorage.removeItem('orbibot_twitch_auth_event');
    localStorage.removeItem('orbibot_twitch_auth_error');

    activeAuthPopup = window.open(twitchAuthUrl, 'TwitchOAuthLogin', `width=${width},height=${height},top=${top},left=${left},status=no,menubar=no,toolbar=no,scrollbars=yes`);
    if (!activeAuthPopup || activeAuthPopup.closed || typeof activeAuthPopup.closed === 'undefined') {
      window.location.href = twitchAuthUrl;
      return;
    }

    let pollCount = 0;
    const authPollInterval = setInterval(async () => {
      pollCount++;

      // 1. Check for success
      const rawEvent = localStorage.getItem('orbibot_twitch_auth_event');
      if (rawEvent) {
        clearInterval(authPollInterval);
        localStorage.removeItem('orbibot_twitch_auth_event');
        try {
          if (activeAuthPopup && !activeAuthPopup.closed) activeAuthPopup.close();
        } catch(e) {}
        activeAuthPopup = null;

        try {
          const payload = JSON.parse(rawEvent);
          await handleAuthSuccess(payload);
        } catch(err) {
          console.error('Error handling auth success payload:', err);
        }
        return;
      }

      // 2. Check for error (e.g. redirect_mismatch)
      const rawError = localStorage.getItem('orbibot_twitch_auth_error');
      if (rawError) {
        clearInterval(authPollInterval);
        localStorage.removeItem('orbibot_twitch_auth_error');
        try {
          const errData = JSON.parse(rawError);
          showToast(`⚠️ Twitch: ${errData.desc || errData.error}`, 'error');
        } catch(e) {}
        return;
      }

      if (pollCount > 600) {
        clearInterval(authPollInterval);
      }
    }, 300);
  }

  // Handle successful OAuth event
  async function handleAuthSuccess(payload) {
    if (activeAuthPopup) {
      try { activeAuthPopup.close(); } catch(e) {}
      activeAuthPopup = null;
    }
    try { window.focus(); } catch(e) {}

    let user = payload.user || payload.data?.user || {};
    const token = (payload.token || payload.oauthToken || '').replace(/^oauth:/i, '').trim();
    let displayName = user.display_name || user.login || '';
    let avatarUrl = user.profile_image_url || '';
    let channelName = (user.login || user.channel || (displayName ? displayName.toLowerCase() : '') || '').replace(/^#/, '');

    // If channelName or displayName is missing, validate token directly with Twitch
    if ((!channelName || !displayName) && token) {
      try {
        const valRes = await fetch('https://id.twitch.tv/oauth2/validate', {
          headers: { 'Authorization': `OAuth ${token}` }
        });
        if (valRes.ok) {
          const valData = await valRes.json();
          channelName = valData.login || channelName;
          displayName = displayName || valData.login;
          if (!avatarUrl) {
            try {
              const uRes = await fetch(`https://api.twitch.tv/helix/users?id=${valData.user_id}`, {
                headers: { 'Client-Id': valData.client_id, 'Authorization': `Bearer ${token}` }
              });
              if (uRes.ok) {
                const uData = await uRes.json();
                if (uData.data?.length > 0) {
                  displayName = uData.data[0].display_name || displayName;
                  avatarUrl = uData.data[0].profile_image_url || avatarUrl;
                }
              }
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    if (!channelName && displayName) {
      channelName = displayName.toLowerCase();
    }

    const twitchCfg = {
      channel: channelName,
      botUsername: channelName,
      oauthToken: token,
      clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
      displayName: displayName || channelName,
      profileImage: avatarUrl || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb60-aee8f1560db5-profile_image-300x300.png',
      userId: user.user_id || '',
      connected: true
    };

    localStorage.setItem('orbibot_twitch_auth', JSON.stringify(twitchCfg));
    try {
      let cfg = JSON.parse(localStorage.getItem('orbibot_config') || '{}');
      cfg.twitch = { ...(cfg.twitch || {}), ...twitchCfg };
      localStorage.setItem('orbibot_config', JSON.stringify(cfg));
    } catch(e) {}

    if (appConfig) {
      appConfig.twitch = { ...(appConfig.twitch || {}), ...twitchCfg };
    } else {
      appConfig = { twitch: twitchCfg };
    }

    showToast(`🎉 ¡Sesión iniciada con éxito! Bienvenido, @${displayName || channelName}`, 'success');

    // Submit token to backend if available and resync from DB
    if (token) {
      try {
        const authRes = await fetch('/api/auth/twitch-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, channel: channelName })
        });
        if (authRes.ok) {
          const authData = await authRes.json();
          if (authData.config) {
            appConfig = authData.config;
          }
        }
      } catch (e) {}
    }

    await loadInitialData();
    bindConfigToUI(appConfig);
    showDashboardView('tab-dashboard');
    populateWidgetUrls();
    initDashboardMqtt();
    if (typeof initWidgetCustomization === 'function') initWidgetCustomization();

    if (channelName && window.tmi) {
      connectInBrowserTwitchBot(twitchCfg);
    }
  }

  // ================= LOGOUT CONFIRMATION MODAL & EXECUTION =================
  const logoutConfirmModal = document.getElementById('logoutConfirmModal');
  const logoutModalBackdrop = document.getElementById('logoutModalBackdrop');
  const btnCancelLogout = document.getElementById('btnCancelLogout');
  const btnConfirmLogout = document.getElementById('btnConfirmLogout');
  const logoutModalUser = document.getElementById('logoutModalUser');
  const logoutModalAvatar = document.getElementById('logoutModalAvatar');
  const logoutModalDisplayName = document.getElementById('logoutModalDisplayName');

  function openLogoutModal() {
    let currentChannel = (appConfig?.twitch?.channel || '').replace(/^#/, '');
    let currentDisplayName = appConfig?.twitch?.displayName || currentChannel || 'Streamer';
    let currentAvatar = appConfig?.twitch?.profileImage || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb60-aee8f1560db5-profile_image-300x300.png';

    if (!currentChannel) {
      try {
        const local = localStorage.getItem('orbibot_twitch_auth');
        if (local) {
          const p = JSON.parse(local);
          currentChannel = (p.channel || p.login || '').replace(/^#/, '');
          currentDisplayName = p.displayName || currentChannel || 'Streamer';
          currentAvatar = p.profileImage || currentAvatar;
        }
      } catch(e) {}
    }

    if (logoutModalUser) logoutModalUser.innerText = `@${currentChannel || currentDisplayName || 'streamer'}`;
    if (logoutModalDisplayName) logoutModalDisplayName.innerText = currentDisplayName || 'Streamer';
    if (logoutModalAvatar) logoutModalAvatar.src = currentAvatar;

    if (logoutConfirmModal) {
      logoutConfirmModal.style.display = 'flex';
    }
  }

  function closeLogoutModal() {
    if (logoutConfirmModal) {
      logoutConfirmModal.style.display = 'none';
    }
  }

  async function executeLogout() {
    closeLogoutModal();

    try {
      await fetch('/api/bot/disconnect', { method: 'POST' });
    } catch (e) {}

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}

    // Clear ALL Twitch credentials & cached settings from localStorage
    localStorage.removeItem('orbibot_twitch_auth');
    localStorage.removeItem('orbibot_twitch_auth_event');
    localStorage.removeItem('orbibot_twitch_auth_error');
    localStorage.removeItem('orbibot_config');

    if (browserTmiClient) {
      try { browserTmiClient.disconnect(); } catch(e) {}
      browserTmiClient = null;
    }

    // Explicitly reset in-memory config state
    appConfig = {
      twitch: {
        channel: '',
        botUsername: '',
        oauthToken: '',
        clientId: 'yw1vr664ichms8an2x5lhji58v7ozk',
        connected: false,
        displayName: '',
        profileImage: '',
        userId: ''
      },
      songRequest: { prefix: '!sr', enabled: true, maxDurationMinutes: 8, maxPerUser: 5, userLevel: 'all', volume: 75, autoplay: true },
      tts: { enabled: true, voice: 'es_001', volume: 90, rate: 1.0, pitch: 1.0, maxLength: 250, bannedWords: [], allowChatCommand: true, chatCommand: '!tts', minBits: 50 },
      goals: {
        subs: { title: 'Meta de Suscriptores', current: 0, target: 50, color: '#9146ff' },
        followers: { title: 'Meta de Seguidores', current: 0, target: 300, color: '#00f2fe' },
        bits: { title: 'Meta de Bits', current: 0, target: 5000, color: '#f5a623' }
      }
    };

    // Reset Top Bar & Header Profile Display
    const topUserPill = document.getElementById('topUserPill');
    const topLoginBtn = document.getElementById('topTwitchLoginBtn');
    const loginHero = document.getElementById('dashboardLoginHero');
    const connectedHero = document.getElementById('dashboardConnectedHero');
    const dashUserAvatar = document.getElementById('dashUserAvatar');
    const dashUserName = document.getElementById('dashUserName');
    const dashUserTag = document.getElementById('dashUserTag');
    const topUserAvatar = document.getElementById('topUserAvatar');
    const topUserName = document.getElementById('topUserName');

    const botStatusDot = document.getElementById('botStatusDot');
    const botStatusText = document.getElementById('botStatusText');
    const twitchBadge = document.getElementById('twitchConnectionBadge');
    const statBotStatus = document.getElementById('statBotStatus');
    const statChannelName = document.getElementById('statChannelName');
    const quickConnectBtn = document.getElementById('quickConnectBtn');

    if (topUserPill) topUserPill.style.display = 'none';
    if (topLoginBtn) topLoginBtn.style.display = 'inline-flex';
    if (loginHero) loginHero.style.display = 'block';
    if (connectedHero) connectedHero.style.display = 'none';

    if (topUserAvatar) topUserAvatar.src = '';
    if (topUserName) topUserName.innerText = '@streamer';
    if (dashUserAvatar) dashUserAvatar.src = '';
    if (dashUserName) dashUserName.innerText = 'Streamer';
    if (dashUserTag) dashUserTag.innerText = '@streamer';

    if (botStatusDot) botStatusDot.className = 'status-dot disconnected';
    if (botStatusText) botStatusText.innerText = 'Desconectado';
    if (twitchBadge) {
      twitchBadge.className = 'btn btn-sm btn-danger';
      twitchBadge.innerText = '🔴 Desconectado';
    }
    if (statBotStatus) {
      statBotStatus.innerText = 'Inactivo';
      statBotStatus.style.color = 'var(--red-danger)';
    }
    if (statChannelName) statChannelName.innerText = 'Ninguno';
    if (quickConnectBtn) {
      quickConnectBtn.innerText = 'Iniciar Sesión';
      quickConnectBtn.className = 'btn btn-primary btn-sm';
    }

    const chanInput = document.getElementById('cfgTwitchChannel');
    const botInput = document.getElementById('cfgTwitchBotUser');
    const tokenInput = document.getElementById('cfgTwitchToken');
    if (chanInput) chanInput.value = '';
    if (botInput) botInput.value = '';
    if (tokenInput) tokenInput.value = '';

    // Clear chat list
    const chatList = document.getElementById('chatMessagesList');
    if (chatList) {
      chatList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 40px 20px; font-size: 13px;">Conecta tu canal de Twitch para ver los mensajes del chat en tiempo real.</div>';
    }

    bindConfigToUI(appConfig);
    populateWidgetUrls();
    initDashboardMqtt();
    updatePlatformLinkingUI();

    showToast('🔒 Has cerrado sesión de Twitch correctamente.', 'info');
    switchTab('tab-dashboard');
  }

  function disconnectTwitchAccount() {
    openLogoutModal();
  }

  // Modal Buttons
  if (btnCancelLogout) btnCancelLogout.addEventListener('click', closeLogoutModal);
  if (logoutModalBackdrop) logoutModalBackdrop.addEventListener('click', closeLogoutModal);
  if (btnConfirmLogout) btnConfirmLogout.addEventListener('click', executeLogout);

  // Twitch Login Buttons
  const topLoginBtn = document.getElementById('topTwitchLoginBtn');
  if (topLoginBtn) topLoginBtn.addEventListener('click', triggerTwitchOAuthLogin);

  const heroLoginBtn = document.getElementById('heroTwitchLoginBtn');
  if (heroLoginBtn) heroLoginBtn.addEventListener('click', triggerTwitchOAuthLogin);

  // Twitch Logout Buttons
  const topLogoutBtn = document.getElementById('topLogoutBtn');
  if (topLogoutBtn) topLogoutBtn.addEventListener('click', openLogoutModal);

  const dashLogoutBtn = document.getElementById('dashLogoutBtn');
  if (dashLogoutBtn) dashLogoutBtn.addEventListener('click', openLogoutModal);

  // Dashboard quick actions
  const dashGotoObsBtn = document.getElementById('dashGotoObsBtn');
  if (dashGotoObsBtn) dashGotoObsBtn.addEventListener('click', () => switchTab('tab-overlays'));

  const dashGotoSrBtn = document.getElementById('dashGotoSrBtn');
  if (dashGotoSrBtn) dashGotoSrBtn.addEventListener('click', () => switchTab('tab-sr'));

  const dashGotoTtsBtn = document.getElementById('dashGotoTtsBtn');
  if (dashGotoTtsBtn) dashGotoTtsBtn.addEventListener('click', () => switchTab('tab-tts'));

  // Listen for OAuth callback message from popup if opener works
  window.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'TWITCH_AUTH_SUCCESS') {
      await handleAuthSuccess(event.data);
    }
  });

  // Sidebar Quick Connect Button
  const quickConnectBtn = document.getElementById('quickConnectBtn');
  if (quickConnectBtn) {
    quickConnectBtn.addEventListener('click', async () => {
      const isConnected = (appConfig?.twitch?.connected || Boolean(localStorage.getItem('orbibot_twitch_auth'))) && (appConfig?.twitch?.channel || localStorage.getItem('orbibot_twitch_auth'));
      if (isConnected) {
        openLogoutModal();
      } else {
        triggerTwitchOAuthLogin();
      }
    });
  }

  // Song Request Controls
  document.getElementById('btnSrSkip').addEventListener('click', skipCurrentSong);
  
  document.getElementById('btnSrClear').addEventListener('click', async () => {
    if (confirm('¿Seguro que deseas vaciar toda la cola de canciones?')) {
      const res = await fetch('/api/sr/clear', { method: 'POST' });
      const data = await res.json();
      showToast(`Cola vaciada (${data.count} canciones eliminadas)`);
    }
  });

  document.getElementById('btnSrAddManual').addEventListener('click', async () => {
    const input = document.getElementById('srManualInput');
    const query = input.value.trim();
    if (!query) return;

    showToast('Buscando y añadiendo canción...', 'info');
    try {
      const res = await fetch('/api/sr/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, requester: 'Streamer' })
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
        input.value = '';
      } else {
        showToast(data.message, 'warn');
      }
    } catch (e) {
      showToast('Error al añadir canción', 'error');
    }
  });

  // TTS Test
  document.getElementById('btnTestTtsPlay').addEventListener('click', triggerTestTTS);

  // Save or Update Command
  document.getElementById('btnSaveNewCommand').addEventListener('click', async () => {
    const name = document.getElementById('newCmdName').value.trim();
    const response = document.getElementById('newCmdResponse').value.trim();
    const noCooldown = document.getElementById('newCmdNoCooldown')?.checked;
    const cooldownVal = Number(document.getElementById('newCmdCooldown').value);
    const cooldown = noCooldown ? 0 : (isNaN(cooldownVal) ? 10 : Math.max(0, cooldownVal));
    const userLevel = document.getElementById('newCmdUserLevel').value;
    const editId = document.getElementById('editCmdId')?.value;

    if (!name || !response) {
      showToast('Debes ingresar el nombre del comando y su respuesta', 'warn');
      return;
    }

    const formattedName = name.startsWith('!') ? name : `!${name}`;
    const commands = await fetch('/api/commands').then(r => r.json());

    const targetIdx = editId 
      ? commands.findIndex(c => c.id === editId)
      : commands.findIndex(c => c.name.toLowerCase() === formattedName.toLowerCase());

    const newCmd = {
      id: targetIdx >= 0 ? commands[targetIdx].id : `cmd-${Date.now()}`,
      name: formattedName,
      response,
      cooldown,
      userLevel,
      enabled: true
    };

    if (targetIdx >= 0) {
      commands[targetIdx] = newCmd;
    } else {
      commands.push(newCmd);
    }

    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commands)
    });
    const data = await res.json();
    renderCommands(data.commands);
    showToast(`Comando ${formattedName} guardado con éxito`, 'success');
    cancelEditCommand();
  });

  // Load custom sounds on startup
  loadSounds();
}

// ================= WIDGET CUSTOMIZATION SYSTEM =================
let wcCurrentWidget = 'alerts';
let wcCurrentMode = 'visual';
let wcActiveAlertEvent = 'follower';
let wcWidgetStyles = {};
let wcAlertImages = {
  follower: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdWk1YW0yZXpxM3c2NHJreGQxbDduMWVvb3hpZGl2dHVqMm1pMG1jYyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/artj92V8o75VPL7AeQ/giphy.gif',
  sub: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOHF4bWpna2JpcXpiZWhqZXE1aXF3MHp4eGpoMXE1bmRhNDVvNXppZSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/IwAZ6dvvvaNN6/giphy.gif',
  bits: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeGJ3eG5obHRwZjcxNHNlNW56dzd2dXB1NmJhcWlnM3c5enIydTFoYSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/LdOyjZ7io5MFUvcKs2/giphy.gif',
  raid: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd2Z0dTh1Z3E0cW51ZnRtdnExNmRwbTN4eWxnd2ZtN213MWg5bmk0eCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/blSTtZehjAZ8I/giphy.gif',
  channel_points: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOW11aWRqZG56YWNka2R3N3N6M2cydDV0OW15bmw0NWJ1ZW51bnd4eiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/111ebonMs90YLu/giphy.gif'
};

let wcAlertSounds = {
  follower: '/assets/sounds/campana_alerta.wav',
  sub: '/assets/sounds/campana_alerta.wav',
  bits: '/assets/sounds/notificacion_puntos.wav',
  raid: '/assets/sounds/airhorn.mp3',
  channel_points: '/assets/sounds/notificacion_puntos.wav'
};

const WC_WIDGET_NAMES = {
  alerts: 'Alert Box',
  nowplaying: 'Now Playing',
  goals: 'Goal Bar',
  chat: 'Chat Overlay'
};

const WC_EVENT_NAMES = {
  follower: 'Seguidor',
  sub: 'Suscripción',
  bits: 'Donación de Bits',
  raid: 'Raid Entrante',
  channel_points: 'Puntos de Canal'
};

const WC_EVENT_PREVIEWS = {
  follower: { badge: 'NUEVO SEGUIDOR', title: '¡StreamerFan123!', msg: 'ahora sigue el canal' },
  sub: { badge: '¡NUEVA SUSCRIPCIÓN!', title: '¡SubVIP_Gamer!', msg: 'se suscribió al canal (Nivel 1)' },
  bits: { badge: 'DONACIÓN DE BITS', title: '¡GamerPro99!', msg: 'envió 500 Bits "¡Gran stream!"' },
  raid: { badge: 'RAID ENTRANTE', title: '¡CapitánRaid!', msg: 'llegó con 45 espectadores' },
  channel_points: { badge: 'PUNTOS DE CANAL', title: '¡ViewerActivo!', msg: 'canjeó "Mensaje Destacado"' }
};

const WC_DEFAULT_VALUES = {
  alerts: { fontFamily: "'Outfit', sans-serif", bgColor:'#0b0e14', bgOpacity:88, titleColor:'#ffffff', messageColor:'#cbd5e1', accentColor:'#9146ff', titleSize:32, messageSize:20, borderRadius:24, imageSize:120, customCSS:'', customJS:'' },
  nowplaying: { fontFamily: "'Outfit', sans-serif", bgColor:'#0f121a', bgOpacity:90, titleColor:'#ffffff', requesterColor:'#9146ff', titleSize:16, borderRadius:18, thumbSize:64, customCSS:'', customJS:'' },
  goals: { fontFamily: "'Outfit', sans-serif", barColor:'#9146ff', barColor2:'#00f2fe', bgColor:'#0e121c', bgOpacity:92, barHeight:18, fontSize:15, borderRadius:18, customCSS:'', customJS:'' },
  chat: { fontFamily: "'Outfit', sans-serif", bubbleBg:'#0f141e', bgOpacity:85, usernameColor:'#9146ff', textColor:'#f1f5f9', fontSize:14, borderRadius:14, borderLeftWidth:4, borderLeftColor:'#9146ff', customCSS:'', customJS:'' }
};

const WC_PRESET_GIFS = {
  follower: [
    { name: "Pikachu Saludo", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdWk1YW0yZXpxM3c2NHJreGQxbDduMWVvb3hpZGl2dHVqMm1pMG1jYyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/artj92V8o75VPL7AeQ/giphy.gif" },
    { name: "Gatito Feliz", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExMjRqa2p6N2Z2c2R0b2s5OXF1bXk4bHhqa3p2Z3BhMGYwb283ZDNyOCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/MDJ9IbxxvDUQM/giphy.gif" },
    { name: "Kirby Baile", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd2RtcW9hNnl6OXh0eGg5Z3pxMXdpdW9vODFwcm5tM3g1Y3l4OXVsayZlcD12MV9naWZzX3NlYXJjaCZjdD1n/5gUnOrltPvZzW/giphy.gif" },
    { name: "Sonic Bienvenida", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNmN0d2psNWtwZmRzMGJrdmszM2R2MXd2YWRnOTlvOWV5eHlzMndkayZlcD12MV9naWZzX3NlYXJjaCZjdD1n/111ebonMs90YLu/giphy.gif" }
  ],
  sub: [
    { name: "Fiesta Confetti", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOHF4bWpna2JpcXpiZWhqZXE1aXF3MHp4eGpoMXE1bmRhNDVvNXppZSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/IwAZ6dvvvaNN6/giphy.gif" },
    { name: "Minion Festejo", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExaGtpNjA5bTZodjVjdzV6c25lZmt1bGVpNWtseHNld2Qxd2c1NmF1NSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/3o7TKSjRrfIPjeiVyM/giphy.gif" },
    { name: "Daft Punk Dance", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNWw4djNudDhtYmpxZ2c1M3dzbmJmbmd3eHlzb21mNzhsaXpvczJjOCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/l3vRlT2k2L35Cnn5C/giphy.gif" },
    { name: "Goku Super Saiyan", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNmJpcnd4OGM4NXBxaHZqMnZ0aHlxbW50NHl3aXp6Y2NsdG56eTZzMyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/97HXn1oGkn37G/giphy.gif" }
  ],
  bits: [
    { name: "Lluvia de Dinero", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeGJ3eG5obHRwZjcxNHNlNW56dzd2dXB1NmJhcWlnM3c5enIydTFoYSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/LdOyjZ7io5MFUvcKs2/giphy.gif" },
    { name: "Cofre del Tesoro", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExaTJveXprZHdrZzB0MnlxbGtsMDkyaW5pYWt4eGJ5b3hzdG56bmpsdSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/26FPJGjhefSJuaRhu/giphy.gif" },
    { name: "Diamantes Neón", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExazlraXBtdWdwZXp5M2VvdGphYndjZnphZ3l4eGR4cXd2ZThsYjVveSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/l0ExhcMymLxqLRM08/giphy.gif" },
    { name: "Mario Monedas", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOXV0OXhjc3M4eG92aW55azc3NGhrcDJzcnRhYW5ub3oxbXFoaGg5ZiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/12PA1zBdFbKFaY/giphy.gif" }
  ],
  raid: [
    { name: "Ejército Vikingo", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd2Z0dTh1Z3E0cW51ZnRtdnExNmRwbTN4eWxnd2ZtN213MWg5bmk0eCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/blSTtZehjAZ8I/giphy.gif" },
    { name: "Avengers Hype", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdDF1aWFidmtyaGJlMmpldWtpM2FjcW80a2xobzNxbXRucnBmdzNveiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/l41lI4bYmcsPJX9Go/giphy.gif" },
    { name: "Fuegos Artificiales", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNnd6aTh0dHVxOGdtaXAzbndubnhrbnhxY2Q2b3ZtdnZob2lhaWdhciZlcD12MV9naWZzX3NlYXJjaCZjdD1n/26tPplGWjN0xLybiU/giphy.gif" }
  ],
  channel_points: [
    { name: "Estrella Mágica", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOW11aWRqZG56YWNka2R3N3N6M2cydDV0OW15bmw0NWJ1ZW51bnd4eiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/111ebonMs90YLu/giphy.gif" },
    { name: "PogChamp", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdnQ1d211YWFscTFjOXNxc3dxM3lyMTRldzZvbDVjMTd6d3lqN2o1dSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/SLFp6ucA5uZEC8Q7b9/giphy.gif" },
    { name: "Gato Bailarín", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExMmZ1MmhyazBpdWExN3Zma3lna21idW51M3lseG1kNHJ3NDF1ZnJ5NiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/jpbnoe3UIa8TU8LM13/giphy.gif" }
  ]
};

function selectCustomizeWidget(widgetKey) {
  wcCurrentWidget = widgetKey;

  // Update selector cards
  document.querySelectorAll('.wc-widget-selector').forEach(el => {
    el.classList.toggle('active', el.dataset.widget === widgetKey);
  });

  // Show/hide control groups
  document.querySelectorAll('.wc-controls-group').forEach(el => el.style.display = 'none');
  const activeGroup = document.getElementById(`wcControls-${widgetKey}`);
  if (activeGroup) activeGroup.style.display = '';

  // Show/hide previews
  document.querySelectorAll('.wc-preview-widget').forEach(el => el.style.display = 'none');
  const activePv = document.getElementById(`wcPreview-${widgetKey}`);
  if (activePv) activePv.style.display = (widgetKey === 'alerts') ? 'flex' : '';

  // Update titles
  const name = WC_WIDGET_NAMES[widgetKey] || widgetKey;
  const visualTitle = document.getElementById('wcVisualTitle');
  const codeTitle = document.getElementById('wcCodeTitle');
  if (visualTitle) visualTitle.innerText = `🎛️ Editor Visual — ${name}`;
  if (codeTitle) codeTitle.innerText = `💻 Editor de Código — ${name}`;

  // Load saved values into controls
  loadWidgetControlValues(widgetKey);

  // Load code editor content
  const styles = wcWidgetStyles[widgetKey] || {};
  const cssEl = document.getElementById('wcCustomCSS');
  const jsEl = document.getElementById('wcCustomJS');
  if (cssEl) cssEl.value = styles.customCSS || '';
  if (jsEl) jsEl.value = styles.customJS || '';
}

function switchCustomizeMode(mode) {
  wcCurrentMode = mode;
  document.querySelectorAll('.wc-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  const visual = document.getElementById('wcVisualEditor');
  const code = document.getElementById('wcCodeEditor');
  if (mode === 'visual') {
    if (visual) visual.style.display = '';
    if (code) code.style.display = 'none';
  } else {
    if (visual) visual.style.display = 'none';
    if (code) code.style.display = '';
  }
}

function selectAlertEvent(eventKey) {
  wcActiveAlertEvent = eventKey;

  // Update event pill buttons
  document.querySelectorAll('.wc-event-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.event === eventKey);
  });

  // Update media and sound header titles
  const mediaTitle = document.getElementById('wcAlertMediaTitle');
  if (mediaTitle) {
    mediaTitle.innerText = `🖼️ Imagen / GIF de Alerta (${WC_EVENT_NAMES[eventKey] || eventKey})`;
  }

  const soundTitle = document.getElementById('wcAlertSoundTitle');
  if (soundTitle) {
    soundTitle.innerText = `🔊 Sonido de Alerta (${WC_EVENT_NAMES[eventKey] || eventKey})`;
  }

  // Load current image URL into input
  const urlInput = document.getElementById('wc-alert-imageUrl');
  const currentImg = wcAlertImages[eventKey] || WC_DEFAULT_ALERT_IMAGES[eventKey] || '';
  if (urlInput) urlInput.value = currentImg;

  // Populate GIF Gallery grid
  renderGifGallery(eventKey);

  // Load sound select
  const currentSound = wcAlertSounds[eventKey] || '/assets/sounds/campana_alerta.wav';
  const soundSelect = document.getElementById('wc-alert-soundSelect');
  const customSoundRow = document.getElementById('wcAlertCustomSoundRow');
  const customSoundInput = document.getElementById('wc-alert-soundUrl');

  if (soundSelect) {
    const isStandardOption = Array.from(soundSelect.options).some(o => o.value === currentSound);
    if (isStandardOption) {
      soundSelect.value = currentSound;
      if (customSoundRow) customSoundRow.style.display = 'none';
    } else {
      soundSelect.value = 'custom';
      if (customSoundRow) customSoundRow.style.display = 'block';
      if (customSoundInput) customSoundInput.value = currentSound;
    }
  }

  // Update live preview card content
  const pvInfo = WC_EVENT_PREVIEWS[eventKey] || { badge: eventKey.toUpperCase(), title: '¡Usuario!', msg: 'ha interactuado' };
  const badgeEl = document.getElementById('wcPvAlertBadge');
  const titleEl = document.getElementById('wcPvAlertTitle');
  const msgEl = document.getElementById('wcPvAlertMsg');
  const imgEl = document.getElementById('wcPvAlertImg');

  if (badgeEl) badgeEl.innerText = pvInfo.badge;
  if (titleEl) titleEl.innerText = pvInfo.title;
  if (msgEl) msgEl.innerText = pvInfo.msg;
  if (imgEl) imgEl.src = currentImg;
}

function renderGifGallery(eventKey) {
  const grid = document.getElementById('wcGifGalleryGrid');
  if (!grid) return;

  const gifs = WC_PRESET_GIFS[eventKey] || WC_PRESET_GIFS.follower;
  grid.innerHTML = gifs.map(g => `
    <div class="wc-gif-card" onclick="selectGalleryGif('${g.url}', '${g.name}')" title="${g.name}">
      <img src="${g.url}" alt="${g.name}" loading="lazy">
      <div class="wc-gif-title">${g.name}</div>
    </div>
  `).join('');
}

function toggleGifGallery() {
  const drawer = document.getElementById('wcGifGalleryDrawer');
  if (!drawer) return;
  const isShown = drawer.style.display !== 'none';
  drawer.style.display = isShown ? 'none' : 'block';
  if (!isShown) renderGifGallery(wcActiveAlertEvent);
}

function selectGalleryGif(url, name) {
  wcAlertImages[wcActiveAlertEvent] = url;
  const urlInput = document.getElementById('wc-alert-imageUrl');
  if (urlInput) urlInput.value = url;

  const imgEl = document.getElementById('wcPvAlertImg');
  if (imgEl) imgEl.src = url;

  showToast(`GIF "${name}" seleccionado para ${WC_EVENT_NAMES[wcActiveAlertEvent]}`, 'info');
}

function handleAlertUrlInput(url) {
  const cleanUrl = url.trim();
  wcAlertImages[wcActiveAlertEvent] = cleanUrl;
  const imgEl = document.getElementById('wcPvAlertImg');
  if (imgEl && cleanUrl) imgEl.src = cleanUrl;
}

function handleAlertFileUpload(input) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = function(e) {
      const dataUrl = e.target.result;
      wcAlertImages[wcActiveAlertEvent] = dataUrl;
      const urlInput = document.getElementById('wc-alert-imageUrl');
      if (urlInput) urlInput.value = dataUrl;
      const imgEl = document.getElementById('wcPvAlertImg');
      if (imgEl) imgEl.src = dataUrl;
      showToast(`Archivo "${file.name}" cargado para ${WC_EVENT_NAMES[wcActiveAlertEvent]}`, 'success');
    };
    reader.readAsDataURL(file);
  }
}

// Sound Management
function handleAlertSoundSelect(val) {
  const customRow = document.getElementById('wcAlertCustomSoundRow');
  if (val === 'custom') {
    if (customRow) customRow.style.display = 'block';
  } else {
    if (customRow) customRow.style.display = 'none';
    wcAlertSounds[wcActiveAlertEvent] = val;
    playActiveAlertSound();
  }
}

function handleAlertSoundUrlInput(url) {
  wcAlertSounds[wcActiveAlertEvent] = url.trim();
}

function handleAlertSoundUpload(input) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = async function(e) {
      const dataUrl = e.target.result;
      
      // Try uploading to backend /api/sounds/upload
      try {
        const res = await fetch('/api/sounds/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, data: dataUrl })
        });
        const data = await res.json();
        if (data.success && data.url) {
          wcAlertSounds[wcActiveAlertEvent] = data.url;
          addSoundOption(data.url, file.name);
          showToast(`Audio "${file.name}" subido correctamente`, 'success');
          playActiveAlertSound();
          return;
        }
      } catch(err) {}

      // Fallback: use dataUrl directly
      wcAlertSounds[wcActiveAlertEvent] = dataUrl;
      addSoundOption(dataUrl, file.name);
      showToast(`Audio local "${file.name}" asignado`, 'success');
      playActiveAlertSound();
    };
    reader.readAsDataURL(file);
  }
}

function addSoundOption(url, name) {
  const sel = document.getElementById('wc-alert-soundSelect');
  if (!sel) return;
  const opt = document.createElement('option');
  opt.value = url;
  opt.innerText = `🎵 ${name}`;
  sel.insertBefore(opt, sel.lastElementChild);
  sel.value = url;
}

function playActiveAlertSound() {
  const sound = wcAlertSounds[wcActiveAlertEvent] || '/assets/sounds/campana_alerta.wav';
  if (sound === 'synthesizer') {
    playSynthesizedAlertChime(wcActiveAlertEvent);
    return;
  }
  try {
    const audio = new Audio(sound);
    audio.play().catch(() => playSynthesizedAlertChime(wcActiveAlertEvent));
  } catch(e) {
    playSynthesizedAlertChime(wcActiveAlertEvent);
  }
}

function playSynthesizedAlertChime(type) {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    let freqs = [523.25, 659.25, 783.99, 1046.50];
    if (type === 'bits') freqs = [587.33, 739.99, 880.00, 1174.66];
    if (type === 'sub') freqs = [440.00, 554.37, 659.25, 880.00];
    if (type === 'raid') freqs = [493.88, 659.25, 987.77, 1318.51];
    osc.frequency.setValueAtTime(freqs[0], now);
    osc.frequency.exponentialRampToValueAtTime(freqs[3], now + 0.35);
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.6);
  } catch(e) {}
}

function previewAlertAnimation() {
  const card = document.getElementById('wcPvAlertCard');
  if (!card) return;

  playActiveAlertSound();

  // Trigger bounce / pulse animation
  card.style.transform = 'scale(0.85)';
  card.style.opacity = '0';
  setTimeout(() => {
    card.style.transition = 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    card.style.transform = 'scale(1.05)';
    card.style.opacity = '1';
    setTimeout(() => {
      card.style.transform = 'scale(1)';
    }, 400);
  }, 100);
}

function triggerActiveAlertTest() {
  const eventKey = wcActiveAlertEvent || 'follower';
  triggerTestAlert(eventKey);
}

function loadWidgetControlValues(widgetKey) {
  const styles = wcWidgetStyles[widgetKey] || WC_DEFAULT_VALUES[widgetKey] || {};
  const defaults = WC_DEFAULT_VALUES[widgetKey] || {};
  const merged = { ...defaults, ...styles };

  // For each input and select in the widget's control group, set value
  const group = document.getElementById(`wcControls-${widgetKey}`);
  if (!group) return;

  group.querySelectorAll('input, select').forEach(input => {
    const prop = input.dataset.prop;
    if (!prop) return;
    const val = merged[prop];
    if (val !== undefined) {
      input.value = val;
    }
    // Update range display value
    if (input.type === 'range') {
      const valEl = document.getElementById(`${input.id}-val`);
      if (valEl) {
        const unit = prop.includes('Opacity') ? '%' : 'px';
        valEl.innerText = `${input.value}${unit}`;
      }
    }
  });

  // If alerts, also select current alert event
  if (widgetKey === 'alerts') {
    selectAlertEvent(wcActiveAlertEvent || 'follower');
  }

  // Apply to preview
  updateWidgetPreview(widgetKey, merged);
}

function getWidgetValues(widgetKey) {
  const group = document.getElementById(`wcControls-${widgetKey}`);
  if (!group) return {};
  const values = {};
  group.querySelectorAll('input, select').forEach(input => {
    const prop = input.dataset.prop;
    if (!prop) return;
    if (input.type === 'color' || input.tagName === 'SELECT') {
      values[prop] = input.value;
    } else {
      values[prop] = Number(input.value);
    }
  });
  // Include code editor values
  values.customCSS = document.getElementById('wcCustomCSS')?.value || '';
  values.customJS = document.getElementById('wcCustomJS')?.value || '';
  return values;
}

function updateWidgetPreview(widgetKey, vals) {
  const font = vals.fontFamily || "'Outfit', sans-serif";

  if (widgetKey === 'alerts') {
    const card = document.getElementById('wcPvAlertCard');
    const badge = document.getElementById('wcPvAlertBadge');
    const title = document.getElementById('wcPvAlertTitle');
    const msg = document.getElementById('wcPvAlertMsg');
    const img = document.getElementById('wcPvAlertImg');

    if (card) {
      card.style.fontFamily = font;
      const r = Math.round(parseInt(vals.bgColor?.slice(1,3)||'0b',16));
      const g = Math.round(parseInt(vals.bgColor?.slice(3,5)||'0e',16));
      const b = Math.round(parseInt(vals.bgColor?.slice(5,7)||'14',16));
      card.style.background = `rgba(${r},${g},${b},${(vals.bgOpacity||88)/100})`;
      card.style.borderRadius = `${vals.borderRadius || 24}px`;
      card.style.borderColor = vals.accentColor || '#9146ff';
      card.style.boxShadow = `0 10px 40px rgba(0,0,0,0.6), 0 0 35px ${vals.accentColor || '#9146ff'}50`;
    }
    if (badge) {
      badge.style.fontFamily = font;
      badge.style.background = `linear-gradient(135deg, ${vals.accentColor||'#9146ff'}, #00f2fe)`;
    }
    if (title) {
      title.style.fontFamily = font;
      title.style.color = vals.titleColor || '#fff';
      title.style.fontSize = `${vals.titleSize || 32}px`;
    }
    if (msg) {
      msg.style.fontFamily = font;
      msg.style.color = vals.messageColor || '#cbd5e1';
      msg.style.fontSize = `${vals.messageSize || 20}px`;
    }
    if (img) {
      img.style.maxHeight = `${vals.imageSize || 120}px`;
    }

  } else if (widgetKey === 'nowplaying') {
    const card = document.getElementById('wcPvNpCard');
    const title = document.getElementById('wcPvNpTitle');
    const thumb = document.getElementById('wcPvNpThumb');
    const req = document.getElementById('wcPvNpRequester');
    if (card) {
      card.style.fontFamily = font;
      const r = parseInt(vals.bgColor?.slice(1,3)||'0f',16);
      const g = parseInt(vals.bgColor?.slice(3,5)||'12',16);
      const b = parseInt(vals.bgColor?.slice(5,7)||'1a',16);
      card.style.background = `rgba(${r},${g},${b},${(vals.bgOpacity||90)/100})`;
      card.style.borderRadius = `${vals.borderRadius || 18}px`;
    }
    if (title) {
      title.style.fontFamily = font;
      title.style.color = vals.titleColor || '#fff';
      title.style.fontSize = `${vals.titleSize || 16}px`;
    }
    if (thumb) {
      thumb.style.width = `${vals.thumbSize||64}px`;
      thumb.style.height = `${vals.thumbSize||64}px`;
    }
    if (req) {
      req.style.fontFamily = font;
      const s = req.querySelector('strong');
      if (s) s.style.color = vals.requesterColor || '#9146ff';
    }

  } else if (widgetKey === 'goals') {
    const card = document.getElementById('wcPvGoalCard');
    const titleEl = document.getElementById('wcPvGoalTitle');
    const barBg = card?.querySelector('.wc-pv-goal-bar-bg');
    const fill = document.getElementById('wcPvGoalFill');
    if (card) {
      card.style.fontFamily = font;
      const r = parseInt(vals.bgColor?.slice(1,3)||'0e',16);
      const g = parseInt(vals.bgColor?.slice(3,5)||'12',16);
      const b = parseInt(vals.bgColor?.slice(5,7)||'1c',16);
      card.style.background = `rgba(${r},${g},${b},${(vals.bgOpacity||92)/100})`;
      card.style.borderRadius = `${vals.borderRadius || 18}px`;
    }
    if (titleEl) {
      titleEl.style.fontFamily = font;
      titleEl.style.fontSize = `${vals.fontSize || 15}px`;
    }
    if (barBg) barBg.style.height = `${vals.barHeight || 18}px`;
    if (fill) fill.style.background = `linear-gradient(90deg, ${vals.barColor || '#9146ff'}, ${vals.barColor2 || '#00f2fe'})`;

  } else if (widgetKey === 'chat') {
    const bubbles = document.querySelectorAll('.wc-pv-chat-bubble');
    const texts = document.querySelectorAll('.wc-pv-chat-text');
    const users = document.querySelectorAll('.wc-pv-chat-user');

    bubbles.forEach(b => {
      b.style.fontFamily = font;
      const r = parseInt(vals.bubbleBg?.slice(1,3)||'0f',16);
      const g = parseInt(vals.bubbleBg?.slice(3,5)||'14',16);
      const bb = parseInt(vals.bubbleBg?.slice(5,7)||'1e',16);
      b.style.background = `rgba(${r},${g},${bb},${(vals.bgOpacity||85)/100})`;
      b.style.borderRadius = `${vals.borderRadius || 14}px`;
      b.style.borderLeftWidth = `${vals.borderLeftWidth || 4}px`;
      b.style.borderLeftColor = vals.borderLeftColor || '#9146ff';
    });
    users.forEach(u => {
      u.style.fontFamily = font;
      u.style.color = vals.usernameColor || '#9146ff';
    });
    texts.forEach(t => {
      t.style.fontFamily = font;
      t.style.color = vals.textColor || '#f1f5f9';
      t.style.fontSize = `${vals.fontSize || 14}px`;
    });
  }
}

function generateWidgetCSS(widgetKey, vals) {
  const font = vals.fontFamily || "'Outfit', sans-serif";

  if (widgetKey === 'alerts') {
    const r = parseInt(vals.bgColor?.slice(1,3)||'0b',16);
    const g = parseInt(vals.bgColor?.slice(3,5)||'0e',16);
    const b = parseInt(vals.bgColor?.slice(5,7)||'14',16);
    return `/* OrbiBot Custom Styles - Alert Box */
.alert-card {
  font-family: ${font} !important;
  background: rgba(${r},${g},${b},${(vals.bgOpacity||88)/100}) !important;
  border-radius: ${vals.borderRadius||24}px !important;
  border-color: ${vals.accentColor||'#9146ff'} !important;
  box-shadow: 0 10px 40px rgba(0,0,0,0.6), 0 0 35px ${vals.accentColor||'#9146ff'}50 !important;
}
.alert-title {
  font-family: ${font} !important;
  color: ${vals.titleColor||'#ffffff'} !important;
  font-size: ${vals.titleSize||32}px !important;
}
.alert-message {
  font-family: ${font} !important;
  color: ${vals.messageColor||'#cbd5e1'} !important;
  font-size: ${vals.messageSize||20}px !important;
}
.alert-badge {
  font-family: ${font} !important;
  background: linear-gradient(135deg, ${vals.accentColor||'#9146ff'}, #00f2fe) !important;
}
.alert-media {
  max-height: ${vals.imageSize||120}px !important;
}
`;
  } else if (widgetKey === 'nowplaying') {
    const r = parseInt(vals.bgColor?.slice(1,3)||'0f',16);
    const g = parseInt(vals.bgColor?.slice(3,5)||'12',16);
    const b = parseInt(vals.bgColor?.slice(5,7)||'1a',16);
    return `/* OrbiBot Custom Styles - Now Playing */
.np-card {
  font-family: ${font} !important;
  background: rgba(${r},${g},${b},${(vals.bgOpacity||90)/100}) !important;
  border-radius: ${vals.borderRadius||18}px !important;
}
.np-title {
  font-family: ${font} !important;
  color: ${vals.titleColor||'#ffffff'} !important;
  font-size: ${vals.titleSize||16}px !important;
}
.np-requester {
  font-family: ${font} !important;
}
.np-requester strong {
  color: ${vals.requesterColor||'#9146ff'} !important;
}
.np-thumb-wrapper {
  width: ${vals.thumbSize||64}px !important;
  height: ${vals.thumbSize||64}px !important;
}
`;
  } else if (widgetKey === 'goals') {
    const r = parseInt(vals.bgColor?.slice(1,3)||'0e',16);
    const g = parseInt(vals.bgColor?.slice(3,5)||'12',16);
    const b = parseInt(vals.bgColor?.slice(5,7)||'1c',16);
    return `/* OrbiBot Custom Styles - Goal Bar */
.goal-card {
  font-family: ${font} !important;
  background: rgba(${r},${g},${b},${(vals.bgOpacity||92)/100}) !important;
  border-radius: ${vals.borderRadius||18}px !important;
}
.goal-title {
  font-family: ${font} !important;
  font-size: ${vals.fontSize||15}px !important;
}
.goal-bar-bg {
  height: ${vals.barHeight||18}px !important;
}
.goal-bar-fill {
  background: linear-gradient(90deg, ${vals.barColor||'#9146ff'}, ${vals.barColor2||'#00f2fe'}) !important;
}
`;
  } else if (widgetKey === 'chat') {
    const r = parseInt(vals.bubbleBg?.slice(1,3)||'0f',16);
    const g = parseInt(vals.bubbleBg?.slice(3,5)||'14',16);
    const b = parseInt(vals.bubbleBg?.slice(5,7)||'1e',16);
    return `/* OrbiBot Custom Styles - Chat Overlay */
.chat-bubble {
  font-family: ${font} !important;
  background: rgba(${r},${g},${b},${(vals.bgOpacity||85)/100}) !important;
  border-radius: ${vals.borderRadius||14}px !important;
  border-left-width: ${vals.borderLeftWidth||4}px !important;
  border-left-color: ${vals.borderLeftColor||'#9146ff'} !important;
}
.chat-bubble .username {
  font-family: ${font} !important;
  color: ${vals.usernameColor||'#9146ff'} !important;
}
.chat-bubble .text {
  font-family: ${font} !important;
  color: ${vals.textColor||'#f1f5f9'} !important;
  font-size: ${vals.fontSize||14}px !important;
}
`;
  }
  return '';
}

async function saveWidgetStyles() {
  setAutoSaveStatus('saving');

  // Collect current widget values
  const vals = getWidgetValues(wcCurrentWidget);
  // Generate CSS from visual controls
  const generatedCSS = generateWidgetCSS(wcCurrentWidget, vals);

  // Merge custom CSS from code editor with generated CSS
  const userCSS = vals.customCSS || '';
  const finalCSS = userCSS ? `${generatedCSS}\n/* --- CSS Personalizado del Usuario --- */\n${userCSS}` : generatedCSS;

  // Save to widgetStyles
  wcWidgetStyles[wcCurrentWidget] = {
    ...vals,
    generatedCSS: generatedCSS,
    finalCSS: finalCSS
  };

  // If alerts widget, also attach custom images and sounds
  if (wcCurrentWidget === 'alerts') {
    wcWidgetStyles.alerts.images = wcAlertImages;
    wcWidgetStyles.alerts.sounds = wcAlertSounds;
  }

  // Save to config
  const payload = { widgetStyles: wcWidgetStyles };

  try {
    // Save to localStorage
    let cfg = JSON.parse(localStorage.getItem('orbibot_config') || '{}');
    cfg.widgetStyles = wcWidgetStyles;
    localStorage.setItem('orbibot_config', JSON.stringify(cfg));

    // Save to backend config (Syncs to Supabase)
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      appConfig = data.config;
    }

    // Also update /api/alerts (Syncs to Supabase under key='alerts')
    if (wcCurrentWidget === 'alerts') {
      try {
        const currentAlertsRes = await fetch('/api/alerts');
        const currentAlerts = await currentAlertsRes.json();
        const updatedAlerts = { ...currentAlerts };

        Object.keys(wcAlertImages).forEach(evKey => {
          if (!updatedAlerts[evKey]) updatedAlerts[evKey] = {};
          updatedAlerts[evKey].image = wcAlertImages[evKey];
        });

        Object.keys(wcAlertSounds).forEach(evKey => {
          if (!updatedAlerts[evKey]) updatedAlerts[evKey] = {};
          updatedAlerts[evKey].sound = wcAlertSounds[evKey];
        });

        await fetch('/api/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedAlerts)
        });
      } catch(e) {}
    }

    setAutoSaveStatus('saved');
    showToast(`✅ Estilos de "${WC_WIDGET_NAMES[wcCurrentWidget]}" guardados en la nube`, 'success');
  } catch (e) {
    setAutoSaveStatus('saved');
    showToast('Estilos guardados localmente', 'info');
  }
}

function resetWidgetStyles() {
  const defaults = WC_DEFAULT_VALUES[wcCurrentWidget];
  if (!defaults) return;

  wcWidgetStyles[wcCurrentWidget] = { ...defaults };

  if (wcCurrentWidget === 'alerts') {
    wcAlertImages = { ...WC_DEFAULT_ALERT_IMAGES };
    wcAlertSounds = {
      follower: '/assets/sounds/campana_alerta.wav',
      sub: '/assets/sounds/campana_alerta.wav',
      bits: '/assets/sounds/notificacion_puntos.wav',
      raid: '/assets/sounds/airhorn.mp3',
      channel_points: '/assets/sounds/notificacion_puntos.wav'
    };
  }

  // Reset code editor
  const cssEl = document.getElementById('wcCustomCSS');
  const jsEl = document.getElementById('wcCustomJS');
  if (cssEl) cssEl.value = '';
  if (jsEl) jsEl.value = '';

  loadWidgetControlValues(wcCurrentWidget);
  showToast(`🔄 Estilos de "${WC_WIDGET_NAMES[wcCurrentWidget]}" restablecidos`, 'info');
}

function initWidgetCustomization() {
  // Load saved widget styles from appConfig
  if (appConfig && appConfig.widgetStyles) {
    wcWidgetStyles = appConfig.widgetStyles;
    if (wcWidgetStyles.alerts) {
      if (wcWidgetStyles.alerts.images) {
        wcAlertImages = { ...wcAlertImages, ...wcWidgetStyles.alerts.images };
      }
      if (wcWidgetStyles.alerts.sounds) {
        wcAlertSounds = { ...wcAlertSounds, ...wcWidgetStyles.alerts.sounds };
      }
    }
  }

  // Also fetch saved alert images and sounds from /api/alerts
  fetch('/api/alerts')
    .then(r => r.json())
    .then(data => {
      if (data && typeof data === 'object') {
        Object.keys(data).forEach(k => {
          if (data[k]) {
            if (data[k].image) wcAlertImages[k] = data[k].image;
            if (data[k].sound) wcAlertSounds[k] = data[k].sound;
          }
        });
        if (wcCurrentWidget === 'alerts') {
          selectAlertEvent(wcActiveAlertEvent || 'follower');
        }
      }
    })
    .catch(() => {});

  // Setup visual controls event listeners for live preview
  document.querySelectorAll('.wc-controls-group input, .wc-controls-group select').forEach(input => {
    const handler = () => {
      const vals = getWidgetValues(wcCurrentWidget);
      updateWidgetPreview(wcCurrentWidget, vals);

      // Update range display value
      if (input.type === 'range') {
        const valEl = document.getElementById(`${input.id}-val`);
        if (valEl) {
          const prop = input.dataset.prop || '';
          const unit = prop.includes('Opacity') ? '%' : 'px';
          valEl.innerText = `${input.value}${unit}`;
        }
      }
    };
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
  });

  // Load initial widget
  selectCustomizeWidget('alerts');
}

// Initialize widget customization when initial data is loaded
const _origLoadInitialData = loadInitialData;
loadInitialData = async function() {
  await _origLoadInitialData();
  initWidgetCustomization();
};


