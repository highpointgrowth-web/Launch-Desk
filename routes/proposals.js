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

function buildRoiPageHtml({ agencyName, businessName }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>What missed calls are costing ${escapeHtml(businessName)}</title>
<style>
:root{--bg:#0a0a0a;--surface:#0f0f0f;--surface2:#151515;--border:#181818;--border2:#242424;--ink:#f0f0f8;--ink2:#8080a0;--indigo:#a78bfa;--indigo-dark:#6d28d9;--green:#4ade80}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:'Inter',system-ui,sans-serif;line-height:1.5;padding:32px 16px;display:flex;justify-content:center}
.card{max-width:520px;width:100%}
.eyebrow{color:var(--indigo);font-size:12.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
h1{font-size:26px;font-weight:700;margin-bottom:24px;line-height:1.25}
.row{margin-bottom:22px}
.row label{display:flex;justify-content:space-between;font-size:13.5px;color:var(--ink2);margin-bottom:8px}
.row label span:last-child{color:var(--ink);font-weight:600}
input[type=range]{width:100%;accent-color:var(--indigo)}
.result{background:var(--surface2);border:1px solid var(--border2);border-radius:14px;padding:24px;text-align:center;margin-top:8px}
.result .label{font-size:12px;color:var(--ink2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.result .amount{font-size:42px;font-weight:700;color:var(--green)}
.result .basis{font-size:12.5px;color:var(--ink2);margin-top:8px}
.footer{margin-top:28px;font-size:12.5px;color:var(--ink2);text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="eyebrow">Revenue Impact</div>
  <h1>What missed calls are costing ${escapeHtml(businessName)}</h1>

  <div class="row">
    <label><span>Missed calls per day</span><span id="callsVal">5</span></label>
    <input type="range" id="calls" min="1" max="20" value="5">
  </div>

  <div class="row">
    <label><span>Average value per job</span><span id="valueVal">$250</span></label>
    <input type="range" id="value" min="50" max="5000" step="50" value="250">
  </div>

  <div class="result">
    <div class="label">Estimated Monthly Lost Revenue</div>
    <div class="amount" id="lostRevenue">$37,500</div>
    <div class="basis" id="basis">Based on 5 missed calls/day × $250/job × 30 days</div>
  </div>

  <div class="footer">Prepared by ${escapeHtml(agencyName)}</div>
</div>
<script>
const calls = document.getElementById('calls');
const value = document.getElementById('value');
const callsVal = document.getElementById('callsVal');
const valueVal = document.getElementById('valueVal');
const lostRevenue = document.getElementById('lostRevenue');
const basis = document.getElementById('basis');

function fmt(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

function update() {
  const c = Number(calls.value);
  const v = Number(value.value);
  callsVal.textContent = c;
  valueVal.textContent = fmt(v);
  lostRevenue.textContent = fmt(c * v * 30);
  basis.textContent = \`Based on \${c} missed calls/day × \${fmt(v)}/job × 30 days\`;
}

calls.addEventListener('input', update);
value.addEventListener('input', update);
</script>
</body>
</html>`;
}

router.get('/:id/roi', async (req, res) => {
  const supabase = req.app.locals.supabase;

  const { data: proposal, error: proposalError } = await supabase
    .from('proposals')
    .select('user_id, leads(business_name)')
    .eq('id', req.params.id)
    .single();

  if (proposalError || !proposal) {
    return res.status(404).send('Proposal not found');
  }

  const { data: user } = await supabase
    .from('users')
    .select('agency_name')
    .eq('id', proposal.user_id)
    .single();

  res.set('Content-Type', 'text/html');
  res.send(
    buildRoiPageHtml({
      agencyName: user?.agency_name || 'Your AI Agency',
      businessName: proposal.leads?.business_name || 'your business',
    })
  );
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

async function generateProposal(lead, proposalTemplate, agencyName) {
  // LaunchDesk is the internal tool the caller uses, not the agency the
  // prospect should hear about - the proposal is sold under the caller's
  // own agency name, matching how cold-call scripts already do this.
  const callerAgency = agencyName || '[Your Agency]';

  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 3000,
    output_config: { effort: 'medium' },
    system:
      `You write professional sales proposals for "${callerAgency}", an agency that sells AI voice receptionist ` +
      "agents to local businesses - always use that exact name for the agency sending this proposal, never " +
      "\"LaunchDesk\" (that's the internal software the agency uses, not their own brand). Given a prospect's " +
      'business details, write a persuasive but honest proposal that shows the ROI of adding an AI receptionist ' +
      'for that specific business - reference their actual rating, review count, and category to ground the ' +
      'pitch, and include a concrete (labeled as estimated) ROI calculation such as missed-call recovery and the ' +
      'value of after-hours coverage. Respond with only the proposal text - no preamble, no explanation, no ' +
      'markdown code fences.' +
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
      .select('plan, proposal_template, agency_name')
      .eq('id', req.userId)
      .single();
    if (userError || !user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    await enforceProposalCap(supabase, req.userId, user.plan);
    const content = await generateProposal(lead, user.proposal_template, user.agency_name);

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
    const roiUrl = `${process.env.APP_URL}/api/proposals/${proposal.id}/roi`;
    const htmlContent =
      `<div style="white-space:pre-wrap;font-family:sans-serif;font-size:14px;line-height:1.6">${escapeHtml(proposal.content)}</div>` +
      `<div style="margin:24px 0"><a href="${roiUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-family:sans-serif;font-size:14px;font-weight:600">See what missed calls are costing you &rarr;</a></div>` +
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
