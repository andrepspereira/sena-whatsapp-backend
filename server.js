const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Versão 10 do servidor SENA.
// Nesta versão refinamos o comportamento do robô e do status para
// alinhá‑lo ao fluxo descrito pelo usuário:
//  - Quando um atendente humano inicia uma conversa via painel e o paciente
//    responde, o status deve permanecer "PENDENTE" e o robô não deve
//    enviar respostas.  Para isso, determinamos o status da mensagem do
//    paciente com base no status e remetente da última mensagem.
//  - Tokens de instâncias são carregados a cada solicitação via Supabase,
//    garantindo que as instâncias permaneçam "online" mesmo após reloads.
//  - Demais rotas de mensagens e webhooks preservam a funcionalidade das
//    versões anteriores.

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

// Middleware CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Helpers para normalizar e verificar a última mensagem
function normaliseString(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]/g, '');
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

// In-memory cache para tokens de instância.  Carregaremos do Supabase
// durante a inicialização e atualizaremos sempre que um token for alterado.
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

// Carrega tokens na inicialização
preloadTokens();

// Rota para listar instâncias.  Usa o cache em memória para determinar se a instância tem token.
app.get('/api/instances', async (req, res) => {
  const count = Number(process.env.INSTANCE_COUNT || 8);
  const list = [];
  for (let i = 0; i < count; i++) {
    const hasToken = !!instanceTokens[i];
    list.push({ id: String(i), hasToken: hasToken, online: hasToken });
  }
  return res.json(list);
});

// Rota para salvar token de instância
app.post('/api/instance/:id/token', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  // Upsert no Supabase
  const updates = {
    id_da_instancia: String(instanceId),
    token: token,
    status: 'active',
    updated_at: new Date().toISOString(),
  };
  try {
    await supabase.from('instances').upsert(updates, { onConflict: 'id_da_instancia' });
    // Atualiza cache local
    instanceTokens[String(instanceId)] = token;
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to upsert token:', err.message);
    return res.status(500).json({ error: 'Failed to save token' });
  }
});

// Envio de mensagem do atendente humano
app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = req.params.id;
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body;
  const phone = numeroPaciente || numero_paciente;
  const patientName = nomePaciente || nome_paciente || null;
  if (!phone || !texto) return res.status(400).json({ error: 'numeroPaciente and texto are required' });
  // Obter token a partir do cache; se não existir, faz fallback ao Supabase e atualiza o cache
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
  // Insere a mensagem do atendente
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

// Webhook para mensagens de pacientes e respostas do robô
app.post('/api/webhook', jsonParser, urlencodedParser, async (req, res) => {
  try {
    const body = req.body || {};
    const instanceId = body.instanceId || '0';
    const numeroPaciente = body.numeroPaciente;
    const mensagemPaciente = body.mensagemPaciente;
    const respostaRobo = body.respostaRobo || null;
    const patientName = body.nomePaciente || body.nome_paciente || null;
    if (!numeroPaciente || !mensagemPaciente) return res.status(400).json({ error: 'Missing numeroPaciente or mensagemPaciente' });
    // Pega última informação (status e remetente)
    const lastInfo = await getLastMessageInfo(numeroPaciente);
    const lastStatus = lastInfo.status_atendimento;
    const lastRemetente = lastInfo.remetente;
    // Determina status da mensagem do paciente:
    // - Se a última mensagem estava PENDENTE, continua PENDENTE
    // - Se estava EM_ATENDIMENTO e o remetente anterior era Atendente, também fica PENDENTE
    // - Caso contrário, EM_ATENDIMENTO (robô ligado)
    let patientStatus;
    if (lastStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente')) {
      patientStatus = 'PENDENTE';
    } else {
      patientStatus = 'EM_ATENDIMENTO';
    }
    // Insere mensagem do paciente
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
      // Define se devemos pular a resposta do robô: pendente ou conversa com atendente
      const skipRobot = patientStatus === 'PENDENTE' || (lastStatus === 'EM_ATENDIMENTO' && lastRemetente === 'Atendente');
      if (skipRobot) {
        // Mesmo que devamos pular a resposta do robô (para não reativar o robô),
        // gravamos a mensagem no banco com status PENDENTE para que apareça no painel.
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
        // Insere a resposta do robô normalmente, com status EM_ATENDIMENTO
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
        // Se a resposta contém frase de transferência, atualiza para pendente
        if (normalized.includes(transferKey)) {
          await supabase.from('messages').update({ status_atendimento: 'PENDENTE' }).eq('numero_paciente', numeroPaciente);
        }
      }
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook insert failed:', err.message);
    return res.status(500).json({ error: 'Webhook insert failed' });
  }
});

// Lista de conversas agrupadas por número
app.get('/api/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const convoMap = {};
    data.forEach((msg) => {
      const key = msg.numero_paciente;
      if (!convoMap[key]) {
        // Define status base: se explícito, usa; senão infere do remetente
        let status;
        if (msg.status_atendimento) status = msg.status_atendimento;
        else status = msg.remetente === 'Paciente' ? 'PENDENTE' : 'EM_ATENDIMENTO';
        // Detecta frase de transferência e força pendente
        if (msg.remetente === 'Robô' && msg.resposta_robo) {
          const normalized = normaliseString(msg.resposta_robo);
          if (normalized.includes('transferir para um atendente humano')) status = 'PENDENTE';
        }
        // Ajusta último remetente conforme status
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

// Atualiza status de uma conversa (Finalizar ou reabrir)
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

// Atualiza nome do paciente
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

// Inicia servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
