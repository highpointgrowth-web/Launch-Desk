const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('meetings')
    .select('*')
    .eq('user_id', req.userId)
    .order('meeting_date', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ meetings: data });
});

router.post('/', async (req, res) => {
  const { business_name, meeting_date, meeting_time, notes, lead_id } = req.body;

  if (!business_name || !meeting_date) {
    return res.status(400).json({ error: 'business_name and meeting_date are required' });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('meetings')
    .insert({
      user_id: req.userId,
      lead_id: lead_id || null,
      business_name,
      meeting_date,
      meeting_time: meeting_time || null,
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ meeting: data });
});

router.put('/:id', async (req, res) => {
  const { business_name, meeting_date, meeting_time, notes, status } = req.body;
  const updates = {};

  if (business_name !== undefined) updates.business_name = business_name;
  if (meeting_date !== undefined) updates.meeting_date = meeting_date;
  if (meeting_time !== undefined) updates.meeting_time = meeting_time;
  if (notes !== undefined) updates.notes = notes;
  if (status !== undefined) {
    if (!['upcoming', 'completed'].includes(status)) {
      return res.status(400).json({ error: "status must be 'upcoming' or 'completed'" });
    }
    updates.status = status;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('meetings')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();

  if (error) {
    return res.status(404).json({ error: error.message });
  }

  res.json({ meeting: data });
});

router.delete('/:id', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { error } = await supabase.from('meetings').delete().eq('id', req.params.id).eq('user_id', req.userId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(204).send();
});

module.exports = router;
