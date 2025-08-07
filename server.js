// server.js (versão restaurada completa com estrutura original intacta)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
const rawBodyParser = bodyParser.text({ type: '*/*' });
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function normaliseString(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.!?]/g, '');
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

app.post('/api/webhook', rawBodyParser, urlencodedParser, async (req, res) => {
  let body;
  try {
    body = JSON.parse(req.body);
  } catch (e) {
    console.error('❌ JSON malformado:', e.message);
    return res.status(400).json({ error: 'JSON malformado' });
  }

  const instanceId = body.instanceId || '0';
  const numeroPaciente = body.numeroPaciente;
  const mensagemPaciente = body.mensagemPaciente;
  const respostaRobo = body.respostaRobo || null;
  const patientName = body.nomePaciente || body.nome_paciente || null;

  if (!numeroPaciente || !mensagemPaciente)
    return res.status(400).json({ error: 'Missing numeroPaciente or mensagemPaciente' });

  const lastInfo = await getLastMessageInfo(numeroPaciente);
  const lastStatus = lastInfo.status_atendimento;
  const lastRemetente = lastInfo.remetente;

  let patientStatus;
  if (lastStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente')) {
    patientStatus = 'PENDENTE';
  } else {
    patientStatus = 'EM_ATENDIMENTO';
  }

  try {
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

    if (respostaRobo) {
      const normalized = normaliseString(respostaRobo);
      const transferKey = 'transferir para um atendente humano';
      const skipRobot = patientStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente');

      if (skipRobot) {
        await supabase.from('messages').insert({
          instance_id: String(instanceId),
          numero_paciente: numeroPaciente,
          nome_paciente: patientName,
          mensagem_paciente: null,
          resposta_robo: respostaRobo,
          resposta_atendente: null,
          remetente: 'Robô',
          status_atendimento: 'PENDENTE',
        });
      } else {
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

        if (normalized.includes(transferKey)) {
          await supabase.from('messages')
            .update({ status_atendimento: 'PENDENTE' })
            .eq('numero_paciente', numeroPaciente);
        }
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook insert failed:', err.message);
    return res.status(500).json({ error: 'Webhook insert failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
