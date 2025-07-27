/*
 * Simple HTTP server to support the WhatsApp panel back‑end without
 * external dependencies. It uses Node.js's built‑in http and https
 * modules to provide REST‑style endpoints for storing API tokens,
 * sending messages via GupShup and retrieving messages for each
 * instance. This server is for demonstration purposes only; to
 * enable real WhatsApp delivery you must substitute your own
 * GupShup account details.
 *
 * Endpoints served on the configured PORT:
 *   GET  /api/instances             → list instances and connection status
 *   POST /api/instance/:id/token    → register an API token for an instance
 *   GET  /api/instance/:id/messages → list stored messages for an instance
 *   POST /api/instance/:id/messages → send a new message via GupShup
 *   POST /api/webhook               → ingest incoming messages from GupShup
 */

const http = require('http');
const https = require('https');
const url = require('url');

/*
 * Firestore setup
 *
 * To enable Firestore integration, you must create a service account in the
 * Firebase console and download its JSON credentials. Save the file as
 * `serviceAccountKey.json` in the same directory as this server. Then
 * install the Firebase Admin SDK by running:
 *
 *   npm install firebase-admin
 *
 * The code below will attempt to initialize the Admin SDK with those
 * credentials. If the file is missing or the module is not installed,
 * Firestore operations will be skipped and logged as warnings.
 */

let firestore = null;
try {
  const admin = require('firebase-admin');
  let serviceAccount;
  if (process.env.SERVICE_ACCOUNT_KEY) {
    try {
      serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
    } catch (parseErr) {
      console.error('Failed to parse SERVICE_ACCOUNT_KEY:', parseErr);
      throw parseErr;
    }
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  firestore = admin.firestore();
  console.log('Firestore initialized');
} catch (err) {
  console.warn('Firestore not initialized. To enable it, provide SERVICE_ACCOUNT_KEY env var or place your service account JSON in serviceAccountKey.json and install firebase-admin. Error:', err.message);
}

// Number of available WhatsApp instances. Adjust as needed.
const INSTANCE_COUNT = 8;

// In‑memory store for instances. Each instance holds a token and a message list.
const instances = {};
for (let i = 0; i < INSTANCE_COUNT; i++) {
  instances[i] = { token: null, messages: [] };
}

// Helper to send JSON responses with CORS headers
function sendJSON(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(json);
}

// Helper to parse request body as JSON
function parseRequestBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1e6) req.connection.destroy();
  });
  req.on('end', () => {
    try {
      const data = body ? JSON.parse(body) : {};
      callback(null, data);
    } catch (err) {
      callback(err);
    }
  });
}

// Main HTTP handler
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '';

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // List instances with connection status
  if (req.method === 'GET' && pathname === '/api/instances') {
    const data = [];
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      const inst = instances[i];
      data.push({ id: i, connected: !!inst.token });
    }
    sendJSON(res, 200, data);
    return;
  }

 // Set token for an instance
const tokenMatch = pathname.match(/^\/api\/instance\/(\d+)\/token$/);
if (req.method === 'POST' && tokenMatch) {
  const id = parseInt(tokenMatch[1], 10);
  if (id >= 0 && id < INSTANCE_COUNT) {
    parseRequestBody(req, (err, data) => {
      if (err) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const token = (data && data.token && data.token.trim()) || null;
      instances[id].token = token;
      sendJSON(res, 200, { id, connected: !!token });
    });
    return;
  }
}

  // Messages endpoints
  const messagesMatch = pathname.match(/^\/api\/instance\/(\d+)\/messages$/);
  if (messagesMatch) {
    const id = parseInt(messagesMatch[1], 10);
    if (id >= 0 && id < INSTANCE_COUNT) {
      if (req.method === 'GET') {
        sendJSON(res, 200, instances[id].messages);
        return;
      } else if (req.method === 'POST') {
        parseRequestBody(req, (err, data) => {
          if (err) {
            sendJSON(res, 400, { error: 'Invalid JSON' });
            return;
          }
          const to = data && data.to;
          const text = data && data.text;
          if (!to || !text) {
            sendJSON(res, 400, { error: "'to' and 'text' fields are required" });
            return;
          }
          const inst = instances[id];
          const token = inst.token;
          if (!token) {
            sendJSON(res, 400, { error: 'No API token set for this instance' });
            return;
          }

          const params = new URLSearchParams();
          params.append('channel', 'whatsapp');
          const srcNumber = process.env.GSWHATSAPP_NUMBER || '<SEU_NUMERO_WHATSAPP>';
          const appName = process.env.GSAPP_NAME || '<NOME_DA_SUA_APP>';
          params.append('source', srcNumber);
          params.append('destination', to);
          params.append('message', JSON.stringify({ type: 'text', text }));
          params.append('src.name', appName);
          const postBody = params.toString();

          const options = {
            hostname: 'api.gupshup.io',
            path: '/wa/api/v1/msg',
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              apikey: token,
              'Content-Length': Buffer.byteLength(postBody)
            }
          };

          const apiReq = https.request(options, apiRes => {
            let responseData = '';
            apiRes.on('data', chunk => (responseData += chunk));
            apiRes.on('end', () => {
              console.log('Resposta da GupShup:', responseData);
            });
          });

          apiReq.on('error', err2 => {
            console.error('Erro ao enviar mensagem para GupShup:', err2);
          });

          apiReq.write(postBody);
          apiReq.end();

          inst.messages.push({ from: 'me', to, text });

          if (firestore) {
            firestore.collection('mensagens').add({
              hora: Date.now().toString(),
              mensagemPaciente: null,
              nomePaciente: '',
              numeroPaciente: to,
              remetente: srcNumber,
              respostaRobo: text,
              statusAtendimento: 'em atendimento humano'
            }).catch(err => {
              console.error('Error saving outgoing message:', err);
            });
          }

          sendJSON(res, 200, { status: 'sent' });
        });
        return;
      }
    }
  }

  // Webhook endpoint – receives messages from GupShup and associates
  // them with the correct instance.
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/webhook') {
    sendJSON(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/webhook') {
    parseRequestBody(req, (err, data) => {
      if (err) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const instanceId = data.instanceId;
      if (instanceId === undefined || instanceId === null) {
        if (firestore) {
          try {
            const numeroPaciente = data.numeroPaciente || data.sender || data.source || '';
            const mensagem = data.mensagemPaciente || data.message || data.text || JSON.stringify(data);
            firestore.collection('mensagens').add({
              hora: Date.now().toString(),
              mensagemPaciente: mensagem,
              nomePaciente: '',
              numeroPaciente: numeroPaciente,
              remetente: numeroPaciente,
              respostaRobo: null,
              statusAtendimento: ''
            }).catch(err => {
              console.error('Error saving incoming message without instanceId:', err);
            });
          } catch (err) {
            console.error('Error processing incoming webhook without instanceId:', err);
          }
        }
        sendJSON(res, 200, { status: 'ok' });
        return;
      }
      const id = parseInt(instanceId, 10);
      if (id >= 0 && id < INSTANCE_COUNT) {
        instances[id].messages.push(data);
        if (firestore) {
          try {
            const numeroPaciente = data.numeroPaciente || data.sender || data.source || '';
            const mensagem = data.mensagemPaciente || data.message || data.text || JSON.stringify(data);
            firestore.collection('mensagens').add({
              hora: Date.now().toString(),
              mensagemPaciente: mensagem,
              nomePaciente: '',
              numeroPaciente: numeroPaciente,
              remetente: numeroPaciente,
              respostaRobo: null,
              statusAtendimento: ''
            }).catch(err => {
              console.error('Error saving incoming message for instance:', err);
            });
          } catch (err) {
            console.error('Error processing incoming webhook for instance:', err);
          }
        }
        sendJSON(res, 200, { status: 'received' });
        return;
      }
      sendJSON(res, 200, { status: 'ok' });
    });
    return;
  }

  /*
   * Firestore conversation APIs
   */
  if (req.method === 'GET' && pathname === '/api/conversations') {
    if (!firestore) {
      sendJSON(res, 503, { error: 'Firestore not configured' });
      return;
    }
    firestore.collection('mensagens').get().then(snapshot => {
      const convMap = {};
      snapshot.forEach(doc => {
        const dataDoc = doc.data();
        const numPac = dataDoc.numeroPaciente;
        const nomePac = dataDoc.nomePaciente;
        const horaStr = dataDoc.hora;
        if (!numPac) {
          return;
        }
        if (!convMap[numPac]) {
          convMap[numPac] = {
            id: numPac,
            nomePaciente: nomePac || '',
            lastHora: horaStr || ''
          };
        } else {
          const existing = convMap[numPac];
          const prev = existing.lastHora || '';
          if (horaStr && horaStr > prev) {
            existing.lastHora = horaStr;
          }
        }
      });
      const convs = Object.values(convMap);
      convs.sort((a, b) => (b.lastHora || '').localeCompare(a.lastHora || ''));
      sendJSON(res, 200, convs);
    }).catch(err => {
      console.error('Error listing conversations:', err);
      sendJSON(res, 500, { error: 'Failed to list conversations' });
    });
    return;
  }

  // GET /api/conversation/:id/messages
  const convMessagesMatch = pathname.match(/^\/api\/conversation\/(.+)\/messages$/);
  if (convMessagesMatch && req.method === 'GET') {
    if (!firestore) {
      sendJSON(res, 503, { error: 'Firestore not configured' });
      return;
    }
    const convId = convMessagesMatch[1];
    firestore.collection('mensagens').where('numeroPaciente', '==', convId).get()
      .then(snapshot => {
        const messages = [];
        snapshot.forEach(doc => {
          messages.push({ id: doc.id, ...doc.data() });
        });
        messages.sort((a, b) => {
          const ha = (a.hora || '').toString();
          const hb = (b.hora || '').toString();
          return ha.localeCompare(hb);
        });
        sendJSON(res, 200, messages);
      })
      .catch(err => {
        console.error('Error listing messages for conversation', convId, err);
        sendJSON(res, 500, { error: 'Failed to list messages' });
      });
    return;
  }

  // POST /api/conversation
  if (pathname === '/api/conversation' && req.method === 'POST') {
    if (!firestore) {
      sendJSON(res, 503, { error: 'Firestore not configured' });
      return;
    }
    parseRequestBody(req, (err, data) => {
      if (err) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const numeroPaciente = data && data.numeroPaciente;
      const nomePaciente = data && data.nomePaciente;
      const texto = data && data.texto;
      if (!numeroPaciente || !nomePaciente || !texto) {
        sendJSON(res, 400, { error: 'numeroPaciente, nomePaciente and texto are required' });
        return;
      }
      firestore.collection('mensagens').add({
        criadoEm: new Date().toISOString(),
        numeroPaciente,
        nomePaciente
      }).then(convRef => {
        const convId = convRef.id;
        return firestore.collection('mensagens').add({
          hora: Date.now().toString(),
          mensagemPaciente: null,
          nomePaciente,
          numeroPaciente,
          remetente: '<ORIGEM>',
          respostaRobo: texto,
          statusAtendimento: 'em atendimento humano'
        }).then(() => {
          sendJSON(res, 201, { id: convId });
        });
      }).catch(err2 => {
        console.error('Error creating conversation:', err2);
        sendJSON(res, 500, { error: 'Failed to create conversation' });
      });
    });
    return;
  }

  // PUT /api/conversation/:id/status
  const convStatusMatch = pathname.match(/^\/api\/conversation\/(.+)\/status$/);
  if (convStatusMatch && req.method === 'PUT') {
    if (!firestore) {
      sendJSON(res, 503, { error: 'Firestore not configured' });
      return;
    }
    const convId = convStatusMatch[1];
    parseRequestBody(req, (err, data) => {
      if (err) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const statusAtendimento = data && data.statusAtendimento;
      if (!statusAtendimento) {
        sendJSON(res, 400, { error: 'statusAtendimento is required' });
        return;
      }
      firestore.collection('mensagens').doc(convId).update({ statusAtendimento })
        .then(() => {
          sendJSON(res, 200, { status: 'updated' });
        })
        .catch(err => {
          console.error('Error updating status for conversation', convId, err);
          sendJSON(res, 500, { error: 'Failed to update status' });
        });
    });
    return;
  }

  // Default 404
  sendJSON(res, 404, { error: 'Not found' });
});

// Use environment PORT or fallback to 5001
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Back‑end server listening on port ${PORT}`);
});
