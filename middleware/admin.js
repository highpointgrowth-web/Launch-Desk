async function requireAdmin(req, res, next) {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase.from('users').select('is_admin').eq('id', req.userId).single();

  if (error || !data || !data.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}

module.exports = { requireAdmin };
