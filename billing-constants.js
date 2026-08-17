// A single call's cost is only known after it ends, so a balance can go
// negative before an agent gets paused. Pausing at a positive buffer instead
// of exactly $0 keeps that overage from routinely landing on us. Used by
// both the pause trigger (server.js) and the resume trigger (routes/stripe.js)
// - they must stay in sync or an agent could resume below the safety margin.
const LOW_BALANCE_PAUSE_CENTS = 500;

// Markup on real Retell call cost, charged to the customer's balance.
// Agency gets a lower rate as a real, usage-scaling perk for the top tier -
// unlike the other plan differences, this one grows in value the more a
// customer actually relies on the product instead of just being a bigger
// cap they'll rarely hit.
const USAGE_MARKUP_BY_PLAN = { starter: 1.1, pro: 1.1, agency: 1.05 };

module.exports = { LOW_BALANCE_PAUSE_CENTS, USAGE_MARKUP_BY_PLAN };
