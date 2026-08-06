const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { requirePaidPlan } = require('../middleware/plan');

const router = express.Router();
const anthropic = new Anthropic();

const RETELL_BASE = 'https://api.retellai.com';

// Pro and Agency are unlimited (no entry here); only Starter is capped,
// matching what the marketing page promises.
const PLAN_AGENT_LIMITS = { starter: 1 };

router.use(requireAuth);
router.use(requirePaidPlan);

async function retellFetch(method, path, body) {
  const res = await fetch(`${RETELL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Retell API error (${res.status}): ${data?.message || res.statusText}`);
  }
  return data;
}

async function scrapeWebsite(url) {
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(`Firecrawl scrape failed: ${data?.error || res.statusText}`);
  }
  return data.data.markdown;
}

function cleanScrapedContent(markdown) {
  if (!markdown) return '';

  // Strip raw HTML tags/artifacts that sometimes leak into "markdown" scrape output.
  let text = markdown.replace(/<[^>]+>/g, ' ');

  // Convert markdown links/images to plain text - keep the label, drop the URL.
  // (Also neutralizes malformed links like "[Name](https://.../maps/contrib/...)".)
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');

  const junkLinePatterns = [
    /reviews?\s*&\s*testimonials/i,
    /^#+.*_\s*$/, // garbled/truncated headings ending in an underscore (widget artifacts)
    /^\d+(\.\d+)?\s*(stars?|★|⭐)/i,
    /^(read more|see all reviews?|leave a review|write a review|google reviews?)$/i,
    /^(home|about|about us|services|contact|contact us|menu|blog|careers)$/i,
    /^(faq|frequently asked questions)$/i,
    /^(privacy policy|terms of service|terms (and|&) conditions|sitemap)$/i,
    /^©.*$/,
    /all rights reserved/i,
    /^(facebook|twitter|instagram|linkedin|youtube|tiktok|x)$/i,
    /^\.{3,}$/,
  ];

  const seenHeadings = new Set();
  const cleanedLines = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (junkLinePatterns.some((pattern) => pattern.test(line))) continue;

    // Drop repeated/garbled headings - a strong signal of scraped widget or nav cruft.
    if (/^#{1,6}\s/.test(line)) {
      const normalized = line.replace(/[#_*]+/g, '').trim().toLowerCase();
      if (!normalized || seenHeadings.has(normalized)) continue;
      seenHeadings.add(normalized);
    }

    cleanedLines.push(line);
  }

  return cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Leads with no website (common for exactly the kind of local business worth
// pitching - "no website" is itself a sales signal) shouldn't block agent
// creation. Falls back to the structured details already captured from
// Google Places at lead-search time instead of scraping anything new.
function buildLeadDetailsSummary(lead) {
  const lines = [];
  if (lead.category) lines.push(`Category/trade: ${lead.category}`);
  if (lead.address) lines.push(`Address: ${lead.address}`);
  else if (lead.city || lead.state) lines.push(`Location: ${[lead.city, lead.state].filter(Boolean).join(', ')}`);
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.rating != null) lines.push(`Google rating: ${lead.rating} (${lead.review_count ?? 'unknown'} reviews)`);
  return lines.join('\n');
}

async function generateSystemPrompt(businessName, niche, content, extraContext, isStructuredFallback) {
  const cleanedContent = isStructuredFallback ? content : cleanScrapedContent(content).slice(0, 15000);

  const contentLabel = isStructuredFallback
    ? 'This business has no website, so only these known details are available (not scraped site content):'
    : 'Website content:';

  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2000,
    output_config: { effort: 'medium' },
    system:
      "You write system prompts for AI phone voice agents. Given a business's available details, write a " +
      'complete system prompt for a voice agent that answers calls, represents the business accurately, and ' +
      'helps with the niche use case described. Ignore any reviews, testimonials, navigation, or footer ' +
      'content - your job is to write a clean AI receptionist system prompt for this business using only ' +
      'the business name, services, hours, location, and contact info actually available. If only category, ' +
      "location, and rating are available (no website content), write a general but professional prompt for " +
      "that category of business rather than inventing specific services or hours. Respond with only " +
      'the system prompt text - no preamble, no explanation, no markdown formatting.',
    messages: [
      {
        role: 'user',
        content:
          `Business name: ${businessName}\nNiche/use case: ${niche}\n\n${contentLabel}\n${cleanedContent}` +
          (extraContext ? `\n\nAdditional business details supplied by the agency (use these too):\n${extraContext}` : ''),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock.text.trim();
}

function createRetellLlm(generalPrompt, beginMessage) {
  return retellFetch('POST', '/create-retell-llm', {
    general_prompt: generalPrompt,
    ...(beginMessage ? { begin_message: beginMessage } : {}),
  });
}

function createRetellAgent(agentName, voiceId, llmId) {
  return retellFetch('POST', '/create-agent', {
    agent_name: agentName,
    voice_id: voiceId,
    response_engine: { type: 'retell-llm', llm_id: llmId },
    webhook_url: `${process.env.APP_URL}/api/webhooks/retell`,
    post_call_analysis_data: [
      {
        type: 'boolean',
        name: 'booked',
        description: 'Whether the caller booked an appointment during the call',
        required: true,
      },
      {
        type: 'string',
        name: 'summary',
        description: 'A brief summary of what happened during the call',
        required: false,
      },
    ],
  });
}

function getRetellAgent(agentId) {
  return retellFetch('GET', `/get-agent/${agentId}`);
}

function updateRetellLlm(llmId, fields) {
  return retellFetch('PATCH', `/update-retell-llm/${llmId}`, fields);
}

function deleteRetellAgent(agentId) {
  return retellFetch('DELETE', `/delete-agent/${agentId}`);
}

function deleteRetellLlm(llmId) {
  return retellFetch('DELETE', `/delete-retell-llm/${llmId}`);
}

function buyRetellPhoneNumber(retellAgentId, areaCode) {
  return retellFetch('POST', '/create-phone-number', {
    inbound_agent_id: retellAgentId,
    ...(areaCode ? { area_code: Number(areaCode) } : {}),
  });
}

function deleteRetellPhoneNumber(phoneNumber) {
  return retellFetch('DELETE', `/delete-phone-number/${encodeURIComponent(phoneNumber)}`);
}

async function resolveSystemPrompt(lead, niche, websiteOverride, extraContext) {
  const websiteToScrape = websiteOverride || lead.website;
  if (websiteToScrape) {
    const scrapedContent = await scrapeWebsite(websiteToScrape);
    return generateSystemPrompt(lead.business_name, niche, scrapedContent, extraContext, false);
  }
  const leadDetails = buildLeadDetailsSummary(lead);
  return generateSystemPrompt(lead.business_name, niche, leadDetails, extraContext, true);
}

router.post('/preview-prompt', async (req, res) => {
  const { lead_id, niche, website_override, extra_context } = req.body;

  if (!lead_id || !niche) {
    return res.status(400).json({ error: 'lead_id and niche are required' });
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

    const systemPrompt = await resolveSystemPrompt(lead, niche, website_override, extra_context);
    res.json({ system_prompt: systemPrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/build', async (req, res) => {
  const {
    lead_id,
    niche,
    agent_name,
    voice,
    greeting,
    cal_api_key,
    cal_event_type_id,
    website_override,
    extra_context,
    transfer_number,
    system_prompt,
  } = req.body;

  if (!lead_id || !niche || !agent_name || !voice) {
    return res.status(400).json({ error: 'lead_id, niche, agent_name, and voice are required' });
  }

  const supabase = req.app.locals.supabase;

  try {
    const { data: user, error: userError } = await supabase.from('users').select('plan').eq('id', req.userId).single();
    if (userError || !user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const agentLimit = PLAN_AGENT_LIMITS[user.plan];
    if (agentLimit != null) {
      const { count, error: countError } = await supabase
        .from('agents')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.userId);

      if (countError) {
        return res.status(500).json({ error: countError.message });
      }

      if (count >= agentLimit) {
        return res.status(403).json({
          error: `Your plan is limited to ${agentLimit} AI agent${agentLimit === 1 ? '' : 's'} - upgrade to Pro for unlimited agents.`,
        });
      }
    }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .eq('user_id', req.userId)
      .single();

    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // A pre-generated prompt (from the builder's review step) is used as-is,
    // including any hand edits - only falls back to generating fresh if none
    // was supplied, so direct API callers keep working unchanged.
    const systemPrompt = system_prompt || (await resolveSystemPrompt(lead, niche, website_override, extra_context));

    const llm = await createRetellLlm(systemPrompt, greeting);
    const retellAgent = await createRetellAgent(agent_name, voice, llm.llm_id);

    const { data: agent, error: insertError } = await supabase
      .from('agents')
      .insert({
        user_id: req.userId,
        lead_id,
        business_name: lead.business_name,
        niche,
        agent_name,
        voice,
        greeting: greeting || null,
        system_prompt: systemPrompt,
        transfer_number: transfer_number || null,
        retell_agent_id: retellAgent.agent_id,
        retell_llm_id: llm.llm_id,
        retell_phone_number: null,
        cal_api_key: cal_api_key || null,
        cal_event_type_id: cal_event_type_id || null,
        status: 'active',
      })
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    res.status(201).json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ agents: data });
});

router.get('/:id', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  res.json({ agent: data });
});

router.get('/:id/calls', async (req, res) => {
  const supabase = req.app.locals.supabase;

  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (agentError || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const { data: callLogs, error } = await supabase
    .from('call_logs')
    .select('*')
    .eq('agent_id', agent.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ call_logs: callLogs });
});

router.put('/:id', async (req, res) => {
  const { system_prompt, greeting, voice, cal_api_key, cal_event_type_id, monthly_charge, transfer_number } = req.body;
  const updates = {};

  if (system_prompt !== undefined) updates.system_prompt = system_prompt;
  if (greeting !== undefined) updates.greeting = greeting;
  if (voice !== undefined) updates.voice = voice;
  if (cal_api_key !== undefined) updates.cal_api_key = cal_api_key;
  if (cal_event_type_id !== undefined) updates.cal_event_type_id = cal_event_type_id;
  if (monthly_charge !== undefined) updates.monthly_charge = monthly_charge;
  if (transfer_number !== undefined) updates.transfer_number = transfer_number;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('agents')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();

  if (error) {
    return res.status(404).json({ error: error.message });
  }

  res.json({ agent: data });
});

router.delete('/:id', async (req, res) => {
  const supabase = req.app.locals.supabase;

  const { data: agent, error: fetchError } = await supabase
    .from('agents')
    .select('retell_agent_id, retell_llm_id, retell_phone_number')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (fetchError || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // A purchased number keeps costing us rent on Retell's side until it's
  // explicitly released - deleting the agent alone doesn't free it.
  if (agent.retell_phone_number) {
    try {
      await deleteRetellPhoneNumber(agent.retell_phone_number);
    } catch (err) {
      // Continue with local deletion even if the Retell-side release fails
      // (e.g. it was already removed there).
    }
  }

  if (agent.retell_agent_id) {
    try {
      await deleteRetellAgent(agent.retell_agent_id);
    } catch (err) {
      // Continue with local deletion even if the Retell-side delete fails
      // (e.g. the agent was already removed there).
    }
  }

  if (agent.retell_llm_id) {
    try {
      await deleteRetellLlm(agent.retell_llm_id);
    } catch (err) {
      // Same as above - don't block local cleanup on a Retell-side failure.
    }
  }

  const { error: deleteError } = await supabase
    .from('agents')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId);

  if (deleteError) {
    return res.status(500).json({ error: deleteError.message });
  }

  res.status(204).send();
});

router.post('/:id/sync', async (req, res) => {
  const supabase = req.app.locals.supabase;

  const { data: agent, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (error || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  if (!agent.retell_agent_id) {
    return res.status(400).json({ error: 'Agent has no linked Retell agent' });
  }

  try {
    const retellAgent = await getRetellAgent(agent.retell_agent_id);
    const llmId = retellAgent.response_engine?.llm_id;

    if (!llmId) {
      return res.status(400).json({ error: 'Retell agent is not backed by a Retell LLM' });
    }

    await updateRetellLlm(llmId, {
      general_prompt: agent.system_prompt,
      ...(agent.greeting ? { begin_message: agent.greeting } : {}),
    });

    res.json({ synced: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/buy-phone', async (req, res) => {
  const { area_code } = req.body;
  const supabase = req.app.locals.supabase;

  const { data: agent, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (error || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  if (!agent.retell_agent_id) {
    return res.status(400).json({ error: 'Agent has no linked Retell agent' });
  }

  if (agent.retell_phone_number) {
    return res.status(400).json({ error: 'Agent already has a phone number' });
  }

  try {
    const phoneNumber = await buyRetellPhoneNumber(agent.retell_agent_id, area_code);

    const { data: updated, error: updateError } = await supabase
      .from('agents')
      .update({ retell_phone_number: phoneNumber.phone_number })
      .eq('id', agent.id)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    res.status(201).json({ agent: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
