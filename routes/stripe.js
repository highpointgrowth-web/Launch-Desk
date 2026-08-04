const express = require('express');
const Stripe = require('stripe');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLAN_BY_AMOUNT = {
  1900: { plan: 'starter', scrape_credits_limit: 100 },
  4900: { plan: 'pro', scrape_credits_limit: 1000 },
  9900: { plan: 'agency', scrape_credits_limit: 2500 },
};

const PRICE_ID_BY_PLAN = {
  starter: process.env.STRIPE_PRICE_ID_STARTER,
  pro: process.env.STRIPE_PRICE_ID_PRO,
  agency: process.env.STRIPE_PRICE_ID_AGENCY,
};

async function handleCheckoutCompleted(supabase, session) {
  const planInfo = PLAN_BY_AMOUNT[session.amount_total];
  if (!planInfo) {
    console.warn(`No plan mapping for checkout amount_total=${session.amount_total}`);
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
      plan: planInfo.plan,
      scrape_credits_limit: planInfo.scrape_credits_limit,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
    })
    .eq('id', userId);

  if (error) {
    throw new Error(`Failed to update user plan after checkout: ${error.message}`);
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

  const price = subscription.items.data[0]?.price;
  const planInfo = price && PLAN_BY_AMOUNT[price.unit_amount];
  if (!planInfo) {
    console.warn(`No plan mapping for subscription update (customer=${subscription.customer})`);
    return;
  }

  const { error } = await supabase
    .from('users')
    .update({
      plan: planInfo.plan,
      scrape_credits_limit: planInfo.scrape_credits_limit,
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
        await handleCheckoutCompleted(supabase, event.data.object);
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

module.exports = router;
