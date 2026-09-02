// A single call's cost is only known after it ends, so a balance can go
// negative before an agent gets paused. Pausing at a positive buffer instead
// of exactly $0 keeps that overage from routinely landing on us. $10 covers
// one worst-case call (~$4, bounded by MAX_CALL_DURATION_MS in routes/agents.js)
// with real room to spare - raised from $5 after the profit-audit conversation
// flagged that multiple concurrent calls on a multi-agent account could each
// land before the first one's pause registers. Used by both the pause trigger
// (server.js) and the resume trigger (routes/stripe.js) - they must stay in
// sync or an agent could resume below the safety margin.
const LOW_BALANCE_PAUSE_CENTS = 1000;

// Markup on real Retell call cost, charged to the customer's balance.
// Agency gets a lower rate as a real, usage-scaling perk for the top tier -
// unlike the other plan differences, this one grows in value the more a
// customer actually relies on the product instead of just being a bigger
// cap they'll rarely hit.
const USAGE_MARKUP_BY_PLAN = { starter: 1.1, pro: 1.1, agency: 1.05 };

// Flat monthly rental charge per phone number, deducted from the customer's
// balance the same way call usage is. Retell's real cost is ~$2.00/mo per
// number (verified against their current published pricing) - $2.20 matches
// what's already advertised in the Phone tab UI and mirrors what competitor
// Client One charges for the same thing, rather than scaling by plan like
// the call markup does.
const PHONE_NUMBER_RENTAL_CENTS = 220;

module.exports = { LOW_BALANCE_PAUSE_CENTS, USAGE_MARKUP_BY_PLAN, PHONE_NUMBER_RENTAL_CENTS };
