/**
 * Redeeming an invitation: the other half of "Invite a teammate".
 *
 * An admin is shown a link exactly once. This is what the person on the end of
 * it opens. It is public — `GET /v1/auth/invitations/:token` needs no session —
 * so it states who invited whom to which workspace before asking for anything,
 * and every way a link can be dead (used, replaced, cancelled, expired) is one
 * answer the server gives, with the way back written under it.
 *
 * `POST /v1/auth/accept` sets the password *and* starts the session, so there
 * is no second sign-in step: the person lands inside the workspace they were
 * invited to.
 */
import { useState } from 'react';
import { Badge, Banner, Button, Card, DescriptionList, Field, Icons, Input, Loading, useFormat } from '../design';
import { ApiClientError, api, invalidate, useQuery } from './api';
import { useRouter } from './router';
import { useSession } from './session';

/** What the public lookup answers for a link that can still be redeemed. */
interface InvitationDetail {
  object: 'invitation';
  id: string;
  created: number;
  expires: number;
  email: string;
  name: string;
  role: string;
  invited_by: { id: string; name: string } | null;
  org: { id: string; name: string; logo_url: string | null; brand_color: string };
}

const MIN_PASSWORD = 8;

export function AcceptInvitePage() {
  const { location, navigate } = useRouter();
  const session = useSession();
  const f = useFormat();
  const token = location.query.token ?? '';
  const invitation = useQuery<InvitationDetail>(token ? `/v1/auth/invitations/${encodeURIComponent(token)}` : null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<ApiClientError | null>(null);
  const [pending, setPending] = useState(false);

  const short = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_PASSWORD && confirm === password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || pending) return;
    setError(null);
    setPending(true);
    try {
      await api.post('/v1/auth/accept', { token, password });
      // The route hands back a live session, so the workspace is simply
      // re-read rather than sending the person to a sign-in form they have
      // already passed.
      invalidate();
      session.refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiClientError
        ? err
        : new ApiClientError(0, { type: 'api_error', code: 'network_error', message: 'The server could not be reached.' }));
    } finally {
      setPending(false);
    }
  };

  const dead = invitation.error;

  return (
    <div className="login">
      <aside className="login__aside">
        <div className="login__brand">
          <span className="shell-mark" aria-hidden>A</span>
          <span className="login__brandname">Ain</span>
        </div>
        <div className="login__pitch">
          <h1 className="login__headline">
            {invitation.data ? `${invitation.data.org.name} kept a seat for you.` : 'One platform from first touch to cash collected.'}
          </h1>
          <p className="login__body">
            CRM, conversations, agents and workflow automation on one side; subscriptions, metered
            usage, prepaid credits, invoicing and dunning on the other — over a single event log and
            a clock you can move.
          </p>
        </div>
      </aside>

      <main className="login__main">
        <div className="login__card">
          <div>
            <h2 className="login__title">Accept your invitation</h2>
            <p className="login__lede">
              {invitation.data
                ? <>Choose a password and you are in — no second sign-in step.</>
                : <>The link an admin sent you is checked before you type anything.</>}
            </p>
          </div>

          {!token && (
            <Banner tone="warning" title="This address is missing its invitation">
              An invitation link carries a one-time token in its address, as{' '}
              <code>/accept?token=…</code>. Ask whoever invited you to send the whole link, or{' '}
              <a href="/login">sign in</a> if you already have a password.
            </Banner>
          )}

          {token && invitation.loading && !invitation.data && (
            <Card><Loading label="Checking the invitation…" /></Card>
          )}

          {dead && (
            <Banner tone="danger" title="This link cannot be used">
              {dead.body.message}
              {dead.body.request_id ? <> · <span className="u-mono">{dead.body.request_id}</span></> : null}
            </Banner>
          )}

          {invitation.data && (
            <Card>
              <DescriptionList
                divided
                items={[
                  { term: 'Workspace', value: invitation.data.org.name },
                  { term: 'Your seat', value: <>{invitation.data.name} · {invitation.data.email}</> },
                  { term: 'Role', value: <Badge tone="info" pill>{invitation.data.role}</Badge> },
                  ...(invitation.data.invited_by ? [{ term: 'Invited by', value: invitation.data.invited_by.name }] : []),
                  {
                    term: 'Link expires',
                    value: `${f.date(invitation.data.expires, { withYear: true })} · ${f.relative(invitation.data.expires)}`,
                  },
                ]}
              />

              <form className="login__form" onSubmit={submit} style={{ marginTop: 'var(--space-6)' }}>
                <Field
                  label="Choose a password"
                  hint={`At least ${MIN_PASSWORD} characters. It is the only thing that will let you back in.`}
                  error={short ? `At least ${MIN_PASSWORD} characters.` : error?.param === 'password' ? error.body.message : undefined}
                >
                  <Input
                    type="password"
                    name="new-password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={password}
                    autoFocus
                    required
                    invalid={short}
                    iconLeft={<Icons.lock size={15} />}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Field label="Type it again" error={mismatch ? 'The two do not match yet.' : undefined}>
                  <Input
                    type="password"
                    name="confirm-password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirm}
                    required
                    invalid={mismatch}
                    iconLeft={<Icons.lock size={15} />}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>
                <Button type="submit" variant="primary" block loading={pending} disabled={!ready}>
                  {`Join ${invitation.data.org.name}`}
                </Button>
              </form>
            </Card>
          )}

          {error && !error.param && (
            <p className="login__hint" style={{ color: 'var(--text-danger)' }}>
              {error.body.message}
              {error.body.request_id ? ` · ${error.body.request_id}` : ''}
            </p>
          )}

          <p className="login__hint">
            Already set a password? <a href="/login">Sign in instead</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
