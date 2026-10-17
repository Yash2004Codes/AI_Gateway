import axios from 'axios';

const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
});

// Inject JWT token from localStorage
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('gateway_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 globally
api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Only a rejected dashboard session logs out; a bad tenant key in the
    // Playground (gateway routes) is just an error to show
    if (err.response?.status === 401 && err.config?.url?.startsWith('/admin')) {
      localStorage.removeItem('gateway_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
