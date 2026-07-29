const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/stats', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  try {
    const [callsTodayResult, meetingsResult, clientsResult] = await Promise.all([
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
    ]);

    for (const result of [callsTodayResult, meetingsResult, clientsResult]) {
      if (result.error) {
        return res.status(500).json({ error: result.error.message });
      }
    }

    res.json({
      calls_today: callsTodayResult.count || 0,
      meetings: meetingsResult.count || 0,
      clients: clientsResult.count || 0,
      // Not tracked anywhere yet: LaunchDesk has no record of what each client
      // pays the agency (only the agency's own plan/subscription to LaunchDesk
      // itself), so there's no real figure to compute this from.
      mrr: 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
