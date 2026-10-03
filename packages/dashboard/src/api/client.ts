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
    if (err.response?.status === 401) {
      localStorage.removeItem('gateway_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
