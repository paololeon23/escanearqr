// Validación QR - Q Berries. GET ?dni= consulta; POST processQR escaneo (registra o devuelve ya registrado).

function doGet(e) {
  if (e == null) e = { parameter: {} };
  var params = (e.parameter != null) ? e.parameter : {};
  if (params.dni !== undefined && params.dni !== null && String(params.dni).trim() !== '') {
    var result = validarDni(String(params.dni).trim());
    var json = JSON.stringify(result);
    if (params.callback) {
      return ContentService.createTextOutput(params.callback + '(' + json + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput('Validación QR - Q Berries. Consulta: ?dni=8digitos')
    .setMimeType(ContentService.MimeType.TEXT);
}

function validarDni(dni) {
  var id = String(dni || '').replace(/\s/g, '').replace(/\D/g, '');
  if (!id || id.length !== CONFIG.DNI_LENGTH) {
    return { ok: false, exists: false, id: id || '', error: 'DNI inválido' };
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONFIG.SHEET_LOG_ACCESOS);
    if (!sheet) return { ok: true, exists: false, id: id };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: true, exists: false, id: id };
    var headers = sheet.getRange(1, 1, 1, 10).getValues()[0];
    var dniCol = 1;
    for (var h = 0; h < headers.length; h++) {
      if (String(headers[h]).toLowerCase().replace(/\s/g, '') === 'dni') { dniCol = h + 1; break; }
    }
    var colDni = sheet.getRange(2, dniCol, lastRow, dniCol).getValues();
    for (var r = 0; r < colDni.length; r++) {
      var cellDni = (colDni[r][0] || '').toString().replace(/\s/g, '');
      if (cellDni === id) return { ok: true, exists: true, id: id, message: 'Usuario ya fue registrado' };
    }
    return { ok: true, exists: false, id: id };
  } catch (err) {
    return { ok: false, exists: false, id: id, error: err.toString() };
  }
}

var CONFIG = {
  SHEET_LOG_ACCESOS: 'Log_Accesos',
  DNI_LENGTH: 8
};

var LOG_ACCESOS_HEADERS = ['id', 'fecha', 'hora', 'dni', 'resultado'];

function doPost(e) {
  var output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  try {
    if (!e || !e.postData || !e.postData.contents) {
      output.setContent(JSON.stringify({ ok: false, error: 'Sin datos POST' }));
      return output;
    }
    var data = JSON.parse(e.postData.contents);
    if (typeof data !== 'object' || data === null) {
      output.setContent(JSON.stringify({ ok: false, error: 'JSON inválido' }));
      return output;
    }
    var action = (data.action || '').toString().trim().toLowerCase();
    if (action === 'processqr') {
      var id = normalizeDni(data.id || '');
      var conInternet = data.isOnline === true || data.conInternet === true;
      var result = processQR(id, conInternet);
      output.setContent(JSON.stringify(result));
      return output;
    }
    output.setContent(JSON.stringify({ ok: false, error: 'Acción no válida: ' + action }));
    return output;
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.toString() }));
    return output;
  }
}

function normalizeDni(id) {
  if (id == null) return '';
  var s = String(id).replace(/\s/g, '').replace(/\D/g, '');
  if (s.length !== CONFIG.DNI_LENGTH) return '';
  return s;
}

function isValidDni(id) {
  var cleaned = String(id || '').replace(/\s/g, '').replace(/\D/g, '');
  return cleaned.length === CONFIG.DNI_LENGTH;
}

function processQR(id, conInternet) {
  if (!isValidDni(id)) {
    return { ok: false, error: 'DNI inválido' };
  }
  var idNorm = String(id).replace(/\s/g, '').replace(/\D/g, '');
  if (idNorm.length !== CONFIG.DNI_LENGTH) return { ok: false, error: 'DNI inválido (debe ser 8 dígitos)' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet(ss, CONFIG.SHEET_LOG_ACCESOS, LOG_ACCESOS_HEADERS);
  var lastRow = sheet.getLastRow();
  var yaExiste = false;
  if (lastRow >= 2) {
    var headers = sheet.getRange(1, 1, 1, 10).getValues()[0];
    var dniCol = 1;
    for (var h = 0; h < headers.length; h++) {
      if (String(headers[h]).toLowerCase().replace(/\s/g, '') === 'dni') { dniCol = h + 1; break; }
    }
    var colDni = sheet.getRange(2, dniCol, lastRow, dniCol).getValues();
    for (var r = 0; r < colDni.length; r++) {
      var cellDni = (colDni[r][0] || '').toString().replace(/\s/g, '');
      if (cellDni === idNorm) { yaExiste = true; break; }
    }
  }

  if (yaExiste) {
    return {
      ok: true,
      validated: true,
      id: idNorm,
      message: 'Usuario ya fue registrado'
    };
  }

  var lock = LockService.getDocumentLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return { ok: false, error: 'Sistema ocupado. Intente de nuevo.' };
  }
  try {
    var now = new Date();
    var tz = Session.getScriptTimeZone() || 'UTC';
    var fecha = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    var hora = Utilities.formatDate(now, tz, 'HH:mm:ss');
    var n = sheet.getLastRow();
    var nextId = n < 10 ? '0' + n : String(n);
    sheet.appendRow([nextId, fecha, hora, idNorm, 'REGISTRADO']);
    lock.releaseLock();
    return { ok: true, registered: true, id: idNorm, timestamp: fecha + ' ' + hora };
  } catch (err) {
    try { lock.releaseLock(); } catch (_) {}
    return { ok: false, error: err.toString() };
  }
}

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1a5276').setFontColor('#fff');
  }
  return sheet;
}
