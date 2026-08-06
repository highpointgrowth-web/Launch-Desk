// Single source of truth for what each plan includes - was previously
// duplicated separately in routes/admin.js and routes/stripe.js, which could
// silently drift out of sync with each other.
const PLAN_CREDITS = { starter: 100, pro: 1000, agency: 2500 };

module.exports = { PLAN_CREDITS };
