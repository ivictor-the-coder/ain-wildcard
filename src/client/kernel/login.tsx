/**
 * Sign-in. Everything on the left half is read from `/v1/health`, the one
 * public route — so the numbers next to the pitch are the running server's own,
 * not a marketing claim.
 */
import { useState } from 'react';
import { AtSignIcon, Banner, Button, Card, Divider, Field, Icons, Input, formatNumber } from '../design';
import { ApiClientError, useQuery } from './api';
import { useRouter } from './router';
import { useSession } from './session';

interface Health {
  status: string;
  version: string;
  modules: number;
  routes: number;
  jobs: { pending: number; done: number; failed: number };
  ai: { provider: string; tools: number };
}

const safeNext = (raw: string | undefined): string => {
  // Only same-origin paths — an open redirect through `?next=` is a real bug.
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
};

export function LoginPage() {
  const { location, navigate } = useRouter();
  const session = useSession();
  const { data: health } = useQuery<Health>('/v1/health');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiClientError | null>(null);
  const [pending, setPending] = useState<'form' | 'demo' | null>(null);

  const next = safeNext(location.query.next);
  // A workspace that was signed in and is not any more is a different screen
  // from one that was never signed in, and the difference is the whole story.
  const ended = session.sessionEnded;

  const finish = () => navigate(next, { replace: true });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending('form');
    try {
      await session.signIn(email.trim(), password);
      finish();
    } catch (err) {
      setError(err instanceof ApiClientError ? err : new ApiClientError(0, { type: 'api_error', code: 'network_error', message: 'The server could not be reached.' }));
    } finally { setPending(null); }
  };

  const demo = async () => {
    setError(null);
    setPending('demo');
    try {
      await session.signInDemo();
      finish();
    } catch (err) {
      setError(err instanceof ApiClientError ? err : new ApiClientError(0, { type: 'api_error', code: 'network_error', message: 'The server could not be reached.' }));
    } finally { setPending(null); }
  };

  const facts: { value: string; label: string }[] = health ? [
    { value: formatNumber(health.routes), label: 'API endpoints live' },
    { value: formatNumber(health.modules), label: 'modules installed' },
    { value: formatNumber(health.ai.tools), label: 'tools the agents can call' },
  ] : [];

  return (
    <div className="login">
      <aside className="login__aside">
        <div className="login__brand">
          <span className="shell-mark" aria-hidden>A</span>
          <span className="login__brandname">Ain</span>
        </div>
        <div className="login__pitch">
          <h1 className="login__headline">One platform from first touch to cash collected.</h1>
          <p className="login__body">
            CRM, conversations, agents and workflow automation on one side; subscriptions, metered
            usage, prepaid credits, invoicing and dunning on the other — over a single event log and
            a clock you can move.
          </p>
        </div>
        <div className="login__facts">
          {facts.map((fact) => (
            <div className="login__fact" key={fact.label}>
              <span className="login__factvalue">{fact.value}</span>
              <span className="login__factlabel">{fact.label}</span>
            </div>
          ))}
        </div>
      </aside>

      <main className="login__main">
        <div className="login__card">
          <div>
            <h2 className="login__title">Sign in</h2>
            <p className="login__lede">
              {next === '/' ? 'Pick up where your workspace left off.' : <>You will land on <code>{next}</code>.</>}
            </p>
          </div>

          {ended && (
            <Banner tone="warning" title="Your session ended while you were working">
              {ended.message} It was <code>{ended.path}</code> that came back 401
              {ended.requestId ? <> · <span className="u-mono">{ended.requestId}</span></> : null}. Signing
              in again puts you back on <code>{next}</code> with nothing lost.
            </Banner>
          )}

          <Card>
            <form className="login__form" onSubmit={submit}>
              <Field
                label="Work email"
                error={error?.param === 'email' || error?.code === 'unauthorized' ? error.body.message : undefined}
              >
                <Input
                  type="email"
                  name="email"
                  autoComplete="username"
                  placeholder="dana@northwind.io"
                  value={email}
                  autoFocus
                  required
                  iconLeft={<AtSignIcon size={15} />}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Password" error={error?.param === 'password' ? error.body.message : undefined}>
                <Input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  required
                  iconLeft={<Icons.lock size={15} />}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="primary" block loading={pending === 'form'} disabled={pending === 'demo'}>
                Sign in
              </Button>
            </form>

            <Divider label="or" />

            <Button
              block
              iconLeft={<Icons.sparkles size={15} />}
              loading={pending === 'demo'}
              disabled={pending === 'form'}
              onClick={demo}
            >
              Use the demo workspace
            </Button>
            <p className="login__hint" style={{ marginTop: 'var(--space-4)' }}>
              Northwind Robotics — an industrial automation company on a usage-priced telemetry
              platform, with its whole history seeded.
            </p>
          </Card>

          {error && error.code !== 'unauthorized' && !error.param && (
            <p className="login__hint" style={{ color: 'var(--text-danger)' }}>
              {error.body.message}
              {error.body.request_id ? ` · ${error.body.request_id}` : ''}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
