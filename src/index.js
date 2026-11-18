import 'node:process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidDecode,
  normalizeMessageContent,
  useMultiFileAuthState,
} from 'baileys'
import pino from 'pino'
import { api } from './api.js'

/*
 * Bot de WhatsApp con Baileys: habla el protocolo de WhatsApp Web por
 * websocket, sin abrir un navegador. Cada negocio cuesta ~30-60 MB de RAM en
 * vez de ~1 GB de Chromium (whatsapp-web.js), que era casi toda la factura.
 *
 * Igual que antes, NO guarda datos de negocio: el backend decide qué sesiones
 * levantar, qué responder (asistente de IA) y qué avisos enviar.
 */

const API_URL = (process.env.API_URL || 'http://localhost:4444').replace(/\/$/, '')
// Mensajes seguidos del cliente («hola» «quiero un polo» «talla M») se juntan
// en uno solo si llegan dentro de esta ventana: una respuesta, no tres.
const AGRUPAR_MS = Number(process.env.INBOUND_DEBOUNCE_MS || 2500)

const SESSIONS_POLL_MS = Number(process.env.SESSIONS_POLL_MS || 2000)
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 2000)
const DELAY_MIN = Number(process.env.SEND_DELAY_MIN_MS || 1500)
const DELAY_MAX = Number(process.env.SEND_DELAY_MAX_MS || 4000)
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 120000)
// Un QR que nadie escanea se cierra pasado este tiempo; se vuelve a pedir con «Conectar».
const QR_TIMEOUT_MS = Number(process.env.QR_TIMEOUT_MS || 180000)
const SESSIONS_DIR = process.env.SESSIONS_DIR || './.sessions'
// Sondeo adaptativo: rápido solo cuando algo está cambiando (QR, conectando).
const SESSIONS_IDLE_MS = Number(process.env.SESSIONS_IDLE_MS || 6000)

const logger = pino({ level: process.env.BAILEYS_LOG || 'silent' })

/** businessUuid -> { sock, status, since, cerrando } */
const clients = new Map()

const carpetaSesion = (uuid) => join(SESSIONS_DIR, 'baileys', uuid)

/**
 * Fallos al conectar, por sesión. Sin esto una sesión rota se reintenta cada
 * 2 s para siempre. Espera 15 s, 30 s, 60 s… hasta 10 min.
 */
const fallos = new Map() // uuid -> { n, hasta }
function registrarFallo(uuid) {
  const n = (fallos.get(uuid)?.n ?? 0) + 1
  const espera = Math.min(15000 * 2 ** (n - 1), 10 * 60 * 1000)
  fallos.set(uuid, { n, hasta: Date.now() + espera })
  log(uuid, `reintento en ${Math.round(espera / 1000)} s (fallo ${n})`)
  return n
}
/** Hasta que el dueño pulse «Conectar» en el panel (status connecting). */
const esperarAlPanel = (uuid) => fallos.set(uuid, { n: 0, hasta: Infinity })
const enEspera = (uuid) => (fallos.get(uuid)?.hasta ?? 0) > Date.now()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString(), ...a)

async function report(uuid, payload) {
  try {
    await api.reportSession(uuid, payload)
  } catch (e) {
    log('no pude reportar sesión', uuid, e.message)
  }
}

/** Versión vigente de WhatsApp Web; con una vieja WhatsApp rechaza la conexión. */
let versionWA = null
async function version() {
  if (versionWA && Date.now() - versionWA.at < 6 * 3600 * 1000) return versionWA.v
  try {
    const { version: v } = await fetchLatestBaileysVersion()
    versionWA = { v, at: Date.now() }
    return v
  } catch {
    return versionWA?.v // undefined: Baileys usa la que trae
  }
}

// ---------------------------------------------------------------------------
// Teléfonos y chats
// ---------------------------------------------------------------------------

const esChatDirecto = (jid) =>
  Boolean(jid) &&
  !isJidGroup(jid) &&
  !isJidBroadcast(jid) &&
  !isJidNewsletter(jid) &&
  (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))

/**
 * WhatsApp entrega muchos chats con un id interno (@lid) que NO es el
 * teléfono. Baileys 7 trae el número en `remoteJidAlt` o en su mapa LID→PN;
 * solo si nada sirve se usa el id (el envío lo intenta por @lid).
 */
async function telefonoDe(sock, jid, alt) {
  if (jid.endsWith('@s.whatsapp.net')) return jidDecode(jid).user
  if (alt?.endsWith('@s.whatsapp.net')) return jidDecode(alt).user
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid)
    if (pn) return jidDecode(pn).user
  } catch {}
  return jidDecode(jid)?.user ?? jid.replace(/@.*/, '')
}

/** Texto y tipo de un mensaje; null si no es algo que un cliente «dice». */
function leerMensaje(m) {
  const c = normalizeMessageContent(m.message)
  if (!c) return null
  const tipo = getContentType(c)
  const texto =
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    ''

  switch (tipo) {
    case 'conversation':
    case 'extendedTextMessage':
      return texto.trim() ? { texto, kind: 'chat' } : null
    case 'imageMessage':
      return { texto, kind: 'image' }
    case 'audioMessage':
      return { texto: '', kind: c.audioMessage?.ptt ? 'ptt' : 'audio' }
    case 'videoMessage':
      return { texto, kind: 'video' }
    case 'documentMessage':
      return { texto, kind: 'document' }
    case 'stickerMessage':
      return { texto: '', kind: 'sticker' }
    case 'locationMessage':
    case 'liveLocationMessage': {
      const l = c.locationMessage || c.liveLocationMessage
      const enlace = `https://maps.google.com/?q=${l?.degreesLatitude},${l?.degreesLongitude}`
      return { texto: `Mi ubicación: ${[l?.name, l?.address].filter(Boolean).join(', ')} ${enlace}`.trim(), kind: 'location' }
    }
    default:
      // Reacciones, ediciones, borrados, encuestas…: no se responden.
      return null
  }
}

/**
 * Lo que el bot está por mandar se anota antes de enviarlo: así, cuando
 * WhatsApp avisa «salió un mensaje de este número», se sabe si fue el bot o
 * el dueño escribiendo desde su celular. Por negocio y por texto (no por
 * chat): el mismo chat puede aparecer como número o como @lid.
 */
const enviadosPorBot = new Map() // uuid -> [{ texto, hasta }]
function anotarEnvio(uuid, texto) {
  const ahora = Date.now()
  const lista = (enviadosPorBot.get(uuid) || []).filter((e) => e.hasta > ahora)
  lista.push({ texto: String(texto || '').trim(), hasta: ahora + 120000 })
  enviadosPorBot.set(uuid, lista)
}
function esDelBot(uuid, texto) {
  const ahora = Date.now()
  const lista = (enviadosPorBot.get(uuid) || []).filter((e) => e.hasta > ahora)
  const limpio = String(texto || '').trim()
  const i = lista.findIndex((e) => e.texto === limpio)
  if (i >= 0) lista.splice(i, 1)
  enviadosPorBot.set(uuid, lista)
  return i >= 0
}

async function enviar(uuid, sock, jid, contenido) {
  anotarEnvio(uuid, contenido.text ?? contenido.caption ?? '')
  return sock.sendMessage(jid, contenido)
}

// ---------------------------------------------------------------------------
// Mensajes entrantes: se juntan, se responden de a uno por chat
// ---------------------------------------------------------------------------

const buzones = new Map() // `${uuid}|${jid}` -> { msgs, timer, cadena }

function encolarEntrante(uuid, m, leido) {
  const k = `${uuid}|${m.key.remoteJid}`
  const b = buzones.get(k) || { msgs: [], timer: null, cadena: Promise.resolve() }
  buzones.set(k, b)
  b.msgs.push({ m, ...leido })
  clearTimeout(b.timer)
  b.timer = setTimeout(() => {
    const lote = b.msgs.splice(0)
    // Una respuesta a la vez por chat: si el cliente escribe mientras el bot
    // piensa, lo nuevo espera su turno en vez de cruzarse.
    b.cadena = b.cadena
      .then(() => atender(uuid, lote))
      .catch(() => {})
      .finally(() => {
        if (!b.msgs.length && buzones.get(k) === b) buzones.delete(k)
      })
  }, AGRUPAR_MS)
}

const urlDe = (u) => (/^https?:\/\//.test(u) ? u : `${API_URL}${u}`)

const MIMES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const extDe = (n) => (String(n || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
const mimeDe = (nombre) => MIMES[extDe(nombre)] || 'application/octet-stream'
/** El nombre que ve el cliente, con la extensión del archivo real. */
function nombreArchivo(nombre, url) {
  const ext = extDe(url) || 'pdf'
  const base = String(nombre || 'Catalogo').trim() || 'Catalogo'
  return extDe(base) === ext ? base : `${base}.${ext}`
}

async function atender(uuid, lote) {
  const entry = clients.get(uuid)
  if (!entry || entry.status !== 'connected') return
  const { sock } = entry
  const ultimo = lote[lote.length - 1].m
  const jid = ultimo.key.remoteJid
  const textos = lote.map((x) => x.texto.trim()).filter(Boolean)
  // Si alguno no es texto (foto, audio…), se avisa el tipo del último que no lo sea.
  const noTexto = [...lote].reverse().find((x) => x.kind !== 'chat')

  try {
    const telefono = await telefonoDe(sock, jid, ultimo.key.remoteJidAlt)
    if (process.env.DEBUG_INBOUND !== '0') {
      log(uuid, 'mensaje entrante', JSON.stringify({ jid, resuelto: telefono, n: lote.length }))
    }

    try {
      await sock.readMessages(lote.map((x) => x.m.key))
      await sock.sendPresenceUpdate('composing', jid)
    } catch {}

    // Fotos que mandó el cliente: se descargan para que el asistente las vea.
    const imagenes = []
    for (const x of lote.filter((x) => x.kind === 'image').slice(-3)) {
      try {
        const buf = await downloadMediaMessage(x.m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
        if (buf.length > 6 * 1024 * 1024) continue
        const mime = normalizeMessageContent(x.m.message)?.imageMessage?.mimetype?.split(';')[0] || 'image/jpeg'
        imagenes.push({ mime, data: buf.toString('base64') })
      } catch (e) {
        log(uuid, 'no pude descargar la foto del cliente', e.message)
      }
    }

    const r = await api.inbound(uuid, telefono, textos.join('\n'), noTexto?.kind || 'chat', imagenes)
    const media = r?.media || []
    // Las fotos que pidió el asistente llevan la respuesta; lo del saludo
    // (catálogo en PDF, productos destacados) sale después del texto.
    const fotos = media.filter((f) => !f.trasTexto && f.tipo !== 'documento')
    const despues = media.filter((f) => f.trasTexto || f.tipo === 'documento')
    let reply = r?.reply || null

    if (reply) {
      // Pausa proporcional al largo: parece alguien escribiendo, no una máquina.
      await sleep(Math.min(4000, 700 + reply.length * 15) + Math.random() * 800)
    }

    // Foto + texto en UN mensaje: la respuesta va como descripción de la
    // última foto (WhatsApp corta descripciones muy largas: ahí van aparte).
    for (const [i, f] of fotos.entries()) {
      const ultima = i === fotos.length - 1
      const juntar = ultima && reply && reply.length <= 1000
      try {
        await enviar(uuid, sock, jid, { image: { url: urlDe(f.url) }, caption: juntar ? reply : f.caption })
        if (juntar) reply = null
        if (!ultima) await sleep(600 + Math.random() * 600)
      } catch (e) {
        // Si la foto no se pudo mandar, el texto igual sale (abajo).
        log(uuid, 'no pude enviar foto', e.message)
      }
    }

    if (reply) await enviar(uuid, sock, jid, { text: reply })

    for (const f of despues) {
      await sleep(700 + Math.random() * 600)
      try {
        if (f.tipo === 'documento') {
          const nombre = nombreArchivo(f.nombre, f.url)
          await enviar(uuid, sock, jid, {
            document: { url: urlDe(f.url) },
            fileName: nombre,
            mimetype: mimeDe(nombre),
          })
        } else {
          await enviar(uuid, sock, jid, { image: { url: urlDe(f.url) }, caption: f.caption })
        }
      } catch (e) {
        log(uuid, 'no pude enviar adjunto del saludo', e.message)
      }
    }
  } catch (e) {
    log(uuid, 'error al responder', e.message)
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', jid)
    } catch {}
  }
}

/**
 * Cuándo escribió el cliente por última vez en cada chat (por número y por
 * @lid). Sirve para reconocer las respuestas automáticas de WhatsApp Business
 * (mensaje de bienvenida / de ausencia): salen del número del negocio al
 * instante, sin que nadie las teclee, y no deben callar al asistente.
 */
const ultimaEntrada = new Map() // `${uuid}|${jid}` -> ms
const AUTO_RESPUESTA_MS = Number(process.env.AUTO_REPLY_WINDOW_MS || 8000)
function anotarEntrada(uuid, m) {
  const ahora = Date.now()
  for (const j of [m.key.remoteJid, m.key.remoteJidAlt]) if (j) ultimaEntrada.set(`${uuid}|${j}`, ahora)
  if (ultimaEntrada.size > 5000) {
    for (const [k, t] of ultimaEntrada) if (ahora - t > 60000) ultimaEntrada.delete(k)
  }
}
function esRespuestaAutomatica(uuid, m) {
  const ahora = Date.now()
  return [m.key.remoteJid, m.key.remoteJidAlt].some(
    (j) => j && ahora - (ultimaEntrada.get(`${uuid}|${j}`) ?? 0) < AUTO_RESPUESTA_MS
  )
}

/** El dueño escribió desde su celular: el asistente se aparta con ese cliente. */
async function mensajeDelDueno(uuid, sock, m, leido) {
  // Sin contenido legible (avisos internos de WhatsApp: cifrado, mensajes
  // temporales, reacciones, ediciones…) no es el dueño atendiendo.
  if (!leido) {
    const tipo = getContentType(normalizeMessageContent(m.message) || {}) || '?'
    log(uuid, 'mensaje propio sin contenido ignorado:', tipo)
    return
  }
  if (esDelBot(uuid, leido.texto ?? '')) return
  // Bienvenida / ausencia automática de WhatsApp Business: se anota en la
  // conversación, pero el asistente sigue atendiendo.
  const automatico = esRespuestaAutomatica(uuid, m)
  try {
    const telefono = await telefonoDe(sock, m.key.remoteJid, m.key.remoteJidAlt)
    await api.ownerMessage(uuid, telefono, leido.texto || '', !automatico)
    log(
      uuid,
      automatico
        ? 'respuesta automática de WhatsApp Business (el asistente sigue) con'
        : 'el dueño respondió a mano: asistente en pausa con',
      telefono
    )
  } catch (e) {
    log(uuid, 'no pude registrar mensaje del dueño', e.message)
  }
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

async function levantar(uuid) {
  if (clients.has(uuid)) return
  // conectadoEn: segundos epoch; lo anterior a la conexión es historial, no se responde.
  const entry = { sock: null, status: 'connecting', since: Date.now(), cerrando: false, conectadoEn: Infinity }
  clients.set(uuid, entry)

  try {
    const { state, saveCreds } = await useMultiFileAuthState(carpetaSesion(uuid))
    const sock = makeWASocket({
      version: await version(),
      auth: state,
      logger,
      browser: Browsers.macOS('Chrome'),
      // Sin «en línea»: el celular del dueño sigue recibiendo sus notificaciones.
      markOnlineOnConnect: false,
      // Nada de historial: es lo que más memoria gastaría y el bot no lo usa.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    })
    entry.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      if (entry.cerrando || clients.get(uuid) !== entry) return

      if (u.qr) {
        entry.status = 'qr'
        log(uuid, 'QR listo')
        await report(uuid, { status: 'qr', qr: u.qr })
      }

      if (u.connection === 'open') {
        entry.status = 'connected'
        entry.conectadoEn = Math.floor(Date.now() / 1000)
        fallos.delete(uuid)
        const phone = jidDecode(sock.user?.id ?? '')?.user ?? null
        log(uuid, 'conectado', phone)
        await report(uuid, { status: 'connected', connectedPhone: phone })
      }

      if (u.connection === 'close') {
        const codigo = u.lastDisconnect?.error?.output?.statusCode
        const estabaConectado = entry.status === 'connected'
        clients.delete(uuid)
        log(uuid, 'conexión cerrada', codigo ?? '')

        if (codigo === DisconnectReason.restartRequired) {
          // Normal justo después de escanear el QR: se reconecta ya con la sesión.
          levantar(uuid)
          return
        }
        if (codigo === DisconnectReason.loggedOut || codigo === DisconnectReason.forbidden) {
          // Desvincularon el dispositivo desde el celular: la sesión ya no sirve.
          rmSync(carpetaSesion(uuid), { recursive: true, force: true })
          esperarAlPanel(uuid)
          await report(uuid, { status: 'disconnected' })
          return
        }
        if (codigo === DisconnectReason.connectionReplaced) {
          // Otra instancia del bot abrió la misma sesión (p. ej. dos despliegues a la vez).
          esperarAlPanel(uuid)
          await report(uuid, { status: 'disconnected' })
          return
        }
        if (entry.status === 'qr') {
          // WhatsApp dejó de generar QR porque nadie lo escaneó: se espera al panel.
          esperarAlPanel(uuid)
          await report(uuid, { status: 'disconnected' })
          return
        }
        // Corte de red u otro: se reintenta con espera creciente. Solo se avisa
        // al panel si no se recupera, para no asustar por un corte de segundos.
        const n = registrarFallo(uuid)
        if (!estabaConectado || n >= 3) await report(uuid, { status: 'disconnected' })
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'append' = lo que llega al reconectar o lo que envía el propio bot: no se responde.
      if (type !== 'notify') return
      for (const m of messages) {
        const jid = m.key?.remoteJid
        if (!esChatDirecto(jid) || !m.message) continue
        // Al conectar, WhatsApp reenvía mensajes recientes (incluidos los que el
        // dueño escribió antes): no son conversación nueva. 30 s de margen por relojes.
        if (Number(m.messageTimestamp ?? 0) < entry.conectadoEn - 30) continue
        const leido = leerMensaje(m)
        if (m.key.fromMe) {
          await mensajeDelDueno(uuid, sock, m, leido)
          continue
        }
        anotarEntrada(uuid, m)
        if (leido) encolarEntrante(uuid, m, leido)
      }
    })
  } catch (e) {
    log(uuid, 'no pudo iniciar', e.message)
    clients.delete(uuid)
    registrarFallo(uuid)
    await report(uuid, { status: 'disconnected' })
  }
}

/**
 * Cierra la sesión. Con `olvidar` además la desvincula de WhatsApp y borra lo
 * guardado (el próximo «Conectar» pide QR); sin él solo libera la memoria.
 */
async function apagar(uuid, { olvidar = false, avisar = true } = {}) {
  const entry = clients.get(uuid)
  clients.delete(uuid)
  if (entry?.sock) {
    entry.cerrando = true
    try {
      if (olvidar) await entry.sock.logout()
      else entry.sock.end(undefined)
    } catch {}
  }
  if (olvidar) rmSync(carpetaSesion(uuid), { recursive: true, force: true })
  if (avisar) await report(uuid, { status: 'disconnected' })
}

// ¿Hay algo cambiando? Decide si el siguiente sondeo es rápido o tranquilo.
let hayActividad = true

async function sincronizarSesiones() {
  try {
    const sesiones = await api.sessions()
    let actividad = false
    for (const s of sesiones) {
      const uuid = s.businessUuid
      if (!uuid) continue

      // El panel pone «connecting» al pulsar Conectar/Reintentar: eso cancela la espera.
      if (s.status === 'connecting' && !clients.has(uuid)) fallos.delete(uuid)
      if (s.status === 'connecting' || s.status === 'qr') actividad = true

      const vivo = clients.get(uuid)
      // Vigilantes: conexión colgada, o QR que nadie escanea.
      if (vivo && vivo.status === 'connecting' && Date.now() - vivo.since > CONNECT_TIMEOUT_MS) {
        log(uuid, 'sin conectar tras 2 min: reintento')
        await apagar(uuid, { avisar: false })
        continue
      }
      if (vivo && vivo.status === 'qr' && Date.now() - vivo.since > QR_TIMEOUT_MS) {
        log(uuid, 'QR sin escanear: cierro hasta que vuelvan a pulsar Conectar')
        esperarAlPanel(uuid)
        await apagar(uuid)
        continue
      }

      if (s.desired === 'connected' && !clients.has(uuid) && !enEspera(uuid)) {
        levantar(uuid)
        actividad = true
      }

      // Negocio desactivado o con el plan vencido: se cierra la conexión pero
      // se conserva la sesión, para que al renovar vuelva sin escanear.
      if (s.desired === 'paused' && clients.has(uuid)) {
        log(uuid, 'negocio sin plan vigente: cierro su sesión (se conserva)')
        await apagar(uuid)
        continue
      }

      if (s.desired === 'disconnected') {
        if (clients.has(uuid)) {
          await apagar(uuid, { olvidar: true })
        } else if (existsSync(carpetaSesion(uuid))) {
          // Desconectado con el bot apagado: que el próximo «Conectar» pida QR.
          rmSync(carpetaSesion(uuid), { recursive: true, force: true })
        }
      }
    }
    hayActividad = actividad || [...clients.values()].some((c) => c.status !== 'connected')
  } catch (e) {
    log('sync sesiones:', e.message)
  }
}

async function cicloSesiones() {
  await sincronizarSesiones()
  setTimeout(cicloSesiones, hayActividad ? SESSIONS_POLL_MS : SESSIONS_IDLE_MS)
}

// ---------------------------------------------------------------------------
// Cola de avisos (cambios de estado de pedidos, mensajes desde el panel)
// ---------------------------------------------------------------------------

async function destinoDe(sock, phone) {
  // Un id @lid (chat que nunca dio su número) se envía directo.
  if (phone.length > 13) return `${phone}@lid`
  const [r] = await sock.onWhatsApp(phone).catch(() => [])
  if (!r?.exists) return null
  return r.jid
}

let enviando = false
async function vaciarCola() {
  if (enviando) return
  enviando = true
  try {
    // Sin ninguna sesión lista no se reclama nada: los mensajes esperan en la
    // cola del backend sin gastar intentos.
    if (![...clients.values()].some((c) => c.status === 'connected')) return

    const lote = await api.claim(10)
    for (const m of lote) {
      const entry = clients.get(m.businessUuid)

      if (!entry || entry.status !== 'connected') {
        // Esa sesión concreta aún no está lista: se devuelve sin contar intento.
        await api.result(m.id, false, 'sesión no conectada', true)
        continue
      }

      try {
        const destino = await destinoDe(entry.sock, m.phone)
        if (!destino) throw new Error('el número no tiene WhatsApp')
        await enviar(m.businessUuid, entry.sock, destino, { text: m.body })
        await api.result(m.id, true)
        log(m.businessUuid, 'enviado', m.id)
      } catch (e) {
        await api.result(m.id, false, e.message)
        log(m.businessUuid, 'falló', m.id, e.message)
      }

      // Pausa aleatoria entre mensajes: ritmo humano, menos riesgo de bloqueo.
      await sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN))
    }
  } catch (e) {
    log('cola:', e.message)
  } finally {
    enviando = false
  }
}

// Un bot que debe vivir siempre registra los rechazos sueltos y sigue: el
// reintento lo hace sincronizarSesiones.
process.on('unhandledRejection', (motivo) => {
  log('rechazo no manejado (ignorado):', motivo?.message ?? motivo)
})
process.on('uncaughtException', (error) => {
  log('excepción no capturada (ignorada):', error?.message ?? error)
})

log('bot iniciado (Baileys)')
setInterval(vaciarCola, OUTBOX_POLL_MS)
cicloSesiones()

async function salir() {
  for (const entry of clients.values()) {
    entry.cerrando = true
    try {
      entry.sock?.end(undefined)
    } catch {}
  }
  process.exit(0)
}
process.on('SIGINT', salir)
process.on('SIGTERM', salir)
