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

// ---------- Utils ----------
function normaliseString(str = '') {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]/g, '');
}

// Garante número só com dígitos (ex.: 55DDDNUMERO)
function normalizePhone(p) {
  return String(p || '').replace(/[^\d]/g, '');
}

// Envia MENSAGEM DE SESSÃO (texto) via Gupshup (form-urlencoded + message em JSON)
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

  if (res.status >= 400) {
    console.error('Gupshup ERROR', res.status, res.data);
  } else {
    console.log('Gupshup OK', res.status, typeof res.data === 'string' ? res.data.slice(0, 200) : res.data);
  }

  // Sinaliza janela de 24h estourada (mensagem típica da API)
  const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
  if (res.status === 400 && /24h|24 h|24 hours|session/i.test(bodyStr)) {
    throw new Error('Fora da janela de 24h: use template.');
  }

  return res;
}

// ---------- Supabase helpers ----------
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

const instanceTokens = {};

async function preloadTokens() {
  try {
    // Mantém compatível com seu schema atual (id_da_instancia)
    const { data } = await supabase.from('instances').select('id_da_instancia, token');
    if (data) {
      data.forEach((row) => {
        if (row.token) instanceTokens[row.id_da_instancia] = row.token;
      });
    }
  } catch (err) {
    console.error('Failed to preload tokens:', err.message);
  }
}

preloadTokens();

// ---------- API ----------
app.get('/api/instances', async (req, res) => {
  const count = Number(process.env.INSTANCE_COUNT || 8);
  const list = [];
  for (let i = 0; i < count; i++) {
    const key = String(i);
    const token = instanceTokens[key] || null;
    const hasToken = !!token;
    list.push({ id: key, token: hasToken, hasToken: hasToken, online: hasToken });
  }
  return res.json(list);
});

app.post('/api/instance/:id/token', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  const updates = {
    id_da_instancia: String(instanceId),
    token: token,
    status: 'active',
    updated_at: new Date().toISOString(),
  };
  try {
    await supabase.from('instances').upsert(updates, { onConflict: 'id_da_instancia' });
    instanceTokens[String(instanceId)] = token;
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to save token:', err.message);
    return res.status(500).json({ error: 'Failed to save token' });
  }
});

// ---------------- HUMANO → WHATSAPP ----------------
app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body;
  const phone = normalizePhone(numeroPaciente || numero_paciente);
  const patientName = nomePaciente || nome_paciente || null;
  if (!phone || !texto) return res.status(400).json({ error: 'numeroPaciente and texto are required' });

  let token = instanceTokens[String(instanceId)];
  if (!token) {
    try {
      const { data } = await supabase
        .from('instances')
        .select('token')
        .eq('id_da_instancia', String(instanceId))
        .single();
      token = data ? data.token : null;
      if (token) instanceTokens[String(instanceId)] = token;
    } catch {
      token = null;
    }
  }

  if (token) {
    try {
      await sendWhatsAppSessionMessage({
        token,
        source: process.env.GSWHATSAPP_NUMBER,
        destination: phone,
        text: texto,
      });
    } catch (err) {
      console.error('Failed to send message via Gupshup:', err.message);
      // Se quiser sinalizar pro painel que precisa template:
      // return res.status(409).json({ error: 'window_24h', detail: err.message });
    }
  } else {
    console.error('No token for instance', instanceId);
  }

  try {
    await supabase.from('messages').insert({
      instance_id: String(instanceId),
      numero_paciente: phone,
      nome_paciente: patientName,
      mensagem_paciente: null,
      resposta_robo: null,
      resposta_atendente: texto,
      remetente: 'Atendente',
      status_atendimento: 'EM_ATENDIMENTO (HUMANO)',
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to insert attendant message:', err.message);
    return res.status(500).json({ error: 'Failed to save message' });
  }
});

// (Opcional) endpoint direto para envio do atendente (sem amarrar a instance via URL)
app.post('/api/agent/reply', jsonParser, async (req, res) => {
  const { chatId, text, instanceId, nomePaciente } = req.body;
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text are required' });
  const phone = normalizePhone(chatId);

  let token = null;
  if (instanceId != null) {
    token = instanceTokens[String(instanceId)];
    if (!token) {
      const { data } = await supabase.from('instances').select('token').eq('id_da_instancia', String(instanceId)).single();
      token = data ? data.token : null;
      if (token) instanceTokens[String(instanceId)] = token;
    }
  } else {
    // fallback: tenta pegar a última instance usada pelo número
    const { data } = await supabase
      .from('messages')
      .select('instance_id')
      .eq('numero_paciente', phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastInstanceId = data?.instance_id || '0';
    token = instanceTokens[String(lastInstanceId)];
    if (!token) {
      const { data: inst } = await supabase.from('instances').select('token').eq('id_da_instancia', String(lastInstanceId)).single();
      token = inst ? inst.token : null;
      if (token) instanceTokens[String(lastInstanceId)] = token;
    }
  }

  if (token) {
    try {
      await sendWhatsAppSessionMessage({
        token,
        source: process.env.GSWHATSAPP_NUMBER,
        destination: phone,
        text,
      });
    } catch (err) {
      console.error('Failed to send message via Gupshup:', err.message);
    }
  }

  try {
    await supabase.from('messages').insert({
      instance_id: String(instanceId || '0'),
      numero_paciente: phone,
      nome_paciente: nomePaciente || null,
      mensagem_paciente: null,
      resposta_robo: null,
      resposta_atendente: text,
      remetente: 'Atendente',
      status_atendimento: 'EM_ATENDIMENTO (HUMANO)',
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to log agent reply:', err.message);
    return res.status(500).json({ error: 'Failed to log agent reply' });
  }
});

// ---------------- WEBHOOK (Make/Gupshup) ----------------
// Webhook com JSON.parse manual (evita erro na 2ª ou 3ª mensagem)
app.post('/api/webhook', rawBodyParser, urlencodedParser, async (req, res) => {
  let body;
  try {
    // Limpa caracteres de controle antes do parse
    const cleaned = String(req.body || '').replace(/[\u0000-\u001F\u007F]/g, '');
    body = JSON.parse(cleaned);
  } catch (e) {
    console.error('❌ JSON malformado:', e.message);
    return res.status(400).json({ error: 'JSON malformado' });
  }

  try {
    const instanceId = body.instanceId || '0';
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

    // Se última foi do atendente, mantemos PENDENTE (fila humana)
    let patientStatus;
    if (lastStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente') || lastStatus === 'EM_ATENDIMENTO (HUMANO)') {
      patientStatus = 'PENDENTE';
    } else if (lastStatus === 'FINALIZADO') {
      patientStatus = 'FINALIZADO';
    } else {
      patientStatus = 'EM_ATENDIMENTO';
    }

    // 1) Loga mensagem do Paciente
    await supabase.from('messages').insert({
      instance_id: String(instanceId),
      numero_paciente: numeroPaciente,
      nome_paciente: patientName,
      mensagem_paciente: mensagemPaciente,
      resposta_robo: null,
      resposta_atendente: null,
      remetente: 'Paciente',
      status_atendimento: patientStatus,
    });

    // 2) Se tiver resposta do robô, avalia se pode gravar / atualizar status
    if (respostaRobo) {
      const normalized = normaliseString(respostaRobo);
      const transferKey = 'transferir para um atendente humano';

      // Se já está PENDENTE ou FINALIZADO, não grava resposta do robô (desliga robô)
      if (patientStatus === 'PENDENTE' || patientStatus === 'FINALIZADO') {
        console.log('Robô suprimido (status atual impede resposta).');
        return res.json({ received: true, suppressed: true });
      }

      const respostaData = {
        instance_id: String(instanceId),
        numero_paciente: numeroPaciente,
        nome_paciente: patientName,
        mensagem_paciente: null,
        resposta_robo: respostaRobo,
        resposta_atendente: null,
        remetente: 'Robô',
        status_atendimento: 'EM_ATENDIMENTO',
      };

      await supabase.from('messages').insert(respostaData);

      // Detecta transferência e põe PENDENTE em todas as mensagens desse número
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

// ---------------- Consultas/Operações de Conversa ----------------
// Lista de conversas agrupadas por número
app.get('/api/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const convoMap = {};
    data.forEach((msg) => {
      const key = msg.numero_paciente;
      if (!convoMap[key]) {
        let status = msg.status_atendimento || (msg.remetente === 'Paciente' ? 'PENDENTE' : 'EM_ATENDIMENTO');
        if (msg.remetente === 'Robô' && msg.resposta_robo) {
          const normalized = normaliseString(msg.resposta_robo);
          if (normalized.includes('transferir para um atendente humano')) status = 'PENDENTE';
        }
        // Ajuste de rotulagem
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

// Histórico de mensagens de um número
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

// Atualiza status de uma conversa (Finalizar ou reabrir)
app.patch('/api/conversation/:numero/status', jsonParser, async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const { statusAtendimento } = req.body;
  if (!statusAtendimento) return res.status(400).json({ error: 'statusAtendimento is required' });

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
  if (!nomePaciente) return res.status(400).json({ error: 'nomePaciente is required' });

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

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
