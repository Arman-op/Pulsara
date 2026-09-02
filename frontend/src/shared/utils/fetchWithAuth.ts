import { useAuthStore } from '../store/authStore';
import { env } from '../../config/env';

export const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
  const { accessToken } = useAuthStore.getState();
  const baseUrl = env.VITE_API_URL;
  const fullUrl = `${baseUrl}/api${url.startsWith('/') ? url : '/' + url}`;

  const headers = new Headers(options.headers);
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(fullUrl, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    useAuthStore.getState().logout();
  }

  return response;
};
