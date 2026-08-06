// A single call's cost is only known after it ends, so a balance can go
// negative before an agent gets paused. Pausing at a positive buffer instead
// of exactly $0 keeps that overage from routinely landing on us. Used by
// both the pause trigger (server.js) and the resume trigger (routes/stripe.js)
// - they must stay in sync or an agent could resume below the safety margin.
const LOW_BALANCE_PAUSE_CENTS = 500;

// Flat fees for AI-generation flows whose cost (Firecrawl scrape, Claude
// call) is known up front, unlike call cost. These are charged atomically
// via charge_if_sufficient() BEFORE the underlying API call is made, so
// insufficient balance blocks the action instead of us fronting it.
const AGENT_PROMPT_GENERATION_FEE_CENTS = 75;
const PROPOSAL_GENERATION_FEE_CENTS = 50;
const COLD_CALL_SCRIPT_FEE_CENTS = 25;

// Deducts amountCents from the user's usage balance only if it's already
// covered, in one atomic DB operation - throws (without deducting anything)
// if it isn't, so the caller can skip the paid action entirely instead of
// fronting its cost. Callers should run this before the Firecrawl/Claude
// call it's paying for, not after.
async function chargeFlatFee(supabase, userId, amountCents, description) {
  const { data: newBalance, error: rpcError } = await supabase.rpc('charge_if_sufficient', {
    p_user_id: userId,
    p_amount_cents: amountCents,
  });

  if (rpcError) {
    throw new Error(`Failed to charge usage balance: ${rpcError.message}`);
  }

  if (newBalance === null) {
    const err = new Error(`Add funds to continue - this action costs $${(amountCents / 100).toFixed(2)}.`);
    err.status = 402;
    throw err;
  }

  const { error: txError } = await supabase.from('usage_transactions').insert({
    user_id: userId,
    amount_cents: -amountCents,
    type: 'feature_charge',
    description,
  });

  if (txError) {
    console.error(`Failed to log usage transaction for user ${userId}: ${txError.message}`);
  }

  return newBalance;
}

module.exports = {
  LOW_BALANCE_PAUSE_CENTS,
  AGENT_PROMPT_GENERATION_FEE_CENTS,
  PROPOSAL_GENERATION_FEE_CENTS,
  COLD_CALL_SCRIPT_FEE_CENTS,
  chargeFlatFee,
};
