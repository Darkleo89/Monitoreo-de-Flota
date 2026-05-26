// ══════════════════════════════════════════════════════════════════
//  ALERTAS SAMSARA — BACKEND POR ROLES  (agregar a Code.gs)
// ══════════════════════════════════════════════════════════════════

// Minutos sin atender antes de disparar alerta visual+sonora
const ALERTA_SIN_ATENDER_MIN = 10;

// Roles con acceso a desempeño
const ROLES_SUPERVISOR = ['Supervisor', 'Jefe Monitoreo', 'Admin', 'Administrador'];
const ROLES_ADMIN = ['Admin', 'Administrador'];




// ── Helper: determina si un rol tiene nivel supervisor o mayor ────
function _esSupervisor(rol) {
  return ROLES_SUPERVISOR.includes(rol);
}
function _esAdmin(rol) {
  return ROLES_ADMIN.includes(rol);
}

// ══════════════════════════════════════════════════════════════════
//  obtenerAlertasSamsara  (reemplaza la versión anterior)
//  — Monitorista: solo alertas abiertas de hoy, su estación
//  — Supervisor/Jefe: todas las estaciones, hoy, con tiempo transcurrido
//  — Admin: igual que supervisor (el filtro de fecha lo maneja el histórico)
// ══════════════════════════════════════════════════════════════════
function obtenerAlertasSamsara(token) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };

  try {
    const ss = _libroPrincipal();
    const hoja = ss.getSheetByName(CFG.H_ALERTAS_SAMSARA);
    if (!hoja || hoja.getLastRow() < 2) return { ok: true, data: [], rol: sess.rol };

    const ahora = new Date();
    const hoyY = ahora.getFullYear();
    const hoyM = ahora.getMonth();
    const hoyD = ahora.getDate();
    const numCols = hoja.getLastColumn();
    const esSup = _esSupervisor(sess.rol);

    // Obtener unidades de la estación del usuario
    let unidadesEstacion = null;
    if (!esSup) {
      try {
        const hAsig = _hojaExterna(CFG.BD_ASIG);
        if (hAsig.getLastRow() > 1) {
          const asigRows = hAsig.getRange(2, 1, hAsig.getLastRow() - 1, 6).getValues();
          unidadesEstacion = new Set(
            asigRows
              .filter(r => {
                const estatus = (r[3] || '').toString().toLowerCase().trim();
                const estacion = (r[2] || '').toString().trim();
                return estatus === 'activo' && _normEst(estacion) === _normEst(sess.estacion);
              })
              .map(r => (r[0] || '').toString().trim())  // columna UNIDAD
          );
        }
      } catch(ex) {
        Logger.log('Error cargando unidades: ' + ex.message);
      }
    }

    const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, numCols).getValues();

    const alertas = datos
      .filter(r => {
        if (!r[0] || !r[1]) return false;
        const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
        if (isNaN(f.getTime())) return false;
        if (f.getFullYear() !== hoyY || f.getMonth() !== hoyM || f.getDate() !== hoyD) return false;
        // Filtrar por unidades de la estación si es monitorista
        if (unidadesEstacion !== null) {
          const unidad = (r[2] || '').toString().trim();
          if (!unidadesEstacion.has(unidad)) return false;
        }
        return true;
      })
      .map(r => {
        const fecha = r[1] instanceof Date ? r[1] : new Date(r[1]);
        const minSin = Math.round((ahora - fecha) / 60000);
        const atendidaPor = (r[9] || '').toString().trim();
        const fechaAten = r[10] instanceof Date ? r[10].toISOString() : (r[10] || '').toString();
        const minResp = (atendidaPor && fechaAten)
          ? Math.round((new Date(fechaAten) - fecha) / 60000) : null;

        return {
          ID_ALERTA:      (r[0] || '').toString(),
          FECHA_HORA:     fecha.toISOString(),
          UNIDAD:         (r[2] || '').toString(),
          TIPO:           (r[3] || '').toString(),
          SEVERIDAD:      (r[4] || 'normal').toString(),
          ESTADO:         (r[5] || 'abierto').toString(),
          VIN:            (r[7] || '').toString(),
          URL_SAMSARA:    (r[8] || '').toString(),
          ATENDIDA_POR:   atendidaPor,
          FECHA_ATENCION: fechaAten,
          RESULTADO:      (r[11] || '').toString(),
          ACCIONES:       (r[12] || '').toString(),
          _minSinAtender: minSin,
          _alerta:        !atendidaPor && minSin >= ALERTA_SIN_ATENDER_MIN,
          _minRespuesta:  minResp,
        };
      })
      .sort((a, b) => new Date(b.FECHA_HORA) - new Date(a.FECHA_HORA));

    return { ok: true, data: alertas, rol: sess.rol, estacion: sess.estacion };

  } catch (ex) {
    Logger.log('ERROR obtenerAlertasSamsara: ' + ex.message);
    return { ok: false, msg: ex.message };
  }
}

// ══════════════════════════════════════════════════════════════════
//  obtenerDesempenoMonitoristas
//  — Solo accesible para Supervisor, Jefe, Admin
//  — Calcula por monitorista: total, atendidas, % atención, t. resp. prom.
// ══════════════════════════════════════════════════════════════════
function obtenerDesempenoMonitoristas(token, fechaDesde, fechaHasta) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  if (!_esSupervisor(sess.rol)) return { ok: false, msg: "Sin permisos" };

  try {
    const ss = _libroPrincipal();
    const hoja = ss.getSheetByName(CFG.H_ALERTAS_SAMSARA);
    if (!hoja || hoja.getLastRow() < 2) return { ok: true, data: [], resumen: {} };

    const desde = fechaDesde ? new Date(fechaDesde)
      : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const hasta = fechaHasta ? new Date(fechaHasta)
      : (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; })();

    const numCols = Math.min(hoja.getLastColumn(), 13);
    const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, numCols).getValues();

    // Agrupar por monitorista
    const mapa = {}; // { nombre: { total, atendidas, tiempos[], tipos[] } }

    datos.forEach(r => {
      if (!r[0] || !r[1]) return;
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < desde || f > hasta) return;

      const atendidaPor = (r[9] || "").toString().trim();
      const fechaAtencion = r[10] || "";
      const tipo = (r[3] || "Desconocido").toString().trim();

      // Contar en TOTAL (sin filtrar por atendidaPor — son todas las alertas del periodo)
      const claveTotal = "_TOTAL_";
      if (!mapa[claveTotal]) mapa[claveTotal] = { total: 0, atendidas: 0, tiempos: [], tipos: {} };
      mapa[claveTotal].total++;
      mapa[claveTotal].tipos[tipo] = (mapa[claveTotal].tipos[tipo] || 0) + 1;
      if (atendidaPor) {
        mapa[claveTotal].atendidas++;
        // Tiempo de respuesta
        if (fechaAtencion) {
          const min = Math.round((new Date(fechaAtencion) - f) / 60000);
          if (min >= 0 && min < 600) mapa[claveTotal].tiempos.push(min);
        }
      }

      // Contar por monitorista (solo las que atendió)
      if (!atendidaPor) return;
      if (!mapa[atendidaPor]) mapa[atendidaPor] = { total: 0, atendidas: 0, tiempos: [], tipos: {} };
      mapa[atendidaPor].atendidas++;
      mapa[atendidaPor].tipos[tipo] = (mapa[atendidaPor].tipos[tipo] || 0) + 1;
      if (fechaAtencion) {
        const min = Math.round((new Date(fechaAtencion) - f) / 60000);
        if (min >= 0 && min < 600) mapa[atendidaPor].tiempos.push(min);
      }
    });

    // Total de alertas del periodo (para calcular % por monitorista)
    const totalAlertas = mapa["_TOTAL_"] ? mapa["_TOTAL_"].total : 0;
    const totalAtendidas = mapa["_TOTAL_"] ? mapa["_TOTAL_"].atendidas : 0;

    // Tipos más frecuentes (global)
    const tiposGlobal = mapa["_TOTAL_"] ? mapa["_TOTAL_"].tipos : {};
    const tiposTop = Object.entries(tiposGlobal)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tipo, cnt]) => ({ tipo, cnt }));

    // Construir array de monitoristas
    const monitoristas = Object.entries(mapa)
      .filter(([k]) => k !== "_TOTAL_")
      .map(([nombre, d]) => {
        const prom = d.tiempos.length
          ? Math.round(d.tiempos.reduce((a, b) => a + b, 0) / d.tiempos.length * 10) / 10
          : null;
        const pct = totalAlertas > 0
          ? Math.round((d.atendidas / totalAlertas) * 100)
          : 0;
        return { nombre, atendidas: d.atendidas, total: totalAlertas, pct, tRespProm: prom };
      })
      .sort((a, b) => b.pct - a.pct);

    const pctGlobal = totalAlertas > 0
      ? Math.round((totalAtendidas / totalAlertas) * 100) : 0;

    return {
      ok: true,
      data: monitoristas,
      resumen: {
        total: totalAlertas,
        atendidas: totalAtendidas,
        sinAtender: totalAlertas - totalAtendidas,
        pctGlobal,
      },
      tiposTop,
      rol: sess.rol,
    };
  } catch (ex) {
    return { ok: false, msg: ex.message };
  }
}

// ══════════════════════════════════════════════════════════════════
//  obtenerHistoricoAlertas  (solo Admin)
//  — Filtrable por fechas y monitorista
//  — Devuelve también evolución diaria agrupada
// ══════════════════════════════════════════════════════════════════
function obtenerHistoricoAlertas(token, fechaDesde, fechaHasta, monitorista) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  if (!_esAdmin(sess.rol)) return { ok: false, msg: "Sin permisos" };

  try {
    const ss = _libroPrincipal();
    const hoja = ss.getSheetByName(CFG.H_ALERTAS_SAMSARA);
    if (!hoja || hoja.getLastRow() < 2) return { ok: true, data: [], evolucion: [] };

    const desde = fechaDesde ? new Date(fechaDesde)
      : (() => { const d = new Date(); d.setDate(d.getDate() - 30); d.setHours(0, 0, 0, 0); return d; })();
    const hasta = fechaHasta ? new Date(fechaHasta)
      : (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; })();

    const numCols = Math.min(hoja.getLastColumn(), 13);
    const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, numCols).getValues();

    // Agrupar por día para gráfica de evolución
    const porDia = {}; // { 'YYYY-MM-DD': { total, atendidas, porMonitorista:{} } }

    const filtradas = datos.filter(r => {
      if (!r[0] || !r[1]) return false;
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < desde || f > hasta) return false;
      if (monitorista && (r[9] || "") !== monitorista) return false;
      return true;
    });

    filtradas.forEach(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      const dia = f.toISOString().slice(0, 10);
      const mon = (r[9] || "").toString().trim();

      if (!porDia[dia]) porDia[dia] = { total: 0, atendidas: 0, porMonitorista: {} };
      porDia[dia].total++;
      if (mon) {
        porDia[dia].atendidas++;
        if (!porDia[dia].porMonitorista[mon]) porDia[dia].porMonitorista[mon] = { total: 0, atendidas: 0 };
        porDia[dia].porMonitorista[mon].atendidas++;
      }
      // contar total por monitorista (sin filtrar)
    });

    // Obtener lista de monitoristas únicos
    const monitoristasUnicos = [...new Set(
      filtradas.map(r => (r[9] || "").toString().trim()).filter(Boolean)
    )];

    // Evolución diaria ordenada
    const evolucion = Object.entries(porDia)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, d]) => ({
        dia,
        total: d.total,
        atendidas: d.atendidas,
        pct: d.total > 0 ? Math.round((d.atendidas / d.total) * 100) : 0,
        porMonitorista: monitoristasUnicos.reduce((acc, m) => {
          const pm = d.porMonitorista[m] || { atendidas: 0 };
          acc[m] = d.total > 0 ? Math.round((pm.atendidas / d.total) * 100) : 0;
          return acc;
        }, {}),
      }));

    return {
      ok: true,
      data: filtradas.map(r => ({
        ID_ALERTA: r[0],
        FECHA_HORA: r[1],
        UNIDAD: r[2],
        TIPO: r[3],
        SEVERIDAD: r[4],
        ESTADO: r[5],
        DETALLES: r[6],
        VIN: r[7],
        URL_SAMSARA: r[8],
        ATENDIDA_POR: r[9] || "",
        FECHA_ATEN: r[10] || "",
        RESULTADO: r[11] || "",
        ACCIONES: r[12] || "",
      })),
      evolucion,
      monitoristasUnicos,
      rol: sess.rol,
    };
  } catch (ex) {
    return { ok: false, msg: ex.message };
  }
}

// ══════════════════════════════════════════════════════════════════
//  marcarAlertaAtendida  (versión actualizada — reemplaza la anterior)
// ══════════════════════════════════════════════════════════════════
function marcarAlertaAtendida(token, idAlerta, monitorista, resultado, acciones) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };

  try {
    const hoja = _hoja(CFG.H_ALERTAS_SAMSARA);
    const rows = hoja.getRange(2, 1, hoja.getLastRow() - 1, 9).getValues();
    const idx = rows.findIndex(r => r[0] === idAlerta);
    if (idx < 0) return { ok: false, msg: "Alerta no encontrada" };

    hoja.getRange(idx + 2, 10).setValue(monitorista || sess.nombre);
    hoja.getRange(idx + 2, 11).setValue(new Date().toISOString());
    hoja.getRange(idx + 2, 12).setValue(resultado || "");
    hoja.getRange(idx + 2, 13).setValue(acciones || "");
    return { ok: true };
  } catch (ex) {
    return { ok: false, msg: ex.message };
  }
}

function testAlertas() {
  const ss = _libroPrincipal();
  const hoja = ss.getSheetByName("Alertas_Samsara");
  Logger.log("Hoja encontrada: " + (hoja !== null));
  Logger.log("Filas: " + (hoja ? hoja.getLastRow() : 0));
  Logger.log("Cols: " + (hoja ? hoja.getLastColumn() : 0));
  if (hoja && hoja.getLastRow() > 1) {
    Logger.log("Fila 2: " + JSON.stringify(hoja.getRange(2, 1, 1, hoja.getLastColumn()).getValues()[0]));
  }
}

function testFiltroFecha() {
  const hoja = _libroPrincipal().getSheetByName(CFG.H_ALERTAS_SAMSARA);
  const datos = hoja.getRange(2, 1, Math.min(hoja.getLastRow() - 1, 50), 9).getValues();
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const hoy_iso = hoy.toISOString().slice(0, 10);

  const pasanFiltro = datos.filter(r => {
    if (!r[0] || !r[1]) return false;
    const f = new Date(r[1]);
    return !isNaN(f.getTime()) && f >= hoy;
  });

  Logger.log("Fecha hoy: " + hoy_iso);
  Logger.log("Filas que pasan filtro hoy: " + pasanFiltro.length);
  if (pasanFiltro.length) Logger.log("Primera: " + pasanFiltro[0][0] + " | " + pasanFiltro[0][1]);
}

function testRangoFechas() {
  const hoja = _libroPrincipal().getSheetByName(CFG.H_ALERTAS_SAMSARA);
  const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues();

  const fechas = datos
    .map(r => new Date(r[1]))
    .filter(f => !isNaN(f.getTime()))
    .sort((a, b) => b - a);

  Logger.log("Fecha más reciente: " + fechas[0].toISOString().slice(0, 10));
  Logger.log("Fecha más antigua:  " + fechas[fechas.length - 1].toISOString().slice(0, 10));
  Logger.log("Total filas válidas: " + fechas.length);
}

function testHoyMexico() {
  const OFFSET_H = -6;
  const ahoraLocal = new Date(new Date().getTime() + OFFSET_H * 3600000);
  const hoyStr = ahoraLocal.toISOString().slice(0, 10);

  const hoja = _libroPrincipal().getSheetByName(CFG.H_ALERTAS_SAMSARA);
  const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues();

  const hoy = datos.filter(r => r[1] && r[1].toString().slice(0, 10) === hoyStr);
  Logger.log("hoyStr: " + hoyStr + " | Filas de hoy: " + hoy.length);
}

function testFechasHoy() {
  const hoja = _libroPrincipal().getSheetByName(CFG.H_ALERTAS_SAMSARA);
  const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues();

  // Mostrar las 5 fechas más recientes tal como están en la hoja
  const recientes = datos
    .filter(r => r[1])
    .sort((a, b) => new Date(b[1]) - new Date(a[1]))
    .slice(0, 5);

  recientes.forEach(r => Logger.log(r[0] + " → " + r[1].toString()));
}



function testFiltroNativo() {
  const ahora = new Date();
  const hoyY = ahora.getFullYear();
  const hoyM = ahora.getMonth();
  const hoyD = ahora.getDate();

  Logger.log("Buscando: " + hoyY + "-" + (hoyM + 1) + "-" + hoyD);

  const hoja = _libroPrincipal().getSheetByName(CFG.H_ALERTAS_SAMSARA);
  const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues();

  const hoy = datos.filter(r => {
    if (!r[1]) return false;
    const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
    return f.getFullYear() === hoyY &&
      f.getMonth() === hoyM &&
      f.getDate() === hoyD;
  });

  Logger.log("Filas de hoy: " + hoy.length);
  if (hoy.length) Logger.log("Ejemplo: " + hoy[0][1].toString());
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function testArchivos() {
  const archivos = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  Logger.log("ID del proyecto activo");

  // Lista todos los archivos HTML del proyecto
  const html = HtmlService.createHtmlOutput('test');
  Logger.log(html);
}

function testValidarToken() {
  // Primero simula un login para obtener un token real
  const resLogin = login('Leonel Cauich', 'Leonel Cauich', 'Circuito Mexico', 'alertas');
  Logger.log("Login result: " + JSON.stringify(resLogin));

  if (resLogin.token) {
    const sess = validarToken(resLogin.token);
    Logger.log("Sesión: " + JSON.stringify(sess));

    // Ahora prueba obtenerAlertasSamsara con ese token
    const resAlertas = obtenerAlertasSamsara(resLogin.token);
    Logger.log("ok: " + resAlertas.ok);
    Logger.log("data length: " + (resAlertas.data ? resAlertas.data.length : 'null'));
    Logger.log("msg: " + resAlertas.msg);
  }
}