# tiendaBot

Servicio independiente que conecta el número de WhatsApp de cada negocio
(whatsapp-web.js) y envía los avisos de pedido. No guarda datos de negocio:
todo vive en el backend (`tiendaApp`) y este proceso solo consulta y ejecuta.

```
cp .env.example .env   # y poner la misma BOT_API_KEY que el backend
npm install
npm start
```

Flujo: el dueño pulsa «Conectar» en el panel → el backend marca `desired=connected`
→ el bot levanta la sesión, reporta el QR → el panel lo muestra → el dueño lo
escanea → `connected`. Cada cambio de estado de un pedido encola un mensaje que
el bot envía con pausas aleatorias.

**Aviso:** whatsapp-web.js no es oficial; WhatsApp puede bloquear números que
envíen mucho o sin consentimiento. Usar solo para avisos de pedidos que el
cliente mismo inició. Cada sesión consume ~150-300 MB de RAM (Chromium).
