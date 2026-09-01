const express = require('express');
const crypto = require('crypto');
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
    .update({ status: 'active', paused_for_balance: false, paused_at: null })
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

  // Stripe's own fee (~2.9% + $0.30) is a fixed cost per transaction - on a
  // $1 top-up that's roughly a third of it gone before it's even usable
  // balance. $5 keeps that fee down to a small fraction instead.
  if (!Number.isFinite(amountCents) || amountCents < 500) {
    return res.status(400).json({ error: 'Minimum top-up is $5' });
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

// ── STRIPE CONNECT (read-only revenue) ──
// Lets an agency link the Stripe account they already use to bill their own
// clients, so real revenue can be shown instead of the self-reported
// monthly_charge estimate. scope=read_only means LaunchDesk can never move
// money through a connected account - only read balance/charge data.

// Signs {userId, timestamp} so the OAuth callback (hit by a redirect from
// Stripe, not our own authenticated fetch - it can't carry a bearer token)
// can still verify which user initiated this and that it hasn't expired,
// without needing a server-side session store.
function signConnectState(userId) {
  const payload = `${userId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyConnectState(state) {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const [userId, timestamp, sig] = decoded.split('.');
    const expectedSig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${userId}.${timestamp}`).digest('hex');
    if (sig !== expectedSig) return null;
    if (Date.now() - Number(timestamp) > 10 * 60 * 1000) return null; // 10 min to complete the OAuth flow
    return userId;
  } catch (err) {
    return null;
  }
}

router.get('/connect/authorize-url', requireAuth, (req, res) => {
  if (!process.env.STRIPE_CONNECT_CLIENT_ID) {
    return res.status(500).json({ error: 'Stripe Connect is not configured yet.' });
  }

  const url = new URL('https://connect.stripe.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.STRIPE_CONNECT_CLIENT_ID);
  url.searchParams.set('scope', 'read_only');
  url.searchParams.set('redirect_uri', `${process.env.APP_URL}/api/stripe/connect/callback`);
  url.searchParams.set('state', signConnectState(req.userId));

  res.json({ url: url.toString() });
});

// Public on purpose - Stripe redirects the browser here directly after the
// agency authorizes, so it can't carry our bearer token. The signed state
// param (not a plain user id) is what stands in for auth here.
router.get('/connect/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const frontendBase = process.env.FRONTEND_URL || 'https://mylaunchdesk.com';

  if (oauthError) {
    return res.redirect(`${frontendBase}/dashboard.html?connect=cancelled`);
  }

  const userId = verifyConnectState(state);
  if (!userId || !code) {
    return res.redirect(`${frontendBase}/dashboard.html?connect=error`);
  }

  try {
    const tokenResponse = await stripe.oauth.token({ grant_type: 'authorization_code', code });
    const supabase = req.app.locals.supabase;

    const { error: updateError } = await supabase
      .from('users')
      .update({ stripe_connect_account_id: tokenResponse.stripe_user_id })
      .eq('id', userId);

    if (updateError) {
      console.error(`Failed to save connected Stripe account for user ${userId}: ${updateError.message}`);
      return res.redirect(`${frontendBase}/dashboard.html?connect=error`);
    }

    res.redirect(`${frontendBase}/dashboard.html?connect=success`);
  } catch (err) {
    console.error(`Stripe Connect token exchange failed: ${err.message}`);
    res.redirect(`${frontendBase}/dashboard.html?connect=error`);
  }
});

router.get('/connect/status', requireAuth, async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('users')
    .select('stripe_connect_account_id')
    .eq('id', req.userId)
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ connected: !!data.stripe_connect_account_id });
});

router.post('/connect/disconnect', requireAuth, async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data: user, error: fetchError } = await supabase
    .from('users')
    .select('stripe_connect_account_id')
    .eq('id', req.userId)
    .single();

  if (fetchError || !user) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  if (user.stripe_connect_account_id) {
    try {
      await stripe.oauth.deauthorize({
        client_id: process.env.STRIPE_CONNECT_CLIENT_ID,
        stripe_user_id: user.stripe_connect_account_id,
      });
    } catch (err) {
      // Continue clearing our own record even if Stripe-side deauth fails
      // (e.g. the agency already revoked it from their own dashboard).
      console.error(`Stripe deauthorize failed for user ${req.userId}: ${err.message}`);
    }
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({ stripe_connect_account_id: null })
    .eq('id', req.userId);

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  res.json({ connected: false });
});

// ── AUTO TOP-UP ──
// Off by default for every user - only someone who explicitly flips this on
// in their own Settings gets charged automatically. Reuses the payment
// method already on file from their plan subscription rather than asking
// for a card again.

// Filtering paymentMethods.list by type:'card' misses a real, common case -
// a customer whose saved method is Stripe Link (or a bank account) rather
// than a plain card object, which showed up as "no payment method" for an
// account that was actively being billed monthly. The customer's own
// invoice_settings.default_payment_method is what Stripe itself already
// uses to auto-charge the subscription, so it's guaranteed reusable
// off-session regardless of its underlying type - reuse that instead of
// re-deriving it from a type-filtered list.
async function getDefaultPaymentMethodId(stripeCustomerId) {
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (customer.deleted) return null;
  return customer.invoice_settings?.default_payment_method || customer.default_source || null;
}

router.get('/auto-topup', requireAuth, async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data: user, error } = await supabase
    .from('users')
    .select('auto_topup_enabled, auto_topup_threshold_cents, auto_topup_amount_cents, stripe_customer_id')
    .eq('id', req.userId)
    .single();

  if (error || !user) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  let hasPaymentMethod = false;
  if (user.stripe_customer_id) {
    try {
      hasPaymentMethod = !!(await getDefaultPaymentMethodId(user.stripe_customer_id));
    } catch (err) {
      console.error(`Failed to check payment methods for user ${req.userId}: ${err.message}`);
    }
  }

  res.json({
    enabled: user.auto_topup_enabled,
    threshold_cents: user.auto_topup_threshold_cents,
    amount_cents: user.auto_topup_amount_cents,
    has_payment_method: hasPaymentMethod,
  });
});

router.post('/auto-topup', requireAuth, async (req, res) => {
  const { enabled, threshold_cents, amount_cents } = req.body;
  const supabase = req.app.locals.supabase;

  // Same $5 floor as a manual top-up, for the same reason: Stripe's own fee
  // eats too much of anything smaller.
  if (enabled) {
    if (!Number.isFinite(amount_cents) || amount_cents < 500) {
      return res.status(400).json({ error: 'Auto top-up amount must be at least $5' });
    }
    if (!Number.isFinite(threshold_cents) || threshold_cents < 0) {
      return res.status(400).json({ error: 'Threshold must be a positive amount' });
    }

    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (fetchError || !user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'Add a payment method first (Settings → Payment method) before enabling auto top-up.' });
    }

    const paymentMethodId = await getDefaultPaymentMethodId(user.stripe_customer_id);
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Add a payment method first (Settings → Payment method) before enabling auto top-up.' });
    }
  }

  const { error } = await supabase
    .from('users')
    .update({
      auto_topup_enabled: !!enabled,
      auto_topup_threshold_cents: enabled ? Math.round(threshold_cents) : null,
      auto_topup_amount_cents: enabled ? Math.round(amount_cents) : null,
    })
    .eq('id', req.userId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ enabled: !!enabled, threshold_cents: threshold_cents ?? null, amount_cents: amount_cents ?? null });
});

// Runs periodically from server.js. For every user who has opted in and
// whose balance has dropped below their own threshold, charges their saved
// card off-session for their configured amount - no checkout redirect, no
// user present, exactly the point of "automatic".
async function runAutoTopups(supabase) {
  const { data: candidates, error } = await supabase
    .from('users')
    .select('id, usage_balance_cents, auto_topup_threshold_cents, auto_topup_amount_cents, stripe_customer_id')
    .eq('auto_topup_enabled', true)
    .not('stripe_customer_id', 'is', null);

  if (error) {
    console.error(`Auto top-up: failed to fetch candidates: ${error.message}`);
    return;
  }
  if (!candidates || candidates.length === 0) return;

  for (const user of candidates) {
    if ((user.usage_balance_cents ?? 0) >= (user.auto_topup_threshold_cents ?? 0)) continue;

    try {
      const paymentMethodId = await getDefaultPaymentMethodId(user.stripe_customer_id);
      if (!paymentMethodId) {
        console.error(`Auto top-up: user ${user.id} has no saved payment method - skipping`);
        continue;
      }

      const amountCents = user.auto_topup_amount_cents;
      const intent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: user.stripe_customer_id,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: 'LaunchDesk auto top-up',
      });

      if (intent.status !== 'succeeded') {
        console.error(`Auto top-up: PaymentIntent for user ${user.id} did not succeed (status=${intent.status})`);
        continue;
      }

      const { data: newBalance, error: rpcError } = await supabase.rpc('increment_usage_balance', {
        p_user_id: user.id,
        p_amount_cents: amountCents,
      });

      if (rpcError) {
        console.error(`Auto top-up: charged user ${user.id} but failed to credit balance: ${rpcError.message}`);
        continue;
      }

      await supabase.from('usage_transactions').insert({
        user_id: user.id,
        amount_cents: amountCents,
        type: 'topup',
        description: 'Auto top-up',
      });

      if (newBalance >= LOW_BALANCE_PAUSE_CENTS) {
        await resumeAgentsForBalance(supabase, user.id);
      }
    } catch (err) {
      // A declined/expired card is expected occasionally - log and move on
      // rather than letting one user's failure stop everyone else's.
      console.error(`Auto top-up failed for user ${user.id}: ${err.message}`);
    }
  }
}

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
module.exports.runAutoTopups = runAutoTopups;
