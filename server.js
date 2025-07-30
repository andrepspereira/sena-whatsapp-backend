const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// This is an updated version of the SENA backend that improves the
// handling of "transferir para um atendente humano" messages.  In
// addition to detecting the transfer phrase at insertion time (see
// `/api/webhook`), this version also inspects the most recent robot
// message when summarising conversations.  If a robot message
// contains the transfer phrase, the conversation status is forced to
// `PENDENTE` so that the front‑end displays the correct badge even
// when upstream automation does not send `respostaRobo`.

// Initialise Supabase client using environment variables.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

// CORS setup
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// In-memory token cache
const instanceTokens = {};

async function upsertInstance(id, token) {
  try {
    const updates = {
      id_da_instancia: String(id),
      token: token ?? null,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    await supabase.from('instances').upsert(updates, { onConflict: 'id_da_instancia' });
    if (token) instanceTokens[id] = token;
  } catch (err) {
    console.error('Failed to upsert instance token:', err.message);
  }
}

// Preload tokens on startup
(async () => {
  try {
    const { data, error } = await supabase.from('instances').select('id_da_instancia, token');
    if (error) throw error;
    data.forEach((row) => {
      if (row.token) instanceTokens[row.id_da_instancia] = row.token;
    });
    console.log('Loaded instance tokens from Supabase');
  } catch (err) {
    console.warn('Could not preload instance tokens:', err.message);
  }
})();

/**
 * Utility that normalises a string by lowering case and stripping
 * diacritics.  This helps us detect key phrases regardless of
 * accents or punctuation.
 */
function normaliseString(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]/g, '');
}

/**
 * GET /api/instances
 * Returns a list of instances and whether they have a token registered.
 */
app.get('/api/instances', async (req, res) => {
  try {
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
 */
app.post('/api/instance/:id/token', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
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
 */
app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body;
  const phone = numeroPaciente || numero_paciente;
  const patientName = nomePaciente || nome_paciente || null;
  if (!phone || !texto) return res.status(400).json({ error: 'numeroPaciente and texto are required' });
  const token = instanceTokens[instanceId];
  try {
    if (token) {
      try {
        await axios.post('https://api.gupshup.io/wa/api/v1/msg', null, {
          params: {
            channel: 'whatsapp',
            source: process.env.GSWHATSAPP_NUMBER,
            destination: phone,
            message: texto,
            'src.name': process.env.GSAPP_NAME,
          },
          headers: { apikey: token },
        });
      } catch (err) {
        console.error('Failed to send message via Gupshup:', err.message);
      }
    }
    await supabase.from('messages').insert({
      instance_id: String(instanceId),
      numero_paciente: phone,
      nome_paciente: patientName,
      mensagem_paciente: null,
      resposta_robo: null,
      resposta_atendente: texto,
      remetente: 'Atendente',
      status_atendimento: 'EM_ATENDIMENTO',
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to send message:', err.message);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/webhook
 * Handles incoming messages from Gupshup or Make.  It records both
 * patient messages and robot responses.  When a robot response
 * indicates transfer, all messages for that conversation are
 * updated to `PENDENTE`.
 */
app.post('/api/webhook', jsonParser, urlencodedParser, async (req, res) => {
  try {
    const body = req.body || {};
    const instanceId = body.instanceId || '0';
    const numeroPaciente = body.numeroPaciente;
    const mensagemPaciente = body.mensagemPaciente;
    const respostaRobo = body.respostaRobo || null;
    const remetente = body.remetente || 'Paciente';
    const patientName = body.nomePaciente || body.nome_paciente || null;
    if (!numeroPaciente || !mensagemPaciente) return res.status(400).json({ error: 'Missing numeroPaciente or mensagemPaciente' });
    await supabase.from('messages').insert({
      instance_id: String(instanceId),
      numero_paciente: numeroPaciente,
      nome_paciente: patientName,
      mensagem_paciente: mensagemPaciente,
      resposta_robo: null,
      resposta_atendente: null,
      remetente: 'Paciente',
      status_atendimento: 'PENDENTE',
    });
    if (respostaRobo) {
      await supabase.from('messages').insert({
        instance_id: String(instanceId),
        numero_paciente: numeroPaciente,
        nome_paciente: patientName,
        mensagem_paciente: null,
        resposta_robo: respostaRobo,
        resposta_atendente: null,
        remetente: 'Robô',
        status_atendimento: 'EM_ATENDIMENTO',
      });
      const normalized = normaliseString(respostaRobo);
      const transferKey = 'transferir para um atendente humano';
      if (normalized.includes(transferKey)) {
        try {
          await supabase.from('messages').update({ status_atendimento: 'PENDENTE' }).eq('numero_paciente', numeroPaciente);
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
 * Returns summaries of conversations.  When the most recent robot
 * message contains the transfer phrase, the status is forced to
 * `PENDENTE` regardless of the stored status or remetente.
 */
app.get('/api/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const convoMap = {};
    data.forEach((msg) => {
      const key = msg.numero_paciente;
      if (!convoMap[key]) {
        // Default status from stored value or inferred from remetente
        let status;
        if (msg.status_atendimento) status = msg.status_atendimento;
        else status = msg.remetente === 'Paciente' ? 'PENDENTE' : 'EM_ATENDIMENTO';
        // Detect transfer phrase on robot messages; override status to PENDENTE
        if (msg.remetente === 'Robô' && msg.resposta_robo) {
          const normalized = normaliseString(msg.resposta_robo);
          const transferKey = 'transferir para um atendente humano';
          if (normalized.includes(transferKey)) status = 'PENDENTE';
        }
        convoMap[key] = {
          numeroPaciente: msg.numero_paciente,
          nomePaciente: msg.nome_paciente || null,
          lastMessage: msg.mensagem_paciente || msg.resposta_robo || msg.resposta_atendente,
          statusAtendimento: status,
          lastRemetente: msg.remetente,
          updatedAt: msg.updated_at,
          instanceId: msg.instance_id,
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
 */
app.get('/api/conversation/:numero/messages', async (req, res) => {
  const numero = req.params.numero;
  try {
    const { data, error } = await supabase.from('messages').select('*').eq('numero_paciente', numero).order('created_at', { ascending: true });
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('Failed to fetch conversation:', err.message);
    return res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

/**
 * PATCH /api/conversation/:numero/status
 */
app.patch('/api/conversation/:numero/status', jsonParser, async (req, res) => {
  const numero = req.params.numero;
  const { statusAtendimento } = req.body;
  if (!statusAtendimento) return res.status(400).json({ error: 'statusAtendimento is required' });
  try {
    const { error } = await supabase.from('messages').update({ status_atendimento: statusAtendimento }).eq('numero_paciente', numero);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to update status:', err.message);
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * PATCH /api/conversation/:numero/name
 */
app.patch('/api/conversation/:numero/name', jsonParser, async (req, res) => {
  const numero = req.params.numero;
  const { nomePaciente } = req.body;
  if (!nomePaciente) return res.status(400).json({ error: 'nomePaciente is required' });
  try {
    const { error } = await supabase.from('messages').update({ nome_paciente: nomePaciente }).eq('numero_paciente', numero);
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
