const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
const rawBodyParser = bodyParser.text({ type: 'application/json' });
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ============================== Utils ============================== */
function normaliseString(str = '') {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]/g, '');
}
function normalizePhone(p) {
  return String(p || '').replace(/[^\d]/g, '');
}
function envSourceForInstance(id) {
  const k = `GSWHATSAPP_NUMBER_${String(id)}`;
  return process.env[k] || process.env.GSWHATSAPP_NUMBER || '';
}

// Gupshup: mensagem de sessão (texto) — form-urlencoded + message em JSON
async function sendWhatsAppSessionMessage({ token, source, destination, text }) {
  const body = new URLSearchParams();
  body.append('channel', 'whatsapp');
  body.append('source', normalizePhone(source));
  body.append('destination', normalizePhone(destination));
  body.append('message', JSON.stringify({ type: 'text', text }));
  body.append('src.name', process.env.GSAPP_NAME || 'SENA');

  const res = await axios.post('https://api.gupshup.io/wa/api/v1/msg', body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apikey: token,
      'cache-control': 'no-cache',
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
  if (res.status >= 400) console.error('Gupshup ERROR', res.status, bodyStr);
  else console.log('Gupshup OK', res.status, bodyStr.slice(0, 200));

  return res;
}

/* ==================== Supabase helpers & cache ===================== */
async function getLastMessageInfo(numeroPaciente) {
  const { data } = await supabase
    .from('messages')
    .select('status_atendimento, remetente')
    .eq('numero_paciente', numeroPaciente)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return { status_atendimento: null, remetente: null };
  return data[0];
}

// cache por instância: token + source_number
const instanceMeta = {}; // { [id]: { token, source_number } }

async function preloadInstances() {
  try {
    // se não tiver source_number na tabela, tudo bem; cairemos nas ENVs
    const { data } = await supabase.from('instances').select('id_da_instancia, token, source_number');
    if (data) {
      data.forEach((row) => {
        const id = String(row.id_da_instancia);
        instanceMeta[id] = {
          token: row.token || null,
          source_number: row.source_number || envSourceForInstance(id),
        };
      });
    }
  } catch (err) {
    console.error('Failed to preload instances:', err.message);
  }
}
preloadInstances();

/* ============================== API =============================== */
// Ver instâncias/tokens/sources
app.get('/api/instances', async (req, res) => {
  const count = Number(process.env.INSTANCE_COUNT || 8);
  const list = [];
  for (let i = 0; i < count; i++) {
    const key = String(i);
    const meta = instanceMeta[key] || {};
    const hasToken = !!meta.token;
    list.push({
      id: key,
      token: hasToken,
      hasToken,
      online: hasToken,
      source: meta.source_number || envSourceForInstance(key) || null,
    });
  }
  return res.json(list);
});

// Salvar token (e opcionalmente source_number) da instância
app.post('/api/instance/:id/token', jsonParser, async (req, res) => {
  const instanceId = String(req.params.id);
  const { token, source_number } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const updates = {
    id_da_instancia: instanceId,
    token,
    source_number: source_number || null,
    status: 'active',
    updated_at: new Date().toISOString(),
  };
  try {
    await supabase.from('instances').upsert(updates, { onConflict: 'id_da_instancia' });
    instanceMeta[instanceId] = {
      token,
      source_number: source_number || envSourceForInstance(instanceId),
    };
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to upsert token:', err.message);
    return res.status(500).json({ error: 'Failed to save token' });
  }
});

/* ======================= HUMANO → WHATSAPP ======================== */
app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = String(req.params.id);
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body;
  const phone = normalizePhone(numeroPaciente || numero_paciente);
  const patientName = nomePaciente || nome_paciente || null;
  if (!phone || !texto) return res.status(400).json({ error: 'numeroPaciente and texto are required' });

  // meta da instância
  let meta = instanceMeta[instanceId];
  if (!meta) {
    const { data } = await supabase
      .from('instances')
      .select('token, source_number')
      .eq('id_da_instancia', instanceId)
      .single();
    meta = instanceMeta[instanceId] = {
      token: data?.token || null,
      source_number: data?.source_number || envSourceForInstance(instanceId),
    };
  }

  // Envia mensagem do humano
  if (meta.token && (meta.source_number || envSourceForInstance(instanceId))) {
    try {
      await sendWhatsAppSessionMessage({
        token: meta.token,
        source: meta.source_number || envSourceForInstance(instanceId),
        destination: phone,
        text: texto,
      });
    } catch (err) {
      console.error('Failed to send message via Gupshup:', err.message);
      // se precisar sinalizar para a UI: return res.status(502).json({ error: 'gupshup_fail', detail: err.message });
    }
  } else {
    console.error('Missing token/source for instance', instanceId, meta);
  }

  // Loga no banco — status padronizado
  try {
    await supabase.from('messages').insert({
      instance_id: instanceId,
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
    console.error('Failed to insert attendant message:', err.message);
    return res.status(500).json({ error: 'Failed to save message' });
  }
});

// (Opcional) endpoint direto pro painel
app.post('/api/agent/reply', jsonParser, async (req, res) => {
  const { chatId, text, instanceId, nomePaciente } = req.body;
  const phone = normalizePhone(chatId);
  if (!phone || !text) return res.status(400).json({ error: 'chatId and text are required' });

  const iid = String(instanceId || '0');
  let meta = instanceMeta[iid];
  if (!meta) {
    const { data } = await supabase.from('instances').select('token, source_number').eq('id_da_instancia', iid).single();
    meta = instanceMeta[iid] = {
      token: data?.token || null,
      source_number: data?.source_number || envSourceForInstance(iid),
    };
  }

  if (meta.token) {
    try {
      await sendWhatsAppSessionMessage({
        token: meta.token,
        source: meta.source_number || envSourceForInstance(iid),
        destination: phone,
        text,
      });
    } catch (err) {
      console.error('Failed to send message via Gupshup:', err.message);
    }
  }

  try {
    await supabase.from('messages').insert({
      instance_id: iid,
      numero_paciente: phone,
      nome_paciente: nomePaciente || null,
      mensagem_paciente: null,
      resposta_robo: null,
      resposta_atendente: text,
      remetente: 'Atendente',
      status_atendimento: 'EM_ATENDIMENTO',
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to log agent reply:', err.message);
    return res.status(500).json({ error: 'Failed to log agent reply' });
  }
});

/* ============================ WEBHOOK ============================== */
// Recebe do Make/Gupshup
app.post('/api/webhook', rawBodyParser, urlencodedParser, async (req, res) => {
  let body;
  try {
    const cleaned = String(req.body || '').replace(/[\u0000-\u001F\u007F]/g, '');
    body = JSON.parse(cleaned);
  } catch (e) {
    console.error('❌ JSON malformado:', e.message);
    return res.status(400).json({ error: 'JSON malformado' });
  }

  try {
    const instanceId = String(body.instanceId || '0');
    const numeroPaciente = normalizePhone(body.numeroPaciente);
    const mensagemPaciente = body.mensagemPaciente;
    const respostaRobo = body.respostaRobo || null;
    const patientName = body.nomePaciente || body.nome_paciente || null;

    if (!numeroPaciente || !mensagemPaciente) {
      return res.status(400).json({ error: 'Missing numeroPaciente or mensagemPaciente' });
    }

    // Último status
    const lastInfo = await getLastMessageInfo(numeroPaciente);
    const lastStatus = lastInfo.status_atendimento;
    const lastRemetente = lastInfo.remetente;

    // Define status desta mensagem do paciente
    let patientStatus;
    if (lastStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente')) {
      patientStatus = 'PENDENTE';
    } else if (lastStatus === 'FINALIZADO') {
      patientStatus = 'FINALIZADO';
    } else {
      patientStatus = 'EM_ATENDIMENTO';
    }

    // 1) Grava mensagem do paciente
    await supabase.from('messages').insert({
      instance_id: instanceId,
      numero_paciente: numeroPaciente,
      nome_paciente: patientName,
      mensagem_paciente: mensagemPaciente,
      resposta_robo: null,
      resposta_atendente: null,
      remetente: 'Paciente',
      status_atendimento: patientStatus,
    });

    // 2) Grava resposta do robô (se houver) — respeitando status
    if (respostaRobo) {
      const normalized = normaliseString(respostaRobo);
      const transferKey = 'transferir para um atendente humano';

      // Se já está PENDENTE/FINALIZADO → não grava resposta do robô
      if (patientStatus === 'PENDENTE' || patientStatus === 'FINALIZADO') {
        console.log('Robô suprimido (status impede resposta).');
        return res.json({ received: true, suppressed: true });
      }

      await supabase.from('messages').insert({
        instance_id: instanceId,
        numero_paciente: numeroPaciente,
        nome_paciente: patientName,
        mensagem_paciente: null,
        resposta_robo: respostaRobo,
        resposta_atendente: null,
        remetente: 'Robô',
        status_atendimento: 'EM_ATENDIMENTO',
      });

      // Detecta transferência pela frase e marca PENDENTE
      if (normalized.includes(transferKey)) {
        await supabase
          .from('messages')
          .update({ status_atendimento: 'PENDENTE' })
          .eq('numero_paciente', numeroPaciente);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook insert failed:', err.message);
    return res.status(500).json({ error: 'Webhook insert failed' });
  }
});

/* =================== Consultas para o painel/UI =================== */
// Lista de conversas (uma por número) — com base NA ÚLTIMA mensagem real
app.get('/api/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const byNumero = new Map();
    for (const msg of data) {
      const key = msg.numero_paciente;
      const prev = byNumero.get(key);
      if (!prev || new Date(msg.created_at) > new Date(prev.created_at)) {
        byNumero.set(key, msg);
      }
    }

    const list = [];
    for (const [numero, msg] of byNumero.entries()) {
      let status = msg.status_atendimento || 'EM_ATENDIMENTO';
      // se a última foi do robô e contém frase de transferência → PENDENTE
      if (msg.remetente === 'Robô' && msg.resposta_robo) {
        const normalized = normaliseString(msg.resposta_robo);
        if (normalized.includes('transferir para um atendente humano')) status = 'PENDENTE';
      }
      list.push({
        numeroPaciente: numero,
        nomePaciente: msg.nome_paciente || null,
        lastMessage: msg.mensagem_paciente || msg.resposta_robo || msg.resposta_atendente,
        statusAtendimento: status,
        lastRemetente: msg.remetente, // quem realmente enviou por último
        updatedAt: msg.updated_at,
        instanceId: msg.instance_id,
      });
    }

    // ordena desc por updatedAt
    list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return res.json(list);
  } catch (err) {
    console.error('Failed to fetch conversations:', err.message);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Histórico completo de um número
app.get('/api/conversation/:numero/messages', async (req, res) => {
  const numero = normalizePhone(req.params.numero);
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

// Atualiza status (Finalizar/Reabrir)
app.patch('/api/conversation/:numero/status', jsonParser, async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const { statusAtendimento } = req.body;
  if (!statusAtendimento)
    return res.status(400).json({ error: 'statusAtendimento is required' });

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

// Atualiza nome do paciente
app.patch('/api/conversation/:numero/name', jsonParser, async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const { nomePaciente } = req.body;
  if (!nomePaciente)
    return res.status(400).json({ error: 'nomePaciente is required' });

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

/* ============================== Start ============================== */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
