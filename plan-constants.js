// Single source of truth for what each plan includes - was previously
// duplicated separately in routes/admin.js and routes/stripe.js, which could
// silently drift out of sync with each other.
const PLAN_CREDITS = { starter: 100, pro: 1000, agency: 2500 };

// Monthly caps on AI-generation actions whose cost is real but bundled into
// the subscription rather than metered from the prepaid balance - sized so
// worst-case cost (cap x estimated real cost) stays under ~30% of what that
// plan pays: agent builds ~$0.75 each, proposals ~$0.50, scripts ~$0.25.
// Agent-build numbers are benchmarked against a competitor's published
// "AI Receptionists/month" caps (3/20/unlimited); proposal and script caps
// were previously set way too generous (worst case ran into the hundreds of
// dollars per account) and have been resized to actually protect margin.
const AGENT_BUILD_CAPS = { starter: 3, pro: 20, agency: 100 };
const PROPOSAL_CAPS = { starter: 5, pro: 9, agency: 18 };
const COLD_CALL_SCRIPT_CAPS = { starter: 8, pro: 18, agency: 36 };

module.exports = { PLAN_CREDITS, AGENT_BUILD_CAPS, PROPOSAL_CAPS, COLD_CALL_SCRIPT_CAPS };
