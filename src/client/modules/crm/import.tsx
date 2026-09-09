/**
 * The import wizard: a file, a column map, a preview, a result.
 *
 * Four steps because each one is a decision a person makes, not a screen to
 * click through: which file, which column is which property, whether the
 * rows look right, and what the server did with them — per row, with the
 * property it blamed, so a refused row can be fixed rather than guessed at.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Banner, Button, Field, Icons, Modal, Select, Steps, Textarea, useFormat, useToast,
} from '@/client/design';
import type { ApiClientError } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import { batchImport, crmChanged, type ObjectTypeDef, type PropertyDef, type WorkspaceUser } from './api';
import { parseCsv } from './csv';
import {
  autoMapColumns, buildImportRows, chunk, importableProperties, outcomesFrom,
  type ImportOutcome, type ImportTarget,
} from './import-rows';
import { ValueView } from './values';

type Step = 'file' | 'map' | 'preview' | 'result';

const STEPS = [
  { id: 'file', label: 'File', description: 'A CSV with a header row' },
  { id: 'map', label: 'Columns', description: 'Which column is which property' },
  { id: 'preview', label: 'Check', description: 'The rows as they will land' },
  { id: 'result', label: 'Result', description: 'What was written' },
];

const PREVIEW_ROWS = 8;

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  objectType: ObjectTypeDef;
  properties: PropertyDef[];
  users: WorkspaceUser[];
  onImported: () => void;
}

export function ImportDialog({ open, onClose, objectType, properties, users, onImported }: ImportDialogProps) {
  const toast = useToast();
  const session = useSession();
  const f = useFormat();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('file');
  const [fileName, setFileName] = useState('');
  const [pasted, setPasted] = useState('');
  const [table, setTable] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ImportTarget[]>([]);
  const [operation, setOperation] = useState<'create' | 'upsert'>('create');
  const [keyProperty, setKeyProperty] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const [failure, setFailure] = useState<ApiClientError | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('file'); setFileName(''); setPasted(''); setTable([]); setMapping([]);
    setOperation('create'); setKeyProperty(''); setBusy(false); setProgress(null); setOutcomes([]); setFailure(null);
  }, [open]);

  const headers = table[0] ?? [];
  const rows = useMemo(() => table.slice(1), [table]);
  const targets = useMemo(() => importableProperties(properties), [properties]);
  const uniqueProperties = useMemo(() => targets.filter((p) => p.unique), [targets]);
  const ctx = useMemo(() => ({ users, currency: session.currency }), [users, session.currency]);
  const propertyIndex = useMemo(() => new Map(properties.map((p) => [p.name, p])), [properties]);

  // The plan is part of the build: what the API will refuse depends on whether
  // a row is a create or a match, and the Check step has to know before it
  // promises anything.
  const built = useMemo(
    () => (rows.length && mapping.length
      ? buildImportRows(rows, headers, mapping, properties, ctx, { operation, keyProperty })
      : null),
    [rows, headers, mapping, properties, ctx, operation, keyProperty],
  );

  const load = (text: string, name: string) => {
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      toast.error('Nothing to import', 'The file needs a header row and at least one row of values.');
      return;
    }
    setFileName(name);
    setTable(parsed);
    const auto = autoMapColumns(parsed[0], properties);
    setMapping(auto);
    // A file with the export's id column is a re-import; one with a unique
    // key is a sync. Everything else creates.
    const hasId = auto.includes('id');
    const key = uniqueProperties.find((p) => auto.includes(p.name));
    if (hasId) { setOperation('upsert'); setKeyProperty(''); }
    else if (key) { setOperation('upsert'); setKeyProperty(key.name); }
    else { setOperation('create'); setKeyProperty(''); }
    setStep('map');
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    load(await file.text(), file.name);
  };

  const mappedCount = mapping.filter(Boolean).length;
  const idMapped = mapping.includes('id');
  const keyMapped = !!keyProperty && mapping.includes(keyProperty);
  const canRun = !!built && built.records.length > 0 && (operation === 'create' || idMapped || keyMapped);

  const run = async () => {
    if (!built || !canRun) return;
    setBusy(true);
    setFailure(null);
    setStep('result');
    const all: ImportOutcome[] = built.problems.length
      ? [...new Map(built.problems.map((p) => [p.row, p])).values()].map((p) => ({
        row: p.row, status: 'refused' as const, blamed: p.column,
        message: built.problems.filter((q) => q.row === p.row).map((q) => q.message).join(' '),
      }))
      : [];
    const pages = chunk(built.records);
    setProgress({ sent: 0, total: built.records.length });
    try {
      for (const page of pages) {
        const result = await batchImport(objectType.name, {
          operation,
          ...(operation === 'upsert' && keyMapped && !idMapped ? { id_property: keyProperty } : {}),
          records: page.map(({ row: _row, ...record }) => record),
        });
        all.push(...outcomesFrom(page, result, properties));
        setProgress((prev) => ({ sent: (prev?.sent ?? 0) + page.length, total: built.records.length }));
        setOutcomes([...all].sort((a, b) => a.row - b.row));
      }
      crmChanged();
      onImported();
      const created = all.filter((o) => o.status === 'created').length;
      const updated = all.filter((o) => o.status === 'updated').length;
      const refused = all.filter((o) => o.status === 'refused').length;
      const summary = [
        created ? `${f.number(created)} created` : '',
        updated ? `${f.number(updated)} updated` : '',
        refused ? `${f.number(refused)} refused` : '',
      ].filter(Boolean).join(', ');
      if (refused && !created && !updated) toast.error('Nothing was imported', `${summary}. Each row says what was wrong with it.`);
      else if (refused) toast.warning('Import finished with refusals', `${summary}. The refused rows are listed with the property the server blamed.`);
      else toast.success(`${objectType.plural_label} imported`, `${summary}. Every row is on its record's timeline as an import.`);
    } catch (e) {
      setFailure(e as ApiClientError);
      toast.error('Import stopped', (e as ApiClientError).body?.message ?? 'The server did not answer.');
    } finally {
      setBusy(false);
      setOutcomes([...all].sort((a, b) => a.row - b.row));
    }
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const heldBack = built ? new Set(built.problems.map((p) => p.row)).size : 0;
  const matchLabel = idMapped ? 'record id' : propertyIndex.get(keyProperty)?.label.toLowerCase() ?? 'key';
  // A file with no name column puts the same sentence on all 400 rows. One
  // line per row is the list of what to fix; the banner above says it once.
  const problemLines = built
    ? built.problems.filter((p) => !built.missingRequired.some((m) => m.label === p.column))
    : [];
  const created = outcomes.filter((o) => o.status === 'created').length;
  const updated = outcomes.filter((o) => o.status === 'updated').length;
  const refused = outcomes.filter((o) => o.status === 'refused');

  const targetOptions = [
    { value: '', label: 'Skip this column' },
    { value: 'id', label: 'Record id', group: 'Record' },
    { value: 'owner_id', label: 'Owner', group: 'Record' },
    ...targets.map((p) => ({ value: p.name, label: p.label, group: p.group })),
  ];

  const sample = (column: number): string => rows.map((r) => r[column] ?? '').find((v) => v.trim() !== '') ?? '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={`Import ${objectType.plural_label.toLowerCase()}`}
      description={step === 'result'
        ? 'Every row was tried on its own, so one bad row never held the others back.'
        : `A CSV with a header row. ${objectType.plural_label} exported from this list re-import as they are.`}
      dismissable={!busy}
      footer={
        <>
          {step === 'map' && <Button variant="ghost" onClick={() => setStep('file')}>Back</Button>}
          {step === 'preview' && <Button variant="ghost" onClick={() => setStep('map')}>Back</Button>}
          <span className="u-spacer" />
          {step !== 'result' && <Button variant="ghost" onClick={onClose}>Cancel</Button>}
          {step === 'map' && (
            <Button variant="primary" disabled={!mappedCount} onClick={() => setStep('preview')}>
              Check {f.number(rows.length)} {f.plural(rows.length, 'row', { hideCount: true })}
            </Button>
          )}
          {step === 'preview' && (
            <Button variant="primary" disabled={!canRun} onClick={() => { void run(); }}>
              {built && built.conditional === built.records.length && built.conditional > 0
                ? `Try ${f.number(built.records.length)} ${f.plural(built.records.length, 'row', { hideCount: true })}`
                : `Import ${f.number(built?.records.length ?? 0)} ${f.plural(built?.records.length ?? 0, objectType.label.toLowerCase(), { hideCount: true })}`}
            </Button>
          )}
          {step === 'result' && <Button variant="primary" loading={busy} onClick={onClose}>Done</Button>}
        </>
      }
      footerBetween
    >
      <div className="crm-import">
        <Steps steps={STEPS} current={stepIndex} />

        {step === 'file' && (
          <div className="crm-import__file">
            <label
              className="crm-import__drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files?.[0]); }}
            >
              <Icons.upload size={22} />
              <span className="crm-import__droptitle">Drop a CSV here, or choose one</span>
              <span className="crm-import__drophint">
                Picklists take the option label or its value, owners their name or email, money a decimal, dates ISO-8601.
              </span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                aria-label="CSV file to import"
                onChange={(e) => { void onFile(e.target.files?.[0]); }}
              />
            </label>
            <Field label="Or paste rows" optional hint="The first line is the header.">
              <Textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                minRows={4}
                className="u-mono"
                placeholder={'First name,Last name,Email\nIngrid,Halvorsen,ingrid@nordhavn.example'}
                aria-label="Pasted CSV"
              />
            </Field>
            <div className="crm-import__pasterow">
              <Button variant="secondary" disabled={!pasted.trim()} onClick={() => load(pasted, 'pasted rows')}>
                Use the pasted rows
              </Button>
            </div>
          </div>
        )}

        {step === 'map' && (
          <div className="crm-import__map">
            <div className="crm-import__filemeta">
              <Badge tone="neutral" size="sm">{fileName}</Badge>
              <span>{f.number(rows.length)} {f.plural(rows.length, 'row', { hideCount: true })} · {headers.length} columns · {mappedCount} mapped</span>
              {/* Said here, where the mapping can still be changed, rather than
                  only on the step after it. */}
              {built && built.missingRequired.length > 0 && (
                <Badge tone="danger" size="sm">
                  no column fills {f.list(built.missingRequired.map((p) => p.label))}
                </Badge>
              )}
            </div>
            <div className="crm-import__tablewrap">
              <table className="crm-import__table">
                <thead>
                  <tr><th scope="col">Column in the file</th><th scope="col">First value</th><th scope="col">Imports as</th></tr>
                </thead>
                <tbody>
                  {headers.map((header, column) => (
                    <tr key={`${header}-${column}`}>
                      <th scope="row">{header || <span className="crm-muted">(blank header)</span>}</th>
                      <td className="crm-import__sample u-mono">{sample(column) || <span className="crm-muted">—</span>}</td>
                      <td>
                        <Select
                          size="sm"
                          value={mapping[column] ?? ''}
                          onChange={(next) => setMapping((prev) => prev.map((t, i) => (i === column ? (next || null) : t === next ? null : t)))}
                          options={targetOptions}
                          aria-label={`Import "${header}" as`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="crm-form__grid">
              <Field
                label="Existing records"
                hint={operation === 'upsert'
                  ? idMapped
                    ? 'Rows with an id update that record; rows without one are created.'
                    : keyMapped
                      ? `Rows whose ${propertyIndex.get(keyProperty)?.label.toLowerCase() ?? keyProperty} matches update that record; the rest are created.`
                      : 'Choose a unique property to match on, or map an id column.'
                  : 'Every row becomes a new record, even if one like it exists.'}
              >
                <Select
                  value={operation}
                  onChange={(next) => setOperation(next as 'create' | 'upsert')}
                  options={[
                    { value: 'create', label: 'Create every row as a new record' },
                    { value: 'upsert', label: 'Update the ones that already exist' },
                  ]}
                  aria-label="How to treat existing records"
                />
              </Field>
              {operation === 'upsert' && !idMapped && (
                <Field label="Match on" error={!keyMapped && keyProperty ? `Map a column to ${propertyIndex.get(keyProperty)?.label ?? keyProperty} first.` : undefined}>
                  <Select
                    value={keyProperty}
                    onChange={setKeyProperty}
                    options={[
                      { value: '', label: uniqueProperties.length ? 'Choose a unique property' : 'No unique property on this object' },
                      ...uniqueProperties.map((p) => ({ value: p.name, label: p.label })),
                    ]}
                    aria-label="Property to match existing records on"
                  />
                </Field>
              )}
            </div>
          </div>
        )}

        {step === 'preview' && built && (
          <div className="crm-import__preview">
            <div className="crm-import__filemeta">
              <Badge tone={built.records.length - built.conditional > 0 ? 'success' : 'neutral'} size="sm">{f.number(built.records.length - built.conditional)} ready</Badge>
              {built.conditional > 0 && <Badge tone="warning" size="sm">{f.number(built.conditional)} only if they already exist</Badge>}
              {heldBack > 0 && <Badge tone="danger" size="sm">{f.number(heldBack)} held back</Badge>}
              {built.skipped > 0 && <Badge tone="neutral" size="sm">{f.number(built.skipped)} empty</Badge>}
              <span>
                {built.records.length
                  ? `Showing the first ${Math.min(PREVIEW_ROWS, built.records.length)} as they will land.`
                  : 'Nothing here can be written yet.'}
              </span>
            </div>
            {/* The API fills a missing property from its default and refuses the
                row when there is none, so a file with no name column is a
                certain refusal on every row it creates. This step used to
                answer "3 ready" to exactly that and let the result explain. */}
            {built.missingRequired.length > 0 && (
              <Banner
                tone={built.conditional > 0 ? 'warning' : 'danger'}
                compact
                title={built.conditional > 0
                  ? `${f.number(built.conditional)} ${f.plural(built.conditional, 'row', { hideCount: true })} can only update, never create`
                  : `Nothing in this file fills ${f.list(built.missingRequired.map((p) => p.label))}`}
              >
                {built.conditional > 0
                  ? `Every ${objectType.label.toLowerCase()} needs ${f.list(built.missingRequired.map((p) => p.label))}, and no column supplies ${built.missingRequired.length === 1 ? 'it' : 'them'}. A row whose ${matchLabel} matches an existing ${objectType.label.toLowerCase()} updates it; any row that does not match is refused.`
                  : `Every ${objectType.label.toLowerCase()} needs ${f.list(built.missingRequired.map((p) => p.label))}. Map a column to ${built.missingRequired.length === 1 ? 'it' : 'each of them'} on the previous step — nothing in this file can be created without ${built.missingRequired.length === 1 ? 'it' : 'them'}.`}
              </Banner>
            )}
            {problemLines.length > 0 && (
              <Banner tone="warning" compact title="Some rows cannot be written as they are">
                <ul className="crm-import__problems">
                  {problemLines.slice(0, 6).map((p, i) => (
                    <li key={i}>Row {p.row}, {p.column}: {p.message}</li>
                  ))}
                  {problemLines.length > 6 && <li>…and {problemLines.length - 6} more. They are listed in the result.</li>}
                </ul>
              </Banner>
            )}
            <div className="crm-import__tablewrap" hidden={built.records.length === 0}>
              <table className="crm-import__table">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    {mapping.map((target, column) => target && (
                      <th scope="col" key={column}>
                        {target === 'id' ? 'Record id' : target === 'owner_id' ? 'Owner' : propertyIndex.get(target)?.label ?? target}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {built.records.slice(0, PREVIEW_ROWS).map((record) => (
                    <tr key={record.row}>
                      <th scope="row">{record.row}</th>
                      {mapping.map((target, column) => target && (
                        <td key={column}>
                          {target === 'id'
                            ? <span className="u-mono">{record.id ?? '—'}</span>
                            : target === 'owner_id'
                              ? (users.find((u) => u.id === record.owner_id)?.name ?? <span className="crm-muted">—</span>)
                              : (
                                <ValueView
                                  property={propertyIndex.get(target)}
                                  value={(record.properties[target] as never) ?? null}
                                  users={new Map(users.map((u) => [u.id, u]))}
                                  compact
                                />
                              )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {step === 'result' && (
          <div className="crm-import__result">
            {failure && (
              <Banner tone="danger" title="The import stopped part-way">
                {failure.body?.message ?? 'The server did not answer.'} Rows already written stay written; the rest were not sent.
              </Banner>
            )}
            <div className="crm-import__filemeta" role="status" aria-live="polite">
              {busy && progress
                ? <span>Writing {f.number(progress.sent)} of {f.number(progress.total)}…</span>
                : (
                  <>
                    <Badge tone="success" size="sm">{f.number(created)} created</Badge>
                    <Badge tone="info" size="sm">{f.number(updated)} updated</Badge>
                    <Badge tone={refused.length ? 'danger' : 'neutral'} size="sm">{f.number(refused.length)} refused</Badge>
                  </>
                )}
            </div>
            {!busy && refused.length > 0 && (
              <div className="crm-import__tablewrap">
                <table className="crm-import__table" aria-label="Refused rows">
                  <thead>
                    <tr><th scope="col">Row</th><th scope="col">Property</th><th scope="col">Why it was refused</th></tr>
                  </thead>
                  <tbody>
                    {refused.map((o) => (
                      <tr key={o.row}>
                        <th scope="row">{o.row}</th>
                        <td>{o.blamed ?? <span className="crm-muted">—</span>}</td>
                        <td>{o.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!busy && refused.length === 0 && outcomes.length > 0 && (
              <p className="crm-import__done">
                Every row landed. The new {objectType.plural_label.toLowerCase()} are in the list behind this dialog.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
