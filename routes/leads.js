const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { requirePaidPlan } = require('../middleware/plan');
const { COLD_CALL_SCRIPT_CAPS } = require('../plan-constants');

async function enforceColdCallScriptCap(supabase, userId, plan) {
  const limit = COLD_CALL_SCRIPT_CAPS[plan];
  if (limit == null) {
    const err = new Error('No cold-call-script limit configured for your plan.');
    err.status = 500;
    throw err;
  }

  const { data: newCount, error: rpcError } = await supabase.rpc('increment_cold_call_script_count', {
    p_user_id: userId,
    p_limit: limit,
  });

  if (rpcError) {
    throw new Error(`Failed to check cold-call-script cap: ${rpcError.message}`);
  }

  if (newCount === null) {
    const err = new Error(
      `You've hit this month's limit of ${limit} cold-call scripts on your plan - it resets next month, or upgrade for a higher limit.`
    );
    err.status = 403;
    throw err;
  }
}

const router = express.Router();
const anthropic = new Anthropic();

const PIPELINE_STAGES = ['new', 'to_contact', 'contacted', 'meeting', 'proposal', 'won', 'lost'];
const ACTIVITY_TYPES = ['call', 'email', 'dm'];
const MAX_RESULTS_OPTIONS = [10, 25, 50, 100];
const DEFAULT_MAX_RESULTS = 25;

router.use(requireAuth);
router.use(requirePaidPlan);

function extractCityState(addressComponents = []) {
  const city = addressComponents.find((c) => c.types.includes('locality'))?.long_name || null;
  const state = addressComponents.find((c) => c.types.includes('administrative_area_level_1'))?.short_name || null;
  return { city, state };
}

// Google Places Text Search caps each page at 20 results. Fetching more
// than that means following next_page_token across pages, each of which
// needs a short delay before the token is valid.
async function searchPlaces(industry, location, radius, maxResults, countryCode) {
  const results = [];
  let pageToken = null;

  while (results.length < maxResults) {
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    if (pageToken) {
      url.searchParams.set('pagetoken', pageToken);
    } else {
      url.searchParams.set('query', `${industry} in ${location}`);
      url.searchParams.set('radius', String(radius));
      // Biases results toward the chosen country - the query text alone
      // (e.g. a city that exists in multiple countries) can otherwise
      // resolve to the wrong one.
      if (countryCode) url.searchParams.set('region', countryCode.toLowerCase());
    }
    url.searchParams.set('key', process.env.GOOGLE_PLACES_API_KEY);

    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places search failed: ${data.status} ${data.error_message || ''}`);
    }

    results.push(...(data.results || []));

    if (!data.next_page_token || results.length >= maxResults) break;
    pageToken = data.next_page_token;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return results.slice(0, maxResults);
}

async function getPlaceDetails(placeId) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  // rating/user_ratings_total deliberately excluded - Text Search already
  // returns both for free, and Google bills a Details call at its highest
  // requested field's tier, so asking for those two here would silently
  // double the cost of every lookup for data we already have.
  url.searchParams.set(
    'fields',
    'name,formatted_phone_number,website,formatted_address,address_components'
  );
  url.searchParams.set('key', process.env.GOOGLE_PLACES_API_KEY);

  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(`Google Places details failed: ${data.status} ${data.error_message || ''}`);
  }
  return data.result;
}

async function buildBusinessList(industry, location, radius, maxResults, countryCode) {
  const results = await searchPlaces(industry, location, radius, maxResults, countryCode);
  const details = await Promise.all(results.map((r) => getPlaceDetails(r.place_id)));

  // rating/user_ratings_total come from the Text Search result, not the
  // Details call - see the comment in getPlaceDetails. `details` and
  // `results` stay in the same order since details was built with
  // results.map(), so they're paired by index.
  return details.map((d, i) => {
    const { city, state } = extractCityState(d.address_components);
    return {
      business_name: d.name,
      phone: d.formatted_phone_number || null,
      email: null,
      website: d.website || null,
      address: d.formatted_address || null,
      city,
      state,
      rating: results[i].rating ?? null,
      review_count: results[i].user_ratings_total ?? null,
      category: industry,
    };
  });
}

async function scoreLeads(businesses) {
  if (businesses.length === 0) return [];

  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000, // headroom for up to 100 scored leads in one batch
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            leads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  ai_score: { type: 'number' },
                  ai_reasoning: { type: 'string' },
                  recommended_agents: { type: 'array', items: { type: 'string' } },
                },
                required: ['index', 'ai_score', 'ai_reasoning', 'recommended_agents'],
                additionalProperties: false,
              },
            },
          },
          required: ['leads'],
          additionalProperties: false,
        },
      },
    },
    system:
      'You score local businesses as sales leads for LaunchDesk, an agency that builds and sells AI voice agents ' +
      '(phone answering, booking, lead qualification) to local businesses. For each business, give an ai_score ' +
      'from 0-100 for how good a fit they are (consider review count, rating, category, and likely call volume), ' +
      'ai_reasoning explaining the score in 1-2 sentences, and recommended_agents listing which AI agent types ' +
      '(e.g. "Booking Agent", "Receptionist Agent", "Lead Qualification Agent", "After-Hours Agent") would suit them.',
    messages: [
      {
        role: 'user',
        content: `Score these ${businesses.length} businesses. Preserve the input index for each.\n\n${JSON.stringify(
          businesses.map((b, index) => ({ index, ...b })),
          null,
          2
        )}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const parsed = JSON.parse(textBlock.text);

  const scoresByIndex = new Map(parsed.leads.map((l) => [l.index, l]));
  return businesses.map((b, index) => {
    const score = scoresByIndex.get(index);
    return {
      ...b,
      ai_score: score?.ai_score ?? null,
      ai_reasoning: score?.ai_reasoning ?? null,
      recommended_agents: score?.recommended_agents ?? [],
    };
  });
}

async function generateColdCallScript(lead, agencyName) {
  // LaunchDesk is the internal tool the caller uses, not the business the
  // prospect should hear about - the caller represents their own agency.
  const callerAgency = agencyName || '[Your Agency]';

  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1200,
    output_config: { effort: 'low' },
    system:
      'You write short, natural-sounding cold call scripts for a local AI-receptionist agency. The caller works ' +
      `for "${callerAgency}" - always use that exact name when the caller introduces themselves or their ` +
      'company, and use the placeholder "[Your Name]" for the caller\'s own personal name, since you don\'t ' +
      "know it. Given one specific business, write a personalized cold call script the caller can read from - " +
      "it must mention the business's actual name, their trade/category, their location, and reference a " +
      'specific, relevant pain point for that kind of business (e.g. missed calls during jobs, no after-hours ' +
      'coverage, no-shows). Structure it as: an opener, a short value pitch, one line for a "not interested" ' +
      'objection, and one line for a "send me info" objection. Keep it conversational and under 150 words ' +
      'total. Respond with only the script text - no preamble, no explanation, no markdown formatting.',
    messages: [
      {
        role: 'user',
        content:
          `Business name: ${lead.business_name}\n` +
          `Category/trade: ${lead.category || 'unknown'}\n` +
          `Location: ${[lead.city, lead.state].filter(Boolean).join(', ') || 'unknown'}\n` +
          `Rating: ${lead.rating ?? 'unknown'}\n` +
          `Review count: ${lead.review_count ?? 'unknown'}\n` +
          `AI fit notes: ${lead.ai_reasoning || 'none'}\n\n` +
          'Write the cold call script now.',
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock.text.trim();
}

router.post('/:id/cold-call-script', async (req, res) => {
  const supabase = req.app.locals.supabase;

  try {
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('plan, agency_name')
      .eq('id', req.userId)
      .single();
    if (userError || !user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    await enforceColdCallScriptCap(supabase, req.userId, user.plan);
    const script = await generateColdCallScript(lead, user.agency_name);
    res.json({ script });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/scrape', async (req, res) => {
  const { industry, location, radius, max_results, country } = req.body;

  if (!industry || !location) {
    return res.status(400).json({ error: 'industry and location are required' });
  }

  const requestedMaxResults = MAX_RESULTS_OPTIONS.includes(Number(max_results)) ? Number(max_results) : DEFAULT_MAX_RESULTS;
  const supabase = req.app.locals.supabase;

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('scrape_credits_used, scrape_credits_limit')
    .eq('id', req.userId)
    .single();

  if (userError || !user) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  const remainingCredits = user.scrape_credits_limit - user.scrape_credits_used;
  if (remainingCredits <= 0) {
    return res.status(403).json({ error: "You've used all your scrape credits for this month." });
  }

  // Capping the actual search to whatever's left (rather than only blocking
  // once already over) stops a single large search from ever running past
  // the monthly limit - each business found still costs a real Google/Claude
  // call, so this bounds that spend to what's actually left, not just what
  // was requested.
  const maxResults = Math.min(requestedMaxResults, remainingCredits);

  try {
    const businesses = await buildBusinessList(industry, location, radius || 5000, maxResults, country);
    const scoredLeads = await scoreLeads(businesses);
    scoredLeads.sort((a, b) => (b.ai_score ?? -1) - (a.ai_score ?? -1));

    if (scoredLeads.length > 0) {
      const { error: creditError } = await supabase
        .from('users')
        .update({ scrape_credits_used: user.scrape_credits_used + scoredLeads.length })
        .eq('id', req.userId);

      if (creditError) {
        // The scrape itself succeeded and the user already paid the API cost for
        // it - don't withhold their results over a bookkeeping update failing.
        console.error(`Failed to increment scrape_credits_used for user ${req.userId}: ${creditError.message}`);
      }
    }

    const { error: searchLogError } = await supabase.from('lead_searches').insert({
      user_id: req.userId,
      industry,
      location,
      radius: radius || 5000,
      result_count: scoredLeads.length,
      results: scoredLeads,
    });

    if (searchLogError) {
      // Same reasoning as the credit-increment failure above - the scrape
      // already succeeded, don't fail the response over a logging write.
      console.error(`Failed to log lead search for user ${req.userId}: ${searchLogError.message}`);
    }

    res.json({ leads: scoredLeads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/searches', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('lead_searches')
    .select('id, industry, location, radius, result_count, created_at')
    .eq('user_id', req.userId)
    .gte('created_at', startOfMonth.toISOString())
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ searches: data });
});

router.get('/searches/:id', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('lead_searches')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Search not found' });
  }

  res.json({ search: data });
});

router.post('/', async (req, res) => {
  const {
    business_name,
    phone,
    email,
    website,
    address,
    city,
    state,
    rating,
    review_count,
    category,
    ai_score,
    ai_reasoning,
    recommended_agents,
    pipeline_stage,
    owner_status,
    notes,
  } = req.body;

  if (!business_name) {
    return res.status(400).json({ error: 'business_name is required' });
  }

  if (pipeline_stage !== undefined && !PIPELINE_STAGES.includes(pipeline_stage)) {
    return res.status(400).json({ error: `pipeline_stage must be one of: ${PIPELINE_STAGES.join(', ')}` });
  }

  const supabase = req.app.locals.supabase;

  if (phone) {
    const { data: existing, error: existingError } = await supabase
      .from('leads')
      .select('*')
      .eq('user_id', req.userId)
      .eq('phone', phone)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ error: existingError.message });
    }

    if (existing) {
      return res.json({ lead: existing, already_exists: true });
    }
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      user_id: req.userId,
      business_name,
      phone: phone || null,
      email: email || null,
      website: website || null,
      address: address || null,
      city: city || null,
      state: state || null,
      rating: rating ?? null,
      review_count: review_count ?? null,
      category: category || null,
      ai_score: ai_score ?? null,
      ai_reasoning: ai_reasoning || null,
      recommended_agents: recommended_agents || null,
      pipeline_stage: pipeline_stage || 'to_contact',
      owner_status: owner_status || null,
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ lead: data });
});

router.get('/', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ leads: data });
});

router.put('/:id', async (req, res) => {
  const { pipeline_stage, owner_status, email, notes } = req.body;
  const updates = {};

  if (pipeline_stage !== undefined) {
    if (!PIPELINE_STAGES.includes(pipeline_stage)) {
      return res.status(400).json({ error: `pipeline_stage must be one of: ${PIPELINE_STAGES.join(', ')}` });
    }
    updates.pipeline_stage = pipeline_stage;
  }

  if (owner_status !== undefined) {
    updates.owner_status = owner_status;
  }

  if (email !== undefined) {
    updates.email = email;
  }

  if (notes !== undefined) {
    updates.notes = notes;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'pipeline_stage, owner_status, email, or notes is required' });
  }

  const supabase = req.app.locals.supabase;
  const { data, error } = await supabase
    .from('leads')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();

  if (error) {
    return res.status(404).json({ error: error.message });
  }

  res.json({ lead: data });
});

router.delete('/:id', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { error } = await supabase.from('leads').delete().eq('id', req.params.id).eq('user_id', req.userId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(204).send();
});

router.get('/activity-summary', async (req, res) => {
  const supabase = req.app.locals.supabase;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('lead_activities')
    .select('type, occurred_at')
    .eq('user_id', req.userId)
    .gte('occurred_at', weekAgo.toISOString());

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const today = { call: 0, email: 0, dm: 0 };
  const week = { call: 0, email: 0, dm: 0 };

  for (const activity of data) {
    if (week[activity.type] !== undefined) week[activity.type] += 1;
    if (today[activity.type] !== undefined && new Date(activity.occurred_at) >= startOfToday) {
      today[activity.type] += 1;
    }
  }

  res.json({ today, week });
});

router.get('/:id/activities', async (req, res) => {
  const supabase = req.app.locals.supabase;

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (leadError || !lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const { data, error } = await supabase
    .from('lead_activities')
    .select('*')
    .eq('lead_id', lead.id)
    .order('occurred_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ activities: data });
});

router.post('/:id/activities', async (req, res) => {
  const { type, notes, occurred_at } = req.body;

  if (!type || !ACTIVITY_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${ACTIVITY_TYPES.join(', ')}` });
  }

  const supabase = req.app.locals.supabase;

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (leadError || !lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const { data, error } = await supabase
    .from('lead_activities')
    .insert({
      user_id: req.userId,
      lead_id: lead.id,
      type,
      notes: notes || null,
      ...(occurred_at ? { occurred_at } : {}),
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ activity: data });
});

module.exports = router;
