require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const leadsRouter = require('./routes/leads');
const agentsRouter = require('./routes/agents');
const authRouter = require('./routes/auth');
const stripeRouter = require('./routes/stripe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

app.locals.supabase = supabase;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/leads', leadsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/auth', authRouter);
app.use('/api/stripe', stripeRouter);

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`LaunchDesk server running on port ${PORT}`);
});
