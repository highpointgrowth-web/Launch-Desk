async function requirePaidPlan(req, res, next) {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase.from('users').select('plan').eq('id', req.userId).single();

  if (error || !data) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  if (data.plan === 'inactive') {
    return res.status(402).json({ error: 'Choose a plan to continue using LaunchDesk.' });
  }

  next();
}

module.exports = { requirePaidPlan };
