// ╔══════════════════════════════════════════════════════════════╗
// ║   MONITOR DE FLOTA PRO — Codigo.gs  v6.1                ║
// ║   GrupoGal · Sistema de Control Logístico               ║
// ╚══════════════════════════════════════════════════════════════╝

const ID_LIBRO_PRINCIPAL = "11tSvKn5T6fEakLc9Oqp8UkKNg9HMTCs-qaB1aZImnfQ";
const ID_LIBRO_BD_ = "1rAKnvS90U5nP1_e8Pa3YM8WsfcPnIQT3r1QYJ-dsCKk";
const SAMSARA_WEBHOOK_SECRET = "KzpI73keTJa4HU+dt0eaW1WRpb0="; // ← Pega tu secret key
let _cacheLibroPrincipal = null;

const CFG = {
  ID_LIBRO_PRINCIPAL: ID_LIBRO_PRINCIPAL,
  ID_LIBRO_BD: ID_LIBRO_BD_,

  // Hojas BD externo
  BD_USUARIOS: "Usuario",
  BD_ASIG: "Asig_Monitoreo",
  BD_ESTACIONES: "Estaciones",
  BD_REMOLQUES: "Remolque",
  BD_DOLLY: "Dolly",

  // Hojas operativas
  H_BARRIDOS: "DB_Barridos",
  H_NOVEDADES: "DB_Novedades",
  H_SLA: "DB_Tareas_SLA",
  H_TOKENS: "DB_Tokens",
  H_MOVIMIENTOS: "DB_Movimientos",
  H_RELEVOS: "DB_Relevos",
  H_NOTAS: "DB_Notas_Unidad",
  H_TRASPASOS: "DB_Traspasos",
  H_ALERTAS_SAMSARA: "Alertas_Samsara",  // ← NUEVA

  EMAIL_CC: "leonel.cauich@grupogal.com",
  EMAIL_INC: "leonel.cauich.pro@gmail.com",

  SLA_BARRIDO: 30,
  SLA_CORREO_INC: 15,
  SLA_CLIMA: 120,
  TOKEN_HORAS: 8,

  ROLES: { MONITORISTA: "Monitorista", SUPERVISOR: "Supervisor", ADMIN: "Admin" },

  TIPOS_INC: [
    "FALLA_MECANICA",
    "ACCIDENTE",
    "INFRACCION",
    "DETENIDO_AUTORIDAD",
    "CORTE_MOTOR",
    "PESOS_DIMENSIONES",
    "INFRACCION_DADIVA",
  ],
};

// ══════════════════════════════════════════════════════════════════
//  WEB APP
// ══════════════════════════════════════════════════════════════════
function doGet(e) {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Monitor de Flota PRO · GrupoGal")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function include(filename) {
  if (!filename) return "";
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
  } catch (e) {
    Logger.log("include ERROR [" + filename + "]: " + e.message);
    return "<!-- ERROR: " + filename + " → " + e.message + " -->";
  }
}

// ══════════════════════════════════════════════════════════════════
//  AUTENTICACIÓN
// ══════════════════════════════════════════════════════════════════
function login(usuario, contrasena, estacion) {
  try {
    const hU = _hojaExterna(CFG.BD_USUARIOS);
    if (hU.getLastRow() < 2) return { ok: false, msg: "Sin usuarios configurados." };
    const cols = hU.getRange(1, 1, 1, 7).getValues()[0];
    const rows = hU.getRange(2, 1, hU.getLastRow() - 1, 7).getValues();
    const fila = rows.find(r => r[0] === usuario && r[1] === contrasena);
    if (!fila) return { ok: false, msg: "Usuario o contraseña incorrectos." };
    const obj = _toObj(cols, fila);
    if ((obj.Estatus || "").toLowerCase() !== "activo")
      return { ok: false, msg: "Usuario inactivo. Contacta al administrador." };

    const rol = obj.Rol || CFG.ROLES.MONITORISTA;
    const nombre = obj.MONITORISTA || obj.USUARIO || usuario;
    const token = Utilities.getUuid();
    const expira = new Date();
    expira.setHours(expira.getHours() + CFG.TOKEN_HORAS);

    const hT = _hoja(CFG.H_TOKENS);
    if (hT.getLastRow() > 1) {
      const tRows = hT.getRange(2, 1, hT.getLastRow() - 1, 7).getValues();
      tRows.forEach((r, i) => {
        if (r[1] === usuario && r[4] === "ACTIVO")
          hT.getRange(i + 2, 5).setValue("INVALIDADO");
      });
    }
    hT.appendRow([token, usuario, nombre, estacion, "ACTIVO", new Date(), expira]);

    try {
      const idx = rows.findIndex(r => r[0] === usuario);
      if (idx >= 0) hU.getRange(idx + 2, 6).setValue(new Date());
    } catch (ex) { }

    _hoja(CFG.H_RELEVOS).appendRow([
      "INICIO_TURNO", new Date(), nombre, usuario, rol, estacion, token, "", ""
    ]);

    return {
      ok: true, token, expira: expira.toISOString(),
      usuario: { nombre, login: usuario, rol, estacion }
    };
  } catch (e) { return { ok: false, msg: "Error interno: " + e.message }; }
}

function validarToken(token) {
  const hT = _hoja(CFG.H_TOKENS);
  if (hT.getLastRow() < 2) return null;
  const rows = hT.getRange(2, 1, hT.getLastRow() - 1, 7).getValues();
  const idx = rows.findIndex(r => r[0] === token && r[4] === "ACTIVO");
  if (idx < 0) return null;
  const expira = rows[idx][6] instanceof Date ? rows[idx][6] : new Date(rows[idx][6]);
  if (new Date() > expira) {
    hT.getRange(idx + 2, 5).setValue("EXPIRADO");
    return null;
  }
  return {
    login: rows[idx][1],
    nombre: rows[idx][2],
    estacion: rows[idx][3],
    rol: _getRolUsuario(rows[idx][1]),
  };
}

function _getRolUsuario(login) {
  try {
    const hU = _hojaExterna(CFG.BD_USUARIOS);
    if (hU.getLastRow() < 2) return CFG.ROLES.MONITORISTA;
    const rows = hU.getRange(2, 1, hU.getLastRow() - 1, 4).getValues();
    const fila = rows.find(r => r[0] === login);
    return fila ? (fila[3] || CFG.ROLES.MONITORISTA) : CFG.ROLES.MONITORISTA;
  } catch (e) { return CFG.ROLES.MONITORISTA; }
}

function logout(token) {
  try {
    const hT = _hoja(CFG.H_TOKENS);
    if (hT.getLastRow() < 2) return { ok: true };
    const rows = hT.getRange(2, 1, hT.getLastRow() - 1, 5).getValues();
    const idx = rows.findIndex(r => r[0] === token);
    if (idx >= 0) hT.getRange(idx + 2, 5).setValue("CERRADO");
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// ══════════════════════════════════════════════════════════════════
//  CATÁLOGOS
// ══════════════════════════════════════════════════════════════════
function obtenerEstacionesPublico() {
  try {
    const h = _hojaExterna(CFG.BD_ESTACIONES);
    if (h.getLastRow() < 2) return [];
    return h.getRange(2, 1, h.getLastRow() - 1, 3).getValues()
      .filter(r => (r[1] || "").toLowerCase() === "activo")
      .map(r => ({ circuito: r[0], detalle: r[2] || r[0] }));
  } catch (e) {
    return [
      { circuito: "Circuito Mexico", detalle: "Circuito Mexico" },
      { circuito: "Base Mexico", detalle: "Base Mexico" },
      { circuito: "Peninsula 1", detalle: "Península 1" },
      { circuito: "Peninsula 2", detalle: "Península 2" },
      { circuito: "Celaya", detalle: "Celaya" },
    ];
  }
}

function obtenerEstaciones(token) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  try {
    const h = _hojaExterna(CFG.BD_ESTACIONES);
    if (h.getLastRow() < 2) return { ok: true, data: [] };
    const cols = h.getRange(1, 1, 1, 3).getValues()[0];
    const data = h.getRange(2, 1, h.getLastRow() - 1, 3).getValues()
      .filter(r => (r[1] || "").toLowerCase() === "activo")
      .map(r => _toObj(cols, r));
    return { ok: true, data };
  } catch (e) { return { ok: false, msg: e.message }; }
}

function obtenerUnidadesAsignadas(token, estacion) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  try {
    const h = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.BD_ASIG);
    if (!h || h.getLastRow() < 2) return { ok: true, data: [] };
    const cols = h.getRange(1, 1, 1, 6).getValues()[0];
    const esAdmin = [CFG.ROLES.ADMIN, CFG.ROLES.SUPERVISOR].includes(sess.rol);
    const est = estacion || sess.estacion;

    const propias = h.getRange(2, 1, h.getLastRow() - 1, 6).getValues()
      .filter(r => {
        if ((r[3] || "").toString().toLowerCase().trim() !== "activo") return false;
        if (esAdmin) return !est || r[2].toString().trim() === est.toString().trim();
        return _normEst(r[2]) === _normEst(est);
      })
      .map(r => {
        const obj = _toObj(cols, r);
        if (obj.UNIDAD) obj.UNIDAD = obj.UNIDAD.toString().trim();
        return { ...obj, _origen: "PROPIA" };
      });

    // Ocultar unidades que están en tránsito saliendo de esta estación
    const enTransito = _unidadesEnTransitoDe(est);
    const idsEnTransito = new Set(enTransito.map(t => t.unidad.toString().trim()));
    const propiasFiltradas = propias.filter(u => !idsEnTransito.has(u.UNIDAD));

    const compartidas = _unidadesCompartidasHacia(est);
    const propiaIds = new Set(propiasFiltradas.map(u => u.UNIDAD));
    const soloComp = compartidas.filter(c => !propiaIds.has(c.UNIDAD));

    return { ok: true, data: [...propiasFiltradas, ...soloComp] };
  } catch (e) { return { ok: false, msg: e.message }; }
}

function obtenerRemolquesCatalogo(token) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  try {
    const hR = _hojaExterna(CFG.BD_REMOLQUES);
    const hD = _hojaExterna(CFG.BD_DOLLY);
    const remolques = hR.getLastRow() > 1
      ? hR.getRange(2, 1, hR.getLastRow() - 1, 2).getValues()
        .filter(r => (r[1] || "").toLowerCase() === "activo")
        .map(r => ({ id: r[0], tipo: "REMOLQUE" }))
      : [];
    const dollys = hD.getLastRow() > 1
      ? hD.getRange(2, 1, hD.getLastRow() - 1, 2).getValues()
        .filter(r => (r[1] || "").toLowerCase() === "activo")
        .map(r => ({ id: r[0], tipo: "DOLLY" }))
      : [];
    return { ok: true, remolques, dollys };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// ══════════════════════════════════════════════════════════════════
//  TRASPASOS ENTRE CIRCUITOS
// ══════════════════════════════════════════════════════════════════
function registrarTraspaso(token, datos) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  try {
    const id = "TRP-" + new Date().getTime();
    _hoja(CFG.H_TRASPASOS).appendRow([
      id,
      new Date(),
      datos.unidad,
      datos.estacionOrigen || sess.estacion,
      datos.estacionDestino,
      datos.remolque || "",
      datos.dolly || "",
      datos.remolque2 || "",
      datos.tipoCarga || "SENCILLO",
      datos.observaciones || "",
      sess.nombre,
      "ACTIVO",
      "",
      "",
    ]);
    return { ok: true, id, msg: "Unidad " + datos.unidad + " en tránsito hacia " + datos.estacionDestino };
  } catch (e) { return { ok: false, msg: e.message }; }
}

function registrarRetorno(token, idTraspaso) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_TRASPASOS);
  if (h.getLastRow() < 2) return { ok: false, msg: "Sin traspasos registrados" };
  const rows = h.getRange(2, 1, h.getLastRow() - 1, 14).getValues();
  const idx = rows.findIndex(r => r[0] === idTraspaso);
  if (idx < 0) return { ok: false, msg: "Traspaso no encontrado" };
  h.getRange(idx + 2, 12).setValue("RETORNADO");
  h.getRange(idx + 2, 13).setValue(new Date());
  h.getRange(idx + 2, 14).setValue(sess.nombre);
  return { ok: true, msg: "Retorno registrado por " + sess.nombre };
}

function _unidadesCompartidasHacia(estacionDestino) {
  const h = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName(CFG.H_TRASPASOS);
  if (!h || h.getLastRow() < 2) return [];
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return h.getRange(2, 1, h.getLastRow() - 1, 14).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      return r[11] === "ACTIVO" && r[4] === estacionDestino && f >= hoy;
    })
    .map(r => ({
      UNIDAD: r[2],
      CIRCUITO: r[3],
      ESTACION: r[4],
      ESTATUS: "Activo",
      FECHA: r[1],
      "Quien Asigno": r[10],
      _origen: "COMPARTIDA",
      _idTraspaso: r[0],
      _estOrigen: r[3],
      _remolque: r[5],
      _dolly: r[6],
      _remolque2: r[7],
      _tipoCarga: r[8],
    }));
}

function _unidadesEnTransitoDe(estacionOrigen) {
  const h = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName(CFG.H_TRASPASOS);
  if (!h || h.getLastRow() < 2) return [];
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return h.getRange(2, 1, h.getLastRow() - 1, 14).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      return r[11] === "ACTIVO" && r[3] === estacionOrigen && f >= hoy;
    })
    .map(r => ({ unidad: r[2], idTraspaso: r[0], estDestino: r[4] }));
}

function obtenerTraspasos(token, estacion) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_TRASPASOS);
  if (h.getLastRow() < 2) return { ok: true, data: [] };
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const cols = h.getRange(1, 1, 1, 14).getValues()[0];
  const esAdmin = [CFG.ROLES.ADMIN, CFG.ROLES.SUPERVISOR].includes(sess.rol);
  const data = h.getRange(2, 1, h.getLastRow() - 1, 14).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < hoy) return false;
      if (!esAdmin && r[3] !== sess.estacion && r[4] !== sess.estacion) return false;
      if (estacion && r[3] !== estacion && r[4] !== estacion) return false;
      return true;
    })
    .map(r => _toObj(cols, r));
  return { ok: true, data };
}

// ══════════════════════════════════════════════════════════════════
//  DASHBOARD — estado en tiempo real
// ══════════════════════════════════════════════════════════════════
function obtenerEstadoFlota(token, estacion) {
  Logger.log("obtenerEstadoFlota INICIO token=" + token + " estacion=" + estacion);
  try {
    // Sanitizar fechas para evitar crash en serialización
    const _sanitize = function (obj) {
      return JSON.parse(JSON.stringify(obj, function (k, v) {
        return v instanceof Date ? v.toISOString() : v;
      }));
    };
    const sess = validarToken(token);
    if (!sess) return {
      ok: false, msg: "Token inválido o expirado",
      unidades: [], tareasSLA: [], novedades: [], timers: [],
      enTransito: [], resumen: {
        total: 0, cargadas: 0, vacias: 0, subida: 0,
        bajada: 0, detenidas: 0, sinBarrido: 0, compartidas: 0
      },
      tareasCriticas: 0, timersVencidos: 0
    };

    // ── Usar el libro ya cacheado (NO openById de nuevo) ─────────
    const ss = _libroPrincipal();
    const estFiltro = estacion || sess.estacion;

    // ── LEER CADA HOJA UNA SOLA VEZ ──────────────────────────────
    const rawBarridos = _leerHojaInterna_(ss, CFG.H_BARRIDOS, 28);
    const rawNovedades = _leerHojaInterna_(ss, CFG.H_NOVEDADES, 14);
    const rawSLA = _leerHojaInterna_(ss, CFG.H_SLA, 11);
    const rawTraspasos = _leerHojaInterna_(ss, CFG.H_TRASPASOS, 14);
    const rawSamsara = _leerHojaInterna_(ss, CFG.H_ALERTAS_SAMSARA, 9);

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const ahora = new Date();

    // ── TRASPASOS ─────────────────────────────────────────────────
    const compartidas = rawTraspasos.filter(r => {
      return r[11] === "ACTIVO" && r[4] === estFiltro;
    }).map(r => ({
      UNIDAD: r[2], CIRCUITO: r[3], ESTACION: r[4], ESTATUS: "Activo",
      FECHA: r[1], "Quien Asigno": r[10],
      _origen: "COMPARTIDA", _idTraspaso: r[0], _estOrigen: r[3],
      _remolque: r[5], _dolly: r[6], _remolque2: r[7], _tipoCarga: r[8],
    }));

    const enTransito = rawTraspasos.filter(r => {
      return r[11] === "ACTIVO" && r[3] === estFiltro;
    }).map(r => ({ unidad: r[2], idTraspaso: r[0], estDestino: r[4] }));

    const idsEnTransito = new Set(enTransito.map(t => t.unidad.toString().trim()));

    // ── UNIDADES ASIGNADAS (libro BD externo, 1 sola llamada) ─────
    const hAsig = _hojaExterna(CFG.BD_ASIG);
    const asigCols = hAsig.getLastRow() > 0
      ? hAsig.getRange(1, 1, 1, 6).getValues()[0] : [];
    const asigRows = hAsig.getLastRow() > 1
      ? hAsig.getRange(2, 1, hAsig.getLastRow() - 1, 6).getValues() : [];

    const esAdmin = [CFG.ROLES.ADMIN, CFG.ROLES.SUPERVISOR].includes(sess.rol);
    const iESTACION = asigCols.indexOf("ESTACION");
    const iESTATUS = asigCols.indexOf("ESTATUS");

    const propias = asigRows.filter(r => {
      const estatus = iESTATUS >= 0 ? (r[iESTATUS] || "").toString().toLowerCase().trim() : (r[3] || "").toString().toLowerCase().trim();
      const estacion = iESTACION >= 0 ? (r[iESTACION] || "").toString().trim() : (r[2] || "").toString().trim();
      if (estatus !== "activo") return false;
      if (esAdmin) return !estFiltro || _normEst(estacion) === _normEst(estFiltro);
      return _normEst(estacion) === _normEst(estFiltro);
    }).map(r => {
      const obj = _toObj(asigCols, r);
      if (obj.UNIDAD) obj.UNIDAD = obj.UNIDAD.toString().trim();
      return { ...obj, _origen: "PROPIA" };
    }).filter(u => !idsEnTransito.has(u.UNIDAD));

    const propiaIds = new Set(propias.map(u => u.UNIDAD));
    const soloComp = compartidas.filter(c => !propiaIds.has(c.UNIDAD));
    const asig = [...propias, ...soloComp];

    Logger.log("obtenerEstadoFlota: propias=" + propias.length +
      " compartidas=" + soloComp.length +
      " barridos_raw=" + rawBarridos.length);

    // ── BARRIDOS — mapa por estación y mapa global ────────────────
    const mapaBarridos = {};
    rawBarridos
      .filter(r => {
        if (!r[0] || !r[1]) return false;
        const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
        if (isNaN(f.getTime()) || f < hoy) return false;
        const estHoja = r[2].toString().replace(/\u00A0/g, ' ').trim();
        const estBusc = estFiltro.toString().replace(/\u00A0/g, ' ').trim();
        return !estBusc || estHoja === estBusc;
      })
      .sort((a, b) => new Date(b[1]) - new Date(a[1]))
      .forEach(r => {
        const u = r[3] ? r[3].toString().trim() : '';
        if (u && !mapaBarridos[u]) {
          mapaBarridos[u] = {
            fecha: r[1],
            cargaStatus: r[8] ? r[8].toString().trim() : '—',
            sentido: r[9] ? r[9].toString().trim() : '—',
            remolque: r[4] ? r[4].toString().trim() : '',
            dolly: r[5] ? r[5].toString().trim() : '',
            gps: r[13] ? r[13].toString().trim() : '—',
            camara: r[14] ? r[14].toString().trim() : '—',
            corte: r[15] ? r[15].toString().trim() : '—',
            obs: r[20] ? r[20].toString().trim() : '',
            tramo: r[24] ? r[24].toString().trim() : '',
            cliente: r[25] ? r[25].toString().trim() : '',
            destino: r[26] ? r[26].toString().trim() : '',
            citaDescarga: r[27] ? r[27].toString().trim() : '',
          };
        }
      });

    // Mapa global (para unidades compartidas)
    const barridosGlobal = {};
    rawBarridos
      .filter(r => {
        if (!r[0] || !r[1] || !r[3]) return false;
        const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
        return !isNaN(f.getTime()) && f >= hoy;
      })
      .sort((a, b) => new Date(b[1]) - new Date(a[1]))
      .forEach(r => {
        const u = r[3] ? r[3].toString().trim() : '';
        if (u && !barridosGlobal[u]) {
          barridosGlobal[u] = {
            fecha: r[1],
            cargaStatus: r[8] ? r[8].toString().trim() : '—',
            sentido: r[9] ? r[9].toString().trim() : '—',
            remolque: r[4] ? r[4].toString().trim() : '',
            dolly: r[5] ? r[5].toString().trim() : '',
            gps: r[13] ? r[13].toString().trim() : '—',
            camara: r[14] ? r[14].toString().trim() : '—',
            corte: r[15] ? r[15].toString().trim() : '—',
            obs: r[20] ? r[20].toString().trim() : '',
            tramo: r[24] ? r[24].toString().trim() : '',
            cliente: r[25] ? r[25].toString().trim() : '',
            destino: r[26] ? r[26].toString().trim() : '',
            citaDescarga: r[27] ? r[27].toString().trim() : '',
          };
        }
      });

    // ── NOVEDADES ─────────────────────────────────────────────────
    const mapaNov = {};
    const mapaNovGlobal = {};
    rawNovedades
      .filter(r => {
        const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
        return f >= hoy && r[8] === "ABIERTA";
      })
      .forEach(r => {
        const u = r[3];
        if (!mapaNovGlobal[u]) mapaNovGlobal[u] = { id: r[0], unidad: u, tipo: r[5] };
        if (r[2] === estFiltro && !mapaNov[u])
          mapaNov[u] = { id: r[0], unidad: u, tipo: r[5] };
      });

    // ── SLA y TIMERS ──────────────────────────────────────────────
    const tareasSLA = rawSLA.filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < hoy || r[7] !== "PENDIENTE" || r[3] === "TIMER_CLIMA") return false;
      if (!esAdmin && r[4] !== estFiltro) return false;
      return true;
    }).map(r => {
      const ini = r[1] instanceof Date ? r[1] : new Date(r[1]);
      const minT = Math.round((ahora - ini) / 60000);
      const rest = (r[9] || 30) - minT;
      return {
        ID_SLA: r[0], INICIO: r[1], TIPO: r[3], ESTACION: r[4],
        UNIDAD: r[5], MONITORISTA: r[6], ESTADO: r[7], SLA_MIN: r[9],
        _minTranscurridos: minT, _slaRestante: rest, _enBreach: rest < 0,
      };
    }).sort((a, b) => a._slaRestante - b._slaRestante);

    const timers = rawSLA
      .filter(r => r[3] === "TIMER_CLIMA" && r[7] === "ACTIVO")
      .map(r => {
        const vence = r[2] ? new Date(r[2]) : null;
        const restSeg = vence ? Math.max(0, Math.round((vence - ahora) / 1000)) : 0;
        return { id: r[0], unidad: r[5], venceISO: r[2], restSeg, alerta: restSeg <= 0 };
      });

    // ── ARMAR UNIDADES CON ESTADO ─────────────────────────────────
    const unidades = asig.map(a => {
      const uid = a.UNIDAD;
      const esComp = a._origen === "COMPARTIDA";
      const ub = mapaBarridos[uid] || (esComp ? barridosGlobal[uid] : null) || {};
      const minSin = ub.fecha ? Math.round((ahora - new Date(ub.fecha)) / 60000) : null;
      const novedad = mapaNov[uid] || (esComp ? mapaNovGlobal[uid] : null) || null;
      const timer = timers.find(t => t.unidad === uid) || null;

      return {
        unidad: uid,
        estacion: a.ESTACION,
        circuito: a.CIRCUITO,
        _origen: a._origen || "PROPIA",
        _idTraspaso: a._idTraspaso || null,
        _estOrigen: a._estOrigen || null,
        _cargaStatus: ub.cargaStatus || "—",
        _sentido: ub.sentido || "—",
        _remolque: a._remolque || ub.remolque || "",
        _dolly: a._dolly || ub.dolly || "",
        _remolque2: a._remolque2 || "",
        _tipoCarga: a._tipoCarga || "SENCILLO",
        _tieneGPS: ub.gps || "—",
        _tieneCamara: ub.camara || "—",
        _tieneCorte: ub.corte || "—",
        _ultimaHora: ub.fecha || null,
        _minSin: minSin,
        _alertaSLA: minSin === null || minSin > CFG.SLA_BARRIDO,
        _estadoBarrido: minSin === null ? "SIN_BARRIDO_HOY"
          : minSin > CFG.SLA_BARRIDO ? "VENCIDO" : "OK",
        _novedad: novedad,
        _timer: timer,
        _obs: ub.obs || "",
        _tramo: ub.tramo || "",
        _cliente: ub.cliente || "",
        _destino: ub.destino || "",
        _citaDescarga: ub.citaDescarga || "",
      };
    });

    // ── RESUMEN ───────────────────────────────────────────────────
    const resumen = {
      total: unidades.length,
      cargadas: unidades.filter(u => u._cargaStatus === "CARGADA").length,
      vacias: unidades.filter(u => u._cargaStatus === "VACIA").length,
      subida: unidades.filter(u => u._sentido === "SUBIDA").length,
      bajada: unidades.filter(u => u._sentido === "BAJADA").length,
      detenidas: unidades.filter(u => u._sentido === "DETENIDO" || u._novedad).length,
      sinBarrido: unidades.filter(u => u._alertaSLA).length,
      enTransito: enTransito.length,
      compartidas: enTransito.length,
    };

    // ── NOVEDADES PANEL (con todos los campos) ────────────────────
    const colsNov = ["ID_INC", "FECHA_HORA", "ESTACION", "UNIDAD", "REMOLQUE", "TIPO",
      "DESCRIPCION", "MONITORISTA", "ESTADO_INC", "EMAIL_ENVIADO",
      "HORA_EMAIL", "RESOLUCION", "LAT", "LNG"];

    const novedadesPanel = rawNovedades
      .filter(r => {
        const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
        return f >= hoy && r[8] === "ABIERTA" && (!estFiltro || r[2] === estFiltro);
      })
      .map(r => _toObj(colsNov, r));

    // ── ALERTAS SAMSARA ───────────────────────────────────────────
    const alertasSamsara = rawSamsara
      .filter(r => {
        if (!r[0] || !r[1]) return false;
        const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
        if (f < hoy) return false;
        if (r[4] === "resuelto") return false; // Ignorar resueltas
        return !estFiltro || r[2] === estFiltro;
      })
      .map(r => ({
        ID_INC: r[0],
        FECHA_HORA: r[1],
        ESTACION: estFiltro,
        UNIDAD: r[2],
        REMOLQUE: "",
        TIPO: "SAMSARA_" + (r[3] || "ALERT"),
        DESCRIPCION: r[6] || "",
        MONITORISTA: "SAMSARA",
        ESTADO_INC: "ABIERTA",
        EMAIL_ENVIADO: "NO",
        HORA_EMAIL: "",
        RESOLUCION: "",
        LAT: "",
        LNG: "",
        _samsara: true,
        _severidad: r[4] || "info"
      }));

    // ── COMBINAR NOVEDADES + ALERTAS SAMSARA ──────────────────────
    const novedadesPanel2 = [...novedadesPanel, ...alertasSamsara];

    // ── RESULTADO FINAL ───────────────────────────────────────────
    const resultado = {
      ok: true, unidades, tareasSLA,
      novedades: novedadesPanel2,
      timers, resumen, enTransito,
      tareasCriticas: tareasSLA.filter(t => t._enBreach).length,
      timersVencidos: timers.filter(t => t.alerta).length,
    };

    Logger.log("obtenerEstadoFlota OK: " + unidades.length + " unidades, " +
      tareasSLA.length + " SLA, " + timers.length + " timers, " +
      alertasSamsara.length + " alertas Samsara");

    return _sanitize(resultado);

  } catch (e) {
    Logger.log("obtenerEstadoFlota ERROR: " + e.message + "\n" + e.stack);
    console.error("obtenerEstadoFlota ERROR: " + e.message);
    try {
      return {
        ok: false, msg: "Error: " + e.message,
        unidades: [], tareasSLA: [], novedades: [], timers: [], enTransito: [],
        resumen: {
          total: 0, cargadas: 0, vacias: 0, subida: 0, bajada: 0,
          detenidas: 0, sinBarrido: 0, compartidas: 0
        },
        tareasCriticas: 0, timersVencidos: 0,
      };
    } catch (e2) {
      Logger.log("obtenerEstadoFlota ERROR2: " + e2.message);
      return {
        ok: false,
        msg: "Error: " + e2.message,
        unidades: [], tareasSLA: [], novedades: [], timers: [], enTransito: [],
        resumen: {
          total: 0, cargadas: 0, vacias: 0, subida: 0, bajada: 0,
          detenidas: 0, sinBarrido: 0, compartidas: 0
        },
        tareasCriticas: 0,
        timersVencidos: 0,
      };
    }
  }
}

// Helper: lee toda una hoja como array de filas (sin encabezado)
// ── Leer hoja interna como array de filas (sin encabezado) ───────
// CORRECTO: usa el objeto ss que ya viene como parámetro
function _leerHojaInterna_(ss, nombre, numCols) {
  try {
    const h = ss.getSheetByName(nombre);
    if (!h) {
      Logger.log('_leerHojaInterna_: hoja no existe: [' + nombre + ']');
      return [];
    }
    if (h.getLastRow() < 2) {
      Logger.log('_leerHojaInterna_: hoja vacía: [' + nombre + ']');
      return [];
    }
    return h.getRange(2, 1, h.getLastRow() - 1, numCols).getValues();
  } catch (e) {
    Logger.log('_leerHojaInterna_ ERROR [' + nombre + ']: ' + e.message);
    return [];
  }
}

function _unidadesConEstado(token, estacion) {
  const asigRes = obtenerUnidadesAsignadas(token, estacion);
  Logger.log("_unidadesConEstado asig result: ok=" + asigRes.ok + " count=" + (asigRes.data ? asigRes.data.length : 0) + " msg=" + (asigRes.msg || ''));
  const asig = (asigRes.data || []);
  const barridos = _ultimosBarridos(estacion);
  Logger.log("_unidadesConEstado barridos count=" + barridos.length);
  if (asig.length > 0 && barridos.length > 0) {
    Logger.log("Primer asig UNIDAD=[" + asig[0].UNIDAD + "] vs primer barrido unidad=[" + barridos[0].unidad + "]");
    const match = barridos.find(b => b.unidad.trim() === asig[0].UNIDAD.trim());
    Logger.log("Match resultado: " + JSON.stringify(match));
  }
  const novedades = _novedadesAbiertasHoy(estacion);
  const timers = (obtenerTimersClima(token).data || []);
  const ahora = new Date();

  return asig.map(a => {
    const unidad = a.UNIDAD;
    const ub = barridos.find(b => b.unidad.trim() === unidad.trim()) ||
      (a._origen === "COMPARTIDA" ? _ultimoBarridoGlobal(unidad) : {});
    const minSin = ub.fecha ? Math.round((ahora - new Date(ub.fecha)) / 60000) : null;
    const novedad = novedades.find(n => n.unidad === unidad) ||
      (a._origen === "COMPARTIDA" ? _novedadAbiertaGlobal(unidad) : null);
    const timer = timers.find(t => t.unidad === unidad) || null;

    return {
      unidad,
      estacion: a.ESTACION,
      circuito: a.CIRCUITO,
      _origen: a._origen || "PROPIA",
      _idTraspaso: a._idTraspaso || null,
      _estOrigen: a._estOrigen || null,
      _cargaStatus: ub.cargaStatus || "—",
      _sentido: ub.sentido || "—",
      _remolque: a._remolque || ub.remolque || "",
      _dolly: a._dolly || ub.dolly || "",
      _remolque2: a._remolque2 || "",
      _tipoCarga: a._tipoCarga || "SENCILLO",
      _tieneGPS: ub.gps || "—",
      _tieneCamara: ub.camara || "—",
      _tieneCorte: ub.corte || "—",
      _ultimaHora: ub.fecha || null,
      _minSin: minSin,
      _alertaSLA: minSin === null || minSin > CFG.SLA_BARRIDO,   // ← fix
      _estadoBarrido: minSin === null ? "SIN_BARRIDO_HOY"           // ← nuevo
        : minSin > CFG.SLA_BARRIDO ? "VENCIDO"
          : "OK",
      _novedad: novedad,
      _timer: timer,
    };
  });
}

function _ultimosBarridos(estacion) {
  const h = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName(CFG.H_BARRIDOS);
  if (!h || h.getLastRow() < 2) return [];

  // Medianoche en la zona horaria del script (la que configuras en GAS)
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0); // ← usa hora LOCAL del servidor GAS, no UTC

  const todos = h.getRange(2, 1, h.getLastRow() - 1, 24).getValues()
    .filter(r => {
      if (!r[0] || !r[1]) return false;
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (isNaN(f.getTime())) return false;
      // Normalizar estación: trim + reemplazar espacios no-breaking
      const estHoja = r[2].toString().replace(/\u00A0/g, ' ').trim();
      const estBusc = (estacion || '').toString().replace(/\u00A0/g, ' ').trim();
      const estOk = !estBusc || estHoja === estBusc;
      return f >= hoy && estOk;
    })
    .map(r => ({
      unidad: r[3] ? r[3].toString().trim() : '',
      fecha: r[1],
      cargaStatus: r[8] ? r[8].toString().trim() : '—',
      sentido: r[9] ? r[9].toString().trim() : '—',
      remolque: r[4] ? r[4].toString().trim() : '',
      dolly: r[5] ? r[5].toString().trim() : '',
      gps: r[13] ? r[13].toString().trim() : '—',
      camara: r[14] ? r[14].toString().trim() : '—',
      corte: r[15] ? r[15].toString().trim() : '—',
    }))
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const map = {};
  todos.forEach(b => { if (b.unidad && !map[b.unidad]) map[b.unidad] = b; });
  Logger.log("_ultimosBarridos [" + estacion + "]: " + JSON.stringify(Object.keys(map)));
  return Object.values(map);
}

function _ultimoBarridoGlobal(unidad) {
  const h = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName(CFG.H_BARRIDOS);
  if (!h || h.getLastRow() < 2) return {};
  // En _ultimoBarridoGlobal:
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0); // ← mismo fix
  const rows = h.getRange(2, 1, h.getLastRow() - 1, 24).getValues()
    .filter(r => {
      if (!r[0] || !r[1]) return false;
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (isNaN(f.getTime())) return false;
      return r[3] != null && r[3].toString().trim() === (unidad || '').toString().trim() && f >= hoy;
    })
    .sort((a, b) => new Date(b[1]) - new Date(a[1]));
  if (!rows.length) return {};
  const r = rows[0];
  return {
    unidad: r[3], fecha: r[1], cargaStatus: r[8], sentido: r[9],
    remolque: r[4], dolly: r[5], gps: r[13], camara: r[14], corte: r[15]
  };
}

function _novedadesAbiertasHoy(estacion) {
  const h = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName(CFG.H_NOVEDADES);
  if (!h || h.getLastRow() < 2) return [];
  // En _novedadesAbiertasHoy:
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0); // ← mismo fix
  return h.getRange(2, 1, h.getLastRow() - 1, 9).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      return f >= hoy && r[8] === "ABIERTA" && (!estacion || r[2] === estacion);
    })
    .map(r => ({ id: r[0], unidad: r[3], tipo: r[5] }));
}

function _novedadAbiertaGlobal(unidad) {
  const h = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName(CFG.H_NOVEDADES);
  if (!h || h.getLastRow() < 2) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const row = h.getRange(2, 1, h.getLastRow() - 1, 9).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      return r[3] === unidad && f >= hoy && r[8] === "ABIERTA";
    })
    .sort((a, b) => new Date(b[1]) - new Date(a[1]))[0];
  return row ? { id: row[0], unidad: row[3], tipo: row[5] } : null;
}

// ══════════════════════════════════════════════════════════════════
//  BARRIDO
// ══════════════════════════════════════════════════════════════════
function registrarBarrido(token, datos) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  try {
    const id = "B-" + new Date().getTime();
    const minSin = _minSinBarrido(datos.unidad);
    const breach = minSin !== null && minSin > CFG.SLA_BARRIDO;

    _hoja(CFG.H_BARRIDOS).appendRow([
      id, new Date(),
      datos.estacion || sess.estacion,
      datos.unidad,
      datos.remolque || "",
      datos.dolly || "",
      datos.remolque2 || "",
      datos.tipoCarga || "SENCILLO",
      datos.cargaStatus,
      datos.sentido || "SUBIDA",
      datos.lat || "",
      datos.lng || "",
      datos.ubicacion || "",
      datos.tieneGPS ? "SI" : "NO",
      datos.tieneCamara ? "SI" : "NO",
      datos.tieneCorte ? "SI" : "NO",
      datos.climaAut ? "SI" : "NO",
      datos.minutosClima || 0,
      datos.bajaCobertura ? "SI" : "NO",
      "",
      datos.observaciones || "",
      sess.nombre,
      minSin || 0,
      breach ? "BREACH" : "OK",
      datos.tramo || "",      // ← NUEVO
      datos.cliente || "",      // ← NUEVO
      datos.destino || "",      // ← NUEVO
      datos.citaDescarga || "",      // ← NUEVO
    ]);

    if (datos.climaAut && datos.minutosClima > 0)
      _registrarTimerClima(datos.unidad, datos.minutosClima, sess.nombre);

    return { ok: true, id, minSin, breach };
  } catch (e) { return { ok: false, msg: e.message }; }
}

function _minSinBarrido(unidad) {
  const h = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName(CFG.H_BARRIDOS);
  if (!h || h.getLastRow() < 2) return null;
  // En _minSinBarrido:
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0); // ← mismo fix
  const fechas = h.getRange(2, 1, h.getLastRow() - 1, 4).getValues()
    .filter(r => {
      if (!r[0] || !r[1] || !r[3]) return false;
      if (!r[3] || r[3].toString().trim() !== (unidad || '').toString().trim()) return false;
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      return !isNaN(f.getTime()) && f >= hoy;
    })
    .map(r => r[1] instanceof Date ? r[1] : new Date(r[1]))
    .sort((a, b) => b - a);
  return fechas.length ? Math.floor((new Date() - fechas[0]) / 60000) : null;
}

// ══════════════════════════════════════════════════════════════════
//  INCIDENCIAS
// ══════════════════════════════════════════════════════════════════
function registrarIncidencia(token, datos) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  try {
    let lat = "", lng = "";
    if (datos.coordenadas) {
      const partes = datos.coordenadas.replace(/[()]/g, "").split(",");
      lat = (partes[0] || "").trim();
      lng = (partes[1] || "").trim();
    }
    const id = _registrarNovedad({
      estacion: datos.estacion || sess.estacion,
      unidad: datos.unidad,
      remolque: datos.remolque || "",
      tipo: datos.tipo,
      descripcion: datos.descripcion || "",
      monitorista: sess.nombre,
      lat, lng,
    });
    _crearTareaSLA(id, datos.tipo, datos.estacion || sess.estacion, datos.unidad, sess.nombre);
    return { ok: true, id };
  } catch (e) { return { ok: false, msg: e.message }; }
}

function _registrarNovedad(d) {
  if (!d) return null;
  const id = "INC-" + new Date().getTime();
  _hoja(CFG.H_NOVEDADES).appendRow([
    id, new Date(), d.estacion || "", d.unidad || "", d.remolque || "",
    d.tipo, d.descripcion, d.monitorista, "ABIERTA", "NO", "", "",
    d.lat || "", d.lng || "",
  ]);
  try {
    const mapsLink = (d.lat && d.lng)
      ? "\nMaps: https://maps.google.com/?q=" + d.lat + "," + d.lng : "";
    GmailApp.sendEmail(
      CFG.EMAIL_INC,
      "[INCIDENCIA " + d.tipo + "] " + d.unidad + " — " + d.estacion,
      "ID: " + id + "\nUnidad: " + d.unidad + "\nEstación: " + d.estacion + "\nTipo: " + d.tipo +
      "\nDescripción: " + d.descripcion + "\nMonitorista: " + d.monitorista +
      "\nFecha: " + new Date().toLocaleString("es-MX") + mapsLink,
      { cc: CFG.EMAIL_CC, name: "Monitor de Flota PRO" }
    );
    const h = _hoja(CFG.H_NOVEDADES);
    h.getRange(h.getLastRow(), 10).setValue("SI");
    h.getRange(h.getLastRow(), 11).setValue(new Date().toISOString());
  } catch (ex) { Logger.log("Email: " + ex.message); }
  return id;
}

function obtenerNovedades(token, estacion, fechaDesde, fechaHasta) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_NOVEDADES);
  if (h.getLastRow() < 2) return { ok: true, data: [] };

  const desde = fechaDesde ? new Date(fechaDesde)
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const hasta = fechaHasta ? new Date(fechaHasta)
    : (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; })();

  const cols = h.getRange(1, 1, 1, 14).getValues()[0];
  const esAdmin = [CFG.ROLES.ADMIN, CFG.ROLES.SUPERVISOR].includes(sess.rol);
  const compartidas = _unidadesCompartidasHacia(estacion || sess.estacion).map(c => c.UNIDAD);

  const data = h.getRange(2, 1, h.getLastRow() - 1, 14).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < desde || f > hasta) return false;
      if (!esAdmin) {
        const esPropia = r[2] === (estacion || sess.estacion);
        const esCompartida = compartidas.includes(r[3]);
        if (!esPropia && !esCompartida) return false;
      }
      if (estacion && r[2] !== estacion && !compartidas.includes(r[3])) return false;
      return true;
    })
    .map(r => _toObj(cols, r));
  return { ok: true, data };
}

function cerrarNovedad(token, idNov, resolucion) {
  const sess = validarToken(token);
  if (!sess) return { ok: false };
  const h = _hoja(CFG.H_NOVEDADES);
  const rows = h.getRange(2, 1, Math.max(h.getLastRow() - 1, 1), 14).getValues();
  const idx = rows.findIndex(r => r[0] === idNov);
  if (idx < 0) return { ok: false, msg: "No encontrada" };
  h.getRange(idx + 2, 9).setValue("CERRADA");
  h.getRange(idx + 2, 12).setValue(resolucion || "");
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════
//  TAREAS SLA
// ══════════════════════════════════════════════════════════════════
function _crearTareaSLA(refId, tipo, estacion, unidad, monitorista) {
  const id = "SLA-" + new Date().getTime();
  const slaMin = (tipo || "").includes("ACCIDENTE") || (tipo || "").includes("FALLA") ? CFG.SLA_CORREO_INC : 30;
  _hoja(CFG.H_SLA).appendRow([
    id, new Date(), "", tipo, estacion, unidad, monitorista, "PENDIENTE", "", slaMin, refId,
  ]);
  return id;
}

function obtenerTareasSLA(token, estacion) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_SLA);
  if (h.getLastRow() < 2) return { ok: true, data: [] };
  const ahora = new Date();
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const cols = h.getRange(1, 1, 1, 11).getValues()[0];
  const esAdmin = [CFG.ROLES.ADMIN, CFG.ROLES.SUPERVISOR].includes(sess.rol);
  const compartidas = _unidadesCompartidasHacia(estacion || sess.estacion).map(c => c.UNIDAD);

  const data = h.getRange(2, 1, h.getLastRow() - 1, 11).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < hoy || r[7] !== "PENDIENTE") return false;
      if (!esAdmin) {
        const esPropia = r[4] === (estacion || sess.estacion);
        const esCompartida = compartidas.includes(r[5]);
        if (!esPropia && !esCompartida) return false;
      }
      if (estacion && r[4] !== estacion && !compartidas.includes(r[5])) return false;
      return true;
    })
    .map(r => {
      const obj = _toObj(cols, r);
      const ini = r[1] instanceof Date ? r[1] : new Date(r[1]);
      obj._minTranscurridos = Math.round((ahora - ini) / 60000);
      obj._slaRestante = (r[9] || 30) - obj._minTranscurridos;
      obj._enBreach = obj._slaRestante < 0;
      return obj;
    })
    .sort((a, b) => a._slaRestante - b._slaRestante);
  return { ok: true, data };
}

function cerrarTareaSLA(token, idSLA, nota) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_SLA);
  const rows = h.getRange(2, 1, Math.max(h.getLastRow() - 1, 1), 11).getValues();
  const idx = rows.findIndex(r => r[0] === idSLA);
  if (idx < 0) return { ok: false, msg: "No encontrada" };
  const ini = rows[idx][1] instanceof Date ? rows[idx][1] : new Date(rows[idx][1]);
  const mins = Math.round((new Date() - ini) / 60000);
  h.getRange(idx + 2, 3).setValue(new Date());
  h.getRange(idx + 2, 8).setValue("COMPLETADO");
  h.getRange(idx + 2, 9).setValue(mins);
  h.getRange(idx + 2, 11).setValue(nota || "");
  return { ok: true, duracionMin: mins };
}

// ══════════════════════════════════════════════════════════════════
//  TIMERS CLIMA
// ══════════════════════════════════════════════════════════════════
function _registrarTimerClima(unidad, minutos, monitorista) {
  if (!unidad || !minutos || isNaN(Number(minutos))) return null;
  const id = "CLM-" + new Date().getTime();
  const vence = new Date();
  vence.setMinutes(vence.getMinutes() + Number(minutos));
  _hoja(CFG.H_SLA).appendRow([
    id, new Date(), vence.toISOString(), "TIMER_CLIMA", "", unidad,
    monitorista, "ACTIVO", minutos, minutos, unidad,
  ]);
  return id;
}

function obtenerTimersClima(token) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, data: [] };
  const h = _hoja(CFG.H_SLA);
  if (h.getLastRow() < 2) return { ok: true, data: [] };
  const ahora = new Date();
  const data = h.getRange(2, 1, h.getLastRow() - 1, 11).getValues()
    .filter(r => r[3] === "TIMER_CLIMA" && r[7] === "ACTIVO")
    .map(r => {
      const vence = r[2] ? new Date(r[2]) : null;
      const restSeg = vence ? Math.max(0, Math.round((vence - ahora) / 1000)) : 0;
      return { id: r[0], unidad: r[5], venceISO: r[2], restSeg, alerta: restSeg <= 0 };
    });
  return { ok: true, data };
}

function cerrarTimerClima(token, idTimer, ejecutoCorte) {
  const sess = validarToken(token);
  if (!sess) return { ok: false };
  const h = _hoja(CFG.H_SLA);
  const rows = h.getRange(2, 1, Math.max(h.getLastRow() - 1, 1), 11).getValues();
  const idx = rows.findIndex(r => r[0] === idTimer);
  if (idx < 0) return { ok: false };
  h.getRange(idx + 2, 8).setValue(ejecutoCorte ? "CORTE_EJECUTADO" : "CERRADO");
  h.getRange(idx + 2, 3).setValue(new Date().toISOString());
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════
//  MOVIMIENTOS
// ══════════════════════════════════════════════════════════════════
function registrarEnganche(token, datos) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  try {
    const id = "MOV-" + new Date().getTime();
    _hoja(CFG.H_MOVIMIENTOS).appendRow([
      id, new Date(), datos.tipo || "ENGANCHE",
      datos.estacion || sess.estacion, datos.unidad,
      datos.remolqueAnterior || "", datos.remolqueNuevo || "",
      datos.dollyAnterior || "", datos.dollyNuevo || "",
      datos.remolque2 || "",
      datos.ubicacion || "", datos.motivo || "",
      sess.nombre, datos.notas || "",
    ]);
    return { ok: true, id, msg: "Movimiento registrado" };
  } catch (e) { return { ok: false, msg: e.message }; }
}

function obtenerMovimientos(token, estacion) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_MOVIMIENTOS);
  if (h.getLastRow() < 2) return { ok: true, data: [] };
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const cols = h.getRange(1, 1, 1, 14).getValues()[0];
  const esAdmin = [CFG.ROLES.ADMIN, CFG.ROLES.SUPERVISOR].includes(sess.rol);
  const data = h.getRange(2, 1, h.getLastRow() - 1, 14).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < hoy) return false;
      if (!esAdmin && r[3] !== sess.estacion) return false;
      if (estacion && r[3] !== estacion) return false;
      return true;
    })
    .map(r => _toObj(cols, r))
    .sort((a, b) => new Date(b.FECHA_HORA) - new Date(a.FECHA_HORA));
  return { ok: true, data };
}

// ══════════════════════════════════════════════════════════════════
//  HISTORIAL
// ══════════════════════════════════════════════════════════════════
function obtenerHistorialBarridos(token, estacion, fechaDesde, fechaHasta) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_BARRIDOS);
  if (h.getLastRow() < 2) return { ok: true, data: [] };
  const desde = fechaDesde ? new Date(fechaDesde)
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const hasta = fechaHasta ? new Date(fechaHasta)
    : (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; })();
  const cols = h.getRange(1, 1, 1, 24).getValues()[0];
  const esAdmin = [CFG.ROLES.ADMIN, CFG.ROLES.SUPERVISOR].includes(sess.rol);
  const compartidas = _unidadesCompartidasHacia(estacion || sess.estacion).map(c => c.UNIDAD);

  const data = h.getRange(2, 1, h.getLastRow() - 1, 24).getValues()
    .filter(r => {
      const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
      if (f < desde || f > hasta) return false;
      if (!esAdmin) {
        const esPropia = r[2] === (estacion || sess.estacion);
        const esCompartida = compartidas.includes(r[3]);
        if (!esPropia && !esCompartida) return false;
      }
      if (estacion && r[2] !== estacion && !compartidas.includes(r[3])) return false;
      return true;
    })
    .map(r => _toObj(cols, r))
    .sort((a, b) => new Date(b.FECHA_HORA) - new Date(a.FECHA_HORA));
  return { ok: true, data };
}

// ══════════════════════════════════════════════════════════════════
//  NOTAS POR UNIDAD
// ══════════════════════════════════════════════════════════════════
function agregarNotaUnidad(token, unidad, nota) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  if (sess.rol === CFG.ROLES.MONITORISTA) return { ok: false, msg: "Sin permisos" };
  _hoja(CFG.H_NOTAS).appendRow([
    "NOTA-" + new Date().getTime(), new Date(), unidad, nota, sess.nombre, sess.rol,
  ]);
  return { ok: true };
}

function obtenerNotasUnidad(token, unidad) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const h = _hoja(CFG.H_NOTAS);
  if (h.getLastRow() < 2) return { ok: true, data: [] };
  const cols = h.getRange(1, 1, 1, 6).getValues()[0];
  const data = h.getRange(2, 1, h.getLastRow() - 1, 6).getValues()
    .filter(r => !unidad || r[2] === unidad)
    .map(r => _toObj(cols, r))
    .sort((a, b) => new Date(b.FECHA_HORA) - new Date(a.FECHA_HORA));
  return { ok: true, data };
}

// ══════════════════════════════════════════════════════════════════
//  RELEVO
// ══════════════════════════════════════════════════════════════════
function generarResumenTurno(token) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  const estado = obtenerEstadoFlota(token, sess.estacion);
  const barridos = (obtenerHistorialBarridos(token, sess.estacion).data || []);
  const misBarr = barridos.filter(b => b.MONITORISTA === sess.nombre);
  const tiempos = misBarr.map(b => Number(b.MIN_SIN_BARRIDO) || 0).filter(m => m > 0);
  const promedio = tiempos.length
    ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : 0;
  const resumen = {
    monitorista: sess.nombre,
    estacion: sess.estacion,
    fechaHora: new Date().toISOString(),
    totalBarridos: misBarr.length,
    promedioReaccion: promedio,
    slaBreaches: misBarr.filter(b => b.SLA_STATUS === "BREACH").length,
    novedadesAbiertas: estado.novedades ? estado.novedades.length : 0,
    unidadesTotales: estado.resumen ? estado.resumen.total : 0,
    unidadesEnRiesgo: (estado.unidades || [])
      .filter(u => u._alertaSLA || u._novedad)
      .map(u => ({
        unidad: u.unidad, remolque: u._remolque,
        motivo: u._novedad ? u._novedad.tipo : "SIN_BARRIDO", minSin: u._minSin,
        obs: u._obs || ""
      })),
  };
  _hoja(CFG.H_RELEVOS).appendRow([
    "FIN_TURNO", new Date(), sess.nombre, sess.login, sess.rol,
    sess.estacion, JSON.stringify(resumen), "", "",
  ]);
  return { ok: true, resumen };
}

// ══════════════════════════════════════════════════════════════════
//  PROTOCOLOS
// ══════════════════════════════════════════════════════════════════
function obtenerProtocolo(token, tipoEvento) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  return { ok: true, tipoEvento, pasos: _protocoloDefault(tipoEvento) };
}

function _protocoloDefault(tipo) {
  const base = {
    ACCIDENTE: [
      { orden: 1, titulo: "Verificar estado de personas", detalle: "Confirmar si hay lesionados. Si los hay, llamar 911 inmediatamente." },
      { orden: 2, titulo: "Asegurar la escena", detalle: "Activar luces de emergencia. Colocar triángulos de seguridad." },
      { orden: 3, titulo: "Notificar a control", detalle: "Reportar ubicación exacta, tipo de accidente y unidades involucradas." },
      { orden: 4, titulo: "Documentar con evidencia", detalle: "Tomar fotos/video antes de mover el vehículo." },
      { orden: 5, titulo: "Enviar correo de incidencia", detalle: "SLA: 15 minutos desde el evento." },
    ],
    INFRACCION: [
      { orden: 1, titulo: "Solicitar datos del oficial", detalle: "Anotar placa y número de unidad de la patrulla." },
      { orden: 2, titulo: "Registrar datos", detalle: "Capturar folio, motivo y monto si se indica." },
      { orden: 3, titulo: "Notificar a supervisor", detalle: "Contactar al supervisor de turno de inmediato." },
      { orden: 4, titulo: "Registrar en sistema", detalle: "SLA: 15 minutos." },
    ],
    INFRACCION_DADIVA: [
      { orden: 1, titulo: "No confrontar", detalle: "El operador no debe negociar ni entregar dinero sin autorización." },
      { orden: 2, titulo: "Notificar de inmediato", detalle: "Llamar al supervisor antes de cualquier acción." },
      { orden: 3, titulo: "Documentar datos del incidente", detalle: "Anotar lugar exacto, hora, número de patrulla si aplica." },
      { orden: 4, titulo: "Registrar en sistema", detalle: "SLA: 15 minutos. Incluir coordenadas exactas." },
    ],
    FALLA_MECANICA: [
      { orden: 1, titulo: "Ubicar posición segura", detalle: "Conducir a acotamiento o zona segura antes de detener." },
      { orden: 2, titulo: "Activar señalización", detalle: "Triángulos y luces de emergencia." },
      { orden: 3, titulo: "Diagnóstico inicial", detalle: "Identificar tipo de falla: motor, llantas, eléctrico, etc." },
      { orden: 4, titulo: "Solicitar auxilio vial", detalle: "Contactar al taller más cercano o grúa autorizada." },
      { orden: 5, titulo: "Registrar en sistema", detalle: "Documentar hora de falla y posición GPS." },
    ],
    CORTE_MOTOR: [
      { orden: 1, titulo: "Confirmar autorización previa", detalle: "Verificar que existe timer de clima activo en el sistema." },
      { orden: 2, titulo: "Ejecutar corte", detalle: "Confirmar que el operador apagó el motor completamente." },
      { orden: 3, titulo: "Registrar hora exacta", detalle: "El sistema estampará la hora al cerrar el timer." },
    ],
  };
  return base[tipo] || [{ orden: 1, titulo: "Seguir procedimiento estándar", detalle: "Contactar a supervisor de turno." }];
}

// ══════════════════════════════════════════════════════════════════
//  INICIALIZACIÓN
// ══════════════════════════════════════════════════════════════════
function inicializarSistema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const esquemas = {
    [CFG.H_TOKENS]: ["TOKEN", "USUARIO", "NOMBRE", "ESTACION", "ESTADO", "INICIO", "EXPIRA"],
    [CFG.H_BARRIDOS]: ["ID_BARRIDO", "FECHA_HORA", "ESTACION", "UNIDAD", "REMOLQUE", "DOLLY",
      "REMOLQUE2", "TIPO_CARGA", "CARGA_STATUS", "SENTIDO", "LAT", "LNG",
      "UBICACION", "TIENE_GPS", "TIENE_CAMARA", "TIENE_CORTE", "CLIMA_AUT",
      "MIN_CLIMA", "BAJA_COB", "INCIDENCIAS", "OBSERVACIONES", "MONITORISTA",
      "MIN_SIN_BARRIDO", "SLA_STATUS",
      "TRAMO", "CLIENTE", "DESTINO", "CITA_DESCARGA"],
    [CFG.H_NOVEDADES]: ["ID_INC", "FECHA_HORA", "ESTACION", "UNIDAD", "REMOLQUE", "TIPO",
      "DESCRIPCION", "MONITORISTA", "ESTADO_INC", "EMAIL_ENVIADO",
      "HORA_EMAIL", "RESOLUCION", "LAT", "LNG"],
    [CFG.H_SLA]: ["ID_SLA", "INICIO", "FIN", "TIPO", "ESTACION", "UNIDAD",
      "MONITORISTA", "ESTADO", "DURACION_MIN", "SLA_MIN", "REFERENCIA"],
    [CFG.H_MOVIMIENTOS]: ["ID_MOV", "FECHA_HORA", "TIPO_MOV", "ESTACION", "UNIDAD",
      "REM_ANTERIOR", "REM_NUEVO", "DOLLY_ANT", "DOLLY_NVO", "REMOLQUE2",
      "UBICACION", "MOTIVO", "MONITORISTA", "NOTAS"],
    [CFG.H_RELEVOS]: ["TIPO", "FECHA_HORA", "NOMBRE", "USUARIO", "ROL", "ESTACION",
      "TOKEN_O_RESUMEN", "ENTRANTE", "NOTAS"],
    [CFG.H_NOTAS]: ["ID_NOTA", "FECHA_HORA", "UNIDAD", "NOTA", "AUTOR", "ROL"],
    [CFG.H_TRASPASOS]: ["ID_TRP", "FECHA_INICIO", "UNIDAD", "EST_ORIGEN", "EST_DESTINO",
      "REMOLQUE", "DOLLY", "REMOLQUE2", "TIPO_CARGA", "OBSERVACIONES",
      "MONITORISTA", "ESTADO", "FECHA_RETORNO", "MONITORISTA_RETORNO"],
    [CFG.H_ALERTAS_SAMSARA]: ["ID_ALERTA", "FECHA", "UNIDAD", "TIPO", "SEVERIDAD", "ESTADO", "DETALLES", "VIN", "URL_SAMSARA"],
  };
  for (const [nom, cols] of Object.entries(esquemas)) {
    const h = ss.getSheetByName(nom) || ss.insertSheet(nom);
    if (h.getLastRow() === 0) {
      h.getRange(1, 1, 1, cols.length)
        .setValues([cols])
        .setBackground("#0d1117")
        .setFontColor("#e6edf3")
        .setFontWeight("bold");
      h.setFrozenRows(1);
    }
  }
  try {
    SpreadsheetApp.getUi().alert(
      "✅ Monitor de Flota PRO v6.1 inicializado.\n\nHojas:\n" + Object.keys(esquemas).join(", ")
    );
  } catch (e) {
    Logger.log("Sistema inicializado: " + Object.keys(esquemas).join(", "));
  }
}

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════
function _libroPrincipal() {
  if (!_cacheLibroPrincipal) {
    _cacheLibroPrincipal = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL);
  }
  return _cacheLibroPrincipal;
}

function _libroPrincipal() {
  if (!_cacheLibroPrincipal) {
    _cacheLibroPrincipal = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL);
  }
  return _cacheLibroPrincipal;
}

function _hoja(nombre) {
  if (!nombre) throw new Error('_hoja llamada sin nombre. Stack: ' + new Error().stack);
  const h = _libroPrincipal().getSheetByName(nombre);
  if (!h) throw new Error('Hoja "' + nombre + '" no existe. Ejecuta Inicializar Sistema.');
  return h;
}

// REEMPLAZA la función _hojaExterna por estas dos:

// Cache del libro BD (catálogos externos)
let _cacheLibroBD = null;

function _libroBD() {
  if (!_cacheLibroBD) {
    _cacheLibroBD = SpreadsheetApp.openById(CFG.ID_LIBRO_BD);
  }
  return _cacheLibroBD;
}

function _hojaExterna(nombreHoja) {
  const h = _libroBD().getSheetByName(nombreHoja);
  if (!h) throw new Error('Hoja externa "' + nombreHoja + '" no encontrada en libro BD.');
  return h;
}

function _toObj(cols, row) {
  const o = {};
  cols.forEach((c, i) => { o[c] = row[i] instanceof Date ? row[i].toISOString() : row[i]; });
  return o;
}

// ── MENÚ ─────────────────────────────────────────────────────────
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("Monitor Flota PRO")
      .addItem("Abrir Centro de Mando", "abrirApp")
      .addSeparator()
      .addItem("Inicializar Sistema (1ª vez)", "inicializarSistema")
      .addToUi();
  } catch (e) {
    Logger.log("onOpen fuera de contexto UI: " + e.message);
  }
}

function abrirApp() {
  try {
    SpreadsheetApp.getUi().showModalDialog(
      HtmlService.createTemplateFromFile("Index")
        .evaluate().setWidth(1200).setHeight(800),
      "Monitor de Flota PRO v6.1"
    );
  } catch (e) {
    Logger.log("abrirApp fuera de contexto UI: " + e.message);
  }
}
function _normEst(s) {
  return (s || '').toString().replace(/\u00A0|\s+/g, ' ').trim();
}



function doPost(e) {
  try {
    let body = '';
    if (e && e.postData && e.postData.contents) {
      body = e.postData.contents;
    } else if (e && e.postData && typeof e.postData === 'string') {
      body = e.postData;
    }

    if (!body || body.length === 0) {
      return ContentService.createTextOutput('OK');
    }

    // Parsear
    let payload = JSON.parse(body);
    
    // Procesar
    procesarWebhookSamsara(payload);
    return ContentService.createTextOutput('OK');

  } catch (ex) {
    return ContentService.createTextOutput('OK');
  }
}

/**
 * Valida la firma HMAC-SHA256 del webhook
 */
function validarFirmaSamsara(timestamp, body, signature) {
  try {
    // Construcción del mensaje: timestamp + body
    const message = timestamp + body;
    const secret = SAMSARA_WEBHOOK_SECRET || '';

    if (!secret) {
      Logger.log('⚠️ SAMSARA_WEBHOOK_SECRET no está definido');
      return false;
    }

    // Calcular firma esperada
    const hmac = Utilities.computeHmacSha256Signature(message, secret);
    const expectedSignature = Utilities.bytesToHex(hmac);

    Logger.log('Firma esperada: ' + expectedSignature);
    Logger.log('Firma recibida: ' + signature);
    Logger.log('Coinciden: ' + (expectedSignature === signature));

    return expectedSignature === signature;

  } catch (ex) {
    Logger.log('❌ Error al validar firma: ' + ex.message);
    return false;
  }
}

/**
 * Procesa webhooks de Samsara (detecta automáticamente versión 1.0 o 2.0)
 */
function procesarWebhookSamsara(payload) {
  try {
    Logger.log('Detectando versión de webhook...');
    Logger.log('EventType: ' + payload.eventType);

    // Ignorar Pings
    if (payload.eventType === 'Ping') {
      Logger.log('⊘ Ping recibido - ignorando');
      const logHoja = SpreadsheetApp.openById(CFG.ID_LIBRO_PRINCIPAL).getSheetByName('Alertas_Samsara');
      if (logHoja) {
        logHoja.appendRow(['PING-' + Date.now(), new Date().toISOString(), 'PING', 'Webhook Ping recibido - OK', '', '', '', '', '']);
      }
      return;
    }

    // Detectar AlertIncident (nuevo formato Samsara)
    if (payload.eventType === 'AlertIncident') {
      Logger.log('📌 Detectado: AlertIncident');
      procesarWebhookSamsara2(payload);
      return;
    }

    // Detectar versión 2.0 antiguo
    if (payload.eventType === 'alerts.vehicle_alert') {
      Logger.log('📌 Detectado: alerts.vehicle_alert');
      procesarWebhookSamsara2(payload);
      return;
    }

    // Detectar versión 1.0
    if (payload.event) {
      Logger.log('📌 Detectado: Webhook 1.0');
      procesarWebhookSamsara1(payload);
      return;
    }

    Logger.log('⚠️ EventType desconocido: ' + payload.eventType);

  } catch (ex) {
    Logger.log('❌ Error en procesarWebhookSamsara: ' + ex.message);
  }
}

/**
 * Procesa Webhooks 2.0 de Samsara (nuevo formato)
 */
function testWebhook2() {
  Logger.log('=== TEST WEBHOOK 2.0 (AlertIncident) ===');

  const testPayload = {
    "eventId": "017db07f-6e95-470e-8cc0-a371f9deed2b",
    "eventTime": "2026-05-15T14:53:09.683Z",
    "eventType": "AlertIncident",
    "orgId": 20936,
    "webhookId": "1411751028848270",
    "data": {
      "configurationId": "9814a1fa-f0c6-408b-bf85-51dc3bc71ac7",
      "happenedAtTime": "2026-05-15T14:53:09Z",
      "resolvedAtTime": null,
      "updatedAtTime": "2026-05-15T14:53:09Z",
      "incidentUrl": "https://cloud.samsara.com/alerts/123456",
      "isResolved": false,
      "conditions": [
        {
          "description": "Harsh Acceleration",
          "details": {
            "geofenceEntry": {
              "vehicle": {
                "id": "494123",
                "name": "UNIDAD-TEST-01",
                "serial": "ABC123DEF456",
                "externalIds": {
                  "maintenanceId": "250020"
                }
              },
              "driver": {
                "id": "45646",
                "name": "Driver Bob"
              }
            }
          },
          "triggerId": 5016
        }
      ]
    }
  };

  const e = {
    postData: {
      contents: JSON.stringify(testPayload),
      headers: {}
    },
    parameter: {}
  };

  Logger.log('Ejecutando doPost con payload AlertIncident...');
  doPost(e);
}

/**
 * Procesa Webhooks 1.0 de Samsara (formato antiguo)
 */
function procesarWebhookSamsara1(payload) {
  try {
    Logger.log('⚙️ Procesando Webhook 1.0...');

    const evt = payload.event || {};
    const device = evt.device || evt.vehicle || {};

    const vehicleName = device.name || device.id || 'Desconocida';
    const alertType = evt.alertConditionId || evt.type || 'Alerta';
    const detalles = evt.details || evt.summary || evt.alertConditionDescription || '';
    const estado = evt.resolved ? 'resuelto' : 'abierto';
    const vin = device.vin || '';
    const alertId = evt.alertEventUrl || evt.id || '';

    const id_alerta = 'SAM-' + new Date().getTime();
    const fecha = new Date().toLocaleString('es-MX');

    Logger.log('🚨 ALERTA DETECTADA (v1.0):');
    Logger.log('  - Unidad: ' + vehicleName);
    Logger.log('  - Tipo: ' + alertType);
    Logger.log('  - Fecha: ' + fecha);

    // Guardar alerta
    guardarAlertaSamsara(id_alerta, fecha, vehicleName, alertType, 'info', estado, detalles, vin, alertId);

    // Registrar como novedad si existe la función
    if (typeof registrarNovedad === 'function') {
      registrarNovedad('SAMSARA_ALERT', vehicleName, alertType, detalles);
    }

  } catch (ex) {
    Logger.log('❌ Error en procesarWebhookSamsara1: ' + ex.message);
    Logger.log('Stack: ' + ex.stack);
  }
}

/**
 * Guarda una alerta en la hoja de cálculo
 */
function guardarAlertaSamsara(id, fecha, unidad, tipo, severidad, estado, detalles, vin, url) {
  try {
    const ss = _libroPrincipal();
    let hoja = ss.getSheetByName(CFG.H_ALERTAS_SAMSARA);

    // Crear hoja si no existe
    if (!hoja) {
      Logger.log('📝 Creando hoja Alertas_Samsara...');
      hoja = ss.insertSheet('Alertas_Samsara');
      hoja.appendRow([
        'ID_ALERTA',
        'FECHA',
        'UNIDAD',
        'TIPO',
        'SEVERIDAD',
        'ESTADO',
        'DETALLES',
        'VIN',
        'URL_SAMSARA'
      ]);
    }

    // Agregar fila de alerta
    hoja.appendRow([id, fecha, unidad, tipo, severidad, estado, detalles, vin, url]);
    Logger.log('✅ Alerta guardada: ' + id);

  } catch (ex) {
    Logger.log('❌ Error al guardar alerta: ' + ex.message);
  }
}

/**
 * Obtiene alertas del día de Samsara
 */
function obtenerAlertasSamsara(token) {
  const sess = validarToken(token);
  if (!sess) return { ok: false, msg: "Sesión expirada" };
  
  try {
    const ss = _libroPrincipal();
    const hoja = ss.getSheetByName(CFG.H_ALERTAS_SAMSARA);
    
    if (!hoja || hoja.getLastRow() < 2) return { ok: true, data: [] };
    
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const cols = ['ID_ALERTA', 'FECHA', 'UNIDAD', 'TIPO', 'SEVERIDAD', 'ESTADO', 'DETALLES', 'VIN', 'URL_SAMSARA'];
    const datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, 9).getValues();
    
    const alertas = datos
      .filter(r => {
        const f = r[1] instanceof Date ? r[1] : new Date(r[1]);
        return f >= hoy;
      })
      .map(r => ({
        ID_INC: r[0],
        FECHA_HORA: r[1],
        UNIDAD: r[2],
        TIPO: r[3],
        SEVERIDAD: r[4],
        ESTADO: r[5],
        DETALLES: r[6],
        VIN: r[7],
        URL_SAMSARA: r[8],
        _severidad: r[4]
      }))
      .sort((a,b) => new Date(b.FECHA_HORA) - new Date(a.FECHA_HORA));
    
    return { ok: true, data: alertas };
  } catch(ex) {
    return { ok: false, msg: ex.message };
  }
}

function marcarAlertaAtendida(token, idAlerta, monitorista) {
  const sess = validarToken(token);
  if (!sess) return { ok: false };
  
  try {
    const hoja = _hoja(CFG.H_ALERTAS_SAMSARA);
    const rows = hoja.getRange(2, 1, hoja.getLastRow() - 1, 9).getValues();
    const idx = rows.findIndex(r => r[0] === idAlerta);
    
    if (idx >= 0) {
      // Agregar columna de "Atendida por" si no existe
      hoja.getRange(idx + 2, 10).setValue(monitorista); // Columna 10
      return { ok: true };
    }
    return { ok: false };
  } catch(ex) {
    return { ok: false, msg: ex.message };
  }
}

/**
 * Función de prueba para webhooks 2.0
 */
function testWebhook2() {
  Logger.log('=== TEST WEBHOOK 2.0 ===');

  const testPayload = {
    eventType: 'alerts.vehicle_alert',
    id: 'test-event-123',
    data: {
      id: 'alert-456',
      type: 'harsh_acceleration',
      severity: 'high',
      triggeredAt: new Date().toISOString(),
      resolvedAt: null,
      vehicle: {
        id: 'vehicle-789',
        name: 'UNIDAD-TEST-01',
        vin: 'ABC123DEF456'
      },
      details: {
        location: 'Test Location',
        speed: 80
      }
    }
  };

  const e = {
    postData: {
      contents: JSON.stringify(testPayload),
      headers: {}
    },
    parameter: {}
  };

  Logger.log('Ejecutando doPost con payload 2.0...');
  doPost(e);
}

/**
 * Función de prueba para webhooks 1.0
 */
function testWebhook1() {
  Logger.log('=== TEST WEBHOOK 1.0 ===');

  const testPayload = {
    eventId: 'test-123',
    eventMs: new Date().getTime(),
    eventType: 'Alert',
    event: {
      device: {
        name: 'UNIDAD-TEST-02',
        id: 'device-999',
        vin: 'XYZ789ABC123'
      },
      alertConditionId: 'harsh_braking',
      details: 'Frenado fuerte detectado',
      resolved: false,
      alertEventUrl: 'https://samsara.com/alerts/123'
    }
  };

  const e = {
    postData: {
      contents: JSON.stringify(testPayload),
      headers: {}
    },
    parameter: {}
  };

  Logger.log('Ejecutando doPost con payload 1.0...');
  doPost(e);
}
/**
 * Procesa Webhooks 2.0 de Samsara (AlertIncident) - VERSIÓN GENÉRICA
 * Detecta automáticamente cualquier tipo de evento sin necesidad de hardcodear
 */
function procesarWebhookSamsara2(payload) {
  try {
    Logger.log('⚙️ Procesando AlertIncident...');

    const data = payload.data || {};
    const conditions = data.conditions || [];
    
    if (!conditions.length) {
      Logger.log('⊘ Sin condiciones');
      return;
    }

    const condition = conditions[0];
    const details = condition.details || {};
    
    // DETECCIÓN AUTOMÁTICA: buscar objeto con "vehicle" O "trailer"
    let vehicle = {};
    let alertType = 'AlertIncident';
    let eventKey = '';
    
    // Buscar recursivamente en details
    for (const key in details) {
      if (details[key] && typeof details[key] === 'object') {
        // Buscar vehicle o trailer
        if (details[key].vehicle) {
          vehicle = details[key].vehicle;
          alertType = key
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, str => str.toUpperCase())
            .trim();
          eventKey = key;
          Logger.log('🔍 Detectado evento (vehicle): ' + eventKey + ' → ' + alertType);
          break;
        }
        else if (details[key].trailer) {
          vehicle = details[key].trailer;
          alertType = key
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, str => str.toUpperCase())
            .trim();
          eventKey = key;
          Logger.log('🔍 Detectado evento (trailer): ' + eventKey + ' → ' + alertType);
          break;
        }
      }
    }
    
    // Si no encontró, buscar directamente en details
    if (!vehicle || !vehicle.id) {
      if (details.vehicle) {
        vehicle = details.vehicle;
        alertType = 'Alert';
      }
      else if (details.trailer) {
        vehicle = details.trailer;
        alertType = 'Trailer Alert';
      }
    }
    
    // Extraer datos
    const vehicleName = vehicle.name || vehicle.id || 'Desconocida';
    const vin = vehicle.serial || vehicle.trailerSerialNumber || vehicle.externalIds?.samsara?.vin || '';
    const triggeredAt = data.happenedAtTime || new Date().toISOString();
    const estado = data.isResolved ? 'resuelto' : 'abierto';
    const detalles = JSON.stringify(details);
    const incidentUrl = data.incidentUrl || '';

    const fecha = new Date(triggeredAt).toLocaleString('es-MX');
    const id_alerta = 'SAM-' + new Date().getTime();

    Logger.log('🚨 ALERTA: ' + vehicleName + ' - ' + alertType + ' - ' + estado);

    // Guardar
    guardarAlertaSamsara(id_alerta, fecha, vehicleName, alertType, 'alert', estado, detalles, vin, incidentUrl);

  } catch (ex) {
    Logger.log('❌ Error: ' + ex.message);
    Logger.log(ex.stack);
  }
}
function cargarAlertasSamsara() {
  google.script.run.withSuccessHandler(function(res) {
    if (!res.ok) return toast(res.msg, 'error');
    
    const body = document.getElementById('alertasSamsaraBody');
    body.innerHTML = '';
    
    if (!res.data || res.data.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="tbl-empty">Sin alertas</td></tr>';
      return;
    }
    
    res.data.forEach(alerta => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(alerta.FECHA_HORA).toLocaleString('es-MX')}</td>
        <td><strong>${alerta.UNIDAD}</strong></td>
        <td>${alerta.TIPO}</td>
        <td><span class="badge" style="background:${alerta._severidad === 'high' ? '#ef4444' : '#f59e0b'}">${alerta._severidad || 'alert'}</span></td>
        <td>${alerta.ESTADO}</td>
        <td><a href="${alerta.URL_SAMSARA}" target="_blank" class="link-sm">Ver en Samsara →</a></td>
        <td id="atendida-${alerta.ID_INC}">—</td>
        <td>
          <button class="btn-xs" onclick="marcarAtendida('${alerta.ID_INC}', '${alerta.UNIDAD}')">Atender</button>
        </td>
      `;
      body.appendChild(tr);
    });
    
    document.getElementById('nb-alertas-samsara').textContent = res.data.length;
    document.getElementById('nb-alertas-samsara').classList.remove('hidden');
    
  }).obtenerAlertasSamsara(token);
}

function marcarAtendida(idAlerta, unidad) {
  const monitorista = sess.nombre;
  google.script.run.withSuccessHandler(function(res) {
    if (res.ok) {
      document.getElementById('atendida-' + idAlerta).textContent = monitorista;
      toast('Alerta marcada como atendida', 'success');
    }
  }).marcarAlertaAtendida(token, idAlerta, monitorista);
}