const express = require('express');
const Stripe = require('stripe');
const { requireAuth } = require('../middleware/auth');
const { requirePaidPlan } = require('../middleware/plan');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.use(requireAuth);
router.use(requirePaidPlan);

// Sums this calendar month's successful charges on the agency's own
// connected Stripe account (stripeAccount header scopes the call to their
// account, read-only - LaunchDesk never touches this money). Real revenue,
// not an estimate, once an agency has connected their account.
async function fetchConnectedRevenue(connectedAccountId) {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  let total = 0;
  let startingAfter;
  for (;;) {
    const page = await stripe.charges.list(
      { created: { gte: Math.floor(startOfMonth.getTime() / 1000) }, limit: 100, starting_after: startingAfter },
      { stripeAccount: connectedAccountId }
    );
    total += page.data.filter((c) => c.paid && !c.refunded).reduce((sum, c) => sum + c.amount, 0);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return total / 100;
}

router.get('/stats', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  try {
    const [callsTodayResult, meetingsResult, clientsResult, proposalsTodayResult, mrrResult, userResult] = await Promise.all([
      supabase
        .from('call_logs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.userId)
        .gte('created_at', startOfToday.toISOString()),
      supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.userId)
        .eq('pipeline_stage', 'meeting'),
      supabase
        .from('agents')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.userId)
        .eq('status', 'active'),
      supabase
        .from('proposals')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.userId)
        .gte('created_at', startOfToday.toISOString()),
      // Self-reported fallback: what the agency inputs per-agent in the
      // Billing tab. Summed across active agents to match the "clients"
      // count above - a paused-for-balance agent isn't counted as a client
      // there either, so it shouldn't contribute to revenue here.
      supabase.from('agents').select('monthly_charge').eq('user_id', req.userId).eq('status', 'active'),
      supabase.from('users').select('stripe_connect_account_id').eq('id', req.userId).single(),
    ]);

    for (const result of [callsTodayResult, meetingsResult, clientsResult, proposalsTodayResult, mrrResult, userResult]) {
      if (result.error) {
        return res.status(500).json({ error: result.error.message });
      }
    }

    const connectedAccountId = userResult.data.stripe_connect_account_id;
    let mrr;
    let revenueSource;

    if (connectedAccountId) {
      try {
        mrr = await fetchConnectedRevenue(connectedAccountId);
        revenueSource = 'stripe';
      } catch (err) {
        console.error(`Failed to fetch connected Stripe revenue for user ${req.userId}: ${err.message}`);
        mrr = mrrResult.data.reduce((sum, agent) => sum + (Number(agent.monthly_charge) || 0), 0);
        revenueSource = 'self_reported';
      }
    } else {
      mrr = mrrResult.data.reduce((sum, agent) => sum + (Number(agent.monthly_charge) || 0), 0);
      revenueSource = 'self_reported';
    }

    res.json({
      calls_today: callsTodayResult.count || 0,
      meetings: meetingsResult.count || 0,
      clients: clientsResult.count || 0,
      proposals_sent_today: proposalsTodayResult.count || 0,
      mrr,
      revenue_source: revenueSource,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
