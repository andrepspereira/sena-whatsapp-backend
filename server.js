// server.js COMPLETO com simulação de insert no webhook e todas as rotas do backend SENA

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();

const jsonParser = bodyParser.json({ strict: false });
const urlencodedParser = bodyParser.urlencoded({ extended: true });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function normaliseString(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!?]/g, '');
}

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
    console.error('Failed to upsert token:', err.message);
    return res.status(500).json({ error: 'Failed to save token' });
  }
});

app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body;
  const phone = numeroPaciente || numero_paciente;
  const patientName = nomePaciente || nome_paciente || null;
  if (!phone || !texto) return res.status(400).json({ error: 'numeroPaciente and texto are required' });
  let token = instanceTokens[String(instanceId)];
  if (!token) {
    try {
      const { data } = await supabase.from('instances').select('token').eq('id_da_instancia', String(instanceId)).single();
      token = data ? data.token : null;
      if (token) instanceTokens[String(instanceId)] = token;
    } catch {
      token = null;
    }
  }
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
  try {
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
    console.error('Failed to insert attendant message:', err.message);
    return res.status(500).json({ error: 'Failed to save message' });
  }
});

app.post('/api/webhook', jsonParser, urlencodedParser, async (req, res) => {
  console.log('📡 Requisição recebida em /api/webhook');

  try {
    const body = req.body || {};
    const instanceId = body.instanceId || '0';
    const numeroPaciente = body.numeroPaciente;
    const mensagemPaciente = body.mensagemPaciente;
    let respostaRobo = body.respostaRobo || null;
    const patientName = body.nomePaciente || body.nome_paciente || null;

    console.log('📥 Dados recebidos:');
    console.log({ instanceId, numeroPaciente, patientName, mensagemPaciente, respostaRobo });

    if (!numeroPaciente || !mensagemPaciente) return res.status(400).json({ error: 'Missing numeroPaciente or mensagemPaciente' });

    if (typeof respostaRobo !== 'string') {
      try {
        if (typeof respostaRobo === 'object' && respostaRobo !== null) {
          respostaRobo = respostaRobo.text || JSON.stringify(respostaRobo);
        } else {
          respostaRobo = String(respostaRobo);
        }
      } catch (e) {
        respostaRobo = '[ERRO AO CONVERTER RESPOSTA]';
      }
    }

    const lastInfo = await getLastMessageInfo(numeroPaciente);
    const lastStatus = lastInfo.status_atendimento;
    const lastRemetente = lastInfo.remetente;

    console.log('🔍 Último status analisado:');
    console.log({ lastStatus, lastRemetente });

    let patientStatus;
    if (lastStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente')) {
      patientStatus = 'PENDENTE';
    } else {
      patientStatus = 'EM_ATENDIMENTO';
    }

    const insertPaciente = {
      instance_id: String(instanceId),
      numero_paciente: numeroPaciente,
      nome_paciente: patientName,
      mensagem_paciente: mensagemPaciente,
      resposta_robo: null,
      resposta_atendente: null,
      remetente: 'Paciente',
      status_atendimento: patientStatus,
    };

    console.log('📝 Simulando insert da mensagem do paciente:');
    console.log(insertPaciente);
    // await supabase.from('messages').insert(insertPaciente);

    const normalized = normaliseString(respostaRobo);
    const transferKey = 'transferir para um atendente humano';
    const skipRobot = patientStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente');

    console.log('🧠 Decisão de resposta IA:');
    console.log({ skipRobot, patientStatus, respostaRobo });

    if (respostaRobo) {
      const respostaData = {
        instance_id: String(instanceId),
        numero_paciente: numeroPaciente,
        nome_paciente: patientName,
        mensagem_paciente: null,
        resposta_robo: respostaRobo,
        resposta_atendente: null,
        remetente: 'Robô',
        status_atendimento: skipRobot ? 'PENDENTE' : 'EM_ATENDIMENTO',
      };

      console.log('📝 Simulando insert da resposta da IA:');
      console.log(respostaData);
      // await supabase.from('messages').insert(respostaData);

      if (!skipRobot && normalized.includes(transferKey)) {
        console.log('🔁 Simulando update de status para PENDENTE');
        // await supabase.from('messages').update({ status_atendimento: 'PENDENTE' }).eq('numero_paciente', numeroPaciente);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Erro no webhook:', err.message);
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
        let status = msg.status_atendimento || (msg.remetente === 'Paciente' ? 'PENDENTE' : 'EM_ATENDIMENTO');
        if (msg.remetente === 'Robô' && msg.resposta_robo) {
          const normalized = normaliseString(msg.resposta_robo);
          if (normalized.includes('transferir para um atendente humano')) status = 'PENDENTE';
        }
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

app.patch('/api/conversation/:numero/status', jsonParser, async (req, res) => {
  const numero = req.params.numero;
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

app.patch('/api/conversation/:numero/name', jsonParser, async (req, res) => {
  const numero = req.params.numero;
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
