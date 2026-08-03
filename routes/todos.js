const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePaidPlan } = require('../middleware/plan');

const router = express.Router();

router.use(requireAuth);
router.use(requirePaidPlan);

router.get('/', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ todos: data });
});

router.post('/', async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('todos')
    .insert({ user_id: req.userId, text })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ todo: data });
});

router.put('/:id', async (req, res) => {
  const { text, done } = req.body;
  const updates = {};

  if (text !== undefined) updates.text = text;
  if (done !== undefined) updates.done = done;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('todos')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();

  if (error) {
    return res.status(404).json({ error: error.message });
  }

  res.json({ todo: data });
});

router.delete('/:id', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { error } = await supabase.from('todos').delete().eq('id', req.params.id).eq('user_id', req.userId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(204).send();
});

module.exports = router;
