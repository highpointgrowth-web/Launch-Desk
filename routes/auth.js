const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password, full_name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const supabase = req.app.locals.supabase;

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name || null },
  });

  if (authError) {
    return res.status(400).json({ error: authError.message });
  }

  const { data: user, error: insertError } = await supabase
    .from('users')
    .insert({
      id: authData.user.id,
      email,
      full_name: full_name || null,
      plan: 'starter',
      scrape_credits_used: 0,
      scrape_credits_limit: 100,
    })
    .select()
    .single();

  if (insertError) {
    await supabase.auth.admin.deleteUser(authData.user.id);
    return res.status(500).json({ error: insertError.message });
  }

  res.status(201).json({ user });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  // Use a throwaway client for sign-in: signInWithPassword attaches the resulting
  // session to whatever client instance it's called on, and req.app.locals.supabase
  // is a single shared client reused by every request. Calling it there would leave
  // this user's session attached for all subsequent requests server-wide, silently
  // replacing the service-role identity other routes rely on to bypass RLS.
  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });

  if (error) {
    return res.status(401).json({ error: error.message });
  }

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_in: data.session.expires_in,
    user: data.user,
  });
});

router.post('/logout', requireAuth, async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { error } = await supabase.auth.admin.signOut(req.token, 'global');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(204).send();
});

router.get('/me', requireAuth, async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase.from('users').select('*').eq('id', req.userId).single();

  if (error || !data) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  res.json({ user: data });
});

router.put('/me', requireAuth, async (req, res) => {
  const { full_name, agency_name, goal_weekly_revenue, goal_monthly_revenue, goal_yearly_revenue } = req.body;
  const updates = {};

  if (full_name !== undefined) updates.full_name = full_name;
  if (agency_name !== undefined) updates.agency_name = agency_name;
  if (goal_weekly_revenue !== undefined) updates.goal_weekly_revenue = goal_weekly_revenue;
  if (goal_monthly_revenue !== undefined) updates.goal_monthly_revenue = goal_monthly_revenue;
  if (goal_yearly_revenue !== undefined) updates.goal_yearly_revenue = goal_yearly_revenue;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.userId)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ user: data });
});

router.post('/forgot-password', async (req, res) => {
  const { email, redirect_to } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  const supabase = req.app.locals.supabase;
  const { error } = await supabase.auth.resetPasswordForEmail(
    email,
    redirect_to ? { redirectTo: redirect_to } : undefined
  );

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ message: 'Password reset email sent' });
});

module.exports = router;
