/**
 * The workspace itself: what it is called, where it bills from, and the three
 * settings — currency, timezone, locale — that every number and date in the
 * product is rendered through.
 *
 * Those three are the reason this screen has a live preview rather than a Save
 * button and a shrug. `useFormat()` binds `Intl` to the workspace's locale,
 * currency and timezone, so changing the timezone here moves every timestamp in
 * the product by hours and changing the currency changes the symbol on every
 * invoice total. The panel on the right shows exactly what the change will do,
 * from the same formatter the rest of the product uses, before it is saved —
 * and once it is saved the session is re-read so the shell picks it up without
 * a reload.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useSession, type SessionOrg } from '../../kernel/session';
import {
  Badge, Banner, Button, Card, Divider, Field, Icons, Inline, Input, KeyValue,
  Select, Stack,
  contrastGrade, contrastRatio, createFormatter, initials, parseColor, useFormat,
  type SelectOption,
} from '../../design';
import { Loading, SettingsShell, useAction } from './common';

interface CatalogCurrency {
  object: 'catalog_currency';
  code: string;
  name: string;
  symbol: string;
  prices: number;
  default: boolean;
}

/**
 * Every zone the runtime can actually format in. `Intl.supportedValuesOf` is
 * ES2022 and present in every browser this product supports; the fallback is
 * there so a runtime without it still offers the zone the workspace is on
 * rather than an empty menu that cannot be escaped from.
 */
function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported === 'function') zones = supported('timeZone');
  } catch { zones = []; }
  if (!zones.length) zones = ['UTC'];
  return zones.includes(current) ? zones : [current, ...zones];
}

/**
 * The locales the workspace can be rendered in. Every tag below is one this
 * runtime resolves — `Intl.DateTimeFormat.supportedLocalesOf` is asked, so a
 * tag the browser would silently fall back to en-US on is never offered as
 * though it worked.
 */
const CANDIDATE_LOCALES = [
  'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IE', 'en-NZ', 'en-ZA', 'en-IN',
  'de-DE', 'de-AT', 'de-CH', 'fr-FR', 'fr-BE', 'fr-CA', 'nl-NL', 'nl-BE',
  'es-ES', 'es-MX', 'it-IT', 'pt-PT', 'pt-BR', 'da-DK', 'sv-SE', 'nb-NO',
  'fi-FI', 'pl-PL', 'cs-CZ', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW',
];

function locales(current: string): string[] {
  let supported: string[] = [];
  try { supported = Intl.DateTimeFormat.supportedLocalesOf(CANDIDATE_LOCALES); } catch { supported = []; }
  const list = supported.length ? supported : ['en-US'];
  return list.includes(current) ? list : [current, ...list];
}

const localeLabel = (tag: string): string => {
  try {
    const names = new Intl.DisplayNames([tag], { type: 'language' });
    const region = tag.split('-')[1];
    const regionName = region ? new Intl.DisplayNames([tag], { type: 'region' }).of(region) : null;
    const language = names.of(tag.split('-')[0]) ?? tag;
    const cased = language.charAt(0).toUpperCase() + language.slice(1);
    return regionName ? `${cased} (${regionName}) · ${tag}` : `${cased} · ${tag}`;
  } catch {
    return tag;
  }
};

const zoneLabel = (zone: string, at: number): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at);
    const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
    return offset ? `${zone.replace(/_/g, ' ')} · ${offset}` : zone.replace(/_/g, ' ');
  } catch {
    return zone.replace(/_/g, ' ');
  }
};

interface Draft {
  name: string;
  domain: string;
  brand_color: string;
  default_currency: string;
  timezone: string;
  locale: string;
}

const draftOf = (org: SessionOrg): Draft => ({
  name: org.name,
  domain: org.domain ?? '',
  brand_color: org.brand_color,
  default_currency: org.default_currency,
  timezone: org.timezone,
  locale: org.locale,
});

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The label each key is known by on screen, for the toast and the diff. */
const FIELD_LABEL: Record<keyof Draft, string> = {
  name: 'name',
  domain: 'domain',
  brand_color: 'brand colour',
  default_currency: 'default currency',
  timezone: 'timezone',
  locale: 'locale',
};

/**
 * Why a field cannot be sent, in the words the operator needs.
 *
 * Two of these are not cosmetic. `name` is `v.string({ min: 1 })` behind
 * `v.optional`, and `optional` maps `''` to `undefined` before the minimum is
 * ever checked — so an empty name is not refused, it is *dropped*: the server
 * answers 200 with the old name, and a form that trusted its own patch would
 * report a save that never happened. The same is true of every optional string
 * on the route, which is why clearing the domain is called out too rather than
 * silently doing nothing.
 */
function problemWith(key: keyof Draft, value: string): string | undefined {
  if (key === 'name' && value.trim().length === 0) return 'A workspace must have a name.';
  if (key === 'brand_color' && !HEX.test(value)) return 'Six hex digits after a #, e.g. #5B4BE1.';
  return undefined;
}

export function WorkspacePage() {
  const session = useSession();
  const org = session.me?.org;
  const action = useAction();
  const f = useFormat();
  const currencies = useQuery<ListEnvelope<CatalogCurrency>>('/v1/catalog/currencies');

  const [draft, setDraft] = useState<Draft | null>(org ? draftOf(org) : null);
  // The org arrives one paint after the first render, and a later refresh can
  // bring changes another admin made. Re-seeding on identity — not on every
  // render — is what stops the form fighting the operator's own typing.
  const stamp = org ? `${org.id}:${org.name}:${org.domain}:${org.brand_color}:${org.default_currency}:${org.timezone}:${org.locale}` : null;
  useEffect(() => { if (org) setDraft(draftOf(org)); }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';

  const currencyOptions = useMemo<SelectOption[]>(() => {
    const rows = currencies.data?.data ?? [];
    const options = rows.map((row) => ({
      value: row.code,
      label: `${row.symbol} ${row.name} · ${row.code.toUpperCase()} · ${row.prices} ${row.prices === 1 ? 'price' : 'prices'}`,
    }));
    const current = draft?.default_currency ?? org?.default_currency;
    if (current && !options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: `${current.toUpperCase()} · in use, no price book entry` });
    }
    return options;
  }, [currencies.data, draft?.default_currency, org?.default_currency]);

  const zoneOptions = useMemo<SelectOption[]>(() => {
    const now = session.now();
    return timeZones(draft?.timezone ?? 'UTC').map((zone) => ({ value: zone, label: zoneLabel(zone, now) }));
    // The offset label only has to be right to the hour, so it is recomputed
    // when the zone list changes rather than on every tick of the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.timezone]);

  const localeOptions = useMemo<SelectOption[]>(
    () => locales(draft?.locale ?? 'en-US').map((tag) => ({ value: tag, label: localeLabel(tag) })),
    [draft?.locale],
  );

  /**
   * The same formatter the whole product renders through, bound to the *draft*
   * rather than the session — which is what makes the preview a preview and not
   * a repeat of what is already on screen.
   */
  const preview = useMemo(
    () => createFormatter(
      { locale: draft?.locale ?? 'en-US', currency: draft?.default_currency ?? 'usd', timeZone: draft?.timezone ?? 'UTC' },
      session.now,
    ),
    [draft?.locale, draft?.default_currency, draft?.timezone, session.now],
  );

  if (!org || !draft) {
    return (
      <SettingsShell title="Workspace" subtitle="What this workspace is called, and the settings every screen renders through.">
        <Card><Loading label="Reading the workspace…" /></Card>
      </SettingsShell>
    );
  }

  const hexValid = HEX.test(draft.brand_color);
  const saved = (key: keyof Draft): string => (key === 'domain' ? (org.domain ?? '') : (org[key as keyof SessionOrg] as string));
  const dirtyKeys = (Object.keys(draft) as (keyof Draft)[]).filter((key) => draft[key] !== saved(key));
  const dirty = dirtyKeys.length > 0;
  // A field the API would refuse *or* silently drop blocks the save, so the
  // button never offers to do something the response will not have done.
  const problems = dirtyKeys
    .map((key) => [key, problemWith(key, draft[key])] as const)
    .filter((pair): pair is [keyof Draft, string] => pair[1] !== undefined);
  const blocked = problems.length > 0;

  const ratio = contrastRatio('#ffffff', hexValid ? draft.brand_color : '#ffffff');
  const monogramRgb = parseColor(draft.brand_color);
  const monogramDark = monogramRgb ? (0.299 * monogramRgb.r + 0.587 * monogramRgb.g + 0.114 * monogramRgb.b) > 150 : false;

  const save = async () => {
    if (blocked) return;
    const patch: Record<string, string> = {};
    for (const key of dirtyKeys) patch[key] = key === 'domain' ? draft.domain.trim() : draft[key];

    const result = await action.run(
      api.patch<SessionOrg>('/v1/org', patch),
      {
        success: 'Workspace updated',
        failure: 'The workspace was not updated',
        inlineOnly: true,
        /**
         * What actually moved, read off the row the server sent back rather
         * than off the patch that was sent to it. A 200 is not a change: the
         * route drops an empty optional, so the answer is the only thing that
         * knows whether anything happened.
         */
        outcome: (returned) => {
          const applied = dirtyKeys.filter((key) => {
            const was = key === 'domain' ? (org.domain ?? '') : (org[key as keyof SessionOrg] as string);
            const now = key === 'domain' ? (returned.domain ?? '') : (returned[key as keyof SessionOrg] as string);
            return was !== now;
          });
          if (applied.length === 0) {
            return {
              tone: 'info',
              title: 'Nothing changed',
              description:
                'The server accepted the request and sent back the workspace exactly as it was. An empty value is '
                + 'dropped by the API rather than written, so the field still holds what it held before.',
            };
          }
          const touchesFormatting = applied.some((key) => key === 'default_currency' || key === 'timezone' || key === 'locale');
          return {
            tone: 'success',
            title: 'Workspace updated',
            description: touchesFormatting
              ? 'Every amount and date in the product is now rendered through these settings.'
              : `Changed ${f.list(applied.map((key) => FIELD_LABEL[key]))}.`,
          };
        },
      },
      ['/v1/me'],
    );
    // `/v1/me` is what the session, the shell clock and every formatter in the
    // product read their locale, currency and timezone from. Re-reading it is
    // what makes the change visible without a reload.
    if (result) session.refresh();
  };

  return (
    <SettingsShell
      title="Workspace"
      subtitle="What this workspace is called, and the settings every screen in the product renders through."
      actions={
        <Inline gap={3}>
          {dirty && (
            <Button variant="ghost" disabled={action.busy} onClick={() => setDraft(draftOf(org))}>
              Discard
            </Button>
          )}
          <Button
            variant={dirty ? 'primary' : 'ghost'}
            loading={action.busy}
            disabled={!dirty || blocked || !admin}
            iconLeft={dirty ? <Icons.check size={15} /> : undefined}
            title={blocked ? problems[0][1] : undefined}
            onClick={() => void save()}
          >
            {dirty ? `Save ${f.plural(dirtyKeys.length, 'change')}` : 'Saved'}
          </Button>
        </Inline>
      }
    >
      <Stack gap={6}>
        {!admin && (
          <Banner tone="info" compact title="You can read these, not change them">
            {`PATCH /v1/org is gated at admin and your role is ${session.me?.role}. The fields below are filled in from the `
              + 'workspace so you can see what is set; saving would be refused.'}
          </Banner>
        )}
        {action.error && !action.error.body.param && (
          <Banner tone="danger" title="The workspace was not updated">
            {action.error.body.message}
            {action.error.body.request_id ? <> · <span className="st-mono">{action.error.body.request_id}</span></> : null}
          </Banner>
        )}

        <div className="st-cols">
          <Stack gap={6}>
            <Card title="Identity" description="How this workspace names itself on invoices, emails and the API.">
              <Stack gap={5}>
                <Inline gap={5} align="center">
                  <div
                    aria-hidden
                    style={{
                      width: 52, height: 52, flex: 'none', borderRadius: 'var(--radius-lg)',
                      background: hexValid ? draft.brand_color : 'var(--bg-sunken)',
                      color: monogramDark ? 'var(--gray-950)' : 'var(--gray-0)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-lg)',
                      fontFamily: 'var(--font-display)',
                    }}
                  >
                    {initials(draft.name || org.name)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 'var(--weight-semibold)' }}>{draft.name || org.name}</div>
                    <div className="st-sub">{`${org.slug} · ${org.id}`}</div>
                  </div>
                </Inline>

                <Field
                  label="Workspace name"
                  required
                  error={action.errorFor('name') ?? (draft.name === org.name ? undefined : problemWith('name', draft.name))}
                >
                  <Input
                    value={draft.name}
                    disabled={!admin}
                    invalid={!!action.errorFor('name') || draft.name.trim().length === 0}
                    maxLength={120}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    aria-label="Workspace name"
                  />
                </Field>

                <Field
                  label="Primary domain"
                  hint={draft.domain.trim() === '' && (org.domain ?? '') !== ''
                    ? `An empty value is dropped by the API before it is written, so saving this leaves the domain at ${org.domain}. Clearing it is not something this route can do.`
                    : 'Used to recognise a teammate signing in with a company address, and printed on customer-facing documents.'}
                  error={action.errorFor('domain')}
                >
                  <Input
                    value={draft.domain}
                    disabled={!admin}
                    placeholder="northwind.io"
                    maxLength={200}
                    invalid={!!action.errorFor('domain')}
                    onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
                    aria-label="Primary domain"
                  />
                </Field>

                <Field
                  label="Brand colour"
                  error={action.errorFor('brand_color') ?? (hexValid ? undefined : 'Six hex digits after a #, e.g. #5B4BE1.')}
                  hint="Served on /v1/me and stamped on customer-facing surfaces. The console keeps its own accent so the interface stays legible in both themes."
                >
                  <Inline gap={4}>
                    <input
                      type="color"
                      className="st-swatch"
                      value={hexValid ? draft.brand_color : '#000000'}
                      disabled={!admin}
                      aria-label="Brand colour"
                      onChange={(e) => setDraft({ ...draft, brand_color: e.target.value })}
                    />
                    <Input
                      value={draft.brand_color}
                      disabled={!admin}
                      mono
                      maxLength={7}
                      invalid={!hexValid}
                      onChange={(e) => setDraft({ ...draft, brand_color: e.target.value })}
                      aria-label="Brand colour hex"
                      wrapperClassName="u-grow"
                    />
                  </Inline>
                </Field>
                {hexValid && ratio !== null && (
                  <div className="st-hint">
                    {`White text on this colour scores ${ratio.toFixed(2)}:1 — ${contrastGrade(ratio)}. `}
                    {contrastGrade(ratio) === 'Fail'
                      ? 'Anything printed on it in white will be hard to read.'
                      : 'Safe for a badge or a header bar.'}
                  </div>
                )}
              </Stack>
            </Card>

            <Card
              title="Facts about this workspace"
              description="Read from /v1/me — not editable here, because nothing in the product may change them."
            >
              <Stack gap={4}>
                <KeyValue label="Workspace id" value={<span className="st-mono">{org.id}</span>} />
                <KeyValue label="Slug" value={<span className="st-mono">{org.slug}</span>} />
                <KeyValue
                  label="Clock"
                  value={
                    <Inline gap={3}>
                      <Badge tone={session.me?.clock.kind === 'virtual' ? 'info' : 'neutral'} pill>
                        {session.me?.clock.kind === 'virtual' ? 'Virtual' : 'Real time'}
                      </Badge>
                      {session.me?.clock.offset_ms ? <span className="st-sub">shifted</span> : null}
                    </Inline>
                  }
                />
                <KeyValue label="Your role" value={session.me?.role ?? '—'} />
                <KeyValue
                  label="Signed in with"
                  value={session.me?.auth_kind === 'api_key' ? 'An API key' : 'A session cookie'}
                />
                {Object.entries(org.settings ?? {}).map(([key, value]) => (
                  <KeyValue key={key} label={key.replace(/_/g, ' ')} value={String(value)} />
                ))}
              </Stack>
            </Card>
          </Stack>

          <Stack gap={6}>
            <Card
              title="Money, time and language"
              description="Every amount, date and number in this product is rendered through these three."
            >
              <Stack gap={5}>
                <Field
                  label="Default currency"
                  error={action.errorFor('default_currency')}
                  hint="The book a new customer is opened in, and the currency an amount with no currency of its own is read as. Nothing is converted between books."
                >
                  <Select
                    value={draft.default_currency}
                    disabled={!admin}
                    options={currencyOptions}
                    onChange={(value) => setDraft({ ...draft, default_currency: value })}
                    aria-label="Default currency"
                  />
                </Field>

                <Field
                  label="Timezone"
                  error={action.errorFor('timezone')}
                  hint="Timestamps — created, paid, last seen — are shown in this zone. Billing period boundaries stay UTC calendar dates, which is why an invoice never moves a day when this changes."
                >
                  <Select
                    value={draft.timezone}
                    disabled={!admin}
                    options={zoneOptions}
                    onChange={(value) => setDraft({ ...draft, timezone: value })}
                    aria-label="Timezone"
                  />
                </Field>

                <Field
                  label="Locale"
                  error={action.errorFor('locale')}
                  hint="Decides digit grouping, decimal separators, date order and how a currency symbol is placed."
                >
                  <Select
                    value={draft.locale}
                    disabled={!admin}
                    options={localeOptions}
                    onChange={(value) => setDraft({ ...draft, locale: value })}
                    aria-label="Locale"
                  />
                </Field>
              </Stack>
            </Card>

            <Card
              title={dirty ? 'What this changes' : 'How the product reads now'}
              description={dirty
                ? 'The same formatter every screen uses, bound to the settings above rather than the saved ones.'
                : 'Rendered through the workspace’s saved locale, currency and timezone.'}
            >
              <Stack gap={4}>
                <KeyValue label="A large invoice total" value={preview.money(1234567)} strong />
                <KeyValue label="A credit balance" value={preview.money(-4500)} />
                <KeyValue label="Workspace time now" value={preview.dateTime(session.now())} />
                <KeyValue label="Zone" value={preview.timeZone.replace(/_/g, ' ')} />
                <KeyValue label="A large count" value={preview.number(1048576)} />
                {dirty && (
                  <>
                    <Divider label="saved right now" />
                    <KeyValue label="A large invoice total" value={f.money(1234567)} />
                    <KeyValue label="Workspace time now" value={f.dateTime(session.now())} />
                  </>
                )}
              </Stack>
            </Card>
          </Stack>
        </div>
      </Stack>
    </SettingsShell>
  );
}
