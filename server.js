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
          ttsModel="eleven_flash_v2_5"
          transcriptionProvider="deepgram"
          welcomeGreeting="Bonjour, clinique vétérinaire du Parc, comment puis-je vous aider ?"
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

// Fonction pour extraire la réponse peu importe le format de n8n
function parseN8nResponse(data) {
  try {
    // Si c'est un tableau, prend le premier élément
    if (Array.isArray(data)) {
      data = data[0];
    }

    // Si c'est déjà le bon format { action, message }
    if (data.action && data.message) {
      return data;
    }

    // Si c'est dans un champ "output" (format AI Agent n8n)
    let output = data.output || data.text || data.response || '';

    // Si output est un objet
    if (typeof output === 'object') {
      if (output.action && output.message) return output;
      output = JSON.stringify(output);
    }

    // Nettoyer les backticks markdown
    output = output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Essayer de parser le JSON
    const parsed = JSON.parse(output);
    if (parsed.action && parsed.message) {
      return parsed;
    }

    // Si rien ne marche, retourner comme message simple
    return { action: 'reply', message: output };

  } catch (e) {
    // Dernier recours : utiliser le texte brut
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return { action: 'reply', message: text };
  }
}

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connecté — conversation démarrée');

  const callId = Date.now().toString();

  ws.on('message', async (data) => {
    const message = JSON.parse(data);
    console.log('📩 Message reçu :', JSON.stringify(message));

    const text = message.text || message.voicePrompt;

    if ((message.type === 'speech' || message.type === 'prompt') && text) {
      console.log(`🗣️ Client dit : "${text}"`);

      try {
        console.log('📤 Envoi à n8n...');
        const response = await axios.post(process.env.N8N_WEBHOOK_URL, {
          callId: callId,
          text: text,
          from: message.from || 'inconnu'
        }, { timeout: 30000 });

        console.log('📥 Réponse n8n brute :', JSON.stringify(response.data));

        const reply = parseN8nResponse(response.data);
        console.log('✅ Réponse parsée :', JSON.stringify(reply));

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