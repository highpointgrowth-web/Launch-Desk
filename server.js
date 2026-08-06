require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { LOW_BALANCE_PAUSE_CENTS } = require('./billing-constants');

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

  // Customers prepay a usage balance; every real Retell call cost is
  // deducted from it with this markup on top so usage is a profit source
  // instead of a cost the agency fronts.
  const USAGE_MARKUP = 1.1;

  // Detaching inbound_agents (rather than deleting the number) stops the
  // agent from actually answering - and therefore stops billable Retell
  // usage - while keeping the number itself intact to reattach later.
  async function detachAgentFromNumber(phoneNumber) {
    const res = await fetch(`https://api.retellai.com/update-phone-number/${encodeURIComponent(phoneNumber)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inbound_agents: null }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Retell update-phone-number failed (${res.status}): ${text}`);
    }
  }

  async function pauseAgentsForBalance(userId) {
    const { data: activeAgents, error: fetchError } = await supabase
      .from('agents')
      .select('id, retell_phone_number')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (fetchError) {
      console.error(`Failed to fetch active agents to pause for user ${userId}: ${fetchError.message}`);
      return;
    }
    if (!activeAgents || activeAgents.length === 0) return;

    for (const agent of activeAgents) {
      if (!agent.retell_phone_number) continue;
      try {
        await detachAgentFromNumber(agent.retell_phone_number);
      } catch (err) {
        console.error(`Failed to detach agent ${agent.id} from its number after balance depletion: ${err.message}`);
      }
    }

    const { error: updateError } = await supabase
      .from('agents')
      .update({ status: 'inactive', paused_for_balance: true })
      .in(
        'id',
        activeAgents.map((a) => a.id)
      );

    if (updateError) {
      console.error(`Failed to mark agents paused_for_balance for user ${userId}: ${updateError.message}`);
    }
  }

  async function chargeUsage(userId, retellCostCents, callLogId) {
    const chargeCents = Math.ceil(retellCostCents * USAGE_MARKUP);

    const { data: newBalance, error: rpcError } = await supabase.rpc('decrement_usage_balance', {
      p_user_id: userId,
      p_amount_cents: chargeCents,
    });

    if (rpcError) {
      console.error(`Failed to deduct usage balance for user ${userId}: ${rpcError.message}`);
      return;
    }

    const { error: txError } = await supabase.from('usage_transactions').insert({
      user_id: userId,
      amount_cents: -chargeCents,
      type: 'call_charge',
      call_log_id: callLogId,
      description: 'Call cost + 10%',
    });

    if (txError) {
      console.error(`Failed to log usage transaction for user ${userId}: ${txError.message}`);
    }

    if (newBalance < LOW_BALANCE_PAUSE_CENTS) {
      await pauseAgentsForBalance(userId);
    }
  }

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

      const retellCostCents = call.call_cost?.combined_cost ?? null;

      const { data: callLog, error: insertError } = await supabase
        .from('call_logs')
        .insert({
          agent_id: agent.id,
          user_id: agent.user_id,
          retell_call_id: call.call_id,
          duration_seconds: durationSeconds,
          transcript: call.transcript || null,
          outcome: call.disconnection_reason || null,
          retell_cost_cents: retellCostCents,
          cost_charged: retellCostCents != null,
          booked: false,
        })
        .select()
        .single();

      if (insertError) {
        return res.status(500).json({ error: insertError.message });
      }

      if (retellCostCents != null) {
        await chargeUsage(agent.user_id, retellCostCents, callLog.id);
      }

      return res.json({ received: true });
    }

    if (payload.event === 'call_analyzed') {
      const booked = call.call_analysis?.custom_analysis_data?.booked === true;

      const { data: existing, error: fetchError } = await supabase
        .from('call_logs')
        .select('id, user_id, retell_cost_cents, cost_charged')
        .eq('retell_call_id', call.call_id)
        .single();

      if (fetchError || !existing) {
        console.warn(`No call_log found for retell_call_id=${call.call_id} on call_analyzed`);
        return res.json({ received: true });
      }

      // call_cost may not be finalized yet at call_ended - pick it up here too
      // if it's present, same way booked only becomes known at this stage.
      const updates = { booked };
      const newCostCents = call.call_cost?.combined_cost ?? null;
      const shouldCharge = !existing.cost_charged && newCostCents != null;

      if (newCostCents != null) {
        updates.retell_cost_cents = newCostCents;
      }
      if (shouldCharge) {
        updates.cost_charged = true;
      }

      const { error: updateError } = await supabase
        .from('call_logs')
        .update(updates)
        .eq('retell_call_id', call.call_id);

      if (updateError) {
        return res.status(500).json({ error: updateError.message });
      }

      if (shouldCharge) {
        await chargeUsage(existing.user_id, newCostCents, existing.id);
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
