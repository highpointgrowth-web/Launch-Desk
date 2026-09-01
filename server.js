require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { USAGE_MARKUP_BY_PLAN, PHONE_NUMBER_RENTAL_CENTS } = require('./billing-constants');
const { chargeUsageBalance } = require('./billing');

const supportRouter = require('./routes/support');
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
app.use('/api/support', supportRouter);

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
  // deducted from it with a markup on top so usage is a profit source
  // instead of a cost the agency fronts. Rate varies by plan - see
  // USAGE_MARKUP_BY_PLAN.

  async function chargeUsage(userId, retellCostCents, callLogId) {
    const { data: user } = await supabase.from('users').select('plan').eq('id', userId).single();
    const markup = USAGE_MARKUP_BY_PLAN[user?.plan] ?? USAGE_MARKUP_BY_PLAN.pro;
    const chargeCents = Math.ceil(retellCostCents * markup);

    await chargeUsageBalance(supabase, userId, chargeCents, {
      type: 'call_charge',
      description: `Call cost + ${Math.round((markup - 1) * 100)}%`,
      callLogId,
    });
  }

  // Some calls never fire call_ended at all (confirmed in practice: a call
  // that errors out with no audio) - call_analyzed is the only event Retell
  // sends for those. Both handlers funnel first-time logging through this,
  // so the call still gets logged and charged even when call_ended never
  // shows up, instead of call_analyzed only being able to update a row that
  // was never created.
  async function insertCallLog(call, extraFields = {}) {
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, user_id')
      .eq('retell_agent_id', call.agent_id)
      .single();

    if (agentError || !agent) {
      console.warn(`No agent found for retell_agent_id=${call.agent_id}`);
      return null;
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
        ...extraFields,
      })
      .select()
      .single();

    if (insertError) {
      // Unique violation means the other event already created this row
      // first (both handlers can race to create it) - not a real failure.
      if (insertError.code === '23505') return 'exists';
      throw new Error(insertError.message);
    }

    if (retellCostCents != null) {
      await chargeUsage(agent.user_id, retellCostCents, callLog.id);
    }

    return callLog;
  }

  try {
    if (payload.event === 'call_ended') {
      await insertCallLog(call);
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
        // call_ended never arrived for this call - create (and charge) it
        // here instead of dropping it, now that we know whether it booked.
        await insertCallLog(call, { booked });
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
    console.error(`Webhook handler error (event=${payload.event}, call_id=${call?.call_id}):`, err);
    res.status(500).json({ error: err.message });
  }
});

// A paused-for-balance agent keeps renting its phone number on our Retell
// account indefinitely if the client never tops up and never deletes it -
// releasing numbers that have sat dormant this long closes that leak.
const DORMANT_PAUSE_DAYS = 60;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function releaseRetellPhoneNumber(phoneNumber) {
  const res = await fetch(`https://api.retellai.com/delete-phone-number/${encodeURIComponent(phoneNumber)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`Retell delete-phone-number failed (${res.status}): ${text}`);
  }
}

async function cleanupDormantAgentPhoneNumbers() {
  const cutoff = new Date(Date.now() - DORMANT_PAUSE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: dormantAgents, error } = await supabase
    .from('agents')
    .select('id, retell_phone_number')
    .eq('paused_for_balance', true)
    .not('retell_phone_number', 'is', null)
    .lt('paused_at', cutoff);

  if (error) {
    console.error(`Dormant-agent cleanup: failed to fetch candidates: ${error.message}`);
    return;
  }
  if (!dormantAgents || dormantAgents.length === 0) return;

  for (const agent of dormantAgents) {
    try {
      await releaseRetellPhoneNumber(agent.retell_phone_number);
      await supabase
        .from('agents')
        .update({ retell_phone_number: null, phone_number_next_bill_at: null })
        .eq('id', agent.id);
      console.log(`Dormant-agent cleanup: released phone number for agent ${agent.id}`);
    } catch (err) {
      console.error(`Dormant-agent cleanup: failed for agent ${agent.id}: ${err.message}`);
    }
  }
}

setInterval(cleanupDormantAgentPhoneNumbers, CLEANUP_INTERVAL_MS);
cleanupDormantAgentPhoneNumbers();

// Retell charges us ~$2/mo per rented number for as long as an agent holds
// one - nothing previously deducted that from the customer's balance, so it
// silently ate margin forever (unlike scrape credits, this never resets).
// Meters it the same way call usage is: charge, log the transaction, and
// pause agents (see chargeUsageBalance) if the deduction drops them below
// the safety buffer. The number itself isn't released here even if paused -
// cleanupDormantAgentPhoneNumbers above already handles that after 60 days.
async function chargePhoneNumberRentals() {
  const { data: dueAgents, error } = await supabase
    .from('agents')
    .select('id, user_id, retell_phone_number')
    .not('retell_phone_number', 'is', null)
    .not('phone_number_next_bill_at', 'is', null)
    .lte('phone_number_next_bill_at', new Date().toISOString());

  if (error) {
    console.error(`Phone rental billing: failed to fetch due agents: ${error.message}`);
    return;
  }
  if (!dueAgents || dueAgents.length === 0) return;

  for (const agent of dueAgents) {
    try {
      await chargeUsageBalance(supabase, agent.user_id, PHONE_NUMBER_RENTAL_CENTS, {
        type: 'feature_charge',
        description: `Phone number rental (${agent.retell_phone_number})`,
      });

      const nextBillAt = new Date();
      nextBillAt.setUTCMonth(nextBillAt.getUTCMonth() + 1);

      const { error: updateError } = await supabase
        .from('agents')
        .update({ phone_number_next_bill_at: nextBillAt.toISOString() })
        .eq('id', agent.id);

      if (updateError) {
        console.error(`Phone rental billing: failed to advance next-bill date for agent ${agent.id}: ${updateError.message}`);
      }
    } catch (err) {
      console.error(`Phone rental billing: failed for agent ${agent.id}: ${err.message}`);
    }
  }
}

setInterval(chargePhoneNumberRentals, CLEANUP_INTERVAL_MS);
chargePhoneNumberRentals();

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`LaunchDesk server running on port ${PORT}`);
});
