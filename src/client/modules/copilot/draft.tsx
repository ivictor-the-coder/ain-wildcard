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
import {
  Badge, Banner, Button, Combobox, Field, Icons, Input, Modal, Select, SkeletonText, Textarea,
  humanize, useToast, type ComboOption, type SelectOption,
} from '@/client/design';

/** What each kind actually produces, so the control that steers is legible. */
const KINDS: { value: string; label: string; hint: string }[] = [
  { value: 'follow_up', label: 'Follow-up', hint: 'Picks up the agreed next step and asks whether it still stands.' },
  { value: 'intro', label: 'Intro', hint: 'A first touch — who we are, and why this account.' },
  { value: 'check_in', label: 'Check-in', hint: 'A light touch on a deal that has gone quiet.' },
  { value: 'renewal', label: 'Renewal', hint: 'Ahead of the contract end, with what the account runs today.' },
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

  const searchDeals = useMemo(() => async (query: string): Promise<ComboOption[]> => {
    const page = await api.get<ListEnvelope<RecordRow>>('/v1/records/deal', { q: query, limit: 8 });
    for (const row of page.data) names.current.set(row.id, row.display_name);
    return page.data.map((row) => ({ value: row.id, label: row.display_name, description: row.id }));
  }, []);

  const kindHint = KINDS.find((row) => row.value === kind)?.hint ?? '';
  const toneHint = TONES.find((row) => row.value === tone)?.hint ?? '';

  const write = useMutation<void, AiDraft>(
    () => api.post<AiDraft>('/v1/ai/draft', {
      // The engine reads the kind and the tone from these fields; the sentence
      // below travels with them so the run log records what was asked for.
      instruction: ownLine.trim() || `${humanize(kind)} in a ${tone} tone`,
      ...(targetId ? { record_id: targetId } : {}),
      ...(contactId ? { contact_id: contactId } : {}),
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

  const log = useMutation<void, { id: string }>(
    () => api.post<{ id: string }>(`/v1/records/${targetType}/${encodeURIComponent(targetId)}/activities`, {
      type: 'email',
      subject: editSubject.trim() || undefined,
      body: editBody.trim() || undefined,
    }),
    {
      invalidates: ['/v1/records', '/v1/events'],
      onSuccess: () => {
        invalidate(`/v1/records/${targetType}/${targetId}`);
        toast.success('Logged on the timeline', `The draft is on ${targetName || 'the record'} as an email activity.`);
        onLogged?.();
        onClose();
      },
      onError: (e) => toast.error('Nothing was logged', e.body.message),
    },
  );

  const canWrite = !!targetId;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Draft with the copilot"
      description="Composed from this record's own facts — the agreed next step, the contact, your signature. Nothing is sent."
      footer={
        draft ? (
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Change it and rewrite</Button>
            <Button
              variant="primary"
              loading={log.loading}
              disabled={!editBody.trim()}
              iconLeft={<Icons.note size={14} />}
              onClick={() => { void log.run().catch(() => undefined); }}
            >
              Log on {targetName ? shortName(targetName) : 'the record'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={write.loading}
              disabled={!canWrite}
              iconLeft={<Icons.sparkles size={14} />}
              onClick={() => { void write.run().catch(() => undefined); }}
            >
              Write the draft
            </Button>
          </>
        )
      }
    >
      <div className="pl-form">
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

            {draft.recipient && (
              <Banner tone="info" compact>
                Written to <strong>{draft.recipient.name}</strong> · {draft.recipient.email}
                {' — '}nothing is sent; logging puts it on the timeline.
              </Banner>
            )}

            <Field label="Subject" hint="Edit anything before it lands on the record.">
              <Input value={editSubject} onChange={(e) => setEditSubject(e.target.value)} aria-label="Subject" />
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
