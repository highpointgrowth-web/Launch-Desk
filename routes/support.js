const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../email');

const router = express.Router();

// Where support requests actually land - separate from any @mylaunchdesk.com
// forwarding setup, since sending straight here avoids depending on that
// forwarding working. Agency gets a distinctly tagged subject so it can be
// filtered and actually answered first - see billing-constants.js for why
// Agency gets real, ongoing perks instead of just bigger plan numbers.
const SUPPORT_INBOX = process.env.SUPPORT_INBOX_EMAIL || 'highpointgrowth@gmail.com';

router.post('/contact', requireAuth, async (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const supabase = req.app.locals.supabase;
  const { data: user, error } = await supabase
    .from('users')
    .select('email, full_name, agency_name, plan')
    .eq('id', req.userId)
    .single();

  if (error || !user) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  const isAgency = user.plan === 'agency';
  const subject = `${isAgency ? '[Priority] ' : '[Support] '}${user.agency_name || user.full_name || user.email}`;
  const body =
    `From: ${user.full_name || 'unknown'} <${user.email}>\n` +
    `Agency: ${user.agency_name || 'not set'}\n` +
    `Plan: ${user.plan}\n\n` +
    `${message.trim()}`;

  try {
    await sendEmail(SUPPORT_INBOX, subject, body);
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to send: ${err.message}` });
  }
});

module.exports = router;
