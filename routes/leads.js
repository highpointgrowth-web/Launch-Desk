const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const anthropic = new Anthropic();

const PIPELINE_STAGES = ['new', 'to_contact', 'contacted', 'meeting', 'proposal', 'won', 'lost'];
const ACTIVITY_TYPES = ['call', 'email', 'dm'];
const MAX_RESULTS_OPTIONS = [10, 25, 50, 100];
const DEFAULT_MAX_RESULTS = 25;

router.use(requireAuth);

function extractCityState(addressComponents = []) {
  const city = addressComponents.find((c) => c.types.includes('locality'))?.long_name || null;
  const state = addressComponents.find((c) => c.types.includes('administrative_area_level_1'))?.short_name || null;
  return { city, state };
}

// Google Places Text Search caps each page at 20 results. Fetching more
// than that means following next_page_token across pages, each of which
// needs a short delay before the token is valid.
async function searchPlaces(industry, location, radius, maxResults) {
  const results = [];
  let pageToken = null;

  while (results.length < maxResults) {
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    if (pageToken) {
      url.searchParams.set('pagetoken', pageToken);
    } else {
      url.searchParams.set('query', `${industry} in ${location}`);
      url.searchParams.set('radius', String(radius));
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
  url.searchParams.set(
    'fields',
    'name,formatted_phone_number,website,formatted_address,address_components,rating,user_ratings_total'
  );
  url.searchParams.set('key', process.env.GOOGLE_PLACES_API_KEY);

  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(`Google Places details failed: ${data.status} ${data.error_message || ''}`);
  }
  return data.result;
}

async function buildBusinessList(industry, location, radius, maxResults) {
  const results = await searchPlaces(industry, location, radius, maxResults);
  const details = await Promise.all(results.map((r) => getPlaceDetails(r.place_id)));

  return details.map((d) => {
    const { city, state } = extractCityState(d.address_components);
    return {
      business_name: d.name,
      phone: d.formatted_phone_number || null,
      email: null,
      website: d.website || null,
      address: d.formatted_address || null,
      city,
      state,
      rating: d.rating ?? null,
      review_count: d.user_ratings_total ?? null,
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

async function generateColdCallScript(lead) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1200,
    output_config: { effort: 'low' },
    system:
      'You write short, natural-sounding cold call scripts for LaunchDesk, an agency that sells AI voice ' +
      'receptionist agents to local businesses. Given one specific business, write a personalized cold call ' +
      "script the caller can read from - it must mention the business's actual name, their trade/category, " +
      'their location, and reference a specific, relevant pain point for that kind of business (e.g. missed ' +
      'calls during jobs, no after-hours coverage, no-shows). Structure it as: an opener, a short value pitch, ' +
      'one line for a "not interested" objection, and one line for a "send me info" objection. Keep it ' +
      'conversational and under 150 words total. Respond with only the script text - no preamble, no ' +
      'explanation, no markdown formatting.',
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

    const script = await generateColdCallScript(lead);
    res.json({ script });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/scrape', async (req, res) => {
  const { industry, location, radius, max_results } = req.body;

  if (!industry || !location) {
    return res.status(400).json({ error: 'industry and location are required' });
  }

  const maxResults = MAX_RESULTS_OPTIONS.includes(Number(max_results)) ? Number(max_results) : DEFAULT_MAX_RESULTS;

  try {
    const businesses = await buildBusinessList(industry, location, radius || 5000, maxResults);
    const scoredLeads = await scoreLeads(businesses);
    res.json({ leads: scoredLeads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
