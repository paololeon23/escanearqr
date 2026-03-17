// network.js - Punto de Validación QR (Control de Personal)
// Misma capacidad de envío que MTTP: no-cors para POST (no falla); GET validar por DNI con JSONP en local.
// Solo 2 hojas: DB_Usuarios (validar si existe), Log_Accesos (registrar cada acceso).

var GAS_EXEC_URL = 'https://script.google.com/macros/s/AKfycbyqtljT6dG7tp2qRrnhEicZdxcDwD1qhPmXtDQ1mYiOTYK3aJTDg-90-NxVaCxXg7Ye/exec';
var retryTimeoutId = null;

function getApiUrl() {
  if (typeof window !== 'undefined' && window.location.hostname === 'script.google.com') {
    return window.location.origin + window.location.pathname;
  }
  return GAS_EXEC_URL;
}

function isLocalOrigin() {
  if (typeof window === 'undefined') return false;
  var h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '';
}

export const REPORTE_WEB_APP_URL = getApiUrl();

const PENDING_KEY = 'qr_val_pendientes';
/** Tope para no llenar localStorage con miles de pendientes (ej. 5000 escaneos sin red). */
const MAX_PENDIENTES = 500;
/** Pausa entre lotes al sincronizar (ms) para no saturar el servidor. */
const SYNC_BATCH_DELAY_MS = 400;
/** Cantidad de ítems por lote al enviar pendientes. */
const SYNC_BATCH_SIZE = 5;

function getPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function setPending(arr) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(arr));
    window.dispatchEvent(new CustomEvent('qr-pending-updated'));
  } catch (_) {}
}

export function addPending(item) {
  var list = getPending();
  list.push({ ...item, addedAt: Date.now() });
  if (list.length > MAX_PENDIENTES) list = list.slice(-MAX_PENDIENTES);
  setPending(list);
}

function removePendingAtIndex(index) {
  const list = getPending();
  list.splice(index, 1);
  setPending(list);
}

export function getPendingCount() {
  return getPending().length;
}

function buildRequest(action, payload) {
  var body = { action: action, ...payload };
  var bodyStr = JSON.stringify(body);
  var url = getApiUrl();
  console.log('---------- REGISTRO (POST) ----------');
  console.log('[POST] Método: POST');
  console.log('[POST] URL:', url);
  console.log('[POST] Action:', action);
  console.log('[POST] Datos enviados:', JSON.stringify(body, null, 2));

  if (isLocalOrigin()) {
    // En local: no-cors + text/plain = petición "simple", no preflight, el POST se envía. No podemos leer la respuesta.
    return fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: bodyStr
    }).then(function () {
      console.log('[POST] Enviado (no-cors, respuesta no leída).');
      console.log('-----------------------------------');
      return { ok: true, localNoCors: true };
    }).catch(function (err) {
      console.warn('[POST] Error:', err.message);
      throw err;
    });
  }

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: bodyStr
  }).then(function (res) {
    if (!res.ok) throw new Error('Error de red');
    return res.json();
  }).then(function (json) {
    console.log('[POST] Respuesta del servidor:', json);
    console.log('-----------------------------------');
    return json;
  });
}

/**
 * Envía DNI al servidor. Retorna Promise<{ ok, exists, worker?, error? }>.
 * Envía isOnline para registrar en Excel si fue CON INTER o SIN INTER.
 */
/** DNI Perú (RENIEC): exactamente 8 dígitos. */
function cleanDniForBackend(value) {
  if (value == null || value === '') return '';
  var s = String(value).replace(/\s/g, '').replace(/\D/g, '');
  return s.length === 8 ? s : '';
}

export function processQR(dni) {
  const id = cleanDniForBackend(dni);
  if (!id || id.length !== 8) return Promise.resolve({ ok: false, error: 'DNI inválido (debe ser 8 dígitos, RENIEC Perú)', exists: false });

  if (!navigator.onLine) {
    addPending({ type: 'processQR', id, isOnline: false });
    return Promise.resolve({ offline: true, id });
  }

  // En local/no-cors no podemos leer la respuesta del POST. Primero GET: si ya existe → "Usuario ya fue registrado"; si no → POST para registrar.
  if (isLocalOrigin()) {
    return getValidarDni(id).then(function (r) {
      if (r.ok && r.exists) {
        return { ok: true, validated: true, id: id, message: r.message || 'Usuario ya fue registrado' };
      }
      return buildRequest('processQR', { id, isOnline: true });
    }).catch(function (err) {
      addPending({ type: 'processQR', id, isOnline: false });
      throw err;
    });
  }

  return buildRequest('processQR', { id, isOnline: true }).catch(function (err) {
    addPending({ type: 'processQR', id, isOnline: false });
    throw err;
  });
}

export function updateUI() {
  const statusText = document.getElementById('status-text');
  const statusCard = document.getElementById('network-status-container');
  const countEl = document.getElementById('pending-count');
  const pending = getPending().length;

  if (countEl) countEl.textContent = pending > 0 ? 'Pendientes: ' + pending : '';

  if (navigator.onLine) {
    if (statusText) statusText.textContent = 'En línea';
    if (statusCard) statusCard.className = 'status-card online';
    if (pending > 0) enviarPendientes();
    programarReintentoSiHayPendientes();
  } else {
    if (statusText) statusText.textContent = 'Sin conexión';
    if (statusCard) statusCard.className = 'status-card offline';
    cancelarReintentos();
  }
}

function programarReintentoSiHayPendientes() {
  cancelarReintentos();
  var pending = getPending().length;
  if (pending === 0 || !navigator.onLine) return;
  retryTimeoutId = setTimeout(function () {
    if (navigator.onLine) {
      enviarPendientes();
      updateUI();
    }
  }, 12000);
}

function cancelarReintentos() {
  if (retryTimeoutId) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }
}

/** GET validar DNI: en local usa JSONP para evitar CORS; en producción fetch normal. */
export function getValidarDni(dni) {
  var id = (dni == null || dni === '') ? '' : String(dni).replace(/\s/g, '').replace(/\D/g, '');
  if (id.length !== 8) return Promise.resolve({ ok: false, exists: false, id: id, error: 'DNI inválido (8 dígitos, RENIEC Perú)' });

  var url = getApiUrl() + '?dni=' + encodeURIComponent(id);
  console.log('[GET] Validar DNI — URL:', url);

  if (isLocalOrigin()) {
    return new Promise(function (resolve, reject) {
      var name = '__qrValidar_' + Date.now();
      var scriptUrl = url + '&callback=' + encodeURIComponent(name);
      var script = document.createElement('script');
      var timer = setTimeout(function () {
        try { if (script.parentNode) script.remove(); } catch (_) {}
        try { delete window[name]; } catch (_) {}
        reject(new Error('Timeout'));
      }, 10000);
      window[name] = function (data) {
        clearTimeout(timer);
        try { if (script.parentNode) script.remove(); } catch (_) {}
        try { delete window[name]; } catch (_) {}
        resolve(data || { ok: false, exists: false });
      };
      script.onerror = function () {
        clearTimeout(timer);
        try { if (script.parentNode) script.remove(); } catch (_) {}
        try { delete window[name]; } catch (_) {}
        reject(new Error('Error de red'));
      };
      script.src = scriptUrl;
      document.head.appendChild(script);
    });
  }

  return fetch(url).then(function (res) { return res.json(); });
}

/**
 * Envía pendientes en lotes con pausa para no saturar el servidor (miles de escaneos).
 */
export async function enviarPendientes() {
  if (!navigator.onLine) return;
  var list = getPending();
  if (list.length === 0) return;

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('qr-sync-start', { detail: { total: list.length } }));
  }
  var sent = 0;
  var batchSize = SYNC_BATCH_SIZE;
  var delay = SYNC_BATCH_DELAY_MS;

  for (var i = list.length - 1; i >= 0; i--) {
    var item = list[i];
    try {
      if (item.type === 'processQR') {
        var isOnline = item.isOnline === true;
        var res = await buildRequest('processQR', { id: item.id, isOnline: isOnline });
        removePendingAtIndex(i);
        var isFirstInBatch = (sent === 0);
        window.dispatchEvent(new CustomEvent('qr-sync-result', { detail: { type: 'processQR', result: res, id: item.id, isFirstInBatch: isFirstInBatch } }));
        await new Promise(function (r) { setTimeout(r, 400); });
      }
      sent++;
      updateUI();
      if (sent % batchSize === 0 && getPending().length > 0) {
        await new Promise(function (r) { setTimeout(r, delay); });
      }
    } catch (_) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('qr-sync-failed', { detail: { pending: getPending().length } }));
      }
      break;
    }
  }
  updateUI();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('qr-sync-done', { detail: { sent: sent } }));
  }
}
