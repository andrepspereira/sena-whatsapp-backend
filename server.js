const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Initialise Supabase client using environment variables.  These must be
// configured on the deployment platform (e.g. Render) for the service to
// authenticate against Supabase.  See README for details.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

// Allow CORS from any origin so the static panel can access the API from a
// different domain.  Without this, browsers will block requests due to
// cross‑origin restrictions.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// In-memory store for instance tokens.  This is primarily used to keep
// compatibility with existing logic; tokens are also persisted to the
// `instances` table in Supabase so that they survive restarts.
const instanceTokens = {};

/**
 * Helper to ensure an instance row exists and, optionally, updates the token.
 *
 * When the panel registers or updates a token via `/api/instance/:id/token`,
 * this helper will upsert the `instances` table in Supabase so that the
 * token persists.  The in‑memory cache is updated to avoid an extra round
 * trip to the database on each message send.
 */
async function upsertInstance(id, token) {
  try {
    const updates = {
      id_da_instancia: String(id),
      token: token ?? null,
      status: 'active',
      updated_at: new Date().toISOString()
    };
    await supabase.from('instances').upsert(updates, { onConflict: 'id_da_instancia' });
    if (token) instanceTokens[id] = token;
  } catch (err) {
    console.error('Failed to upsert instance token:', err.message);
  }
}

// Load tokens from Supabase at startup.  This lets the service pick up
// previously stored tokens after a restart without requiring users to
// re-register them.
(async () => {
  try {
    const { data, error } = await supabase.from('instances').select('id_da_instancia, token');
    if (error) throw error;
    data.forEach(row => {
      if (row.token) instanceTokens[row.id_da_instancia] = row.token;
    });
    console.log('Loaded instance tokens from Supabase');
  } catch (err) {
    console.warn('Could not preload instance tokens:', err.message);
  }
})();

/**
 * GET /api/instances
 * Returns a list of instances and whether they have a token registered.
 */
app.get('/api/instances', async (req, res) => {
  try {
    // Return instances from memory; if none exist, synthesise a fixed list
    // based on the maximum instance count used in the panel (defaults to 8).
    const count = Number(process.env.INSTANCE_COUNT || 8);
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push({ id: String(i), hasToken: !!instanceTokens[i] });
    }
    return res.json(list);
  } catch (err) {
    console.error('Failed to fetch instances:', err.message);
    return res.status(500).json({ error: 'Failed to fetch instances' });
  }
});

/**
 * POST /api/instance/:id/token
 * Registers or updates the API token for a given instance.
 */
app.post('/api/instance/:id/token', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  try {
    await upsertInstance(instanceId, token);
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to update token:', err.message);
    return res.status(500).json({ error: 'Failed to update token' });
  }
});

/**
 * POST /api/instance/:id/messages
 * Sends a message to a user via the Gupshup WhatsApp API and records it in
 * the `messages` table.
 */
app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body;
  const phone = numeroPaciente || numero_paciente;
  // Optional patient name provided by the front‑end or Make.  If present
  // this will be stored on every message for this conversation so that
  // the UI can display the patient’s name instead of just the number.
  const patientName = nomePaciente || nome_paciente || null;
  if (!phone || !texto) {
    return res.status(400).json({ error: 'numeroPaciente and texto are required' });
  }
  const token = instanceTokens[instanceId];
  try {
    // Tenta enviar a mensagem via Gupshup somente se houver token configurado.
    // Mesmo que a chamada falhe ou não exista token, continuamos gravando a
    // mensagem no banco para que apareça no painel.  Isso permite ao
    // atendente responder mesmo que a API do Gupshup esteja indisponível
    // ou a instância ainda não tenha um token cadastrado.
    if (token) {
      try {
        await axios.post('https://api.gupshup.io/wa/api/v1/msg', null, {
          params: {
            channel: 'whatsapp',
            source: process.env.GSWHATSAPP_NUMBER,
            destination: phone,
            message: texto,
            'src.name': process.env.GSAPP_NAME
          },
          headers: { apikey: token }
        });
      } catch (err) {
        console.error('Failed to send message via Gupshup:', err.message);
      }
    }

    // Sempre grava a mensagem no Supabase para refletir no histórico. O
    // remetente é "Atendente" e o status é marcado como em atendimento.
    await supabase.from('messages').insert({
      instance_id: String(instanceId),
      numero_paciente: phone,
      nome_paciente: patientName,
      mensagem_paciente: null,
      resposta_robo: null,
      resposta_atendente: texto,
      remetente: 'Atendente',
      status_atendimento: 'EM_ATENDIMENTO'
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to send message:', err.message);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/webhook
 * Receives messages from Gupshup or forwarded from Make and records them.
 */
app.post('/api/webhook', jsonParser, urlencodedParser, async (req, res) => {
  try {
    // Support both JSON and urlencoded payloads.  When the body parser
    // attempts JSON first and fails, it falls back to urlencoded.
    const body = req.body || {};
    const instanceId = body.instanceId || '0';
    const numeroPaciente = body.numeroPaciente;
    const mensagemPaciente = body.mensagemPaciente;
    const respostaRobo = body.respostaRobo || null;
    const remetente = body.remetente || 'Paciente';
    const patientName = body.nomePaciente || body.nome_paciente || null;

    if (!numeroPaciente || !mensagemPaciente) {
      return res.status(400).json({ error: 'Missing numeroPaciente or mensagemPaciente' });
    }

    // Always record the patient's message as a separate record
    await supabase.from('messages').insert({
      instance_id: String(instanceId),
      numero_paciente: numeroPaciente,
      nome_paciente: patientName,
      mensagem_paciente: mensagemPaciente,
      resposta_robo: null,
      resposta_atendente: null,
      remetente: 'Paciente',
      status_atendimento: 'PENDENTE'
    });

    // If there is a robot response included in the payload, insert it as
    // another row.  This ensures that questions and respostas are stored
    // separately and can be rendered independently in the panel.  The
    // remitente is set to 'Robô' to allow proper styling on the client.
    if (respostaRobo) {
      // Insere a resposta do robô como uma mensagem separada.  Definimos
      // status_atendimento como 'EM_ATENDIMENTO' para indicar que o
      // atendimento está em progresso (não pendente).  Caso a frase
      // indique transferência, o status será atualizado para 'PENDENTE'
      // logo abaixo.
      await supabase.from('messages').insert({
        instance_id: String(instanceId),
        numero_paciente: numeroPaciente,
        nome_paciente: patientName,
        mensagem_paciente: null,
        resposta_robo: respostaRobo,
        resposta_atendente: null,
        remetente: 'Robô',
        status_atendimento: 'EM_ATENDIMENTO'
      });
      // Se a resposta do robô contiver a expressão de transferência, marque a conversa
      // como pendente para que o painel indique que precisa de atendente humano.  Use
      // includes() em vez de igualdade para suportar variações de frase ou emojis.
      const transferKey = 'transferir para um atendente humano';
      if (respostaRobo && respostaRobo.toLowerCase().includes(transferKey)) {
        try {
          await supabase
            .from('messages')
            .update({ status_atendimento: 'PENDENTE' })
            .eq('numero_paciente', numeroPaciente);
        } catch (err) {
          console.error('Failed to update status after transfer phrase:', err.message);
        }
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook insert failed:', err.message);
    return res.status(500).json({ error: 'Webhook insert failed' });
  }
});

/**
 * GET /api/conversations
 * Returns a list of conversations, one per `numero_paciente`, with the most
 * recent message and its status.  This endpoint previously attempted to
 * delegate the grouping logic to Supabase, but that caused errors on
 * deployments; instead, we fetch all messages and group them here.
 */
app.get('/api/conversations', async (req, res) => {
  try {
    // Fetch all messages ordered by newest first
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Build a map of the latest message for each conversation
    const convoMap = {};
    data.forEach((msg) => {
      const key = msg.numero_paciente;
      if (!convoMap[key]) {
        // Determine the status based on the most recent message.  If
        // status_atendimento is explicitly set, use it; otherwise infer
        // from the remetente: paciente -> PENDENTE, Robô ou Atendente -> EM_ATENDIMENTO.
        let status;
        if (msg.status_atendimento) {
          status = msg.status_atendimento;
        } else {
          if (msg.remetente === 'Paciente') status = 'PENDENTE';
          else if (msg.remetente === 'Robô' || msg.remetente === 'Atendente') status = 'EM_ATENDIMENTO';
          else status = 'PENDENTE';
        }
        convoMap[key] = {
          numeroPaciente: msg.numero_paciente,
          nomePaciente: msg.nome_paciente || null,
          lastMessage: msg.mensagem_paciente || msg.resposta_robo || msg.resposta_atendente,
          statusAtendimento: status,
          lastRemetente: msg.remetente,
          updatedAt: msg.updated_at,
          instanceId: msg.instance_id
        };
      }
    });
    return res.json(Object.values(convoMap));
  } catch (err) {
    console.error('Failed to fetch conversations:', err.message);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

/**
 * GET /api/conversation/:numero/messages
 * Returns the full history for a specific conversation.
 */
app.get('/api/conversation/:numero/messages', async (req, res) => {
  const numero = req.params.numero;
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('numero_paciente', numero)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('Failed to fetch conversation:', err.message);
    return res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('API is up and running');
});

/**
 * PATCH /api/conversation/:numero/status
 * Atualiza o status de atendimento de todas as mensagens de uma conversa.  Útil
 * para marcar uma conversa como FINALIZADO ou EM_ATENDIMENTO a partir do
 * painel.  O corpo deve conter `{ statusAtendimento: '<novo_status>' }`.
 */
app.patch('/api/conversation/:numero/status', jsonParser, async (req, res) => {
  const numero = req.params.numero;
  const { statusAtendimento } = req.body;
  if (!statusAtendimento) {
    return res.status(400).json({ error: 'statusAtendimento is required' });
  }
  try {
    const { error } = await supabase
      .from('messages')
      .update({ status_atendimento: statusAtendimento })
      .eq('numero_paciente', numero);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to update status:', err.message);
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * PATCH /api/conversation/:numero/name
 * Atualiza o nome do paciente para todas as mensagens de uma conversa.  Permite
 * que um atendente associe um nome a um número existente quando ele é
 * desconhecido ou para corrigir erros.  O corpo deve conter
 * `{ nomePaciente: '<novo_nome>' }`.
 */
app.patch('/api/conversation/:numero/name', jsonParser, async (req, res) => {
  const numero = req.params.numero;
  const { nomePaciente } = req.body;
  if (!nomePaciente) {
    return res.status(400).json({ error: 'nomePaciente is required' });
  }
  try {
    const { error } = await supabase
      .from('messages')
      .update({ nome_paciente: nomePaciente })
      .eq('numero_paciente', numero);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to update name:', err.message);
    return res.status(500).json({ error: 'Failed to update name' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
