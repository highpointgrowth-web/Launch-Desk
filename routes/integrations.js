const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Only ever send non-secret fields back to the client - api keys/passwords
// are write-only once saved.
function publicConfig(provider, config) {
  if (provider === 'cal') {
    return { event_type_id: config.event_type_id || null };
  }
  if (provider === 'email') {
    return { email: config.email || null, mode: config.mode || null };
  }
  return {};
}

async function upsertIntegration(supabase, userId, provider, config) {
  return supabase
    .from('user_integrations')
    .upsert(
      { user_id: userId, provider, config, connected_at: new Date().toISOString() },
      { onConflict: 'user_id,provider' }
    );
}

router.get('/', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('user_integrations')
    .select('provider, config, connected_at')
    .eq('user_id', req.userId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const integrations = {};
  for (const row of data) {
    integrations[row.provider] = {
      connected: !!row.connected_at,
      ...publicConfig(row.provider, row.config || {}),
    };
  }

  res.json({ integrations });
});

router.put('/cal', async (req, res) => {
  const { api_key, event_type_id } = req.body;

  if (!api_key || !event_type_id) {
    return res.status(400).json({ error: 'api_key and event_type_id are required' });
  }

  const supabase = req.app.locals.supabase;
  const { error } = await upsertIntegration(supabase, req.userId, 'cal', { api_key, event_type_id });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ connected: true, event_type_id });
});

router.put('/email', async (req, res) => {
  const { email, mode, app_password, smtp_host, smtp_port, smtp_username, smtp_password } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  const useSmtp = mode === 'smtp';
  if (useSmtp && (!smtp_host || !smtp_port || !smtp_username || !smtp_password)) {
    return res
      .status(400)
      .json({ error: 'smtp_host, smtp_port, smtp_username, and smtp_password are required for SMTP mode' });
  }
  if (!useSmtp && !app_password) {
    return res.status(400).json({ error: 'app_password is required' });
  }

  const config = useSmtp
    ? { email, mode: 'smtp', smtp_host, smtp_port, smtp_username, smtp_password }
    : { email, mode: 'app_password', app_password };

  const supabase = req.app.locals.supabase;
  const { error } = await upsertIntegration(supabase, req.userId, 'email', config);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ connected: true, email });
});

module.exports = router;
