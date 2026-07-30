const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const anthropic = new Anthropic();

router.use(requireAuth);

function buildTransport(config) {
  if (config.mode === 'smtp') {
    const port = Number(config.smtp_port);
    return nodemailer.createTransport({
      host: config.smtp_host,
      port,
      secure: port === 465,
      auth: { user: config.smtp_username, pass: config.smtp_password },
    });
  }

  // App-password mode assumes Gmail, the overwhelmingly common app-password provider.
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email, pass: config.app_password },
  });
}

async function generateProposal(lead) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 3000,
    output_config: { effort: 'medium' },
    system:
      'You write professional sales proposals for LaunchDesk, an agency that sells AI voice receptionist agents ' +
      "to local businesses. Given a prospect's business details, write a persuasive but honest proposal that " +
      'shows the ROI of adding an AI receptionist for that specific business - reference their actual rating, ' +
      'review count, and category to ground the pitch, and include a concrete (labeled as estimated) ROI ' +
      'calculation such as missed-call recovery and the value of after-hours coverage. Respond with only the ' +
      'proposal text - no preamble, no explanation, no markdown code fences.',
    messages: [
      {
        role: 'user',
        content:
          `Business name: ${lead.business_name}\n` +
          `Category: ${lead.category || 'unknown'}\n` +
          `Rating: ${lead.rating ?? 'unknown'}\n` +
          `Review count: ${lead.review_count ?? 'unknown'}\n` +
          `Location: ${[lead.city, lead.state].filter(Boolean).join(', ') || 'unknown'}\n` +
          `Website: ${lead.website || 'none'}\n` +
          `AI lead-fit notes: ${lead.ai_reasoning || 'none'}\n\n` +
          'Write the proposal now.',
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock.text.trim();
}

router.post('/', async (req, res) => {
  const { lead_id } = req.body;

  if (!lead_id) {
    return res.status(400).json({ error: 'lead_id is required' });
  }

  const supabase = req.app.locals.supabase;

  try {
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .eq('user_id', req.userId)
      .single();

    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const content = await generateProposal(lead);

    const { data: proposal, error: insertError } = await supabase
      .from('proposals')
      .insert({
        user_id: req.userId,
        lead_id,
        content,
      })
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    res.status(201).json({ proposal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('proposals')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ proposals: data });
});

router.post('/:id/send', async (req, res) => {
  const supabase = req.app.locals.supabase;

  try {
    const { data: proposal, error: proposalError } = await supabase
      .from('proposals')
      .select('*, leads(business_name, email)')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (proposalError || !proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const lead = proposal.leads;
    if (!lead || !lead.email) {
      return res.status(400).json({ error: 'This lead has no email address on file' });
    }

    const { data: integration, error: integrationError } = await supabase
      .from('user_integrations')
      .select('config')
      .eq('user_id', req.userId)
      .eq('provider', 'email')
      .single();

    if (integrationError || !integration) {
      return res.status(400).json({ error: 'Connect your email in Settings before sending proposals' });
    }

    const transport = buildTransport(integration.config);
    await transport.sendMail({
      from: integration.config.email,
      to: lead.email,
      subject: `Proposal for ${lead.business_name}`,
      text: proposal.content,
    });

    const { data: updated, error: updateError } = await supabase
      .from('proposals')
      .update({ status: 'sent' })
      .eq('id', proposal.id)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    res.json({ proposal: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
