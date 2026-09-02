/**
 * Writing, with the workspace's own facts in it.
 *
 * `POST /v1/ai/draft` composes from a record — the deal's agreed next step, the
 * contact who owns it, the signature of whoever is asking — and says which facts
 * it used. This dialog is the loop around it: choose what kind of message and
 * what tone, choose who it is to, read what came back, *edit it*, and log it on
 * the record's timeline.
 *
 * What steers the engine is the kind and the tone; those are the controls, and
 * each says what it produces before you press the button. A sentence of your own
 * is optional, is yours rather than the engine's, and is dropped into the draft
 * verbatim where you can move it — the dialog does not ask for an instruction it
 * would then quietly ignore.
 *
 * Nothing is sent to anybody. Logging writes an email activity on the record,
 * which is what the CRM, the copilot's later answers and the timeline all read.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, invalidate, useMutation, useQuery, type ApiClientError, type ListEnvelope } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import {
  Badge, Banner, Button, Combobox, Field, Icons, Input, Modal, Select, SkeletonText, Textarea,
  humanize, useFormat, useToast, type ComboOption, type SelectOption,
} from '@/client/design';
import {
  EMPTY_LEDGER, checkDunning, draftsFromAccount, ledgerFrom, ledgerTotal, type LedgerRead,
} from './draft-core';

/** What each kind actually produces, so the control that steers is legible. */
const KINDS: { value: string; label: string; hint: string }[] = [
  { value: 'follow_up', label: 'Follow-up', hint: 'Picks up the agreed next step and asks whether it still stands.' },
  { value: 'intro', label: 'Intro', hint: 'A first touch — who we are, and why this account.' },
  { value: 'check_in', label: 'Check-in', hint: 'A light touch on a deal that has gone quiet.' },
  { value: 'renewal', label: 'Renewal', hint: 'Ahead of the contract end, with what the account runs today.' },
  {
    value: 'dunning',
    label: 'Payment chase',
    hint: 'Names the invoices still due on the account, with the amounts and how late they are. Written from the ledger, and refused if the ledger cannot be read.',
  },
  { value: 'meeting_recap', label: 'Meeting recap', hint: 'What was agreed and who does what next.' },
  { value: 'call_summary', label: 'Call summary', hint: 'A record of the last call, for the timeline.' },
  { value: 'meeting_notes', label: 'Meeting notes', hint: 'Notes as notes — no greeting, no sign-off.' },
  { value: 'deal_summary', label: 'Deal summary', hint: 'The whole deal on one page, for a pipeline review.' },
  { value: 'handover', label: 'Handover', hint: 'Everything the next owner needs to take this over.' },
  { value: 'escalation_update', label: 'Escalation update', hint: 'Where the open ticket stands and what happens next.' },
  { value: 'win_back', label: 'Win back', hint: 'Re-opens a deal that closed lost.' },
];

const TONES: { value: string; label: string; hint: string }[] = [
  { value: 'direct', label: 'Direct', hint: 'Plain, and to the point.' },
  { value: 'warm', label: 'Warm', hint: 'First names, and a thank you.' },
  { value: 'formal', label: 'Formal', hint: '“Dear …”, full names, “Kind regards”.' },
  { value: 'concise', label: 'Concise', hint: 'As short as the facts allow.' },
  { value: 'consultative', label: 'Consultative', hint: 'Leads with an observation rather than an ask.' },
  { value: 'urgent', label: 'Urgent', hint: 'Says what is needed, and by when.' },
  { value: 'apologetic', label: 'Apologetic', hint: 'Opens by acknowledging what went wrong.' },
];

export interface AiDraft {
  object: 'ai_draft';
  channel: string;
  kind: string;
  tone: string;
  subject: string;
  body: string;
  /** The workspace facts the engine put in, quoted back so they can be checked. */
  personalisation: string[];
  recipient: { id: string; name: string; email: string } | null;
}

export interface DraftSubject {
  id: string;
  objectType: string;
  name: string;
}

interface RecordRow { id: string; display_name: string }

interface AssociationRow {
  id: string;
  association_type: string;
  record_id: string;
  object_type: string;
  display_name: string;
  is_primary: boolean;
}

/** Errors the server raised, bound to the `param` it named. */
const errorFor = (error: ApiClientError | null, param: string): string | null =>
  error && error.body.param === param ? error.body.message : null;

/** The record's short name — a deal is "Account — programme", the account is enough. */
const shortName = (name: string): string => {
  const head = name.split(' — ')[0];
  return head.length > 42 ? `${head.slice(0, 41)}…` : head;
};

/**
 * Put the operator's own sentence into the draft.
 *
 * Under the greeting is where a person would type it, and it is one paragraph so
 * it can be dragged anywhere else before the draft is logged. It is inserted
 * verbatim: these are the user's words, not a claim the engine is making.
 */
export function withOwnLine(body: string, line: string): string {
  const own = line.trim();
  if (!own) return body;
  const blocks = body.split(/\n{2,}/);
  if (blocks.length < 2) return `${body}\n\n${own}`;
  return [blocks[0], own, ...blocks.slice(1)].join('\n\n');
}

export function DraftDialog({
  open, subject, onClose, onLogged,
}: {
  open: boolean;
  /** Fixed when opened from a record; chosen in the dialog when opened from the copilot. */
  subject?: DraftSubject;
  onClose: () => void;
  onLogged?: () => void;
}) {
  const toast = useToast();
  const f = useFormat();
  // The workspace's clock, not the browser's: `POST /v1/time/advance` moves the
  // ledger's idea of "56 days late" and the chase has to move with it.
  const session = useSession();
  const [kind, setKind] = useState<string>('follow_up');
  const [tone, setTone] = useState<string>('direct');
  const [ownLine, setOwnLine] = useState('');
  const [contactId, setContactId] = useState('');
  const [pickedId, setPickedId] = useState('');
  const [pickedName, setPickedName] = useState('');
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  // A combobox hands back the id it was given; the label it was chosen by has to
  // be remembered, or the button that commits the write names a primary key.
  const names = useRef(new Map<string, string>());
  /**
   * Where the caret goes when the dialog opens, and where it goes when the
   * draft lands.
   *
   * The focus trap otherwise takes the first focusable node it finds, which is
   * the header's close button: typing a search straight into the dialog sent
   * the first Space to Close and threw the whole thing away. And when the draft
   * arrives the form it replaces is unmounted, so the caret fell to `<body>`
   * with an editable subject, body and two actions on screen — 25 Tab stops
   * from the sidebar. The first field takes it on open; Subject takes it when
   * there is something to edit.
   */
  const firstField = useRef<HTMLElement | null>(null);
  const subjectField = useRef<HTMLInputElement>(null);
  const captureFirstField = (node: HTMLDivElement | null) => {
    firstField.current = node?.querySelector<HTMLElement>('input, select, textarea') ?? null;
  };

  /**
   * The form that had focus is gone once the draft lands, so the caret follows
   * the draft rather than falling to the document.
   *
   * This used to be one `requestAnimationFrame` inside the mutation's success
   * handler, which is a race it lost about one time in five: React had not
   * necessarily committed the draft by the next frame, so `subjectField` was
   * still null and the focus call did nothing. An effect runs after the commit
   * that mounts the field, which is exactly when it can be focused.
   */
  useEffect(() => { if (draft) subjectField.current?.focus(); }, [draft]);

  useEffect(() => {
    if (!open) return;
    setKind('follow_up');
    setTone('direct');
    setOwnLine('');
    setContactId('');
    setPickedId(subject?.id ?? '');
    setPickedName(subject?.name ?? '');
    setDraft(null);
  }, [open, subject?.id, subject?.name]);

  const targetId = subject?.id ?? pickedId;
  const targetName = subject?.name ?? pickedName;
  const targetType = subject?.objectType ?? 'deal';

  // Who the draft is addressed to. The engine picks the primary contact when
  // nobody is named; naming one is the difference between a draft you can send
  // and a draft you have to rewrite.
  const record = useQuery<{ associations?: AssociationRow[] }>(
    open && targetId ? `/v1/records/${targetType}/${encodeURIComponent(targetId)}` : null,
    { expand: 'associations' },
  );
  const contacts = useMemo(
    () => (record.data?.associations ?? []).filter((row) => row.object_type === 'contact'),
    [record.data],
  );

  /**
   * The account behind the record, and its ledger.
   *
   * A chase is a claim about invoices, invoices hang off a billing customer,
   * and a billing customer hangs off the *company* — never off the deal this
   * dialog searches. Handing `POST /v1/ai/draft` a deal id is why every chase
   * it produced opened "the billing ledger shows no invoice with an amount
   * still due on that account" for accounts that owed six figures.
   */
  const chasing = draftsFromAccount(kind);
  const account = useMemo(
    () => (targetType === 'company'
      ? { record_id: targetId, display_name: targetName }
      : (record.data?.associations ?? []).find((row) => row.object_type === 'company')),
    [record.data, targetType, targetId, targetName],
  );
  const customers = useQuery<ListEnvelope<{ id: string; name: string }>>(
    open && chasing && account?.record_id ? '/v1/customers' : null,
    { crm_record_id: account?.record_id ?? '', limit: 1 },
  );
  const customerId = customers.data?.data[0]?.id ?? null;
  const invoices = useQuery<ListEnvelope<{ number: string; amount_due: number; currency: string; due_date: number | null; status: string }>>(
    open && chasing && customerId ? '/v1/invoices' : null,
    { customer: customerId ?? '', status: 'open_like', limit: 20 },
  );
  const ledgerLoading = chasing && (record.loading || customers.loading || invoices.loading);
  const ledger: LedgerRead = useMemo(() => {
    if (!chasing) return EMPTY_LEDGER;
    if (!account?.record_id) {
      return { ...EMPTY_LEDGER, why: 'This record is not linked to a company, so there is no billing account to read.' };
    }
    if (customers.error || invoices.error) {
      return { ...EMPTY_LEDGER, why: (customers.error ?? invoices.error)?.body.message ?? 'The billing ledger did not answer.' };
    }
    if (ledgerLoading) return { ...EMPTY_LEDGER, why: 'Still reading this account’s billing ledger.' };
    if (!customerId) {
      return { ...EMPTY_LEDGER, why: `${account.display_name} has no billing customer, so it has no invoices to chase.` };
    }
    return ledgerFrom(invoices.data?.data ?? [], session.now());
  }, [chasing, account, customers.error, customers.data, invoices.error, invoices.data, customerId, ledgerLoading, session]);
  const owed = ledgerTotal(ledger);
  const verdict = chasing && draft ? checkDunning(draft, ledger) : null;

  const searchDeals = useMemo(() => async (query: string): Promise<ComboOption[]> => {
    const page = await api.get<ListEnvelope<RecordRow>>('/v1/records/deal', { q: query, limit: 8 });
    for (const row of page.data) names.current.set(row.id, row.display_name);
    return page.data.map((row) => ({ value: row.id, label: row.display_name, description: row.id }));
  }, []);

  const kindHint = KINDS.find((row) => row.value === kind)?.hint ?? '';
  const toneHint = TONES.find((row) => row.value === tone)?.hint ?? '';

  // A chase is composed from the account, because that is the record the
  // ledger hangs off; everything else is composed from the deal.
  const composeFrom = chasing ? account?.record_id ?? targetId : targetId;

  const write = useMutation<void, AiDraft>(
    () => api.post<AiDraft>('/v1/ai/draft', {
      // The engine reads the kind and the tone from these fields; the sentence
      // below travels with them so the run log records what was asked for.
      instruction: ownLine.trim() || `${humanize(kind)} in a ${tone} tone`,
      ...(composeFrom ? { record_id: composeFrom } : {}),
      ...(contactId && !chasing ? { contact_id: contactId } : {}),
      kind,
      tone,
    }),
    {
      onSuccess: (result) => {
        setDraft(result);
        setEditSubject(result.subject);
        setEditBody(withOwnLine(result.body, ownLine));
      },
      onError: (e) => { if (!e.body.param) toast.error('Nothing was drafted', e.body.message); },
    },
  );

  // A chase belongs on the account's timeline, next to the invoices it is about.
  const logType = chasing && account?.record_id ? 'company' : targetType;
  const logId = chasing && account?.record_id ? account.record_id : targetId;
  const logName = chasing && account?.display_name ? account.display_name : targetName;

  const log = useMutation<void, { id: string }>(
    () => api.post<{ id: string }>(`/v1/records/${logType}/${encodeURIComponent(logId)}/activities`, {
      type: 'email',
      subject: editSubject.trim() || undefined,
      body: editBody.trim() || undefined,
    }),
    {
      invalidates: ['/v1/records', '/v1/events'],
      onSuccess: () => {
        invalidate(`/v1/records/${logType}/${logId}`);
        toast.success('Logged on the timeline', `The draft is on ${logName || 'the record'} as an email activity.`);
        onLogged?.();
        onClose();
      },
      onError: (e) => toast.error('Nothing was logged', e.body.message),
    },
  );

  // A chase whose figures could not be read is not drafted at all: a dunning
  // letter that tells a delinquent customer they are square is worse than no
  // letter, and the only way to be sure it does not is to have read the ledger.
  const canWrite = !!targetId && (!chasing || ledger.state === 'read');
  const blockedByLedger = chasing && verdict?.state === 'contradicted';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      initialFocus={firstField}
      title="Draft with the copilot"
      description="Composed from this record's own facts — the agreed next step, the contact, your signature. Nothing is sent."
      footer={
        draft ? (
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Change it and rewrite</Button>
            <Button
              variant="primary"
              loading={log.loading}
              disabled={!editBody.trim() || blockedByLedger}
              title={blockedByLedger ? 'This draft contradicts the ledger, so it cannot be logged.' : undefined}
              iconLeft={<Icons.note size={14} />}
              onClick={() => { void log.run().catch(() => undefined); }}
            >
              Log on {logName ? shortName(logName) : 'the record'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={write.loading || ledgerLoading}
              disabled={!canWrite}
              title={chasing && ledger.state === 'unread' ? ledger.why : undefined}
              iconLeft={<Icons.sparkles size={14} />}
              onClick={() => { void write.run().catch(() => undefined); }}
            >
              Write the draft
            </Button>
          </>
        )
      }
    >
      <div className="pl-form" ref={captureFirstField}>
        {write.error && !write.error.body.param && (
          <Banner tone="danger" title="Nothing was drafted">{write.error.body.message}</Banner>
        )}

        {!draft && (
          <>
            {!subject && (
              <Field label="About which deal" required hint="The draft is written from this record’s facts.">
                <Combobox
                  value={pickedId}
                  onChange={(next) => {
                    const id = Array.isArray(next) ? next[0] ?? '' : next;
                    setPickedId(id);
                    setPickedName(names.current.get(id) ?? id);
                    setContactId('');
                  }}
                  onSearch={searchDeals}
                  placeholder="Search deals…"
                  emptyMessage="No deal matches that."
                  aria-label="About which deal"
                />
              </Field>
            )}

            {subject && (
              <Banner tone="neutral" compact>
                Writing about <strong>{subject.name}</strong>.
              </Banner>
            )}

            {chasing && ledger.state === 'unread' && (
              <Banner tone="danger" bar title="No chase can be written for this record">
                {ledger.why} A dunning letter is a claim about money made to a customer, so it is not
                drafted from figures this screen has not read.
              </Banner>
            )}

            {chasing && ledger.state === 'read' && ledger.bills.length === 0 && (
              <Banner tone="warning" compact title="Nothing is outstanding on this account">
                {account?.display_name ?? 'This account'} has no invoice with an amount still due, so a
                chase would name a bill that does not exist. The draft will say so rather than invent one.
              </Banner>
            )}

            {chasing && ledger.state === 'read' && ledger.bills.length > 0 && (
              <Banner
                tone="info"
                title={owed === null
                  ? `${ledger.bills.length} invoices outstanding on ${account?.display_name ?? 'this account'}`
                  : `${f.money(owed, { currency: ledger.currencies[0] })} outstanding on ${account?.display_name ?? 'this account'}`}
              >
                <ul className="cp-scope__reasons">
                  {ledger.bills.slice(0, 4).map((bill) => (
                    <li key={bill.number}>
                      {bill.number} — {f.money(bill.amountDue, { currency: bill.currency })}
                      {bill.dueAt ? `, due ${f.date(bill.dueAt, { timeZone: 'UTC' })}` : ''}
                      {bill.daysOverdue ? ` (${bill.daysOverdue} days past due)` : ''}
                    </li>
                  ))}
                </ul>
                <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
                  Read from the billing ledger just now. The draft is checked against these figures
                  before it can be logged.
                </p>
              </Banner>
            )}

            <div className="pl-form__row">
              <Field label="Kind" hint={kindHint} error={errorFor(write.error, 'kind')}>
                <Select
                  value={kind}
                  onChange={setKind}
                  options={KINDS.map<SelectOption>((row) => ({ value: row.value, label: row.label }))}
                  aria-label="Kind"
                />
              </Field>
              <Field label="Tone" hint={toneHint} error={errorFor(write.error, 'tone')}>
                <Select
                  value={tone}
                  onChange={setTone}
                  options={TONES.map<SelectOption>((row) => ({ value: row.value, label: row.label }))}
                  aria-label="Tone"
                />
              </Field>
            </div>

            <Field
              label="Write it to"
              optional
              hint={contacts.length
                ? 'Leave it on the primary contact and the engine picks whoever owns the relationship.'
                : record.loading ? 'Reading this record’s contacts…' : 'This record has no contacts linked, so the draft is addressed generically.'}
            >
              <Select
                value={contactId}
                onChange={setContactId}
                disabled={contacts.length === 0}
                options={[
                  { value: '', label: contacts.length ? 'The primary contact' : 'No contact linked' },
                  ...contacts.map<SelectOption>((row) => ({
                    value: row.record_id,
                    label: `${row.display_name}${row.is_primary ? ' · primary' : ''}`,
                  })),
                ]}
                aria-label="Write it to"
              />
            </Field>

            <Field
              label="A line of your own"
              optional
              hint="Dropped into the draft under the greeting, word for word, where you can edit or move it. The rest of the message comes from the record."
              error={errorFor(write.error, 'instruction')}
            >
              <Textarea
                value={ownLine}
                onChange={(e) => setOwnLine(e.target.value)}
                minRows={2}
                maxRows={6}
                placeholder="Sorry again about Tuesday’s outage — we are crediting 10% of the month."
                aria-label="A line of your own"
              />
            </Field>

            {write.loading && <SkeletonText lines={6} />}
          </>
        )}

        {draft && (
          <>
            <div className="cp-chips">
              <span className="cp-chips__label">Grounded in</span>
              {draft.personalisation.map((fact) => (
                <span className="cp-chip" key={fact}>
                  <Icons.check size={12} />
                  <span className="u-truncate">{fact}</span>
                </span>
              ))}
              {ownLine.trim() && (
                <span className="cp-chip" key="__own">
                  <Icons.edit size={12} />
                  <span className="u-truncate">Your own line, verbatim</span>
                </span>
              )}
              {draft.personalisation.length === 0 && !ownLine.trim() && (
                <span className="cp-note">
                  The engine found no record facts to personalise with — read this one closely before logging it.
                </span>
              )}
            </div>

            {verdict?.state === 'contradicted' && (
              <Banner tone="danger" bar title="This draft contradicts the ledger">
                <p>{verdict.why} It cannot be logged.</p>
                <ul className="cp-scope__reasons">
                  {ledger.bills.slice(0, 4).map((bill) => (
                    <li key={bill.number}>
                      {bill.number} — {f.money(bill.amountDue, { currency: bill.currency })}
                      {bill.daysOverdue ? `, ${bill.daysOverdue} days past due` : ''}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}

            {draft.recipient && (
              <Banner tone="info" compact>
                Written to <strong>{draft.recipient.name}</strong> · {draft.recipient.email}
                {' — '}nothing is sent; logging puts it on the timeline.
              </Banner>
            )}

            <Field label="Subject" hint="Edit anything before it lands on the record.">
              <Input
                ref={subjectField}
                value={editSubject}
                onChange={(e) => setEditSubject(e.target.value)}
                aria-label="Subject"
              />
            </Field>

            <Field label="Body">
              <Textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                minRows={10}
                maxRows={22}
                aria-label="Body"
              />
            </Field>

            <p className="cp-note">
              <Badge size="sm" tone="neutral">{humanize(draft.kind)}</Badge>
              {' '}
              <Badge size="sm" tone="neutral">{humanize(draft.tone)}</Badge>
              {' '}
              A draft is a starting point. Every word is editable, and nothing leaves Ain.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
