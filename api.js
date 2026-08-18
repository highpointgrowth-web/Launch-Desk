(function (global) {
  const API_BASE_URL = 'https://launchdesk-production-16fc.up.railway.app';
  const TOKEN_KEY = 'launchdesk_token';
  const REFRESH_TOKEN_KEY = 'launchdesk_refresh_token';
  const REMEMBER_KEY = 'launchdesk_remember';

  // "Remember me" decides which Storage the actual tokens live in - checked
  // (or never chosen yet) uses localStorage so the session survives closing
  // the tab; unchecked uses sessionStorage so it's gone as soon as the tab
  // closes. The choice itself is recorded in localStorage (a small,
  // non-sensitive flag) so a fresh page load knows where to look - if the
  // session was "don't remember", that lookup finds an empty sessionStorage
  // once the tab that set it is gone, which is exactly the intended effect.
  function getActiveStorage() {
    return localStorage.getItem(REMEMBER_KEY) === '0' ? sessionStorage : localStorage;
  }

  function setRemember(remember) {
    localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
  }

  function getToken() {
    return getActiveStorage().getItem(TOKEN_KEY);
  }

  function setToken(token) {
    getActiveStorage().setItem(TOKEN_KEY, token);
  }

  function getRefreshToken() {
    return getActiveStorage().getItem(REFRESH_TOKEN_KEY);
  }

  function setRefreshToken(token) {
    getActiveStorage().setItem(REFRESH_TOKEN_KEY, token);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(REMEMBER_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  }

  // Concurrent 401s (e.g. several dashboard widgets loading at once) should
  // all wait on one refresh attempt rather than firing a refresh each -
  // Supabase rotates the refresh token on every use, so a second concurrent
  // call would already be using a stale one and fail.
  let refreshPromise = null;

  function refreshSession() {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const refresh_token = getRefreshToken();
        if (!refresh_token) {
          throw new Error('No refresh token available');
        }

        const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token }),
        });
        const data = await res.json().catch(() => null);

        if (!res.ok || !data?.access_token) {
          throw new Error(data?.error || 'Session refresh failed');
        }

        setToken(data.access_token);
        setRefreshToken(data.refresh_token);
        return data;
      })().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function request(method, path, body, isRetry) {
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

    // A 401 on a request that carried a token means the access token was
    // rejected - distinct from a login/signup attempt failing with 401,
    // which never sends a token in the first place (that still falls
    // through to the normal error below). Try a silent refresh first so an
    // old-but-not-fully-revoked session doesn't kick the user out; only a
    // failed refresh (or no refresh token to try) forces the redirect.
    if (res.status === 401 && token) {
      if (!isRetry) {
        try {
          await refreshSession();
          return request(method, path, body, true);
        } catch (refreshErr) {
          // fall through to full logout below
        }
      }
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

    async login({ email, password, remember = true }) {
      const data = await request('POST', '/api/auth/login', { email, password });
      // Set the storage choice before writing the tokens, since setToken/
      // setRefreshToken route through getActiveStorage() to decide where.
      setRemember(remember);
      if (data?.access_token) {
        setToken(data.access_token);
      }
      if (data?.refresh_token) {
        setRefreshToken(data.refresh_token);
      }
      return data;
    },

    async refreshSession() {
      return refreshSession();
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

    async changePassword(password) {
      return request('PUT', '/api/auth/password', { password });
    },
  };

  const leads = {
    async scrape({ industry, location, radius, max_results, country }) {
      return request('POST', '/api/leads/scrape', { industry, location, radius, max_results, country });
    },

    async getSearches() {
      return request('GET', '/api/leads/searches');
    },

    async getSearch(id) {
      return request('GET', `/api/leads/searches/${id}`);
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

    async generateColdCallScript(id) {
      return request('POST', `/api/leads/${id}/cold-call-script`);
    },
  };

  const agents = {
    async previewPrompt({ lead_id, niche, website_override, extra_context }) {
      return request('POST', '/api/agents/preview-prompt', { lead_id, niche, website_override, extra_context });
    },

    async build({
      lead_id,
      niche,
      agent_name,
      voice,
      greeting,
      cal_api_key,
      cal_event_type_id,
      website_override,
      extra_context,
      transfer_number,
      system_prompt,
    }) {
      return request('POST', '/api/agents/build', {
        lead_id,
        niche,
        agent_name,
        voice,
        greeting,
        cal_api_key,
        cal_event_type_id,
        website_override,
        extra_context,
        transfer_number,
        system_prompt,
      });
    },

    async getAll() {
      return request('GET', '/api/agents');
    },

    async get(id) {
      return request('GET', `/api/agents/${id}`);
    },

    async update(id, { system_prompt, greeting, voice, cal_api_key, cal_event_type_id, monthly_charge, transfer_number } = {}) {
      return request('PUT', `/api/agents/${id}`, {
        system_prompt,
        greeting,
        voice,
        cal_api_key,
        cal_event_type_id,
        monthly_charge,
        transfer_number,
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

    async addFunds({ amount }) {
      return request('POST', '/api/stripe/add-funds', { amount });
    },

    async getUsageTransactions() {
      return request('GET', '/api/stripe/usage-transactions');
    },

    async getConnectUrl() {
      return request('GET', '/api/stripe/connect/authorize-url');
    },

    async getConnectStatus() {
      return request('GET', '/api/stripe/connect/status');
    },

    async disconnectStripe() {
      return request('POST', '/api/stripe/connect/disconnect');
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

  const support = {
    async contact(message) {
      return request('POST', '/api/support/contact', { message });
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
    support,
  };
})(window);
