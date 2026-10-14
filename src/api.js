const API_URL = (process.env.API_URL || 'http://localhost:4444').replace(/\/$/, '')
const KEY = process.env.BOT_API_KEY || ''

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_URL}/api/bot${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-bot-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
  return res.json()
}

export const api = {
  sessions: () => call('/sessions').then((r) => r.data),
  reportSession: (uuid, payload) => call(`/sessions/${uuid}`, { method: 'POST', body: payload }),
  claim: (limit = 10) => call('/outbox/claim', { method: 'POST', body: { limit } }).then((r) => r.data),
  result: (id, ok, error, requeue = false) =>
    call(`/outbox/${id}/result`, { method: 'POST', body: { ok, error, requeue } }),
  inbound: (businessUuid, phone, text) =>
    call('/inbound', { method: 'POST', body: { businessUuid, phone, text } }).then((r) => r.reply),
}
