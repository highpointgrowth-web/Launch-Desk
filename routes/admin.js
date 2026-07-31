const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

const PLAN_CREDITS = { starter: 100, pro: 1000, agency: 2500 };
const VALID_PLANS = Object.keys(PLAN_CREDITS);

router.put('/users/:email/plan', async (req, res) => {
  const { plan, scrape_credits_limit } = req.body;

  if (!plan || !VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: `plan must be one of: ${VALID_PLANS.join(', ')}` });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('users')
    .update({
      plan,
      scrape_credits_limit: scrape_credits_limit != null ? scrape_credits_limit : PLAN_CREDITS[plan],
    })
    .eq('email', req.params.email)
    .select()
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ user: data });
});

module.exports = router;
