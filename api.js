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
  };

  const leads = {
    async scrape({ industry, location, radius }) {
      return request('POST', '/api/leads/scrape', { industry, location, radius });
    },

    async getAll() {
      return request('GET', '/api/leads');
    },

    async update(id, { pipeline_stage, owner_status } = {}) {
      return request('PUT', `/api/leads/${id}`, { pipeline_stage, owner_status });
    },

    async delete(id) {
      return request('DELETE', `/api/leads/${id}`);
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

    async update(id, { system_prompt, greeting, voice, cal_api_key, cal_event_type_id } = {}) {
      return request('PUT', `/api/agents/${id}`, {
        system_prompt,
        greeting,
        voice,
        cal_api_key,
        cal_event_type_id,
      });
    },

    async delete(id) {
      return request('DELETE', `/api/agents/${id}`);
    },

    async sync(id) {
      return request('POST', `/api/agents/${id}/sync`);
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
  };
})(window);
