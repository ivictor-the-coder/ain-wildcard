/**
 * How an account pays: the methods on file, the prepaid credit it holds, and
 * the registration numbers that decide who accounts for its tax.
 *
 * This tab used to be a poster. Every object it renders is mutable through an
 * endpoint the API already serves, and the single most common billing task in
 * the world — "this account's card is failing, fix it" — happens on the screen
 * that shows it failing. Nothing here is simulated in the client: the platform
 * runs a simulated processor, so a method carries the outcome it will produce
 * and that outcome is chosen here, on the record, rather than in a fixture.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { usePlatform } from '../../kernel/platform';
import {
  Badge, Banner, Button, Card, DatePicker, EmptyState, Field, Grid, GridItem, Icons, Input,
  Menu, Modal, NumberInput, Select, Stack, Textarea, humanize,
  type MenuSection,
} from '../../design';
import { CreditCardIcon, XCircleIcon } from '../../design';
import { useSession } from '../../kernel/session';
import {
  DialogFields, Loading, MoneyField, SectionError, StatusPill, idem, statusLabel, useAction, useBillingFormat,
  useDialogForm,
} from './common';
import type { CreditBalance, CreditGrant, Customer, PaymentMethod, TaxId } from './types';

/* --------------------------------- shared -------------------------------- */

const INVALIDATE_PAYMENTS = ['/v1/payment_methods', '/v1/customers'];
const INVALIDATE_CREDITS = ['/v1/credit-grants', '/v1/credit-balance', '/v1/customers'];

/** A row menu that behaves like the grid's: one button, one popover, no nesting. */
function RowMenu({ sections, label }: { sections: MenuSection[]; label: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        iconLeft={<Icons.more size={14} />}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} sections={sections} ariaLabel={label} placement="bottom-end" />
    </>
  );
}

/* ============================== payment methods =========================== */

const CARD_BRANDS = ['visa', 'mastercard', 'amex', 'discover', 'jcb', 'diners', 'unionpay', 'unknown'] as const;

/**
 * What the simulated processor will do with this method.
 *
 * The wording is what an operator is chasing, not the code the gateway returns:
 * they are reproducing "her card keeps bouncing", so the list reads as reasons.
 */
const CARD_BEHAVIORS: { value: string; label: string }[] = [
  { value: 'succeeds', label: 'Authorises every charge' },
  { value: 'insufficient_funds', label: 'Declines — insufficient funds' },
  { value: 'card_declined', label: 'Declines — the issuer refused it' },
  { value: 'expired_card', label: 'Declines — expired card' },
  { value: 'incorrect_cvc', label: 'Declines — incorrect CVC' },
  { value: 'processing_error', label: 'Declines — processing error' },
  { value: 'authentication_required', label: 'Needs the cardholder to authenticate' },
];

const BANK_BEHAVIORS: { value: string; label: string }[] = [
  { value: 'succeeds', label: 'Collects every charge' },
  { value: 'insufficient_funds', label: 'Fails — insufficient funds' },
  { value: 'account_closed', label: 'Fails — the account is closed' },
  { value: 'no_account', label: 'Fails — no such account' },
  { value: 'debit_not_authorized', label: 'Fails — the mandate does not cover it' },
];

export function PaymentMethodDialog({ customer, open, onClose, method }: {
  customer: Customer; open: boolean; onClose: () => void; method?: PaymentMethod | null;
}) {
  const action = useAction();
  const editing = !!method;
  const [type, setType] = useState<'card' | 'bank_debit'>('card');
  const [brand, setBrand] = useState('visa');
  const [last4, setLast4] = useState('4242');
  const [expMonth, setExpMonth] = useState<number | null>(12);
  const [expYear, setExpYear] = useState<number | null>(new Date().getUTCFullYear() + 3);
  const [funding, setFunding] = useState('credit');
  const [bankName, setBankName] = useState('');
  const [accountType, setAccountType] = useState('checking');
  const [behavior, setBehavior] = useState('succeeds');
  const [declineCount, setDeclineCount] = useState<number | null>(null);
  const [setDefault, setSetDefault] = useState(true);

  useEffect(() => {
    if (!open) return;
    action.clear();
    if (method) {
      setType(method.type === 'bank_debit' ? 'bank_debit' : 'card');
      setExpMonth(method.card?.exp_month ?? null);
      setExpYear(method.card?.exp_year ?? null);
      setBehavior(method.simulated?.behavior ?? 'succeeds');
    } else {
      setType('card'); setBrand('visa'); setLast4('4242'); setFunding('credit');
      setExpMonth(12); setExpYear(new Date().getUTCFullYear() + 3);
      setBankName(''); setAccountType('checking'); setBehavior('succeeds');
      setDeclineCount(null); setSetDefault(true);
    }
  }, [open, method]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const result = editing && method
      ? await action.run(
        api.patch<PaymentMethod>(`/v1/payment_methods/${method.id}`, {
          ...(expMonth ? { exp_month: expMonth } : {}),
          ...(expYear ? { exp_year: expYear } : {}),
          simulated_behavior: behavior,
          ...(declineCount !== null ? { simulated_decline_count: declineCount } : {}),
        }),
        { success: 'Payment method updated', description: 'The next charge uses what you just set.', failure: 'The change was refused' },
        INVALIDATE_PAYMENTS,
      )
      : await action.run(
        api.post<PaymentMethod>('/v1/payment_methods', {
          type,
          customer: customer.id,
          ...(type === 'card'
            ? { brand, funding, last4: last4.trim(), ...(expMonth ? { exp_month: expMonth } : {}), ...(expYear ? { exp_year: expYear } : {}) }
            : { ...(bankName.trim() ? { bank_name: bankName.trim() } : {}), account_type: accountType, last4: last4.trim() }),
          simulated_behavior: behavior,
          ...(declineCount !== null ? { simulated_decline_count: declineCount } : {}),
          set_default: setDefault,
        }, { idempotencyKey: idem() }),
        {
          success: 'Payment method attached',
          description: setDefault ? `It is now the default for ${customer.name}.` : `It is on file for ${customer.name}.`,
          failure: 'The payment method was refused',
        },
        INVALIDATE_PAYMENTS,
      );
    if (result) onClose();
  };

  const behaviors = type === 'card' ? CARD_BEHAVIORS : BANK_BEHAVIORS;

  const form = useDialogForm(open, !(type === 'card' && last4.trim().length !== 4) && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${method?.display_name}` : 'Attach a payment method'}
      description={
        'This platform runs a simulated processor and never holds a card number. Describe the instrument the '
        + 'customer sent through, and choose the outcome charges against it should produce.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={type === 'card' && last4.trim().length !== 4} onClick={() => { void submit(); }}>
            {editing ? 'Save the method' : 'Attach it'}
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        {!editing && (
          <Field label="Instrument" hint="A card is charged automatically; a debit is collected against a mandate.">
            <Select
              value={type}
              onChange={(value) => { setType(value as 'card' | 'bank_debit'); setBehavior('succeeds'); }}
              options={[{ value: 'card', label: 'Card' }, { value: 'bank_debit', label: 'Bank debit' }]}
            />
          </Field>
        )}

        {type === 'card' ? (
          <Grid columns={4} gap={5}>
            <GridItem span={2}>
              <Field label="Brand" error={action.errorFor('brand')}>
                <Select
                  value={brand}
                  disabled={editing}
                  onChange={setBrand}
                  options={CARD_BRANDS.map((value) => ({ value, label: humanize(value) }))}
                />
              </Field>
            </GridItem>
            <GridItem span={2}>
              <Field label="Last four digits" required hint="The only part of a card number this platform ever stores." error={action.errorFor('last4')}>
                <Input value={last4} maxLength={4} disabled={editing} inputMode="numeric" onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="Expiry month" error={action.errorFor('exp_month')}>
                <NumberInput value={expMonth} min={1} max={12} onChange={setExpMonth} aria-label="Expiry month" />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="Expiry year" error={action.errorFor('exp_year')}>
                <NumberInput value={expYear} min={2000} max={2100} onChange={setExpYear} aria-label="Expiry year" />
              </Field>
            </GridItem>
            <GridItem span={2}>
              <Field label="Funding">
                <Select
                  value={funding}
                  disabled={editing}
                  onChange={setFunding}
                  options={['credit', 'debit', 'prepaid', 'unknown'].map((value) => ({ value, label: humanize(value) }))}
                />
              </Field>
            </GridItem>
          </Grid>
        ) : (
          <Grid columns={3} gap={5}>
            <GridItem span={2}>
              <Field label="Bank" error={action.errorFor('bank_name')}>
                <Input value={bankName} placeholder="Royal Bank of Canada" onChange={(e) => setBankName(e.target.value)} />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="Last four" required error={action.errorFor('last4')}>
                <Input value={last4} maxLength={4} inputMode="numeric" onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} />
              </Field>
            </GridItem>
            <GridItem span={3}>
              <Field label="Account type">
                <Select
                  value={accountType}
                  onChange={setAccountType}
                  options={[{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }]}
                />
              </Field>
            </GridItem>
          </Grid>
        )}

        <Field label="What charges against it do" hint="Every collection attempt in this workspace goes through this one setting.">
          <Select value={behavior} onChange={setBehavior} options={behaviors} />
        </Field>

        {behavior !== 'succeeds' && (
          <Field
            label="Declines before it starts working"
            optional
            hint="Leave empty to decline every time. Set 2 to reproduce an account that recovers on the third attempt."
            error={action.errorFor('simulated_decline_count')}
          >
            <NumberInput value={declineCount} min={0} max={20} onChange={setDeclineCount} aria-label="Declines before it starts working" />
          </Field>
        )}

        {!editing && (
          <Field label="Default for this account">
            <Select
              value={setDefault ? 'yes' : 'no'}
              onChange={(value) => setSetDefault(value === 'yes')}
              options={[
                { value: 'yes', label: 'Make it the default — automatic charges use it' },
                { value: 'no', label: 'Keep it on file only' },
              ]}
            />
          </Field>
        )}
      </Stack>
      </DialogFields>
    </Modal>
  );
}

export function PaymentMethodsCard({ customer }: { customer: Customer }) {
  const platform = usePlatform(true);
  const action = useAction();
  const served = platform.serves('GET', '/v1/customers/:id/payment_methods');
  const methods = useQuery<ListEnvelope<PaymentMethod>>(`/v1/customers/${customer.id}/payment_methods`, undefined, { enabled: served });
  const [dialog, setDialog] = useState<null | { method: PaymentMethod | null }>(null);

  const rows = methods.data?.data ?? [];
  const attached = rows.filter((row) => row.status === 'attached');
  const declining = attached.filter((row) => row.simulated && row.simulated.behavior !== 'succeeds');

  const menuFor = (method: PaymentMethod): MenuSection[] => [{
    id: 'method',
    items: [
      {
        id: 'default',
        label: 'Make it the default',
        icon: <Icons.check size={14} />,
        disabled: method.default_for_customer || method.status !== 'attached',
        onSelect: () => {
          void action.run(
            api.post<PaymentMethod>(`/v1/payment_methods/${method.id}/set_default`, {}),
            { success: 'Default payment method changed', description: `${method.display_name} now takes the automatic charges.`, failure: 'That method could not be made the default' },
            INVALIDATE_PAYMENTS,
          );
        },
      },
      { id: 'edit', label: 'Edit expiry or behaviour…', icon: <Icons.edit size={14} />, onSelect: () => setDialog({ method }) },
      {
        id: 'detach',
        label: 'Detach it',
        icon: <Icons.trash size={14} />,
        danger: true,
        disabled: method.status !== 'attached',
        onSelect: () => {
          void action.run(
            api.post<PaymentMethod>(`/v1/payment_methods/${method.id}/detach`, {}),
            {
              success: `${method.display_name} detached`,
              description: 'Nothing can be charged against it now. The payments it already made keep pointing at it.',
              failure: 'That method could not be detached',
            },
            INVALIDATE_PAYMENTS,
          );
        },
      },
    ],
  }];

  return (
    <Card
      title="Payment methods"
      description="What this account can be charged against."
      actions={served && rows.length > 0
        ? <Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={() => setDialog({ method: null })}>Attach</Button>
        : undefined}
    >
      {!served && <EmptyState size="sm" inline illustration={null} title="Payments is not installed" body="No module on this workspace serves payment methods." />}
      {served && methods.loading && <Loading label="Reading payment methods…" />}
      {served && methods.error && (
        <SectionError error={methods.error} path={`GET /v1/customers/${customer.id}/payment_methods`} onRetry={methods.refetch} />
      )}
      {served && !methods.loading && !methods.error && rows.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No payment method on file"
          body="Nothing can be collected automatically until there is one, and a trial that ends without one follows the trial end behaviour."
          action={<Button size="sm" variant="primary" iconLeft={<Icons.plus size={13} />} onClick={() => setDialog({ method: null })}>Attach a payment method</Button>}
        />
      )}

      {customer.delinquent && declining.length > 0 && (
        <Banner tone="danger" compact title="This is why the account is delinquent">
          {`${declining.map((row) => row.display_name).join(', ')} ${declining.length === 1 ? 'is' : 'are'} set to decline. `
            + 'Attach a working method and make it the default, then present the open invoices for collection again.'}
        </Banner>
      )}

      {rows.map((method) => (
        <div key={method.id} className="bl-row">
          <span className="bl-row__icon"><CreditCardIcon size={16} /></span>
          <div className="bl-row__main">
            <div className="bl-row__title">{method.display_name}</div>
            <div className="bl-row__sub">
              {humanize(method.type)}
              {method.simulated ? ` · ${method.simulated.explanation}` : ''}
            </div>
          </div>
          <div className="bl-row__aside">
            {method.default_for_customer
              ? <Badge tone="brand">Default</Badge>
              : <Badge tone={method.status === 'attached' ? 'neutral' : 'warning'}>{humanize(method.status)}</Badge>}
          </div>
          <div className="bl-row__act">
            <RowMenu sections={menuFor(method)} label={`Actions for ${method.display_name}`} />
          </div>
        </div>
      ))}

      {dialog && (
        <PaymentMethodDialog customer={customer} method={dialog.method} open onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}

/* ============================== credit grants ============================= */

interface Meter { id: string; display_name?: string; name?: string; unit_label?: string | null }

export function CreditGrantDialog({ customer, open, onClose }: { customer: Customer; open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const session = useSession();
  const action = useAction();
  const platform = usePlatform(true);
  const meters = useQuery<ListEnvelope<Meter>>('/v1/meters', { limit: 100 }, { enabled: platform.serves('GET', '/v1/meters') });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'monetary' | 'unit'>('monetary');
  const [category, setCategory] = useState<'paid' | 'promotional'>('promotional');
  const [amount, setAmount] = useState<number | null>(null);
  const [units, setUnits] = useState<number | null>(null);
  const [meter, setMeter] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  const meterOptions = useMemo(
    () => (meters.data?.data ?? []).map((row) => ({ value: row.id, label: row.display_name ?? row.name ?? row.id })),
    [meters.data],
  );

  useEffect(() => {
    if (!open) return;
    action.clear();
    setName(''); setKind('monetary'); setCategory('promotional');
    setAmount(null); setUnits(null); setExpiresAt(null); setReason('');
    setMeter(meterOptions[0]?.value ?? '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!meter && meterOptions.length) setMeter(meterOptions[0].value); }, [meterOptions, meter]);

  const value = kind === 'monetary' ? amount : units;
  const submit = async () => {
    const result = await action.run(
      api.post<CreditGrant>('/v1/credit-grants', {
        customer: customer.id,
        name: name.trim() || (kind === 'monetary' ? 'Account credit' : 'Usage credit'),
        category,
        kind,
        ...(kind === 'monetary'
          ? { currency: customer.currency, amount: amount ?? 0, applicability: { scope: 'all' } }
          : { amount: units ?? 0, meter, applicability: { scope: 'targeted', meters: [meter] } }),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: 'Credit granted',
        description: kind === 'monetary'
          ? `${f.money(amount ?? 0, { currency: customer.currency })} is available to draw down before the balance is touched.`
          : `${f.number(units ?? 0)} units are available on that meter.`,
        failure: 'The grant was refused',
      },
      INVALIDATE_CREDITS,
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, !!value && value > 0 && !(kind === 'unit' && !meter) && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Grant credit to ${customer.name}`}
      description="Prepaid credit is drawn down before anything reaches the invoice — it is not a balance adjustment, and it can be restricted to what it may pay for."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!value || value <= 0 || (kind === 'unit' && !meter)} onClick={() => { void submit(); }}>
            Grant it
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field label="Name" optional hint="What this pot is called on the invoice that draws it down." error={action.errorFor('name')}>
          <Input value={name} maxLength={140} placeholder="Goodwill for the 6 March ingestion outage" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Grid columns={2} gap={5}>
          <GridItem>
            <Field label="What is granted" hint="Money pays for anything in this currency; units pay for usage on one meter.">
              <Select
                value={kind}
                onChange={(next) => setKind(next as 'monetary' | 'unit')}
                options={[
                  { value: 'monetary', label: `Money — ${customer.currency.toUpperCase()}` },
                  { value: 'unit', label: 'Metered units' },
                ]}
              />
            </Field>
          </GridItem>
          <GridItem>
            <Field label="Where it came from" hint="Paid credit can be refunded; promotional credit can only be voided.">
              <Select
                value={category}
                onChange={(next) => setCategory(next as 'paid' | 'promotional')}
                options={[
                  { value: 'promotional', label: 'Promotional — given, not bought' },
                  { value: 'paid', label: 'Paid — the customer bought it' },
                ]}
              />
            </Field>
          </GridItem>
        </Grid>

        {kind === 'monetary' ? (
          <Field label="Amount" required hint={`In ${customer.currency.toUpperCase()}, the currency this account bills in.`} error={action.errorFor('amount')}>
            <MoneyField value={amount} onChange={setAmount} currency={customer.currency} min={1} label="Amount" />
          </Field>
        ) : (
          <Grid columns={2} gap={5}>
            <GridItem>
              <Field label="Units" required error={action.errorFor('amount')}>
                <NumberInput value={units} min={1} max={1_000_000_000} onChange={setUnits} aria-label="Units" />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="Meter" required hint="The usage this credit may be spent on." error={action.errorFor('meter')}>
                <Select
                  value={meter}
                  onChange={setMeter}
                  options={meterOptions.length ? meterOptions : [{ value: '', label: 'No meter is installed' }]}
                />
              </Field>
            </GridItem>
          </Grid>
        )}

        <Field label="Expires on" optional hint="Leave empty and it never expires. Expiry is a job, so the time machine replays it." >
          <DatePicker value={expiresAt} onChange={setExpiresAt} min={session.now()} aria-label="Expires on" />
        </Field>
        <Field label="Why" optional counter={{ value: reason.length, max: 300 }} error={action.errorFor('reason')}>
          <Textarea value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="What the customer was promised, for whoever reads the ledger in a year." />
        </Field>
      </Stack>
      </DialogFields>
    </Modal>
  );
}

function GrantRefundDialog({ grant, open, onClose }: { grant: CreditGrant; open: boolean; onClose: () => void }) {
  const f = useBillingFormat();
  const action = useAction();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) { setAmount(grant.balance); setReason(''); action.clear(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const result = await action.run(
      api.post<CreditGrant>(`/v1/credit-grants/${grant.id}/refund`, {
        ...(amount !== null ? { amount } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }, { idempotencyKey: idem() }),
      {
        success: 'Credit refunded',
        description: 'The refunded units come off the pot pro rata to what was paid for them.',
        failure: 'The refund was refused',
      },
      INVALIDATE_CREDITS,
    );
    if (result) onClose();
  };

  const form = useDialogForm(open, !!amount && amount > 0 && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Refund ${grant.name}`}
      description="Only unused paid credit can be refunded, and only pro rata to what was bought."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!amount || amount <= 0} onClick={() => { void submit(); }}>
            Refund it
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Banner tone="info" compact>
          {grant.kind === 'monetary'
            ? `${f.money(grant.balance, { currency: grant.currency })} of this grant is unused.`
            : `${f.number(grant.balance)} ${grant.unit_label ?? 'units'} of this grant are unused.`}
        </Banner>
        <Field label="Amount to refund" required error={action.errorFor('amount')}>
          {grant.kind === 'monetary'
            ? <MoneyField value={amount} onChange={setAmount} currency={grant.currency} min={1} max={grant.balance} label="Amount to refund" />
            : <NumberInput value={amount} min={1} max={grant.balance} onChange={setAmount} aria-label="Amount to refund" />}
        </Field>
        <Field label="Why" optional error={action.errorFor('reason')}>
          <Input value={reason} maxLength={300} placeholder="Unused prepay returned on cancellation" onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Stack>
      </DialogFields>
    </Modal>
  );
}

export function CreditCard({ customer }: { customer: Customer }) {
  const f = useBillingFormat();
  const platform = usePlatform(true);
  const action = useAction();
  const served = platform.serves('GET', '/v1/customers/:id/credit-balance');
  const balance = useQuery<CreditBalance>(`/v1/customers/${customer.id}/credit-balance`, undefined, { enabled: served });
  const grants = useQuery<ListEnvelope<CreditGrant>>('/v1/credit-grants', { customer: customer.id, limit: 50 }, { enabled: served });
  const [granting, setGranting] = useState(false);
  const [refunding, setRefunding] = useState<CreditGrant | null>(null);

  const rows = grants.data?.data ?? [];
  const pots = balance.data?.balances ?? [];
  const scopes = useMemo(() => [...new Set(rows.map((grant) => grant.applies_to))], [rows]);

  const menuFor = (grant: CreditGrant): MenuSection[] => [{
    id: 'grant',
    items: [
      {
        id: 'refund',
        // A disabled item with no reason is a dead end: the rule lives inside a
        // different dialog the operator is not looking at. Say it here.
        label: grant.category !== 'paid'
          ? 'Refund — promotional credit can only be voided'
          : grant.balance <= 0
            ? 'Refund — nothing is left on this grant'
            : grant.status !== 'active'
              ? `Refund — this grant is ${statusLabel(grant.status).toLowerCase()}`
              : 'Refund the unused balance…',
        icon: <Icons.receipt size={14} />,
        disabled: grant.category !== 'paid' || grant.balance <= 0 || grant.status !== 'active',
        onSelect: () => setRefunding(grant),
      },
      {
        id: 'void',
        label: 'Void this grant',
        icon: <XCircleIcon size={14} />,
        danger: true,
        disabled: grant.status !== 'active',
        onSelect: () => {
          void action.run(
            api.post<CreditGrant>(`/v1/credit-grants/${grant.id}/void`, { reason: 'Withdrawn from the customer record.' }),
            {
              success: `${grant.name} voided`,
              description: 'Whatever was left on it is withdrawn; what it has already paid for stands.',
              failure: 'The grant could not be voided',
            },
            INVALIDATE_CREDITS,
          );
        },
      },
    ],
  }];

  return (
    <Card
      title="Prepaid credit"
      description="Credit packs and grants, and what they may be spent on."
      actions={served && (pots.length > 0 || rows.length > 0)
        ? <Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={() => setGranting(true)}>Grant credit</Button>
        : undefined}
    >
      {!served && <EmptyState size="sm" inline illustration={null} title="Credits is not installed" body="No module on this workspace serves prepaid credit." />}
      {served && (balance.loading || grants.loading) && <Loading label="Reading credit…" />}
      {served && balance.error && (
        <SectionError error={balance.error} path={`GET /v1/customers/${customer.id}/credit-balance`} onRetry={balance.refetch} />
      )}
      {served && !balance.loading && !balance.error && (
        <>
          {pots.length === 0 && rows.length === 0 && (
            <EmptyState
              size="sm"
              inline
              illustration={null}
              title="No prepaid credit"
              body="This account pays for usage on the invoice rather than from a pot bought up front."
              action={<Button size="sm" variant="primary" iconLeft={<Icons.plus size={13} />} onClick={() => setGranting(true)}>Grant credit</Button>}
            />
          )}
          {/* The pot is the total; the grants beneath it are what make it up.
              Titling the total with the API's applicability sentence made the
              heading and every grant under it repeat the same lowercase phrase,
              and with one grant nothing distinguished the total from the row. */}
          {pots.map((bucket) => (
            <div key={bucket.key} className="bl-row bl-row--total">
              <div className="bl-row__main">
                <div className="bl-row__title">
                  {bucket.kind === 'monetary'
                    ? `Available — ${bucket.currency.toUpperCase()}`
                    : `Available — ${bucket.unit_label ?? 'units'}`}
                </div>
                <div className="bl-row__sub">
                  {`${bucket.applies_to} · `}
                  {bucket.next_expiry ? `next expiry ${f.day(bucket.next_expiry.at)}, ${bucket.next_expiry.grant_name}` : 'never expires'}
                </div>
              </div>
              <div className="bl-row__aside bl-row__aside--total">
                {bucket.kind === 'monetary'
                  ? f.money(bucket.available, { currency: bucket.currency })
                  : `${f.number(bucket.available)} ${bucket.unit_label ?? 'units'}`}
              </div>
            </div>
          ))}
          {rows.map((grant) => (
            <div key={grant.id} className="bl-row">
              <div className="bl-row__main">
                <div className="bl-row__title">{grant.name}</div>
                <div className="bl-row__sub">
                  {/* The scope only earns a line when the grants in this pot
                      do not all share it — otherwise it is the total's caption
                      printed again, once per row. */}
                  {scopes.length > 1 ? `${grant.applies_to} · ` : ''}
                  {humanize(grant.source)}
                  {grant.expires_at ? ` · expires ${f.day(grant.expires_at)}` : ''}
                </div>
              </div>
              <div className="bl-row__aside">
                <div>
                  {grant.kind === 'monetary'
                    ? f.money(grant.balance, { currency: grant.currency })
                    : `${f.number(grant.balance)} of ${f.number(grant.amount)} ${grant.unit_label ?? 'units'}`}
                </div>
                <div className="bl-sub"><StatusPill status={grant.status} /></div>
              </div>
              <div className="bl-row__act">
                <RowMenu sections={menuFor(grant)} label={`Actions for ${grant.name}`} />
              </div>
            </div>
          ))}
        </>
      )}

      <CreditGrantDialog customer={customer} open={granting} onClose={() => setGranting(false)} />
      {refunding && <GrantRefundDialog grant={refunding} open onClose={() => setRefunding(null)} />}
    </Card>
  );
}

export function PaymentsTab({ customer }: { customer: Customer }) {
  return (
    <div className="bl-cols">
      <PaymentMethodsCard customer={customer} />
      <CreditCard customer={customer} />
    </div>
  );
}

/* ============================ tax registrations =========================== */

/**
 * The registration kinds the server validates the shape of.
 *
 * `country` is the country that *issues* the kind, which is what the tax engine
 * needs and what the field on the dialog means — not the address the invoice is
 * sent to. EU VAT has no single issuer, so it is derived from the number's own
 * two-letter prefix instead.
 */
const TAX_ID_TYPES: { value: string; label: string; example: string; country: string | null }[] = [
  { value: 'eu_vat', label: 'EU VAT', example: 'DE811907980', country: null },
  { value: 'gb_vat', label: 'UK VAT', example: 'GB123456789', country: 'United Kingdom' },
  { value: 'ch_vat', label: 'Swiss VAT', example: 'CHE123456789MWST', country: 'Switzerland' },
  { value: 'no_vat', label: 'Norwegian VAT', example: 'NO123456789MVA', country: 'Norway' },
  { value: 'us_ein', label: 'US EIN', example: '12-3456789', country: 'United States' },
  { value: 'ca_bn', label: 'Canadian Business Number', example: '123456789', country: 'Canada' },
  { value: 'ca_gst_hst', label: 'Canadian GST/HST', example: '123456789RT0001', country: 'Canada' },
  { value: 'au_abn', label: 'Australian Business Number', example: '12345678901', country: 'Australia' },
  { value: 'nz_gst', label: 'New Zealand GST', example: '123456789', country: 'New Zealand' },
  { value: 'in_gst', label: 'Indian GSTIN', example: '27AAPFU0939F1ZV', country: 'India' },
  { value: 'jp_ct', label: 'Japanese Corporate Number', example: 'T1234567890123', country: 'Japan' },
  { value: 'sg_gst', label: 'Singapore GST', example: '12345678M', country: 'Singapore' },
  { value: 'za_vat', label: 'South African VAT', example: '4123456789', country: 'South Africa' },
  { value: 'br_cnpj', label: 'Brazilian CNPJ', example: '12345678000195', country: 'Brazil' },
  { value: 'mx_rfc', label: 'Mexican RFC', example: 'ABC010203AB9', country: 'Mexico' },
  { value: 'kr_brn', label: 'Korean BRN', example: '123-45-67890', country: 'South Korea' },
];

/** The VAT prefixes an EU number carries, which name its issuing member state. */
const EU_VAT_COUNTRIES: Record<string, string> = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany',
  DK: 'Denmark', EE: 'Estonia', EL: 'Greece', ES: 'Spain', FI: 'Finland', FR: 'France',
  HR: 'Croatia', HU: 'Hungary', IE: 'Ireland', IT: 'Italy', LT: 'Lithuania', LU: 'Luxembourg',
  LV: 'Latvia', MT: 'Malta', NL: 'Netherlands', PL: 'Poland', PT: 'Portugal', RO: 'Romania',
  SE: 'Sweden', SI: 'Slovenia', SK: 'Slovakia',
};

/** The kind a business in this country would actually hold. */
function kindForCountry(country: string | null | undefined): string {
  if (!country) return 'eu_vat';
  if (Object.values(EU_VAT_COUNTRIES).includes(country)) return 'eu_vat';
  return TAX_ID_TYPES.find((row) => row.country === country)?.value ?? 'eu_vat';
}

/** Where a registration of this kind, written this way, was issued. */
function countryForRegistration(type: string, value: string): string | null {
  if (type === 'eu_vat') return EU_VAT_COUNTRIES[value.trim().slice(0, 2).toUpperCase()] ?? null;
  return TAX_ID_TYPES.find((row) => row.value === type)?.country ?? null;
}

function TaxIdDialog({ customer, open, onClose }: { customer: Customer; open: boolean; onClose: () => void }) {
  const action = useAction();
  const [type, setType] = useState(() => kindForCountry(customer.address?.country));
  const [value, setValue] = useState('');
  const [country, setCountry] = useState('');
  const [countryTouched, setCountryTouched] = useState(false);
  const [status, setStatus] = useState('pending');

  useEffect(() => {
    if (!open) return;
    action.clear();
    // Kind follows the billing country — a Des Moines business is offered US
    // EIN, not EU VAT with a German example number underneath it.
    setType(kindForCountry(customer.address?.country));
    setValue('');
    setStatus('pending');
    // Country is explicitly the "differs from the billing address" override, so
    // it starts empty and is derived from the *registration*, never from the
    // address it is there to override. Prefilling it from the address is how a
    // UK VAT number was persisted as issued in the United States.
    setCountry('');
    setCountryTouched(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-derived whenever the kind or the number changes, until it is typed into.
  const derived = countryForRegistration(type, value);
  useEffect(() => {
    if (!countryTouched) setCountry(derived ?? '');
  }, [derived, countryTouched]);

  const row = TAX_ID_TYPES.find((r) => r.value === type);
  const example = row?.example ?? '';
  const issuer = derived;
  const mismatch = countryTouched && country.trim() && issuer && country.trim().toLowerCase() !== issuer.toLowerCase()
    ? `${row?.label ?? 'This kind'} is issued by ${issuer}. Saving it as issued in ${country.trim()} means the tax engine will look for the wrong register.`
    : null;

  const submit = async () => {
    const next = [
      ...customer.tax_ids.map((row) => ({ type: row.type, value: row.value, ...(row.country ? { country: row.country } : {}) })),
      { type, value: value.trim(), ...(country.trim() ? { country: country.trim() } : {}) },
    ];
    const saved = await action.run(
      api.patch<Customer>(`/v1/customers/${customer.id}`, { tax_ids: next }),
      {
        success: 'Registration added',
        description: status === 'verified'
          ? 'It is recorded as confirmed, so a cross-border supply is reverse charged.'
          : 'Tax is charged as normal until the register confirms it.',
        failure: 'The registration was refused',
        // The refusal is already on the Registration number field, which is the
        // field it is about. A toast over the dialog says it a second time and
        // covers the input that would fix it.
        inlineOnly: true,
      },
      ['/v1/customers'],
    );
    if (!saved) return;
    if (status !== 'pending') {
      await action.run(
        api.post<Customer>(`/v1/customers/${customer.id}/tax_ids/verify`, { value: value.trim(), status }),
        { success: 'Verification recorded', failure: 'The verification could not be recorded' },
        ['/v1/customers'],
      );
    }
    onClose();
  };

  const form = useDialogForm(open, value.trim().length >= 2 && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a tax registration"
      description="A number the register confirmed is the only thing that shifts the tax onto the customer. Anything else is charged the rate its address matches."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={value.trim().length < 2} onClick={() => { void submit(); }}>
            Add it
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field label="Kind" hint={`Defaulted from the billing address${customer.address?.country ? ` — ${customer.address.country}` : ''}.`}>
          <Select
            value={type}
            onChange={(next) => { setType(next); setCountryTouched(false); }}
            options={TAX_ID_TYPES.map((r) => ({ value: r.value, label: r.label }))}
          />
        </Field>
        <Field
          label="Registration number"
          required
          hint={`As the authority writes it — ${example}. Spaces and dots come off; a number that is not the right shape is refused.`}
          error={action.errorFor('tax_ids')}
        >
          <Input value={value} maxLength={60} placeholder={example} onChange={(e) => setValue(e.target.value.toUpperCase())} mono />
        </Field>
        <Field
          label="Issued in"
          optional
          hint={issuer && !countryTouched
            ? `Read from the registration itself — ${issuer}. Override it only if the register that issued it is elsewhere.`
            : 'Where the registration was issued, when that differs from the billing address.'}
          error={mismatch ?? undefined}
        >
          <Input
            value={country}
            maxLength={80}
            placeholder={type === 'eu_vat' ? 'Set by the number’s country prefix' : 'Set by the kind above'}
            invalid={!!mismatch}
            onChange={(e) => { setCountryTouched(true); setCountry(e.target.value); }}
          />
        </Field>
        <Field label="Has the register confirmed it?" hint="Record what a check actually returned. Only 'verified' moves the tax.">
          <Select
            value={status}
            onChange={setStatus}
            options={[
              { value: 'pending', label: 'Not checked yet' },
              { value: 'verified', label: 'Verified — the register confirmed it' },
              { value: 'unverified', label: 'Unverified — the register did not recognise it' },
              { value: 'unavailable', label: 'Unavailable — the register did not answer' },
            ]}
          />
        </Field>
      </Stack>
      </DialogFields>
    </Modal>
  );
}

export function TaxRegistrationsCard({ customer }: { customer: Customer }) {
  const f = useBillingFormat();
  const action = useAction();
  const [adding, setAdding] = useState(false);

  const remove = (taxId: TaxId) => {
    void action.run(
      api.patch<Customer>(`/v1/customers/${customer.id}`, {
        tax_ids: customer.tax_ids
          .filter((row) => !(row.type === taxId.type && row.value === taxId.value))
          .map((row) => ({ type: row.type, value: row.value, ...(row.country ? { country: row.country } : {}) })),
      }),
      {
        success: `${taxId.value} removed`,
        description: 'This account is charged the rate its address matches from the next invoice.',
        failure: 'The registration could not be removed',
      },
      ['/v1/customers'],
    );
  };

  const verify = (taxId: TaxId, status: string) => {
    void action.run(
      api.post<Customer>(`/v1/customers/${customer.id}/tax_ids/verify`, { value: taxId.value, status }),
      {
        success: status === 'verified' ? `${taxId.value} verified` : 'Verification recorded',
        description: status === 'verified'
          ? 'A cross-border supply to this account is now reverse charged.'
          : 'Tax is charged as normal until the register confirms it.',
        failure: 'The verification could not be recorded',
      },
      ['/v1/customers'],
    );
  };

  const menuFor = (taxId: TaxId): MenuSection[] => [{
    id: 'taxid',
    label: 'What the register said',
    items: [
      { id: 'verified', label: 'Mark verified', icon: <Icons.check size={14} />, disabled: taxId.verification.status === 'verified', onSelect: () => verify(taxId, 'verified') },
      { id: 'unverified', label: 'Mark unverified', icon: <XCircleIcon size={14} />, disabled: taxId.verification.status === 'unverified', onSelect: () => verify(taxId, 'unverified') },
      { id: 'unavailable', label: 'Register did not answer', icon: <Icons.help size={14} />, onSelect: () => verify(taxId, 'unavailable') },
      { id: 'remove', label: 'Remove this registration', icon: <Icons.trash size={14} />, danger: true, onSelect: () => remove(taxId) },
    ],
  }];

  return (
    <Card
      title="Tax registrations"
      description="A number the register confirmed is the only thing that shifts tax onto the customer."
      actions={customer.tax_ids.length > 0
        ? <Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={() => setAdding(true)}>Add</Button>
        : undefined}
    >
      {customer.tax_ids.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No registration on file"
          body="Without one, this account is charged the rate its address matches."
          action={<Button size="sm" variant="primary" iconLeft={<Icons.plus size={13} />} onClick={() => setAdding(true)}>Add a registration</Button>}
        />
      )}
      {customer.tax_ids.map((taxId) => (
        <div key={`${taxId.type}-${taxId.value}`} className="bl-row">
          <div className="bl-row__main">
            <div className="bl-row__title u-mono">{taxId.value}</div>
            <div className="bl-row__sub">{taxId.verification.note ?? humanize(taxId.type)}</div>
            {taxId.verification.checked_at && (
              <div className="bl-row__sub">
                {`${taxId.verification.verified_name ? `${taxId.verification.verified_name} · ` : ''}checked ${f.date(taxId.verification.checked_at, { withYear: true })}`}
              </div>
            )}
          </div>
          <div className="bl-row__aside"><StatusPill status={taxId.verification.status} /></div>
          <div className="bl-row__act">
            <RowMenu sections={menuFor(taxId)} label={`Actions for ${taxId.value}`} />
          </div>
        </div>
      ))}
      <TaxIdDialog customer={customer} open={adding} onClose={() => setAdding(false)} />
    </Card>
  );
}
