(function (global) {
  const API_BASE_URL = 'https://launchdesk-production-16fc.up.railway.app';
  const TOKEN_KEY = 'launchdesk_token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // A 401 on a request that carried a token means the session itself is
    // dead (expired/revoked) - distinct from a login/signup attempt failing
    // with 401, which never sends a token in the first place. Only the
    // former should force a redirect; the latter needs to surface its error
    // on the current form instead.
    if (res.status === 401 && token) {
      clearToken();
      if (!/\/auth\.html$/.test(global.location.pathname)) {
        global.location.href = 'auth.html?expired=1';
      }
      throw new Error('Your session expired, please log in again.');
    }

    if (res.status === 204) {
      return null;
    }

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(data?.error || `Request failed with status ${res.status}`);
    }

    return data;
  }

  const auth = {
    async signup({ email, password, full_name }) {
      return request('POST', '/api/auth/signup', { email, password, full_name });
    },

    async login({ email, password }) {
      const data = await request('POST', '/api/auth/login', { email, password });
      if (data?.access_token) {
        setToken(data.access_token);
      }
      return data;
    },

    async logout() {
      try {
        await request('POST', '/api/auth/logout');
      } finally {
        clearToken();
      }
    },

    async getMe() {
      return request('GET', '/api/auth/me');
    },

    async updateMe({ full_name, agency_name, goal_weekly_revenue, goal_monthly_revenue, goal_yearly_revenue } = {}) {
      return request('PUT', '/api/auth/me', {
        full_name,
        agency_name,
        goal_weekly_revenue,
        goal_monthly_revenue,
        goal_yearly_revenue,
      });
    },
  };

  const leads = {
    async scrape({ industry, location, radius, max_results }) {
      return request('POST', '/api/leads/scrape', { industry, location, radius, max_results });
    },

    async create(lead) {
      return request('POST', '/api/leads', lead);
    },

    async getAll() {
      return request('GET', '/api/leads');
    },

    async update(id, { pipeline_stage, owner_status, email, notes } = {}) {
      return request('PUT', `/api/leads/${id}`, { pipeline_stage, owner_status, email, notes });
    },

    async delete(id) {
      return request('DELETE', `/api/leads/${id}`);
    },

    async getActivities(id) {
      return request('GET', `/api/leads/${id}/activities`);
    },

    async createActivity(id, { type, notes, occurred_at } = {}) {
      return request('POST', `/api/leads/${id}/activities`, { type, notes, occurred_at });
    },

    async getActivitySummary() {
      return request('GET', '/api/leads/activity-summary');
    },
  };

  const agents = {
    async build({ lead_id, niche, agent_name, voice, greeting, cal_api_key, cal_event_type_id }) {
      return request('POST', '/api/agents/build', {
        lead_id,
        niche,
        agent_name,
        voice,
        greeting,
        cal_api_key,
        cal_event_type_id,
      });
    },

    async getAll() {
      return request('GET', '/api/agents');
    },

    async get(id) {
      return request('GET', `/api/agents/${id}`);
    },

    async update(id, { system_prompt, greeting, voice, cal_api_key, cal_event_type_id, monthly_charge } = {}) {
      return request('PUT', `/api/agents/${id}`, {
        system_prompt,
        greeting,
        voice,
        cal_api_key,
        cal_event_type_id,
        monthly_charge,
      });
    },

    async delete(id) {
      return request('DELETE', `/api/agents/${id}`);
    },

    async sync(id) {
      return request('POST', `/api/agents/${id}/sync`);
    },

    async getCalls(id) {
      return request('GET', `/api/agents/${id}/calls`);
    },

    async buyPhone(id, { area_code } = {}) {
      return request('POST', `/api/agents/${id}/buy-phone`, { area_code });
    },
  };

  const stripe = {
    async createCheckout({ plan }) {
      return request('POST', '/api/stripe/create-checkout', { plan });
    },

    async getPortal({ return_url } = {}) {
      const query = return_url ? `?return_url=${encodeURIComponent(return_url)}` : '';
      return request('GET', `/api/stripe/portal${query}`);
    },
  };

  const proposals = {
    async create({ lead_id }) {
      return request('POST', '/api/proposals', { lead_id });
    },

    async getAll() {
      return request('GET', '/api/proposals');
    },

    async send(id) {
      return request('POST', `/api/proposals/${id}/send`);
    },

    async getStats() {
      return request('GET', '/api/proposals/stats');
    },

    async saveTemplate(proposal_template) {
      return request('PUT', '/api/proposals/template', { proposal_template });
    },
  };

  const meetings = {
    async getAll() {
      return request('GET', '/api/meetings');
    },

    async create({ business_name, meeting_date, meeting_time, notes, lead_id } = {}) {
      return request('POST', '/api/meetings', { business_name, meeting_date, meeting_time, notes, lead_id });
    },

    async update(id, fields = {}) {
      return request('PUT', `/api/meetings/${id}`, fields);
    },

    async delete(id) {
      return request('DELETE', `/api/meetings/${id}`);
    },
  };

  const todos = {
    async getAll() {
      return request('GET', '/api/todos');
    },

    async create(text) {
      return request('POST', '/api/todos', { text });
    },

    async update(id, fields = {}) {
      return request('PUT', `/api/todos/${id}`, fields);
    },

    async delete(id) {
      return request('DELETE', `/api/todos/${id}`);
    },
  };

  const dashboard = {
    async getStats() {
      return request('GET', '/api/dashboard/stats');
    },
  };

  const integrations = {
    async getAll() {
      return request('GET', '/api/integrations');
    },

    async saveCal({ api_key, event_type_id }) {
      return request('PUT', '/api/integrations/cal', { api_key, event_type_id });
    },

    async saveEmail({ email, mode, app_password, smtp_host, smtp_port, smtp_username, smtp_password }) {
      return request('PUT', '/api/integrations/email', {
        email,
        mode,
        app_password,
        smtp_host,
        smtp_port,
        smtp_username,
        smtp_password,
      });
    },
  };

  global.API = {
    baseUrl: API_BASE_URL,
    getToken,
    setToken,
    clearToken,
    auth,
    leads,
    agents,
    stripe,
    proposals,
    dashboard,
    integrations,
    meetings,
    todos,
  };
})(window);
