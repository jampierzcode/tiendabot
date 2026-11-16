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

**Asistente de ventas con IA:** cada mensaje del cliente va a `/api/bot/inbound`;
el backend (`SalesAgentService`) conversa con OpenAI usando herramientas que leen
el catálogo, cotizan, crean pedidos reales y consultan su estado. El bot solo
junta los mensajes seguidos, muestra «escribiendo…», manda el texto y las fotos.
Si el dueño responde a mano (desde el panel o desde su celular), el asistente
se calla con ese cliente durante `AI_AGENT_HUMAN_PAUSE_MIN` minutos.
Requiere `OPENAI_API_KEY` en el backend; sin ella se usan las reglas fijas.

**Aviso:** whatsapp-web.js no es oficial; WhatsApp puede bloquear números que
envíen mucho o sin consentimiento. Usar solo para avisos de pedidos que el
cliente mismo inició. Cada sesión consume ~150-300 MB de RAM (Chromium).
