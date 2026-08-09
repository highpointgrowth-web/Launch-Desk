const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const { requireAuth } = require('../middleware/auth');
const { requirePaidPlan } = require('../middleware/plan');
const { PROPOSAL_CAPS } = require('../plan-constants');

async function enforceProposalCap(supabase, userId, plan) {
  const limit = PROPOSAL_CAPS[plan];
  if (limit == null) {
    const err = new Error('No proposal limit configured for your plan.');
    err.status = 500;
    throw err;
  }

  const { data: newCount, error: rpcError } = await supabase.rpc('increment_proposal_count', {
    p_user_id: userId,
    p_limit: limit,
  });

  if (rpcError) {
    throw new Error(`Failed to check proposal cap: ${rpcError.message}`);
  }

  if (newCount === null) {
    const err = new Error(
      `You've hit this month's limit of ${limit} proposals on your plan - it resets next month, or upgrade for a higher limit.`
    );
    err.status = 403;
    throw err;
  }
}

const router = express.Router();
const anthropic = new Anthropic();

// A 1x1 transparent PNG, served by the tracking pixel below.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// Unauthenticated on purpose - email clients load this as a plain <img>
// with no way to attach a bearer token. Registered before requireAuth
// below so it bypasses the router-wide auth gate, the same way the
// Retell/Stripe webhooks bypass it in server.js. Security is by
// unguessable proposal id, the standard model for tracking pixels.
router.get('/:id/pixel.png', async (req, res) => {
  const supabase = req.app.locals.supabase;

  await supabase
    .from('proposals')
    .update({ status: 'viewed', viewed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('status', 'sent');

  res.set('Content-Type', 'image/png');
  res.send(TRANSPARENT_PNG);
});

router.use(requireAuth);
router.use(requirePaidPlan);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

async function generateProposal(lead, proposalTemplate) {
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
      'proposal text - no preamble, no explanation, no markdown code fences.' +
      (proposalTemplate
        ? `\n\nFollow this template's structure and style as closely as possible:\n\n${proposalTemplate}`
        : ''),
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

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('plan, proposal_template')
      .eq('id', req.userId)
      .single();
    if (userError || !user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    await enforceProposalCap(supabase, req.userId, user.plan);
    const content = await generateProposal(lead, user.proposal_template);

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
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('proposals')
    .select('*, leads(business_name)')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ proposals: data });
});

router.get('/stats', async (req, res) => {
  const supabase = req.app.locals.supabase;

  const { data: proposals, error } = await supabase
    .from('proposals')
    .select('id, status, lead_id')
    .eq('user_id', req.userId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const sent = proposals.filter((p) => p.status !== 'draft');
  const viewed = sent.filter((p) => p.status === 'viewed' || p.status === 'closed');
  const leadIds = [...new Set(sent.map((p) => p.lead_id).filter(Boolean))];

  let wonLeadIds = new Set();
  if (leadIds.length > 0) {
    const { data: wonLeads, error: leadsError } = await supabase
      .from('leads')
      .select('id')
      .in('id', leadIds)
      .eq('user_id', req.userId)
      .eq('pipeline_stage', 'won');

    if (leadsError) {
      return res.status(500).json({ error: leadsError.message });
    }
    wonLeadIds = new Set(wonLeads.map((l) => l.id));
  }

  const wonProposals = sent.filter((p) => p.lead_id && wonLeadIds.has(p.lead_id));

  let mrrWon = 0;
  if (wonLeadIds.size > 0) {
    const { data: agentsForWonLeads, error: agentsError } = await supabase
      .from('agents')
      .select('lead_id, monthly_charge')
      .in('lead_id', [...wonLeadIds])
      .eq('user_id', req.userId);

    if (agentsError) {
      return res.status(500).json({ error: agentsError.message });
    }
    mrrWon = agentsForWonLeads.reduce((sum, a) => sum + (Number(a.monthly_charge) || 0), 0);
  }

  res.json({
    total_sent: sent.length,
    viewed_count: viewed.length,
    view_rate: sent.length ? viewed.length / sent.length : 0,
    won_count: wonProposals.length,
    close_rate: sent.length ? wonProposals.length / sent.length : 0,
    mrr_won: mrrWon,
  });
});

router.put('/template', async (req, res) => {
  const { proposal_template } = req.body;
  const supabase = req.app.locals.supabase;

  const { data, error } = await supabase
    .from('users')
    .update({ proposal_template: proposal_template || null })
    .eq('id', req.userId)
    .select('proposal_template')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ proposal_template: data.proposal_template });
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
    const pixelUrl = `${process.env.APP_URL}/api/proposals/${proposal.id}/pixel.png`;
    const htmlContent =
      `<div style="white-space:pre-wrap;font-family:sans-serif;font-size:14px;line-height:1.6">${escapeHtml(proposal.content)}</div>` +
      `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none">`;

    await transport.sendMail({
      from: integration.config.email,
      to: lead.email,
      subject: `Proposal for ${lead.business_name}`,
      text: proposal.content,
      html: htmlContent,
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
