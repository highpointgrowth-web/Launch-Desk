const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const anthropic = new Anthropic();

const PIPELINE_STAGES = ['new', 'to_contact', 'contacted', 'meeting', 'proposal', 'won', 'lost'];

router.use(requireAuth);

function extractCityState(addressComponents = []) {
  const city = addressComponents.find((c) => c.types.includes('locality'))?.long_name || null;
  const state = addressComponents.find((c) => c.types.includes('administrative_area_level_1'))?.short_name || null;
  return { city, state };
}

async function searchPlaces(industry, location, radius) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
  url.searchParams.set('query', `${industry} in ${location}`);
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('key', process.env.GOOGLE_PLACES_API_KEY);

  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places search failed: ${data.status} ${data.error_message || ''}`);
  }
  return (data.results || []).slice(0, 20);
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

async function buildBusinessList(industry, location, radius) {
  const results = await searchPlaces(industry, location, radius);
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
    max_tokens: 8000,
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

router.post('/scrape', async (req, res) => {
  const { industry, location, radius } = req.body;

  if (!industry || !location) {
    return res.status(400).json({ error: 'industry and location are required' });
  }

  try {
    const businesses = await buildBusinessList(industry, location, radius || 5000);
    const scoredLeads = await scoreLeads(businesses);

    if (scoredLeads.length === 0) {
      return res.json({ leads: [] });
    }

    const rows = scoredLeads.map((lead) => ({ ...lead, user_id: req.userId }));

    const supabase = req.app.locals.supabase;
    const { data, error } = await supabase.from('leads').insert(rows).select();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ leads: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { pipeline_stage, owner_status } = req.body;
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

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'pipeline_stage or owner_status is required' });
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

module.exports = router;
