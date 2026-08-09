// A single call's cost is only known after it ends, so a balance can go
// negative before an agent gets paused. Pausing at a positive buffer instead
// of exactly $0 keeps that overage from routinely landing on us. Used by
// both the pause trigger (server.js) and the resume trigger (routes/stripe.js)
// - they must stay in sync or an agent could resume below the safety margin.
const LOW_BALANCE_PAUSE_CENTS = 500;

module.exports = { LOW_BALANCE_PAUSE_CENTS };
