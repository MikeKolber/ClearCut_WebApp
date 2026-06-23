import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { login as apiLogin, logout as apiLogout } from '../../services/api';
import './Login.css';

/**
 * Login — deliberately anonymous gate that fronts the entire app.
 *
 *   • No logos, no product name, no version string, no telemetry.
 *   • Two inputs + one button on a black background.
 *   • Generic error copy; never reveals whether the username was right
 *     (no "user not found" leak — backend returns the same 401 either way).
 *
 * After a successful login the user is *always* sent to the Landing page
 * (the three-button "main page"), so post-login is a consistent
 * experience regardless of how the user got to /login (cold visit,
 * deep link, mid-session expiry).
 *
 * Query params:
 *   ?logout=1        clear the session cookie on mount, then show the form
 */
function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const wantLogout = params.get('logout') === '1';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  /* If we got here via "?logout=1", call the backend logout once and then
     drop the query param so a refresh doesn't re-trigger it. */
  useEffect(() => {
    if (!wantLogout) return;
    apiLogout().catch(() => {}).finally(() => {
      navigate('/login', { replace: true });
    });
  }, [wantLogout, navigate]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await apiLogin(username.trim(), password);
      // Always land on the main Landing page after login.
      navigate('/', { replace: true });
    } catch (err) {
      if (err?.status === 429) setError('Too many attempts. Try again later.');
      else setError('Access denied.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="Login-root">
      <form className="Login-form" onSubmit={onSubmit} autoComplete="off">
        <input
          className="Login-input"
          type="text"
          name="u"
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
        />
        <input
          className="Login-input"
          type="password"
          name="p"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button
          className="Login-submit"
          type="submit"
          disabled={submitting || !username || !password}
        >
          {submitting ? '\u2026' : 'enter'}
        </button>
        <div
          className={`Login-error ${error ? 'Login-error--shown' : ''}`}
          role="alert"
          aria-live="polite"
        >
          {/* nbsp keeps the layout from jumping */}
          {error || '\u00A0'}
        </div>
      </form>
    </div>
  );
}

export default Login;
