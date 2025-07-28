/*
 * supabase_server.js
 *
 * This Express server exposes a simple REST API for the SENA project using
 * Supabase as its primary data store. It manages WhatsApp instances,
 * persists messages and tokens, and provides endpoints for listing
 * conversations and sending messages. To use this server you need to set
 * the following environment variables:
 *
 *   SUPABASE_URL       – the URL of your Supabase project (e.g. https://xyz.supabase.co)
 *   SUPABASE_ANON_KEY  – the anon/public API key for your Supabase project
 *   GSWHATSAPP_NUMBER  – your default Gupshup phone number (e.g. 5521998051860)
 *   GSAPP_NAME         – name of your Gupshup app (used for the sender name)
 *
 * Optionally, you can set a token per instance by calling
 * POST /api/instance/:id/token with a JSON body like { token: "your-gupshup-api-key" }.
 * Tokens are stored in the `instances` table. Messages are stored in the
 * `messages` table.
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Environment variables and sanity checks
const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  GSWHATSAPP_NUMBER = '',
  GSAPP_NAME = '',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be provided in the environment');
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
app.use(bodyParser.json());

/**
 * Helper: get token for a given instance id.
 */
async function getInstanceToken(instanceId) {
  const { data, error } = await supabase
    .from('instances')
    .select('token')
    .eq('instance_id', instanceId)
    .single();
  if (error) {
    console.error('Supabase error fetching token:', error.message);
    return null;
  }
  return data ? data.token : null;
}

/**
 * GET /api/instances
 * List all instances with their tokens (token is omitted from the response for security).
 */
app.get('/api/instances', async (req, res) => {
  const { data, error } = await supabase.from('instances').select('instance_id, status, updated_at');
  if (error) {
    console.error('Error listing instances:', error.message);
    return res.status(500).json({ error: 'Failed to fetch instances' });
  }
  res.json(data.map(row => ({ id: row.instance_id, status: row.status, updatedAt: row.updated_at })));
});

/**
 * POST /api/instance/:id/token
 * Set or update the API token for a given instance. Body must contain { token }.
 */
app.post('/api/instance/:id/token', async (req, res) => {
  const instanceId = req.params.id;
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  try {
    // Upsert token into instances table
    const { error } = await supabase
      .from('instances')
      .upsert({ instance_id: instanceId, token, status: 'active', updated_at: new Date().toISOString() }, { onConflict: 'instance_id' });
    if (error) {
      throw error;
    }
    res.json({ message: 'Token updated' });
  } catch (err) {
    console.error('Error saving token:', err.message);
    res.status(500).json({ error: 'Failed to save token' });
  }
});

/**
 * POST /api/instance/:id/messages
 * Send a WhatsApp message via Gupshup for a given instance. Expects body with
 * { numero_paciente, texto }. Uses stored token for the instance.
 */
app.post('/api/instance/:id/messages', async (req, res) => {
  const instanceId = req.params.id;
  const { numero_paciente: numeroPaciente, texto } = req.body;
  if (!numeroPaciente || !texto) {
    return res.status(400).json({ error: 'numero_paciente and texto are required' });
  }
  const token = await getInstanceToken(instanceId);
  if (!token) {
    return res.status(400).json({ error: 'No token configured for this instance' });
  }
  try {
    // Send message via Gupshup HTTP API
    const url = 'https://api.gupshup.io/wa/api/v1/msg';
    const payload = new URLSearchParams();
    payload.append('channel', 'whatsapp');
    payload.append('source', GSWHATSAPP_NUMBER);
    payload.append('destination', numeroPaciente);
    payload.append('message', texto);
    payload.append('src.name', GSAPP_NAME);
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        apikey: token,
      },
    });
    // Persist sent message to Supabase
    await supabase.from('messages').insert([
      {
        instance_id: instanceId,
        numero_paciente: numeroPaciente,
        mensagem_paciente: null,
        resposta_robo: texto,
        resposta_atendente: null,
        remetente: 'Robô',
        status_atendimento: 'PENDENTE',
      },
    ]);
    res.json({ success: true, gupshupResponse: response.data });
  } catch (err) {
    console.error('Error sending message:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/webhook
 * Endpoint to receive incoming messages either directly from Gupshup or forwarded from Make.
 * Expects body with at least instanceId, numeroPaciente and mensagemPaciente.
 */
app.post('/api/webhook', async (req, res) => {
  // Accept both direct Gupshup payloads and proxy payloads from Make.
  const body = req.body;
  let instanceId = body.instanceId || body.payload?.app || null;
  let numeroPaciente = body.numeroPaciente || body.payload?.sender?.phone || null;
  let mensagemPaciente = body.mensagemPaciente || body.payload?.payload?.text || body.payload?.payload?.message?.text || null;
  if (!instanceId || !numeroPaciente || !mensagemPaciente) {
    console.warn('Webhook called with missing fields');
    return res.status(400).json({ error: 'Missing instanceId, numeroPaciente or mensagemPaciente' });
  }
  try {
    // Insert incoming message into Supabase
    await supabase.from('messages').insert([
      {
        instance_id: instanceId,
        numero_paciente: numeroPaciente,
        mensagem_paciente: mensagemPaciente,
        resposta_robo: null,
        resposta_atendente: null,
        remetente: 'Paciente',
        status_atendimento: 'PENDENTE',
      },
    ]);
    res.json({ received: true });
  } catch (err) {
    console.error('Error storing incoming message:', err.message);
    res.status(500).json({ error: 'Failed to store message' });
  }
});

/**
 * GET /api/conversations
 * Returns a list of unique conversations grouped by numero_paciente and instance_id.
 */
app.get('/api/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('instance_id, numero_paciente, status_atendimento, MAX(updated_at) as last_updated')
      .group('instance_id, numero_paciente, status_atendimento');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error listing conversations:', err.message);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

/**
 * POST /api/conversas
 * Cria uma nova conversa vazia. Aceita { numeroPaciente, nomePaciente, texto } e grava um registro
 * na tabela messages com status PENDENTE. Este endpoint é mantido por compatibilidade com o painel
 * anterior, onde a criação de conversa não envia mensagem imediatamente.
 */
app.post('/api/conversas', async (req, res) => {
  const { numeroPaciente, nomePaciente, texto } = req.body;
  if (!numeroPaciente) {
    return res.status(400).json({ error: 'numeroPaciente is required' });
  }
  try {
    await supabase.from('messages').insert([
      {
        instance_id: null,
        numero_paciente: numeroPaciente,
        mensagem_paciente: texto || null,
        resposta_robo: null,
        resposta_atendente: null,
        remetente: nomePaciente || 'Paciente',
        status_atendimento: 'PENDENTE',
      },
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error creating conversation:', err.message);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

/**
 * GET /api/conversation/:numero_paciente/messages
 * Fetch messages for a given numero_paciente across all instances or filtered by instance query param.
 */
app.get('/api/conversation/:numero_paciente/messages', async (req, res) => {
  const numeroPaciente = req.params.numero_paciente;
  const { instanceId } = req.query;
  try {
    let query = supabase
      .from('messages')
      .select('*')
      .eq('numero_paciente', numeroPaciente)
      .order('created_at', { ascending: true });
    if (instanceId) query = query.eq('instance_id', instanceId);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error fetching conversation messages:', err.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Start the server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Supabase-based server listening on port ${PORT}`);
});
