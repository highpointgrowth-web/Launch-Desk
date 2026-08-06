const express = require('express');
const Stripe = require('stripe');
const { requireAuth } = require('../middleware/auth');
const { LOW_BALANCE_PAUSE_CENTS } = require('../billing-constants');
const { PLAN_CREDITS } = require('../plan-constants');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_ID_BY_PLAN = {
  starter: process.env.STRIPE_PRICE_ID_STARTER,
  pro: process.env.STRIPE_PRICE_ID_PRO,
  agency: process.env.STRIPE_PRICE_ID_AGENCY,
};

// Inverse of the above, for resolving a plan back out of a Stripe price id.
const PLAN_BY_PRICE_ID = Object.fromEntries(
  Object.entries(PRICE_ID_BY_PLAN)
    .filter(([, priceId]) => priceId)
    .map(([plan, priceId]) => [priceId, plan])
);

// checkout.session.completed doesn't carry the price id directly, so the
// plan chosen in /create-checkout is threaded through via metadata instead
// of being re-derived from amount_total - matching on the dollar amount
// charged breaks the moment a coupon, proration, or currency changes what
// was actually paid, silently leaving a paying customer on no plan at all.
async function handleCheckoutCompleted(supabase, session) {
  const plan = session.metadata?.plan;
  const planCredits = plan && PLAN_CREDITS[plan];
  if (!planCredits) {
    console.warn(`No plan metadata on checkout session ${session.id} (metadata.plan=${plan})`);
    return;
  }

  const userId = session.client_reference_id;
  if (!userId) {
    console.warn(`checkout.session.completed had no client_reference_id (session ${session.id})`);
    return;
  }

  const { error } = await supabase
    .from('users')
    .update({
      plan,
      scrape_credits_limit: planCredits,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
    })
    .eq('id', userId);

  if (error) {
    throw new Error(`Failed to update user plan after checkout: ${error.message}`);
  }
}

// Reattaches inbound_agents on a phone number - the inverse of the detach
// done when a balance hits zero.
async function reattachAgentToNumber(phoneNumber, retellAgentId) {
  const res = await fetch(`https://api.retellai.com/update-phone-number/${encodeURIComponent(phoneNumber)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inbound_agents: [{ agent_id: retellAgentId, weight: 1 }] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Retell update-phone-number failed (${res.status}): ${text}`);
  }
}

async function resumeAgentsForBalance(supabase, userId) {
  const { data: pausedAgents, error: fetchError } = await supabase
    .from('agents')
    .select('id, retell_agent_id, retell_phone_number')
    .eq('user_id', userId)
    .eq('paused_for_balance', true);

  if (fetchError) {
    console.error(`Failed to fetch paused agents to resume for user ${userId}: ${fetchError.message}`);
    return;
  }
  if (!pausedAgents || pausedAgents.length === 0) return;

  for (const agent of pausedAgents) {
    if (!agent.retell_phone_number || !agent.retell_agent_id) continue;
    try {
      await reattachAgentToNumber(agent.retell_phone_number, agent.retell_agent_id);
    } catch (err) {
      console.error(`Failed to reattach agent ${agent.id} after top-up: ${err.message}`);
    }
  }

  const { error: updateError } = await supabase
    .from('agents')
    .update({ status: 'active', paused_for_balance: false })
    .in(
      'id',
      pausedAgents.map((a) => a.id)
    );

  if (updateError) {
    console.error(`Failed to un-pause agents for user ${userId}: ${updateError.message}`);
  }
}

async function handleUsageTopupCompleted(supabase, session) {
  const userId = session.client_reference_id;
  if (!userId) {
    console.warn(`usage top-up checkout.session.completed had no client_reference_id (session ${session.id})`);
    return;
  }

  const { data: newBalance, error: rpcError } = await supabase.rpc('increment_usage_balance', {
    p_user_id: userId,
    p_amount_cents: session.amount_total,
  });

  if (rpcError) {
    throw new Error(`Failed to credit usage balance: ${rpcError.message}`);
  }

  const { error: txError } = await supabase.from('usage_transactions').insert({
    user_id: userId,
    amount_cents: session.amount_total,
    type: 'topup',
    description: 'Balance top-up',
  });

  if (txError) {
    throw new Error(`Failed to log usage top-up transaction: ${txError.message}`);
  }

  if (newBalance >= LOW_BALANCE_PAUSE_CENTS) {
    await resumeAgentsForBalance(supabase, userId);
  }
}

async function handleSubscriptionDeleted(supabase, subscription) {
  // No free tier: a canceled subscription means no access, not the old
  // free-starter default.
  const { error } = await supabase
    .from('users')
    .update({
      plan: 'inactive',
      scrape_credits_limit: 0,
      stripe_subscription_id: null,
    })
    .eq('stripe_customer_id', subscription.customer);

  if (error) {
    throw new Error(`Failed to downgrade user after subscription deletion: ${error.message}`);
  }
}

async function handleSubscriptionUpdated(supabase, subscription) {
  // Only react to a subscription that's actually in force - other status
  // transitions (past_due, unpaid, etc.) aren't a plan change and are best
  // left alone rather than guessed at here.
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return;

  const priceId = subscription.items.data[0]?.price?.id;
  const plan = priceId && PLAN_BY_PRICE_ID[priceId];
  const planCredits = plan && PLAN_CREDITS[plan];
  if (!planCredits) {
    console.warn(`No plan mapping for subscription update (customer=${subscription.customer}, price=${priceId})`);
    return;
  }

  const { error } = await supabase
    .from('users')
    .update({
      plan,
      scrape_credits_limit: planCredits,
      stripe_subscription_id: subscription.id,
    })
    .eq('stripe_customer_id', subscription.customer);

  if (error) {
    throw new Error(`Failed to update user plan after subscription update: ${error.message}`);
  }
}

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  const supabase = req.app.locals.supabase;

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        if (event.data.object.mode === 'payment') {
          await handleUsageTopupCompleted(supabase, event.data.object);
        } else {
          await handleCheckoutCompleted(supabase, event.data.object);
        }
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(supabase, event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(supabase, event.data.object);
        break;
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ received: true });
});

router.get('/portal', requireAuth, async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data: user, error } = await supabase
    .from('users')
    .select('stripe_customer_id')
    .eq('id', req.userId)
    .single();

  if (error || !user) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  if (!user.stripe_customer_id) {
    return res.status(400).json({ error: 'User has no Stripe customer on file' });
  }

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: req.query.return_url || process.env.FRONTEND_URL || 'http://localhost:3000',
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create-checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const priceId = PRICE_ID_BY_PLAN[plan];

  if (!priceId) {
    return res.status(400).json({ error: 'plan must be one of: starter, pro, agency' });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.userId,
      metadata: { plan },
      // APP_URL is the Railway backend (used for webhook_url elsewhere) - checkout
      // redirects need the actual frontend, which is a separate static site.
      success_url: `${process.env.FRONTEND_URL}/dashboard.html?checkout=success`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard.html?checkout=cancel`,
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/add-funds', requireAuth, async (req, res) => {
  const { amount } = req.body;
  const amountCents = Math.round(Number(amount) * 100);

  if (!Number.isFinite(amountCents) || amountCents < 100) {
    return res.status(400).json({ error: 'Minimum top-up is $1' });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'LaunchDesk usage balance top-up' },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      client_reference_id: req.userId,
      success_url: `${process.env.FRONTEND_URL}/dashboard.html?topup=success`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard.html?topup=cancel`,
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage-transactions', requireAuth, async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('usage_transactions')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ transactions: data });
});

module.exports = router;
