import { api } from './api.js';

export const auth = {
  signup: (email, password, name) =>
    api.post('/api/v3/auth/signup', { email, password, name }),
  login:  (email, password) =>
    api.post('/api/v3/auth/login',  { email, password }),
  logout: () => api.post('/api/v3/auth/logout'),
  me:     () => api.get('/api/v3/auth/me'),
};
