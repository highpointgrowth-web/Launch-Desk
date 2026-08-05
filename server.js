require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const leadsRouter = require('./routes/leads');
const agentsRouter = require('./routes/agents');
const authRouter = require('./routes/auth');
const stripeRouter = require('./routes/stripe');
const proposalsRouter = require('./routes/proposals');
const dashboardRouter = require('./routes/dashboard');
const adminRouter = require('./routes/admin');
const integrationsRouter = require('./routes/integrations');
const meetingsRouter = require('./routes/meetings');
const todosRouter = require('./routes/todos');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook' || req.path === '/api/webhooks/retell') return next();
  express.json()(req, res, next);
});

app.locals.supabase = supabase;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/leads', leadsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/auth', authRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/proposals', proposalsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/admin', adminRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/todos', todosRouter);

function verifyRetellSignature(rawBody, signatureHeader, apiKey) {
  if (!signatureHeader) return false;

  const match = signatureHeader.match(/v=(\d+),d=(.*)/);
  if (!match) return false;

  const [, timestamp, digest] = match;
  const REPLAY_WINDOW_MS = 5 * 60 * 1000;
  if (Math.abs(Date.now() - Number(timestamp)) > REPLAY_WINDOW_MS) return false;

  const expected = crypto.createHmac('sha256', apiKey).update(rawBody + timestamp).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const digestBuf = Buffer.from(digest, 'utf8');

  if (expectedBuf.length !== digestBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, digestBuf);
}

app.post('/api/webhooks/retell', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-retell-signature'];
  const rawBody = req.body.toString('utf8');

  if (!verifyRetellSignature(rawBody, signature, process.env.RETELL_API_KEY)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const payload = JSON.parse(rawBody);
  const call = payload.call;

  try {
    if (payload.event === 'call_ended') {
      const { data: agent, error: agentError } = await supabase
        .from('agents')
        .select('id, user_id')
        .eq('retell_agent_id', call.agent_id)
        .single();

      if (agentError || !agent) {
        console.warn(`No agent found for retell_agent_id=${call.agent_id}`);
        return res.json({ received: true });
      }

      const durationSeconds =
        call.start_timestamp && call.end_timestamp
          ? Math.round((call.end_timestamp - call.start_timestamp) / 1000)
          : null;

      const { error: insertError } = await supabase.from('call_logs').insert({
        agent_id: agent.id,
        user_id: agent.user_id,
        retell_call_id: call.call_id,
        duration_seconds: durationSeconds,
        transcript: call.transcript || null,
        outcome: call.disconnection_reason || null,
        retell_cost_cents: call.call_cost?.combined_cost ?? null,
        booked: false,
      });

      if (insertError) {
        return res.status(500).json({ error: insertError.message });
      }

      return res.json({ received: true });
    }

    if (payload.event === 'call_analyzed') {
      const booked = call.call_analysis?.custom_analysis_data?.booked === true;

      // call_cost may not be finalized yet at call_ended - pick it up here too
      // if it's present, same way booked only becomes known at this stage.
      const updates = { booked };
      if (call.call_cost?.combined_cost != null) {
        updates.retell_cost_cents = call.call_cost.combined_cost;
      }

      const { error: updateError } = await supabase
        .from('call_logs')
        .update(updates)
        .eq('retell_call_id', call.call_id);

      if (updateError) {
        return res.status(500).json({ error: updateError.message });
      }

      return res.json({ received: true });
    }

    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`LaunchDesk server running on port ${PORT}`);
});
