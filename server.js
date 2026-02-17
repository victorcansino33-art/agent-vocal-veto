require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post('/incoming-call', (req, res) => {
  console.log('📞 Appel entrant de :', req.body.From);

  const twiml = `
    <Response>
      <Connect>
        <ConversationRelay
          url="wss://${req.headers.host}/ws"
          tts="elevenlabs"
          voice="${process.env.ELEVENLABS_VOICE_ID}"
          language="fr-FR"
          transcriptionProvider="deepgram"
          welcomeGreeting="Bonjour, clinique vétérinaire, comment puis-je vous aider ?"
        />
      </Connect>
    </Response>
  `;

  res.type('text/xml').send(twiml);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connecté — conversation démarrée');

  const callId = Date.now().toString();

  ws.on('message', async (data) => {
    const message = JSON.parse(data);

    if (message.type === 'speech' && message.text) {
      console.log(`🗣️ Client dit : "${message.text}"`);

      try {
        const response = await axios.post(process.env.N8N_WEBHOOK_URL, {
          callId: callId,
          text: message.text,
          from: message.from || 'inconnu'
        });

        const reply = response.data;

        if (reply.action === 'transfer') {
          console.log('🚨 Transfert urgence vers :', reply.transferTo);
          ws.send(JSON.stringify({
            type: 'text',
            token: reply.message
          }));
          ws.send(JSON.stringify({ type: 'end_of_response' }));
          ws.send(JSON.stringify({
            type: 'transfer',
            handoff: reply.transferTo
          }));
          return;
        }

        if (reply.action === 'hangup') {
          ws.send(JSON.stringify({
            type: 'text',
            token: reply.message
          }));
          ws.send(JSON.stringify({ type: 'end_of_response' }));
          ws.send(JSON.stringify({ type: 'end' }));
          return;
        }

        console.log(`🤖 Agent répond : "${reply.message}"`);
        ws.send(JSON.stringify({
          type: 'text',
          token: reply.message
        }));
        ws.send(JSON.stringify({ type: 'end_of_response' }));

      } catch (error) {
        console.error('❌ Erreur n8n :', error.message);
        ws.send(JSON.stringify({
          type: 'text',
          token: "Excusez-moi, je rencontre un petit souci technique. Pouvez-vous patienter un instant ?"
        }));
        ws.send(JSON.stringify({ type: 'end_of_response' }));
      }
    }
  });

  ws.on('close', () => {
    console.log('📴 Appel terminé');
    axios.post(process.env.N8N_WEBHOOK_URL, {
      callId: callId,
      text: '__CALL_ENDED__',
    }).catch(() => {});
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur le port ${PORT}`);
  console.log(`📞 Webhook Twilio : POST /incoming-call`);
  console.log(`🔗 WebSocket : /ws`);
});