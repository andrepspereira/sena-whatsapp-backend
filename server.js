const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Versão 4 do servidor SENA. Além de normalizar o texto da resposta do robô e
// corrigir a exibição de status na lista de conversas, esta versão
// desativa o robô após uma transferência para atendente humano.  Se a
// conversa estiver com status PENDENTE ou FINALIZADO, qualquer
// `respostaRobo` recebida será ignorada (não inserida nem enviada ao
// paciente).  Também adiciona um campo `online` no endpoint
// `/api/instances` para que o painel saiba se uma instância possui
// token ativo.

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const instanceTokens = {};

async function upsertInstance(id, token) {
  const updates = {
    id_da_instancia: String(id),
    token: token ?? null,
    status: 'active',
    updated_at: new Date().toISOString(),
  };
  await supabase.from('instances').upsert(updates, { onConflict: 'id_da_instancia' });
  if (token) instanceTokens[id] = token;
}

(async () => {
  const { data, error } = await supabase.from('instances').select('id_da_instancia, token');
  if (!error) {
    data.forEach((row) => {
      if (row.token) instanceTokens[row.id_da_instancia] = row.token;
    });
  }
})();

function normaliseString(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]/g, '');
}

// Helper to get the current status of a conversation
async function getCurrentStatus(numeroPaciente) {
  const { data, error } = await supabase
    .from('messages')
    .select('status_atendimento')
    .eq('numero_paciente', numeroPaciente)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].status_atendimento;
}

app.get('/api/instances', async (req, res) => {
  const count = Number(process.env.INSTANCE_COUNT || 8);
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push({ id: String(i), hasToken: !!instanceTokens[i], online: !!instanceTokens[i] });
  }
  return res.json(list);
});

app.post('/api/instance/:id/token', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  await upsertInstance(instanceId, token);
  return res.json({ success: true });
});

app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body;
  const phone = numeroPaciente || numero_paciente;
  const patientName = nomePaciente || nome_paciente || null;
  if (!phone || !texto) return res.status(400).json({ error: 'numeroPaciente and texto are required' });
  const token = instanceTokens[instanceId];
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
});

app.post('/api/webhook', jsonParser, urlencodedParser, async (req, res) => {
  try {
    const body = req.body || {};
    const instanceId = body.instanceId || '0';
    const numeroPaciente = body.numeroPaciente;
    const mensagemPaciente = body.mensagemPaciente;
    const respostaRobo = body.respostaRobo || null;
    const patientName = body.nomePaciente || body.nome_paciente || null;
    if (!numeroPaciente || !mensagemPaciente) return res.status(400).json({ error: 'Missing numeroPaciente or mensagemPaciente' });
    // Always record the patient's message
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
    // Before recording the robot response, check current status.  If
    // status is PENDENTE or FINALIZADO, we should ignore the robot
    // response to prevent reactivating the bot.
    if (respostaRobo) {
      const currentStatus = await getCurrentStatus(numeroPaciente);
      if (currentStatus === 'PENDENTE' || currentStatus === 'FINALIZADO') {
        // Skip inserting robot response entirely to prevent bot reactivation
        return res.json({ received: true, ignored: true });
      }
      // Otherwise insert the robot response
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
        await supabase.from('messages').update({ status_atendimento: 'PENDENTE' }).eq('numero_paciente', numeroPaciente);
      }
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook insert failed:', err.message);
    return res.status(500).json({ error: 'Webhook insert failed' });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const convoMap = {};
    data.forEach((msg) => {
      const key = msg.numero_paciente;
      if (!convoMap[key]) {
        let status;
        if (msg.status_atendimento) status = msg.status_atendimento;
        else status = msg.remetente === 'Paciente' ? 'PENDENTE' : 'EM_ATENDIMENTO';
        // Override to PENDENTE if robot text includes transfer phrase
        if (msg.remetente === 'Robô' && msg.resposta_robo) {
          const normalized = normaliseString(msg.resposta_robo);
          if (normalized.includes('transferir para um atendente humano')) status = 'PENDENTE';
        }
        // Derive lastRemetente consistent with status
        let lastRemetente = msg.remetente;
        if (status === 'PENDENTE') lastRemetente = 'Paciente';
        else if (status === 'FINALIZADO') lastRemetente = 'Finalizado';
        convoMap[key] = {
          numeroPaciente: msg.numero_paciente,
          nomePaciente: msg.nome_paciente || null,
          lastMessage: msg.mensagem_paciente || msg.resposta_robo || msg.resposta_atendente,
          statusAtendimento: status,
          lastRemetente: lastRemetente,
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

app.get('/api/conversation/:numero/messages', async (req, res) => {
  const numero = req.params.numero;
  const { data, error } = await supabase.from('messages').select('*').eq('numero_paciente', numero).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to fetch conversation' });
  return res.json(data);
});

app.patch('/api/conversation/:numero/status', jsonParser, async (req, res) => {
  const numero = req.params.numero;
  const { statusAtendimento } = req.body;
  if (!statusAtendimento) return res.status(400).json({ error: 'statusAtendimento is required' });
  const { error } = await supabase.from('messages').update({ status_atendimento: statusAtendimento }).eq('numero_paciente', numero);
  if (error) return res.status(500).json({ error: 'Failed to update status' });
  return res.json({ success: true });
});

app.patch('/api/conversation/:numero/name', jsonParser, async (req, res) => {
  const numero = req.params.numero;
  const { nomePaciente } = req.body;
  if (!nomePaciente) return res.status(400).json({ error: 'nomePaciente is required' });
  const { error } = await supabase.from('messages').update({ nome_paciente: nomePaciente }).eq('numero_paciente', numero);
  if (error) return res.status(500).json({ error: 'Failed to update name' });
  return res.json({ success: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
