import * as React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../shared/store/authStore';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../shared/components/Card';
import { Button } from '../../shared/components/Button';
import { Input } from '../../shared/components/Input';
import { Command } from 'lucide-react';
import { useToastStore } from '../../shared/store/toastStore';
import { signInWithPopup } from 'firebase/auth';
import { createGoogleProvider, getFirebaseAuth } from '../../shared/utils/firebase';
import { env, isGoogleSignInEnabled } from '../../config/env';

export default function Login() {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);
  const { setAuth } = useAuthStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const res = await fetch(`${env.VITE_API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAuth(data.data.user, data.data.accessToken);
        addToast({ type: 'success', title: 'Welcome back!', message: 'Successfully logged in.' });
        navigate(from, { replace: true });
      } else {
        addToast({
          type: 'error',
          title: 'Login failed',
          message: data.error || 'Invalid credentials',
        });
      }
    } catch {
      addToast({
        type: 'error',
        title: 'Connection Error',
        message: 'Could not reach auth server.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    try {
      const result = await signInWithPopup(getFirebaseAuth(), createGoogleProvider());
      const idToken = await result.user.getIdToken();
      const res = await fetch(`${env.VITE_API_URL}/api/auth/firebase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAuth(data.data.user, data.data.accessToken);
        addToast({
          type: 'success',
          title: 'Welcome back!',
          message: 'Successfully logged in with Google.',
        });
        navigate(from, { replace: true });
      } else {
        addToast({
          type: 'error',
          title: 'Login failed',
          message: data.error || 'Authentication error',
        });
      }
    } catch (error) {
      // Firebase surfaces cancellations as errors too; the message is the only
      // part worth showing, and only when it is actually a string.
      const message =
        error instanceof Error ? error.message : 'Google sign-in could not be completed.';
      addToast({ type: 'error', title: 'Sign-in Error', message });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_50%_0%,rgba(77,158,255,0.1),transparent_50%)]" />

      <Card className="w-full max-w-md z-10 border-border/50 bg-surface/80 backdrop-blur-xl">
        <CardHeader className="space-y-4 items-center">
          <div className="h-12 w-12 bg-accent rounded-2xl flex items-center justify-center shadow-lg shadow-accent/20">
            <Command className="h-6 w-6 text-white" />
          </div>
          <div className="text-center space-y-1.5">
            <CardTitle className="text-2xl">Welcome to Pulsara</CardTitle>
            <CardDescription>Sign in to access your DevOps dashboard</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-white" htmlFor="email">
                Email
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-white" htmlFor="password">
                  Password
                </label>
              </div>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <Button type="submit" className="w-full mt-6" isLoading={isLoading}>
              Sign In
            </Button>
          </form>

          {/* Rendered only when the deployment is configured for Google
              sign-in; offering a control that is guaranteed to fail is
              worse than not offering it. */}
          {isGoogleSignInEnabled && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border/50"></div>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-surface px-2 text-muted">Or continue with</span>
                </div>
              </div>

              <Button
                onClick={handleGoogleSignIn}
                className="w-full flex items-center justify-center space-x-2 bg-white text-black hover:bg-gray-100 transition-colors"
                isLoading={isLoading}
              >
                {!isLoading && (
                  <svg className="w-5 h-5 mr-2 shrink-0" viewBox="0 0 24 24">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                )}
                <span>Sign in with Google</span>
              </Button>
            </>
          )}

          <p className="text-center text-xs text-muted mt-6">
            Protected by SSO. Contact IT for access issues.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
