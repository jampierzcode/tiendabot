import 'node:process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import pkg from 'whatsapp-web.js'
import { api } from './api.js'

const { Client, LocalAuth } = pkg

const SESSIONS_POLL_MS = Number(process.env.SESSIONS_POLL_MS || 2000)
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 2000)
const DELAY_MIN = Number(process.env.SEND_DELAY_MIN_MS || 1500)
const DELAY_MAX = Number(process.env.SEND_DELAY_MAX_MS || 4000)
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 120000)
const SESSIONS_DIR = process.env.SESSIONS_DIR || './.sessions'
// Navegadores precargados en espera (sin sesión guardada): cada uno cuesta
// ~200 MB de RAM, pero «Conectar» muestra el QR al instante.
const PRELOAD_MAX = Number(
  process.env.PRELOAD_MAX ?? (process.env.NODE_ENV === 'production' ? 0 : 2)
)
// Sondeo adaptativo: rápido solo cuando algo está cambiando (QR, conectando).
const SESSIONS_IDLE_MS = Number(process.env.SESSIONS_IDLE_MS || 6000)
const USER_AGENT =
  process.env.WA_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

/** businessUuid -> { client, status } */
const clients = new Map()

/**
 * Fallos al abrir el navegador, por sesión. Sin esto un Chromium que no puede
 * arrancar se reintenta cada 2 s para siempre (y por cada negocio que alguna
 * vez abrió la pantalla de WhatsApp). Espera 15 s, 30 s, 60 s… hasta 10 min.
 */
const fallos = new Map() // uuid -> { n, hasta }
function registrarFallo(uuid) {
  const n = (fallos.get(uuid)?.n ?? 0) + 1
  const espera = Math.min(15000 * 2 ** (n - 1), 10 * 60 * 1000)
  fallos.set(uuid, { n, hasta: Date.now() + espera })
  log(uuid, `reintento en ${Math.round(espera / 1000)} s (fallo ${n})`)
}
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

function levantar(uuid, standby = false) {
  if (clients.has(uuid)) return

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: uuid, dataPath: SESSIONS_DIR }),
    // Sin esto el navegador se anuncia como «HeadlessChrome» y WhatsApp Web
    // no llega a mostrar el QR (la librería se queda en «Navigating frame was detached»).
    userAgent: USER_AGENT,
    puppeteer: {
      headless: true,
      // En el contenedor se usa el Chromium del sistema (ver Dockerfile).
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  })

  // standby: navegador abierto y QR listo, pero nadie lo pidió aún (no se reporta).
  const entry = { client, status: 'connecting', since: Date.now(), standby, lastQr: null }
  clients.set(uuid, entry)

  client.on('qr', async (qr) => {
    entry.status = 'qr'
    entry.lastQr = qr
    log(uuid, standby && entry.standby ? 'QR listo (en espera)' : 'QR listo')
    if (!entry.standby) await report(uuid, { status: 'qr', qr })
  })

  client.on('ready', async () => {
    entry.status = 'connected'
    fallos.delete(uuid)
    const phone = client.info?.wid?.user ?? null
    log(uuid, 'conectado', phone)
    await report(uuid, { status: 'connected', connectedPhone: phone })
  })

  client.on('auth_failure', async (m) => {
    log(uuid, 'fallo de autenticación', m)
    registrarFallo(uuid)
    await apagar(uuid)
  })

  client.on('disconnected', async (reason) => {
    log(uuid, 'desconectado', reason)
    await apagar(uuid)
  })

  client.on('message', async (msg) => {
    // Solo chats directos; ignora grupos, estados y mensajes propios.
    if (msg.fromMe || msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return
    // Canales y newsletters (@newsletter) también llegan aquí: no son clientes.
    if (!msg.from.endsWith('@c.us') && !msg.from.endsWith('@lid')) return
    try {
      // WhatsApp ya entrega muchos chats con un id interno (@lid) que NO es el
      // teléfono. Se resuelve el número real por varias vías; solo si ninguna
      // sirve se usa el id (y el envío lo intenta por @lid).
      let telefono = msg.from.replace(/@.*/, '')
      const diag = { from: msg.from, author: msg.author ?? null, notifyName: msg._data?.notifyName ?? null }
      if (msg.from.endsWith('@lid')) {
        try {
          const [par] = await entry.client.getContactLidAndPhone([msg.from])
          diag.lidAndPhone = par
          const pn = String(par?.pn || '').replace(/@.*/, '').replace(/\D/g, '')
          if (pn) telefono = pn
        } catch (e) {
          diag.lidAndPhoneError = e.message
        }
        if (telefono === msg.from.replace(/@.*/, '')) {
          try {
            const contacto = await msg.getContact()
            diag.contact = {
              id: contacto?.id?._serialized,
              number: contacto?.number,
              name: contacto?.name,
              pushname: contacto?.pushname,
              isMyContact: contacto?.isMyContact,
            }
            const real = String(contacto?.number || '').replace(/\D/g, '')
            if (real) telefono = real
          } catch (e) {
            diag.contactError = e.message
          }
        }
      }
      diag.resuelto = telefono
      if (process.env.DEBUG_INBOUND !== '0') log(uuid, 'mensaje entrante', JSON.stringify(diag))
      const reply = await api.inbound(uuid, telefono, msg.body)
      if (reply) {
        await sleep(800 + Math.random() * 1200)
        await msg.reply(reply)
      }
    } catch (e) {
      log(uuid, 'error al responder', e.message)
    }
  })

  client.initialize().catch(async (e) => {
    log(uuid, 'no pudo iniciar', e.message.split('\n')[0])
    registrarFallo(uuid)
    await apagar(uuid)
  })
}

async function apagar(uuid) {
  const entry = clients.get(uuid)
  clients.delete(uuid)
  if (entry) {
    try {
      await entry.client.destroy()
    } catch {}
  }
  // Un navegador precargado nadie lo pidió: su fallo no es noticia para el panel.
  if (!entry?.standby) await report(uuid, { status: 'disconnected' })
}

// ¿Hay algo cambiando? Decide si el siguiente sondeo es rápido o tranquilo.
let hayActividad = true

async function sincronizarSesiones() {
  try {
    const sesiones = await api.sessions()
    let actividad = false
    for (const s of sesiones) {
      if (!s.businessUuid) continue

      // El panel pone «connecting» al pulsar Conectar/Reintentar: eso cancela la espera.
      if (s.status === 'connecting' && !clients.has(s.businessUuid)) fallos.delete(s.businessUuid)
      if (s.status === 'connecting' || s.status === 'qr') actividad = true

      // Vigilante: restaurar una sesión guardada a veces se queda colgado sin
      // error ni QR. Pasados 2 minutos sin conectar se descarta y se reintenta
      // (la sesión guardada se conserva; solo se reinicia el navegador).
      const vivo = clients.get(s.businessUuid)
      if (vivo && vivo.status === 'connecting' && Date.now() - vivo.since > CONNECT_TIMEOUT_MS) {
        log(s.businessUuid, 'sin conectar tras 2 min: reiniciando navegador')
        await apagar(s.businessUuid)
        continue
      }
      if (s.desired === 'connected' && !clients.has(s.businessUuid) && !enEspera(s.businessUuid)) {
        levantar(s.businessUuid)
        actividad = true
      }

      // Alguien pidió conectar y ya había un navegador precargado: se entrega
      // el QR que tiene guardado en vez de arrancar de cero.
      const previo = clients.get(s.businessUuid)
      if (s.desired === 'connected' && previo?.standby) {
        previo.standby = false
        previo.since = Date.now()
        log(s.businessUuid, 'usando navegador precargado')
        if (previo.lastQr) await report(s.businessUuid, { status: 'qr', qr: previo.lastQr })
      }

      // Precarga: sesión sin vincular que el panel ya abrió. Si ya hay una
      // sesión guardada no se precarga (se conectaría sola sin que lo pidan).
      if (
        s.desired === 'disconnected' &&
        !clients.has(s.businessUuid) &&
        !enEspera(s.businessUuid) &&
        [...clients.values()].filter((c) => c.standby).length < PRELOAD_MAX &&
        !existsSync(join(SESSIONS_DIR, `session-${s.businessUuid}`))
      ) {
        log(s.businessUuid, 'precargando navegador')
        levantar(s.businessUuid, true)
      }

      if (s.desired === 'disconnected' && clients.has(s.businessUuid) && !clients.get(s.businessUuid).standby) {
        const entry = clients.get(s.businessUuid)
        try {
          await entry.client.logout() // olvida la sesión: el próximo connect pide QR
        } catch {}
        await apagar(s.businessUuid)
      }
    }
    hayActividad = actividad || [...clients.values()].some((c) => c.status === 'connecting' && !c.standby)
  } catch (e) {
    log('sync sesiones:', e.message)
  }
}

async function cicloSesiones() {
  await sincronizarSesiones()
  setTimeout(cicloSesiones, hayActividad ? SESSIONS_POLL_MS : SESSIONS_IDLE_MS)
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
        // Un número real se valida; un id @lid (chat antiguo) se envía directo.
        const numero = await entry.client.getNumberId(m.phone).catch(() => null)
        const destino = numero?._serialized ?? (m.phone.length > 13 ? `${m.phone}@lid` : null)
        if (!destino) throw new Error('el número no tiene WhatsApp')
        await entry.client.sendMessage(destino, m.body)
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

// whatsapp-web.js lanza rechazos sueltos (p. ej. «auth timeout» de un intento
// ya descartado). Node 24 mata el proceso ante cualquiera; un bot que debe
// vivir siempre los registra y sigue: el reintento lo hace sincronizarSesiones.
process.on('unhandledRejection', (motivo) => {
  log('rechazo no manejado (ignorado):', motivo?.message ?? motivo)
})
process.on('uncaughtException', (error) => {
  log('excepción no capturada (ignorada):', error?.message ?? error)
})

log('bot iniciado')
setInterval(vaciarCola, OUTBOX_POLL_MS)
cicloSesiones()

process.on('SIGINT', async () => {
  for (const uuid of [...clients.keys()]) {
    try {
      await clients.get(uuid).client.destroy()
    } catch {}
  }
  process.exit(0)
})
