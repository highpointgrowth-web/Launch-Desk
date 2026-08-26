const { LOW_BALANCE_PAUSE_CENTS } = require('./billing-constants');
const { sendEmail } = require('./email');

// Detaching inbound_agents (rather than deleting the number) stops the
// agent from actually answering - and therefore stops billable Retell
// usage - while keeping the number itself intact to reattach later.
async function detachAgentFromNumber(phoneNumber) {
  const res = await fetch(`https://api.retellai.com/update-phone-number/${encodeURIComponent(phoneNumber)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inbound_agents: null }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Retell update-phone-number failed (${res.status}): ${text}`);
  }
}

function lowBalanceEmailBody(userName) {
  return (
    `Hi ${userName || 'there'},\n\n` +
    "Your LaunchDesk usage balance ran out, so your AI agents have been paused and aren't answering calls right now.\n\n" +
    `Add funds to resume: ${process.env.FRONTEND_URL || 'https://mylaunchdesk.com'}/dashboard.html\n\n` +
    '- LaunchDesk'
  );
}

async function sendLowBalanceEmail(userEmail, userName) {
  try {
    await sendEmail(userEmail, 'Your AI agents have stopped taking calls', lowBalanceEmailBody(userName));
  } catch (err) {
    console.error(`Failed to send low-balance email to ${userEmail}: ${err.message}`);
  }
}

// Shared by call-usage charges (server.js webhook) and phone rental charges
// (server.js monthly cron, routes/agents.js on purchase) so pause behavior
// can't drift between the two the way it would if each kept its own copy.
async function pauseAgentsForBalance(supabase, userId) {
  const { data: activeAgents, error: fetchError } = await supabase
    .from('agents')
    .select('id, retell_phone_number')
    .eq('user_id', userId)
    .eq('status', 'active');

  if (fetchError) {
    console.error(`Failed to fetch active agents to pause for user ${userId}: ${fetchError.message}`);
    return;
  }
  if (!activeAgents || activeAgents.length === 0) return;

  for (const agent of activeAgents) {
    if (!agent.retell_phone_number) continue;
    try {
      await detachAgentFromNumber(agent.retell_phone_number);
    } catch (err) {
      console.error(`Failed to detach agent ${agent.id} from its number after balance depletion: ${err.message}`);
    }
  }

  const { error: updateError } = await supabase
    .from('agents')
    .update({ status: 'inactive', paused_for_balance: true, paused_at: new Date().toISOString() })
    .in(
      'id',
      activeAgents.map((a) => a.id)
    );

  if (updateError) {
    console.error(`Failed to mark agents paused_for_balance for user ${userId}: ${updateError.message}`);
  }

  // Only fires when agents were just newly paused (the length check above
  // returns early otherwise), so this can't re-send on every subsequent
  // charge while the account stays at zero.
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('email, full_name')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    console.error(`Failed to fetch user for low-balance email (user ${userId}): ${userError?.message}`);
    return;
  }

  await sendLowBalanceEmail(user.email, user.full_name);
}

// Deducts chargeCents from a user's prepaid balance (allowed to go negative
// - the underlying cost is already incurred, same as a call charge), logs
// the transaction, and pauses their agents if it drops them below the
// safety buffer.
async function chargeUsageBalance(supabase, userId, chargeCents, { type, description, callLogId = null }) {
  const { data: newBalance, error: rpcError } = await supabase.rpc('decrement_usage_balance', {
    p_user_id: userId,
    p_amount_cents: chargeCents,
  });

  if (rpcError) {
    console.error(`Failed to deduct usage balance for user ${userId}: ${rpcError.message}`);
    return;
  }

  const { error: txError } = await supabase.from('usage_transactions').insert({
    user_id: userId,
    amount_cents: -chargeCents,
    type,
    call_log_id: callLogId,
    description,
  });

  if (txError) {
    console.error(`Failed to log usage transaction for user ${userId}: ${txError.message}`);
  }

  if (newBalance < LOW_BALANCE_PAUSE_CENTS) {
    await pauseAgentsForBalance(supabase, userId);
  }
}

module.exports = { chargeUsageBalance, pauseAgentsForBalance };
