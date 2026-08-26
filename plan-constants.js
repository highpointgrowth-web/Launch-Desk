// Single source of truth for what each plan includes - was previously
// duplicated separately in routes/admin.js and routes/stripe.js, which could
// silently drift out of sync with each other.
//
// PLAN_CREDITS is the monthly scrape-credit allowance (1 credit = 1 scored
// business from Lead Finder, not 1 search - a single search can burn dozens
// of credits at once). Real cost per credit is ~$0.039 (Google Places Text
// Search $32/1000 calls + Place Details $35/1000 calls, verified against
// Google's current published pricing, plus a small Claude Opus scoring
// cost) - the previous caps (100/1000/2500) were benchmarked against
// competitor tiers, never against this real per-credit cost, and left Pro
// and Agency losing money in the true worst case. Agency was cut from 2500
// to 2000 to fix that; Starter and Pro were already fine once the real
// number was used instead of a guess.
const PLAN_CREDITS = { starter: 100, pro: 1000, agency: 2000 };

// Monthly caps on AI-generation actions whose cost is real but bundled into
// the subscription rather than metered from the prepaid balance. Real cost
// per unit (verified against Claude Opus 5's current $5/$25 per-MTok pricing
// and actual token counts in the code, plus Firecrawl's published per-page
// pricing for builds) is far cheaper than the older $0.75/$0.50/$0.25
// guesses this comment used to cite: agent builds ~$0.07 each (mostly
// Claude prompt generation, Firecrawl scraping is a rounding error),
// proposals ~$0.03, cold-call scripts ~$0.01. Combined with the corrected
// PLAN_CREDITS above, true worst-case margin (every category maxed on the
// same account in the same month) is roughly Starter 77%, Pro 17%,
// Agency 18% - see the profit-audit conversation this was derived from
// for the full math if these assumptions ever need re-checking.
const AGENT_BUILD_CAPS = { starter: 3, pro: 20, agency: 35 };
const PROPOSAL_CAPS = { starter: 5, pro: 9, agency: 18 };
const COLD_CALL_SCRIPT_CAPS = { starter: 8, pro: 18, agency: 36 };

module.exports = { PLAN_CREDITS, AGENT_BUILD_CAPS, PROPOSAL_CAPS, COLD_CALL_SCRIPT_CAPS };
