// Single source of truth for what each plan includes - was previously
// duplicated separately in routes/admin.js and routes/stripe.js, which could
// silently drift out of sync with each other.
const PLAN_CREDITS = { starter: 100, pro: 1000, agency: 2500 };

// Monthly caps on AI-generation actions whose cost is real but bundled into
// the subscription rather than metered from the prepaid balance - sized so
// worst-case cost (cap x estimated real cost) stays well under what that
// plan pays: agent builds ~$0.75 each, proposals ~$0.50, scripts ~$0.25.
// Benchmarked against a competitor's published "AI Receptionists/month" caps
// (3/20/unlimited) for the agent-build number specifically.
const AGENT_BUILD_CAPS = { starter: 3, pro: 20, agency: 100 };
const PROPOSAL_CAPS = { starter: 50, pro: 250, agency: 1000 };
const COLD_CALL_SCRIPT_CAPS = { starter: 100, pro: 500, agency: 2000 };

module.exports = { PLAN_CREDITS, AGENT_BUILD_CAPS, PROPOSAL_CAPS, COLD_CALL_SCRIPT_CAPS };
