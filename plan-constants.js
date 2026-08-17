// Single source of truth for what each plan includes - was previously
// duplicated separately in routes/admin.js and routes/stripe.js, which could
// silently drift out of sync with each other.
const PLAN_CREDITS = { starter: 100, pro: 1000, agency: 2500 };

// Monthly caps on AI-generation actions whose cost is real but bundled into
// the subscription rather than metered from the prepaid balance - sized so
// worst-case cost, ACROSS ALL THREE CATEGORIES COMBINED on the same account,
// stays comfortably under what that plan pays: agent builds ~$0.75 each,
// proposals ~$0.50, scripts ~$0.25. Agency's build cap was originally set by
// benchmarking builds alone against a competitor's "unlimited" top tier
// (3/20/unlimited) - in isolation that looked fine, but combined with the
// proposal/script caps it left only ~6% margin in the true worst case.
// Tightened so every tier keeps ~50%+ of revenue even if an account maxes
// every category in the same month.
const AGENT_BUILD_CAPS = { starter: 3, pro: 20, agency: 35 };
const PROPOSAL_CAPS = { starter: 5, pro: 9, agency: 18 };
const COLD_CALL_SCRIPT_CAPS = { starter: 8, pro: 18, agency: 36 };

module.exports = { PLAN_CREDITS, AGENT_BUILD_CAPS, PROPOSAL_CAPS, COLD_CALL_SCRIPT_CAPS };
