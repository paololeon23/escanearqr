/**
 * script.js - Punto de Validación QR. Scope con IIFE.
 * Escáner html5-qrcode, processQR, modal éxito/registro, historial local, sidebar.
 */
import {
  processQR,
  updateUI,
  enviarPendientes,
  getPendingCount,
  getValidarDni
} from './network.js';

(function () {
  const HISTORIAL_KEY = 'qr_val_historial';
  const MAX_HISTORIAL = 100;
  const HISTORIAL_PAGE_SIZE = 10;
  const HISTORIAL_PAGINATION_MIN = 10;
  let historialCurrentPage = 1;

  let html5QrCode = null;
  let html5QrCodeFile = null;
  let scannerStarted = false;

  function getHistorial() {
    try {
      const raw = localStorage.getItem(HISTORIAL_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  /** Cada escaneo añade una fila al historial (todos los movimientos, con o sin internet, 1ª o 2ª vez). */
  function addHistorial(entry) {
    const list = getHistorial();
    list.unshift({ dni: entry.dni || '', resultado: entry.resultado || '', ts: Date.now() });
    while (list.length > MAX_HISTORIAL) list.pop();
    try {
      localStorage.setItem(HISTORIAL_KEY, JSON.stringify(list));
      window.dispatchEvent(new CustomEvent('qr-historial-updated'));
    } catch (_) {}
  }

  /** Al sincronizar un pendiente: actualiza esa fila de "Pendiente" a "Registrado" o "Validado" en tiempo real. */
  function updateHistorialPendienteToSynced(dni, result, isFirstInBatch) {
    const id = String(dni || '').replace(/\D/g, '');
    if (!id) return;
    const list = getHistorial();
    for (var i = 0; i < list.length; i++) {
      const cellDni = String(list[i].dni || '').replace(/\D/g, '');
      if (list[i].resultado === 'Pendiente' && cellDni === id) {
        var nuevo = 'Validado';
        if (result && result.registered === true) nuevo = 'Registrado';
        else if (isFirstInBatch && !result.validated) nuevo = 'Registrado';
        list[i].resultado = nuevo;
        try {
          localStorage.setItem(HISTORIAL_KEY, JSON.stringify(list));
          window.dispatchEvent(new CustomEvent('qr-historial-updated'));
        } catch (_) {}
        return;
      }
    }
  }

  function playSuccess() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      o.type = 'sine';
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.15);
    } catch (_) {}
  }

  function playError() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 220;
      o.type = 'sine';
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.2);
    } catch (_) {}
  }

  /** Sonido al detectar QR (escaneo correcto, antes de respuesta del servidor). */
  function playScan() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 660;
      o.type = 'sine';
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.08);
    } catch (_) {}
  }

  /** DNI Perú (RENIEC): exactamente 8 dígitos. Acepta "7 0839 380" -> "70839380". */
  var DNI_LENGTH = 8;

  function cleanDni(value) {
    if (value == null || value === '') return '';
    var digits = String(value).replace(/\s/g, '').replace(/\D/g, '');
    return digits.length === DNI_LENGTH ? digits : '';
  }

  function extractDniFromQr(text) {
    if (!text || typeof text !== 'string') return '';
    var t = text.replace(/\uFEFF/g, '').replace(/[\u200B-\u200D\u2060\u00AD]/g, '').replace(/\s/g, '').trim();
    if (!t) return '';

    var match = t.match(/\d{8}/);
    if (match) return cleanDni(match[0]) ? match[0] : '';

    if (/^\{/.test(t)) {
      try {
        var obj = JSON.parse(text);
        if (obj && typeof obj === 'object') {
          var id = obj.dni || obj.DNI || obj.documento || obj.cedula || obj.numDoc || obj.id || obj.Id;
          if (id != null) return cleanDni(String(id)) || '';
        }
      } catch (_) {}
    }

    var digits = t.replace(/\D/g, '');
    if (digits.length === DNI_LENGTH) return digits;
    var m = text.match(/(?:dni|id|documento|cedula)?\s*[:\-=]?\s*[\d\s]{8,20}/i);
    if (m) return cleanDni(m[0]) || '';
    return '';
  }

  function setLoading(show, message) {
    var overlay = document.getElementById('qr-loading-overlay');
    var msgEl = document.getElementById('qr-loading-message');
    if (overlay) {
      overlay.setAttribute('aria-hidden', show ? 'false' : 'true');
      if (show) overlay.removeAttribute('hidden'); else overlay.setAttribute('hidden', '');
    }
    if (msgEl) msgEl.textContent = message || 'Procesando...';
  }

  /** Muestra el último DNI procesado debajo del escáner (refuerzo visual de que se tomó el DNI). */
  function setLastDniDisplay(dni, estado) {
    var el = document.getElementById('qr-last-dni');
    if (!el) return;
    if (!dni) {
      el.hidden = true;
      el.textContent = '';
        return;
    }
    el.textContent = 'DNI ' + dni + ' — ' + (estado || 'Procesado');
    el.removeAttribute('hidden');
  }

  /** Voz (solo frontend): "Escaneado", "Registrado", "Validado" con Web Speech API. */
  function speakVoice(text) {
    if (!window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'es-ES';
      u.rate = 0.95;
      var voices = window.speechSynthesis.getVoices();
      var es = voices.filter(function (v) { return v.lang === 'es-ES' || v.lang === 'es'; });
      if (es.length) u.voice = es[0];
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  /** Chip toast estilo app moderna: mensaje corto que se cierra solo (ej. "Registrado", "Validado"). */
  var _qrChipTimeout = null;
  function showChipToast(text, type) {
    type = type || 'success';
    var el = document.getElementById('qr-chip-toast');
    if (!el) return;
    clearTimeout(_qrChipTimeout);
    el.textContent = text;
    el.className = 'qr-chip-toast qr-chip-toast--' + type;
    el.removeAttribute('hidden');
    _qrChipTimeout = setTimeout(function () {
      el.setAttribute('hidden', '');
      el.className = 'qr-chip-toast';
    }, 2200);
  }

  /** Guarda el elemento con foco antes de abrir el modal (para restaurar al cerrar y evitar error aria-hidden). */
  var _qrModalPreviousFocus = null;

  /** Modal "Todo correcto" con DNI (solo para validar por DNI manual; en escaneo usamos chip). */
  function showTodoCorrectoModal(dni, esRegistro) {
    var modal = document.getElementById('qr-modal-success');
    var body = document.getElementById('qr-modal-success-body');
    var titleEl = document.getElementById('qr-modal-success-title');
    if (!modal || !body) return;
    _qrModalPreviousFocus = document.activeElement;
    if (titleEl) titleEl.textContent = esRegistro ? 'Registrado' : 'Todo correcto';
    body.innerHTML = '<div class="qr-modal-dni-badge" aria-label="DNI">' + (dni || '-') + '</div><p class="qr-modal-message">' + (esRegistro ? 'DNI registrado correctamente.' : 'Validación correcta.') + '</p>';
    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    var closeBtn = document.getElementById('qr-modal-success-close');
    if (closeBtn) closeBtn.focus();
    if (window.lucide) window.lucide.createIcons();
  }

  function closeSuccessModal() {
    var modal = document.getElementById('qr-modal-success');
    if (modal) {
      var focusTarget = _qrModalPreviousFocus && document.body.contains(_qrModalPreviousFocus) && !modal.contains(_qrModalPreviousFocus)
        ? _qrModalPreviousFocus
        : document.getElementById('qr-menu-btn');
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
      modal.setAttribute('hidden', '');
      modal.setAttribute('aria-hidden', 'true');
    }
  }

  var isProcessingQr = false;

  function onQrSuccess(decodedText, ocrData) {
    var dni = extractDniFromQr(decodedText);
    if (!dni) {
      playError();
      var msg = 'El código QR no contiene un DNI válido. En Perú (RENIEC) el DNI tiene exactamente 8 dígitos.';
      if (typeof Swal !== 'undefined') Swal.fire({ title: 'DNI no detectado', text: msg, icon: 'warning', confirmButtonColor: '#27ae60' });
      else alert(msg);
      return;
    }
    if (isProcessingQr) return;
    isProcessingQr = true;
    playScan();
    speakVoice('Escaneando');
    setLoading(true, 'Procesando...');
    processQR(dni)
      .then(function (result) {
        isProcessingQr = false;
        setLoading(false);
        if (result.offline) {
          addHistorial({ dni, resultado: 'Pendiente' });
          updateUI();
          setLastDniDisplay(dni, 'Registrado');
          playSuccess();
          speakVoice('Registrado');
          showChipToast('Registrado', 'success');
          return;
        }
        if (result.localNoCors) {
          playSuccess();
          speakVoice('Registrado');
          addHistorial({ dni, resultado: 'Enviado' });
          updateUI();
          setLastDniDisplay(dni, 'Enviado');
          showChipToast('Registrado', 'success');
          return;
        }
        if (result.ok && result.registered) {
          playSuccess();
          speakVoice('Registrado');
          addHistorial({ dni, resultado: 'Registrado' });
          updateUI();
          setLastDniDisplay(result.id || dni, 'Registrado');
          showChipToast('Registrado', 'success');
          return;
        }
        if (result.ok && result.validated) {
          playSuccess();
          speakVoice('Usuario ya registrado');
          addHistorial({ dni, resultado: 'Validado' });
          updateUI();
          setLastDniDisplay(result.id || dni, 'Validado');
          var msg = (result.message || 'Usuario ya fue registrado') + ' · Q Berries';
          showChipToast(msg, 'success');
          return;
        }
        playError();
        if (typeof Swal !== 'undefined') Swal.fire({ title: 'Error', text: result.error || 'Error al procesar', icon: 'error', confirmButtonColor: '#1a5276' });
        else alert(result.error || 'Error al procesar');
      })
      .catch(function (err) {
        isProcessingQr = false;
        setLoading(false);
        addHistorial({ dni, resultado: 'Pendiente' });
        updateUI();
        setLastDniDisplay(dni, 'Registrado');
        playSuccess();
        speakVoice('Registrado');
        showChipToast('Guardado. Se enviará al conectar.', 'success');
      });
  }

  function showConnectionErrorSwal() {
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        title: 'Problemas de conexión',
        text: 'Verifique su internet e intente de nuevo. Si el problema continúa, contacte a soporte.',
        icon: 'error',
        confirmButtonText: 'Entendido',
        confirmButtonColor: '#27ae60',
        customClass: { popup: 'qr-swal-popup' }
      });
    } else {
      alert('Problemas de conexión. Verifique su internet e intente de nuevo.');
    }
  }

  function getFileScannerInstance() {
    if (html5QrCodeFile) return html5QrCodeFile;
    if (typeof Html5Qrcode !== 'function') return null;
    var el = document.getElementById('qr-file-scanner');
    if (!el) return null;
    html5QrCodeFile = new Html5Qrcode('qr-file-scanner');
    return html5QrCodeFile;
  }

  function setFileNamePlaceholder(name) {
    var el = document.getElementById('qr-file-name');
    if (el) el.textContent = name ? 'Archivo: ' + name : '';
  }

  /** Si Tesseract está cargado, extrae de la imagen los demás datos (nombre, cargo) para prellenar el formulario. No valida DNI. */
  function getOcrDataFromImage(file, onResult) {
    if (typeof Tesseract === 'undefined' || !Tesseract.recognize || !file) {
      onResult(null);
      return;
    }
    Tesseract.recognize(file, 'spa+eng', { logger: function () {} })
      .then(function (result) {
        var text = (result && result.data && result.data.text) ? result.data.text : '';
        var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        var dniDigits = extractDniFromQr(text).replace(/\D/g, '');
        var cargo = '';
        var nombre = '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var onlyDigits = line.replace(/\D/g, '');
          if (onlyDigits.length === 8) continue;
          if (line.length < 2) continue;
          if (!cargo) { cargo = line; continue; }
          if (!nombre) { nombre = line; break; }
        }
        if (!cargo && nombre) { cargo = nombre; nombre = ''; }
        onResult((cargo || nombre) ? { cargo: cargo || '', nombre: nombre || '' } : null);
      })
      .catch(function () {
        onResult(null);
      });
  }

  /** Normaliza tamaño de imagen (escala arriba o abajo) para que el decoder lea mejor. Retorna Promise<File>. */
  function resizeImageForQr(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        var scale = maxSide / Math.max(w, h);
        if (Math.abs(scale - 1) < 0.05) {
          resolve(file);
          return;
        }
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (blob) {
          if (!blob) { resolve(file); return; }
          resolve(new File([blob], file.name || 'image.jpg', { type: blob.type }));
        }, file.type || 'image/jpeg', quality || 0.92);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  var MAX_FILE_SIZE_MB = 12;
  var MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

  function scanFileAsQr(file) {
    if (!file || !file.type.startsWith('image/')) {
      if (file && !file.type.startsWith('image/')) {
        setFileNamePlaceholder('');
        playError();
        if (typeof Swal !== 'undefined') Swal.fire({ title: 'Archivo no válido', text: 'Seleccione una imagen (JPG, PNG, etc.).', icon: 'warning', confirmButtonColor: '#27ae60' });
        else alert('Seleccione una imagen.');
      }
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileNamePlaceholder('');
      playError();
      if (typeof Swal !== 'undefined') Swal.fire({ title: 'Archivo demasiado grande', text: 'El archivo no debe superar ' + MAX_FILE_SIZE_MB + ' MB.', icon: 'warning', confirmButtonColor: '#27ae60' });
      else alert('El archivo no debe superar ' + MAX_FILE_SIZE_MB + ' MB.');
      return;
    }
    setFileNamePlaceholder(file.name);
    setLoading(true, 'Analizando imagen...');
    var instance = getFileScannerInstance();
    if (!instance) {
      setLoading(false);
      playError();
      setFileNamePlaceholder('');
      if (typeof Swal !== 'undefined') Swal.fire({ title: 'Error', text: 'Librería de escaneo no disponible.', icon: 'error', confirmButtonColor: '#27ae60' });
      else alert('Librería de escaneo no disponible.');
      return;
    }
    function doScan(f) {
      return instance.scanFile(f, false);
    }
    function onScanSuccess(decodedText) {
      var dniFromQr = extractDniFromQr(decodedText);
      if (!dniFromQr) {
        setLoading(false);
        setFileNamePlaceholder('');
        playError();
        if (typeof Swal !== 'undefined') Swal.fire({ title: 'DNI no válido', text: 'El DNI en Perú (RENIEC) debe tener exactamente 8 dígitos.', icon: 'warning', confirmButtonColor: '#27ae60' });
        else alert('El QR no contiene un DNI válido.');
        return;
      }
      setLoading(true, 'Extrayendo datos...');
      getOcrDataFromImage(file, function (ocrData) {
        setLoading(false);
        setFileNamePlaceholder('');
        onQrSuccess(decodedText, ocrData);
      });
    }
    function onScanError() {
      setLoading(false);
      setFileNamePlaceholder('');
      playError();
      if (typeof Swal !== 'undefined') Swal.fire({
        title: 'Código QR no reconocido',
        text: 'No se detectó un QR válido en la imagen. Use una foto nítida de la credencial donde el código se vea completo y sin reflejos.',
        icon: 'warning',
        confirmButtonText: 'Entendido',
        confirmButtonColor: '#27ae60'
      });
      else alert('No se pudo leer el código QR. Use una foto nítida de la credencial.');
    }
    doScan(file)
      .then(function (decodedText) {
        onScanSuccess(decodedText);
      })
      .catch(function () {
        resizeImageForQr(file, 1200, 0.9)
          .then(function (resized) {
            return resized === file ? Promise.reject() : doScan(resized);
          })
          .then(function (decodedText) {
            onScanSuccess(decodedText);
          })
          .catch(function () {
            return resizeImageForQr(file, 800, 0.88)
              .then(function (resized) { return doScan(resized); })
              .then(function (decodedText) {
                onScanSuccess(decodedText);
              });
          })
          .catch(function () {
            onScanError();
          });
      });
  }

  function initScanner() {
    const container = document.getElementById('qr-reader');
    if (!container || typeof Html5Qrcode !== 'function') return;

    if (html5QrCode) {
      try { html5QrCode.clear(); } catch (_) {}
      html5QrCode = null;
      scannerStarted = false;
    }

    html5QrCode = new Html5Qrcode('qr-reader');
    // Área de escaneo más grande y adaptable para que lea QR como el de la credencial (Google/cel leen mejor si el cuadro es amplio)
    const config = {
      fps: 15,
      qrbox: function (viewfinderWidth, viewfinderHeight) {
        var size = Math.min(320, Math.min(viewfinderWidth, viewfinderHeight) * 0.85);
        return { width: size, height: size };
      },
      aspectRatio: 1.0
    };

    html5QrCode.start(
      { facingMode: 'environment' },
      config,
      function (decodedText) {
        if (!scannerStarted) return;
        onQrSuccess(decodedText);
        html5QrCode.pause();
        setTimeout(function () {
          if (html5QrCode && scannerStarted) html5QrCode.resume();
        }, 1500);
      },
      function () {}
    ).then(function () {
      scannerStarted = true;
    }).catch(function (err) {
      if (typeof Swal !== 'undefined') Swal.fire({ title: 'Cámara', text: 'No se pudo acceder a la cámara. Revisa permisos.', icon: 'warning', confirmButtonColor: '#27ae60' });
      else alert('No se pudo acceder a la cámara.');
    });
  }

  function showView(viewId) {
    document.querySelectorAll('.qr-view').forEach(function (el) {
      el.hidden = el.id !== 'view-' + viewId;
    });
    document.querySelectorAll('.qr-nav-link, .nav-link[data-view]').forEach(function (link) {
      link.classList.toggle('active', link.getAttribute('data-view') === viewId);
    });
    const sidebar = document.getElementById('qr-sidebar');
    if (sidebar) sidebar.classList.remove('active');

    if (viewId === 'escanear' && !scannerStarted && html5QrCode) {
      try { html5QrCode.resume(); } catch (_) {}
    }
    if (viewId === 'historial') renderHistorial();
    if (window.lucide) window.lucide.createIcons();
  }

  function renderHistorial() {
    const tbody = document.getElementById('qr-historial-body');
    const empty = document.getElementById('qr-historial-empty');
    const wrap = document.querySelector('.qr-historial-table-wrap');
    const paginationEl = document.getElementById('qr-historial-pagination');
    const pendientesAviso = document.getElementById('qr-historial-pendientes-aviso');
    if (pendientesAviso) pendientesAviso.hidden = getPendingCount() === 0;
    const list = getHistorial();
    if (!tbody) return;
    tbody.innerHTML = '';
    if (list.length === 0) {
      if (empty) empty.style.display = 'block';
      if (wrap) wrap.style.display = 'none';
      if (paginationEl) paginationEl.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (wrap) wrap.style.display = 'block';
    var usePagination = list.length >= HISTORIAL_PAGINATION_MIN;
    var pageList = list;
    if (usePagination) {
      var totalPages = Math.max(1, Math.ceil(list.length / HISTORIAL_PAGE_SIZE));
      if (historialCurrentPage > totalPages) historialCurrentPage = totalPages;
      var start = (historialCurrentPage - 1) * HISTORIAL_PAGE_SIZE;
      pageList = list.slice(start, start + HISTORIAL_PAGE_SIZE);
      if (paginationEl) {
        paginationEl.style.display = 'block';
        var from = start + 1;
        var to = Math.min(start + HISTORIAL_PAGE_SIZE, list.length);
        paginationEl.innerHTML = '<div class="qr-historial-pagination-info">' + from + ' – ' + to + ' de ' + list.length + '</div>' +
          '<div class="qr-historial-pagination-btns">' +
          '<button type="button" class="qr-pagination-btn" id="qr-historial-prev" ' + (historialCurrentPage <= 1 ? 'disabled' : '') + ' aria-label="Página anterior">Anterior</button>' +
          '<span class="qr-pagination-page">Página ' + historialCurrentPage + ' de ' + totalPages + '</span>' +
          '<button type="button" class="qr-pagination-btn" id="qr-historial-next" ' + (historialCurrentPage >= totalPages ? 'disabled' : '') + ' aria-label="Página siguiente">Siguiente</button>' +
          '</div>';
        var prevBtn = document.getElementById('qr-historial-prev');
        var nextBtn = document.getElementById('qr-historial-next');
        if (prevBtn) prevBtn.addEventListener('click', function () { historialCurrentPage--; renderHistorial(); });
        if (nextBtn) nextBtn.addEventListener('click', function () { historialCurrentPage++; renderHistorial(); });
      }
    } else {
      if (paginationEl) paginationEl.style.display = 'none';
    }
    pageList.forEach(function (e) {
      const tr = document.createElement('tr');
      const fecha = e.ts ? new Date(e.ts).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'medium' }) : '-';
      tr.innerHTML = '<td>' + fecha + '</td><td>' + (e.dni || '') + '</td><td>' + (e.resultado || '') + '</td>';
      tbody.appendChild(tr);
    });
  }

  function updateOfflineNotice() {
    var el = document.getElementById('qr-offline-notice');
    if (!el) return;
    if (navigator.onLine) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function bindUi() {
    updateUI();
    updateOfflineNotice();
    window.addEventListener('online', function () {
      updateUI();
      updateOfflineNotice();
      enviarPendientes();
    });
    window.addEventListener('offline', function () {
      updateUI();
      updateOfflineNotice();
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: 'Modo offline',
          html: '<p>Estamos en modo offline. Todo se guardará en caché.</p><p>Los escaneos quedarán en <strong>Pendiente</strong> y se enviarán al recuperar la conexión.</p>',
          icon: 'info',
          confirmButtonText: 'Entendido',
          confirmButtonColor: '#27ae60',
          customClass: { popup: 'qr-swal-popup' }
        });
      }
    });
    window.addEventListener('qr-pending-updated', updateUI);
    window.addEventListener('qr-sync-start', function (ev) {
      var n = (ev.detail && ev.detail.total) || 0;
      if (n > 0) showChipToast('Enviando pendientes (uno por uno)...', 'info');
    });
    window.addEventListener('qr-sync-done', function (ev) {
      var sent = (ev.detail && ev.detail.sent) || 0;
      if (sent > 0) showChipToast('Pendientes enviados. Historial actualizado.', 'success');
      window.dispatchEvent(new CustomEvent('qr-historial-updated'));
    });
    window.addEventListener('qr-sync-failed', function () {
      showChipToast('No se logró guardar. Se reintentará automáticamente.', 'info');
    });
    window.addEventListener('qr-sync-result', function (ev) {
      var d = ev.detail;
      if (d.type === 'processQR' && d.result && d.result.ok) {
        var dni = (d.result && d.result.id) || d.id;
        updateHistorialPendienteToSynced(dni, d.result, d.isFirstInBatch);
        renderHistorial();
      }
      updateUI();
    });
    window.addEventListener('qr-historial-updated', renderHistorial);

    const sidebar = document.getElementById('qr-sidebar');
    const menuBtn = document.getElementById('qr-menu-btn');
    const closeBtn = document.getElementById('qr-close-btn');
    if (menuBtn && sidebar) menuBtn.addEventListener('click', function () { sidebar.classList.add('active'); });
    if (closeBtn && sidebar) closeBtn.addEventListener('click', function () { sidebar.classList.remove('active'); });
    document.addEventListener('click', function (e) {
      if (!sidebar || !sidebar.classList.contains('active')) return;
      if (!sidebar.contains(e.target) && !(menuBtn && menuBtn.contains(e.target))) sidebar.classList.remove('active');
    });

    document.querySelectorAll('.qr-nav-link, .nav-link[data-view]').forEach(function (link) {
      link.addEventListener('click', function (ev) {
        ev.preventDefault();
            const view = link.getAttribute('data-view');
            if (view) showView(view);
        });
    });

    const successClose = document.getElementById('qr-modal-success-close');
    if (successClose) successClose.addEventListener('click', closeSuccessModal);
    document.getElementById('qr-modal-success')?.querySelector('.qr-modal-backdrop')?.addEventListener('click', closeSuccessModal);

    var validarBtn = document.getElementById('qr-validar-btn');
    var validarDniInput = document.getElementById('qr-validar-dni');
    var validarResult = document.getElementById('qr-validar-result');
    if (validarBtn && validarDniInput && validarResult) {
      validarBtn.addEventListener('click', function () {
        var dni = validarDniInput.value.trim().replace(/\D/g, '');
        if (dni.length !== 8) {
          validarResult.hidden = false;
          validarResult.className = 'qr-validar-result qr-validar-result-error';
          validarResult.textContent = 'El DNI en Perú (RENIEC) tiene exactamente 8 dígitos.';
          return;
        }
        if (!navigator.onLine) {
          validarResult.hidden = false;
          validarResult.className = 'qr-validar-result qr-validar-result-error';
          validarResult.textContent = 'No se puede validar por falta de internet.';
          return;
        }
        validarResult.hidden = true;
        validarResult.textContent = '';
        validarBtn.disabled = true;
        setLoading(true, 'Validando...');
        getValidarDni(dni)
          .then(function (r) {
            validarBtn.disabled = false;
            setLoading(false);
            if (r.ok && r.exists) {
              validarResult.hidden = true;
              setLastDniDisplay(r.id || dni, 'Validado');
              speakVoice('Usuario ya registrado');
              var idShow = r.id || dni;
              if (typeof Swal !== 'undefined') {
                Swal.fire({
                  title: 'Todo correcto',
                  html: '<div class="qr-swal-user-icon"><i data-lucide="user-check"></i></div><p class="qr-swal-dni">DNI <strong>' + idShow + '</strong></p><p class="qr-swal-msg">Está registrado. Validación correcta.</p>',
                  icon: null,
                  showConfirmButton: true,
                  confirmButtonText: 'Cerrar',
                  confirmButtonColor: '#27ae60',
                  customClass: { popup: 'qr-swal-validado-popup' },
                  didOpen: function () { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); }
                });
              } else {
                showChipToast('Todo correcto', 'success');
              }
            } else if (r.ok && !r.exists) {
              validarResult.hidden = false;
              validarResult.className = 'qr-validar-result qr-validar-result-warn';
              validarResult.textContent = 'No está en el registro.';
            } else {
              validarResult.hidden = false;
              validarResult.className = 'qr-validar-result qr-validar-result-error';
              validarResult.textContent = r.error || 'Error al validar.';
            }
          })
          .catch(function (err) {
            validarBtn.disabled = false;
            setLoading(false);
            validarResult.hidden = false;
            validarResult.className = 'qr-validar-result qr-validar-result-error';
            validarResult.textContent = 'Error de conexión. Intente de nuevo.';
          });
      });
    }

  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindUi();

    var fileInput = document.getElementById('qr-file-input');
    var btnUpload = document.getElementById('qr-btn-upload');
    var uploadZone = document.getElementById('qr-upload-zone');
    var fileNameEl = document.getElementById('qr-file-name');
    function handleFile(file) {
      if (!file) return;
      setFileNamePlaceholder(file.name);
      scanFileAsQr(file);
    }
    if (btnUpload && fileInput) {
      btnUpload.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        handleFile(file);
        fileInput.value = '';
      });
    }
    if (uploadZone && fileInput) {
      uploadZone.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.add('qr-upload-dragover');
      });
      uploadZone.addEventListener('dragleave', function (e) {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.remove('qr-upload-dragover');
      });
      uploadZone.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.remove('qr-upload-dragover');
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
          handleFile(file);
        } else if (file) {
          setFileNamePlaceholder('');
          playError();
          if (typeof Swal !== 'undefined') Swal.fire({ title: 'Archivo no válido', text: 'Suelte una imagen (JPG, PNG, etc.).', icon: 'warning', confirmButtonColor: '#27ae60' });
        }
        fileInput.value = '';
      });
    }

    if (window.lucide) window.lucide.createIcons();
    showView('escanear');
    initScanner();
  });
})();
