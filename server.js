/*
  Projeto SENA — Backend (server.js)
  Versão: v11f (2025-08-09) — COMPLETÃO, compat com seu front, e à prova de falta da coluna status_conversa

  O que esta versão garante:
  • Todas as rotas e comportamentos que você já usava
  • status_atendimento e status_conversa SEMPRE sincronizados (se a coluna existir)
  • Se a coluna status_conversa NÃO existir, o servidor entra em fallback automático (só usa status_atendimento) e NÃO quebra
  • Header X-Conversation-Status no histórico para pintar o topo do chat
  • Robô bloqueado quando conversa está PENDENTE/FINALIZADO
  • Envio humano só grava se a Gupshup retornar 2xx (confirmação real)
  • Handoff/transferência atualiza em massa
  • Compat com payloads numeroPaciente/numero_paciente e nomePaciente/nome_paciente

  Variáveis de ambiente relevantes:
  - PORT
  - SUPABASE_URL
  - SUPABASE_ANON_KEY (compat)
  - GSAPP_NAME (opcional, nome exibido na Gupshup)
*/

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

/* =========================== Supabase ============================ */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Faltam SUPABASE_URL/SUPABASE_ANON_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseAnonKey);

/* ============================ Express ============================ */
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
  return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!?]/g, '');
}
function normalizePhone(p) { return String(p || '').replace(/[^\d]/g, ''); }
function nowIso() { return new Date().toISOString(); }
function safeString(x) { if (x == null) return ''; if (typeof x === 'string') return x; try { return JSON.stringify(x); } catch { return String(x); } }

const Status = {
  ROBO: 'EM_ATENDIMENTO_ROBO',
  PENDENTE: 'PENDENTE',
  HUMANO: 'EM_ATENDIMENTO_HUMANO',
  FINALIZADO: 'FINALIZADO',
};

const TRANSFER_TRIGGERS = [
  'vou te transferir para um atendente humano',
  'vou te deixar com alguem da equipe',
];

/* ====== Detecção dinâmica: existe coluna status_conversa? ====== */
let HAS_STATUS_CONVERSA = true; // assume que sim até provar o contrário
function isStatusColError(err) {
  const s = String(err && (err.message || err));
  return s.includes('status_conversa') || (s.includes('column') && s.includes('status_conversa'));
}

async function safeInsert(row) {
  const payload = { ...row, created_at: nowIso(), updated_at: nowIso() };
  try {
    const { error } = await supabase.from('messages').insert(payload);
    if (error) throw error;
  } catch (err) {
    if (isStatusColError(err)) {
      HAS_STATUS_CONVERSA = false;
      const clone = { ...payload }; delete clone.status_conversa;
      const { error: e2 } = await supabase.from('messages').insert(clone);
      if (e2) throw e2;
    } else { throw err; }
  }
}

async function safeUpdateByNumero(numeroPaciente, values) {
  try {
    const { error } = await supabase.from('messages').update(values).eq('numero_paciente', numeroPaciente);
    if (error) throw error;
  } catch (err) {
    if (isStatusColError(err)) {
      HAS_STATUS_CONVERSA = false;
      const clone = { ...values }; delete clone.status_conversa;
      const { error: e2 } = await supabase.from('messages').update(clone).eq('numero_paciente', numeroPaciente);
      if (e2) throw e2;
    } else { throw err; }
  }
}

/* ==================== Supabase helpers & cache ===================== */
async function getLastMessageInfo(numeroPaciente) {
  const { data } = await supabase
    .from('messages')
    .select('status_atendimento, status_conversa, remetente')
    .eq('numero_paciente', numeroPaciente)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!data || !data.length) return { status_atendimento: null, status_conversa: null, remetente: null };
  return data[0];
}
async function getLastRow(numeroPaciente) {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('numero_paciente', numeroPaciente)
    .order('created_at', { ascending: false })
    .limit(1);
  return (data && data[0]) || null;
}

async function setConversationStatusMass(numeroPaciente, statusKey) {
  const values = { status_atendimento: statusKey, status_conversa: statusKey, updated_at: nowIso() };
  if (!HAS_STATUS_CONVERSA) delete values.status_conversa;
  await safeUpdateByNumero(numeroPaciente, values);
}

/* =================== Gupshup (texto sessão) =================== */
async function sendWhatsAppSessionMessage({ token, source, destination, text }) {
  const body = new URLSearchParams();
  body.append('channel', 'whatsapp');
  body.append('source', normalizePhone(source));
  body.append('destination', normalizePhone(destination));
  body.append('message', JSON.stringify({ type: 'text', text }));
  body.append('src.name', process.env.GSAPP_NAME || 'SENA');

  const res = await axios.post('https://api.gupshup.io/wa/api/v1/msg', body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', apikey: token, 'cache-control': 'no-cache' },
    timeout: 15000,
    validateStatus: () => true,
  });

  const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
  if (res.status >= 400) console.error('Gupshup ERROR', res.status, bodyStr);
  else console.log('Gupshup OK', res.status, bodyStr.slice(0, 200));
  return res;
}

/* ============================== API =============================== */
app.get('/health', (req, res) => res.json({ ok: true, version: 'v11f', hasStatusConversa: HAS_STATUS_CONVERSA, ts: nowIso() }));

// Instâncias (listagem simples)
app.get('/api/instances', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('instances').select('id_da_instancia, token, source_number');
    if (error) throw error;
    const out = (data || []).map(r => ({ id: String(r.id_da_instancia), hasToken: !!r.token, source: r.source_number || null }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/instance/:id/token', jsonParser, async (req, res) => {
  const instanceId = String(req.params.id);
  const { token, source_number } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token is required' });
  const updates = { id_da_instancia: instanceId, token, source_number: source_number || null, status: 'active', updated_at: nowIso() };
  try {
    await supabase.from('instances').upsert(updates, { onConflict: 'id_da_instancia' });
    return res.json({ success: true });
  } catch (err) { console.error('Failed to upsert token:', err.message); return res.status(500).json({ error: 'Failed to save token' }); }
});

/* ======================= HUMANO → WHATSAPP ======================== */
app.post('/api/instance/:id/messages', jsonParser, async (req, res) => {
  const instanceId = String(req.params.id);
  const { numeroPaciente, numero_paciente, nomePaciente, nome_paciente, texto } = req.body || {};
  const phone = normalizePhone(numeroPaciente || numero_paciente);
  const patientName = safeString(nomePaciente || nome_paciente || '');
  const text = String(texto || '').trim();
  if (!phone || !text) return res.status(400).json({ error: 'numeroPaciente and non-empty texto are required' });

  // pega credenciais da instância
  const { data: inst, error: e1 } = await supabase
    .from('instances').select('token, source_number').eq('id_da_instancia', instanceId).single();
  if (e1 || !inst || !inst.token || !inst.source_number) {
    console.error('Missing token/source for instance', instanceId, inst);
    return res.status(500).json({ error: 'instance_not_ready' });
  }

  // Envia via Gupshup — só grava se 2xx
  const resp = await sendWhatsAppSessionMessage({ token: inst.token, source: inst.source_number, destination: phone, text });
  if (resp.status < 200 || resp.status >= 300) return res.status(502).json({ error: 'gupshup_fail', status: resp.status, body: resp.data });

  try {
    await setConversationStatusMass(phone, Status.HUMANO);
    await safeInsert({
      instance_id: instanceId,
      numero_paciente: phone,
      nome_paciente: patientName,
      mensagem_paciente: null,
      resposta_robo: null,
      resposta_atendente: text,
      remetente: 'Atendente',
      status_atendimento: Status.HUMANO,
      status_conversa: Status.HUMANO,
    });
    return res.json({ success: true });
  } catch (err) { console.error('Failed to insert attendant message:', err.message); return res.status(500).json({ error: 'Failed to save message' }); }
});

/* ============================ WEBHOOK ============================== */
app.post('/api/webhook', rawBodyParser, urlencodedParser, async (req, res) => {
  let body;
  try {
    const cleaned = String(req.body || '').replace(/[\u0000-\u001F\u007F]/g, '');
    body = JSON.parse(cleaned);
  } catch (e) { console.error('❌ JSON malformado:', e.message); return res.status(400).json({ error: 'JSON malformado' }); }

  try {
    const instanceId = String(body.instanceId || body.instance_id || '0');
    const numeroPaciente = normalizePhone(body.numeroPaciente || body.numero_paciente);
    const mensagemPaciente = body.mensagemPaciente;
    const respostaRobo = body.respostaRobo || body.resposta_robo || null;
    const patientName = safeString(body.nomePaciente || body.nome_paciente || '');
    const remetente = body.remetente || (respostaRobo ? 'Robô' : 'Paciente');

    if (!numeroPaciente) return res.status(400).json({ error: 'Missing numeroPaciente' });

    const lastInfo = await getLastMessageInfo(numeroPaciente);
    let current = lastInfo.status_conversa || lastInfo.status_atendimento || Status.ROBO;

    if (remetente === 'Paciente') {
      // FSM p/ paciente
      switch (current) {
        case Status.FINALIZADO: current = Status.ROBO; break;
        case Status.HUMANO:     current = Status.PENDENTE; break;
        default:                /* mantém */ break;
      }
      if (mensagemPaciente) {
        await safeInsert({
          instance_id: instanceId, numero_paciente: numeroPaciente, nome_paciente: patientName,
          mensagem_paciente: safeString(mensagemPaciente), resposta_robo: null, resposta_atendente: null,
          remetente: 'Paciente', status_atendimento: current, status_conversa: current,
        });
      }
      if (current === Status.PENDENTE || current === Status.FINALIZADO) {
        await setConversationStatusMass(numeroPaciente, current);
      }
    }

    if (respostaRobo) {
      // BLOQUEIO do robô quando PENDENTE/FINALIZADO
      if (current === Status.PENDENTE || current === Status.FINALIZADO) {
        console.log('Robô suprimido (status impede resposta).');
        return res.json({ received: true, suppressed: true });
      }
      let statusForBot = Status.ROBO;
      if (TRANSFER_TRIGGERS.some(t => normaliseString(respostaRobo).includes(t))) {
        statusForBot = Status.PENDENTE;
        await setConversationStatusMass(numeroPaciente, Status.PENDENTE);
      }
      await safeInsert({
        instance_id: instanceId, numero_paciente: numeroPaciente, nome_paciente: patientName,
        mensagem_paciente: null, resposta_robo: safeString(respostaRobo), resposta_atendente: null,
        remetente: 'Robô', status_atendimento: statusForBot, status_conversa: statusForBot,
      });
    }

    return res.json({ received: true });
  } catch (err) { console.error('Webhook insert failed:', err.message); return res.status(500).json({ error: 'Webhook insert failed' }); }
});

/* =================== Consultas para o painel/UI =================== */
// Lista de conversas — considera a ÚLTIMA linha
app.get('/api/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: true });
    if (error) throw error;

    const byNumero = new Map();
    for (const msg of (data || [])) {
      const key = msg.numero_paciente;
      const prev = byNumero.get(key);
      if (!prev || new Date(msg.created_at) > new Date(prev.created_at)) byNumero.set(key, msg);
    }

    const list = [];
    for (const [numero, msg] of byNumero.entries()) {
      const status = msg.status_conversa || msg.status_atendimento || Status.ROBO;
      let label;
      if (status === Status.FINALIZADO) label = 'FINALIZADO';
      else if (status === Status.PENDENTE) label = 'PENDENTE';
      else if (status === Status.HUMANO) label = 'HUMANO';
      else label = 'ROBÔ';

      list.push({
        numeroPaciente: numero,
        nomePaciente: msg.nome_paciente || null,
        lastMessage: msg.mensagem_paciente || msg.resposta_robo || msg.resposta_atendente,
        statusAtendimento: status,
        lastRemetente: msg.remetente,
        label, updatedAt: msg.updated_at, instanceId: msg.instance_id,
      });
    }

    list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return res.json(list);
  } catch (err) { console.error('Failed to fetch conversations:', err.message); return res.status(500).json({ error: 'Failed to fetch conversations' }); }
});

// Histórico completo — preserva mensagens; adiciona status_conversa e Header X-Conversation-Status
app.get('/api/conversation/:numero/messages', async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('numero_paciente', numero)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const last = (data || [])[data.length - 1] || null;
    const statusAtual = (last && (last.status_conversa || last.status_atendimento)) || Status.ROBO;

    const out = (data || []).map(m => ({ ...m, status_conversa: m.status_conversa || statusAtual }));

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('X-Conversation-Status', statusAtual);

    return res.json(out);
  } catch (err) {
    console.error('Failed to fetch conversation:', err.message);
    return res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Finalizar/Reabrir/Pendente/Humano — ATUALIZA EM MASSA
app.patch('/api/conversation/:numero/status', jsonParser, async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const { statusAtendimento, status } = req.body || {};
  const desired = statusAtendimento || status;
  if (!desired || !Object.values(Status).includes(desired)) {
    return res.status(400).json({ error: 'statusAtendimento/status inválido' });
  }

  try {
    await setConversationStatusMass(numero, desired);
    return res.json({ success: true });
  } catch (err) { console.error('Failed to update status:', err.message); return res.status(500).json({ error: 'Failed to update status' }); }
});

// Atualiza nome
app.patch('/api/conversation/:numero/name', jsonParser, async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const { nomePaciente } = req.body || {};
  if (!nomePaciente) return res.status(400).json({ error: 'nomePaciente is required' });

  try {
    const { error } = await supabase.from('messages').update({ nome_paciente: nomePaciente }).eq('numero_paciente', numero);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) { console.error('Failed to update name:', err.message); return res.status(500).json({ error: 'Failed to update name' }); }
});

/* ============================== Start ============================== */
const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`Server v11f running on port ${port} — HAS_STATUS_CONVERSA=${HAS_STATUS_CONVERSA}`); });
