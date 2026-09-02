/**
 * The scope an answer was measured at, on screen beside the answer.
 *
 * Two things live here. The scope bar states, for every answer that measured
 * something, exactly what the query narrowed to — the pipeline, the stage, the
 * owner, the account, the period, the metric. And when the question named a
 * qualifier the query did not use, that fact is put *above* the answer in the
 * loudest thing this design system has, because a workspace total read as a
 * pipeline total is not a small error: it is off by a factor of six here.
 *
 * Nothing below computes a business number. It reports the arguments the engine
 * passed and the words the question used, and says when they disagree.
 */
import { Badge, Banner, Icons, useFormat } from '@/client/design';
import { useRouter } from '@/client/kernel/router';
import {
  WIDE_SCOPE, scopeChips,
  type BreakdownReport, type QualifierKind, type QualifierVerdict,
  type ScopeReport, type Vocabulary,
} from './scope-core';

/* -------------------------------- the chips ------------------------------- */

const KIND_ICON: Record<QualifierKind, keyof typeof Icons> = {
  pipeline: 'columns',
  stage: 'flag',
  owner: 'user',
  period: 'calendar',
  status: 'check',
  metric: 'gauge',
  account: 'building',
  currency: 'coins',
  unit: 'hash',
  meter: 'activity',
  object: 'database',
  group: 'layers',
};

export function ScopeBar({ report, vocab, loading }: { report: ScopeReport; vocab: Vocabulary; loading?: boolean }) {
  const f = useFormat();
  if (!report.answering.length) return null;
  // Every chip below is read through this workspace's own vocabulary: without
  // it an owner id renders as `usr_seed01`, and the eight open stage names that
  // together mean "open deals" render as eight stage chips over an answer that
  // narrowed to nothing. Until it has been read there is nothing true to say.
  if (loading || (!vocab.pipelines.length && !vocab.people.length && !vocab.metrics.length)) {
    return (
      <div className="cp-scope">
        <div className="cp-scope__row">
          <span className="cp-scope__label">Measured over</span>
          <span className="cp-scope__chip is-unchecked">
            <Icons.clock size={11} />
            <span className="u-truncate">reading this workspace’s pipelines, teammates and measures…</span>
          </span>
        </div>
      </div>
    );
  }
  const name = (id: string) => report.resolve(id) ?? id;
  const window = (w: { start: number | null; end: number | null; label: string | null }) =>
    w.label ?? (w.start !== null && w.end !== null ? f.dateRange(w.start, w.end) : w.start !== null ? `from ${f.date(w.start)}` : `to ${f.date(w.end ?? 0)}`);

  return (
    <div className="cp-scope">
      {report.answering.map((measurement, index) => {
        const chips = scopeChips(measurement, vocab, index === 0 ? report.verdicts : [], { window, name });
        if (!chips.length) return null;
        return (
          <div className="cp-scope__row" key={`${measurement.tool}-${index}`}>
            <span className="cp-scope__label">
              {report.answering.length > 1 ? `${measurement.figure ?? measurement.tool} measured over` : 'Measured over'}
            </span>
            {chips.map((chip) => (
              <span
                className={`cp-scope__chip${chip.wide ? ' is-wide' : ''}${chip.unchecked ? ' is-unchecked' : ''}`}
                key={`${chip.kind}:${chip.label}:${chip.value}`}
                title={chip.unchecked
                  ? `${chip.label}: ${chip.value} — the query carried this, and nothing in the answer confirms the figure was measured that way`
                  : `${chip.label}: ${chip.value}`}
              >
                {iconFor(chip.kind)}
                <span className="cp-scope__key">{chip.label}</span>
                <span className="u-truncate">{chip.value}</span>
                {chip.unchecked && <span className="cp-scope__unchecked">unchecked</span>}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const iconFor = (kind: QualifierKind) => {
  const Glyph = Icons[KIND_ICON[kind]] ?? Icons.tag;
  return <Glyph size={11} />;
};

/* ------------------------------- the warning ------------------------------ */

const SENTENCE: Record<QualifierKind, (v: QualifierVerdict) => string> = {
  pipeline: (v) => v.state === 'substituted'
    ? `You asked about the ${v.asked} pipeline. This figure was measured over ${v.used} instead.`
    : `You asked about the ${v.asked} pipeline. This figure was measured over ${v.used} — every deal in the workspace, not ${v.asked}’s.`,
  stage: (v) => v.state === 'substituted'
    ? `You asked about ${v.asked}. This figure was measured over ${v.used} instead.`
    : `You asked about ${v.asked}. This figure counts ${v.used} — it is not the ${v.asked} figure.`,
  owner: (v) => v.state === 'substituted'
    ? `You asked about ${v.asked}. This figure was measured for ${v.used} — a different record, not ${v.asked}’s book.`
    : `You asked about ${v.asked}. This figure covers ${v.used}, not the records ${v.asked} owns.`,
  period: (v) => v.state === 'bound'
    ? `You named ${v.asked}. This figure was measured over ${v.used}.`
    : `You named ${v.asked}. This figure was measured ${v.used}, not over ${v.asked}.`,
  status: (v) => `You asked about ${v.asked.toLowerCase()}. This figure counts ${v.used}.`,
  metric: (v) => (v.state === 'substituted'
    ? `You asked for ${v.asked}. This figure is ${v.used}, which is a different measure.`
    : `You asked for ${v.asked}. Nothing in this workspace’s metric catalogue is that measure, and the figure below is ${v.used}.`),
  currency: (v) => (v.state === 'substituted'
    ? `You asked for the ${v.asked} book. This figure is in ${v.used} — it is not the ${v.asked} figure.`
    : `You asked for the ${v.asked} book. This figure was not scoped to a currency: it is ${v.used}.`),
  account: (v) => (v.state === 'substituted'
    ? `You asked about ${v.asked}. This figure was measured for ${v.used}.`
    : `You asked about ${v.asked}. This figure covers ${v.used}.`),
  unit: (v) => `You named ${v.asked}. This figure was not scoped to it — it counts ${v.used}.`,
  meter: (v) => `You named the ${v.asked} meter. This figure was not scoped to it — it counts ${v.used}.`,
  object: (v) => (v.state === 'substituted'
    ? `You asked about deals. This figure counts ${v.used}, which are not deals.`
    : `You asked about deals. This figure was measured over ${v.used}.`),
  group: (v) => (v.state === 'substituted'
    ? `You asked for this broken down by ${v.asked}. It came back broken down by ${v.used} instead.`
    : `You asked for this broken down by ${v.asked}. It came back as ${v.used} — nothing here ranks the ${v.asked}s.`),
};

/**
 * What the answer did not narrow to, before the answer.
 *
 * Placed above the prose and above the figure deliberately: the same warning
 * under the number is a footnote, and a reader who has already read
 * "$9,010,960 in open pipeline" has already taken it as the Renewal answer.
 */
export function ScopeWarning({ report, board }: { report: ScopeReport; board?: { href: string; label: string } | null }) {
  if (!report.unscoped.length) return null;
  const substituted = report.unscoped.some((v) => v.state === 'substituted');
  // `waived` is the engine's own word for a qualifier it parsed and then did
  // not use. It is the strongest signal on this screen because it is the engine
  // agreeing with the warning.
  const waived = report.unscoped.some((v) => v.state === 'waived');
  const tools = [...new Set(report.unscoped.map((v) => v.tool).filter((t): t is string => !!t))];
  // Only the dimensions the query carried no filter for at all. A period a
  // snapshot metric ignored is not one of those: the argument was passed, the
  // metric simply does not read it.
  const widened = report.unscoped.filter((v) => v.state !== 'substituted' && v.used === WIDE_SCOPE[v.kind]);
  // A dimension nothing was grouped by is not a missing filter, and telling a
  // person to "ask again naming the record" is advice about a different defect.
  const grouped = widened.filter((v) => v.kind === 'group');
  const filters = widened.filter((v) => v.kind !== 'group' && v.kind !== 'object');

  return (
    <Banner
      tone="danger"
      bar
      title={substituted
        ? 'This answer measured something other than what was asked'
        : waived
          ? 'The engine dropped part of this question'
          : 'This answer is wider than the question'}
    >
      <ul className="cp-scope__reasons">
        {report.unscoped.map((verdict) => (
          <li key={`${verdict.kind}:${verdict.asked}`}>
            {SENTENCE[verdict.kind](verdict)}
          </li>
        ))}
      </ul>
      {filters.length > 0 && tools.length === 1 && (
        <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
          The query <span className="cp-mono">{tools[0]}</span> ran carried no{' '}
          {filters.map((v) => v.kind).join(' or ')} filter at all. Ask again naming the record, or
          read the figure on the board, where the filter exists.
        </p>
      )}
      {board && <BoardLink board={board} />}
      {grouped.length > 0 && (
        <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
          Nothing was grouped by {grouped.map((v) => v.asked).join(' or ')}, so there is no ranking in
          this answer to read. The board groups by pipeline, stage and owner, and its columns carry the
          same totals.
        </p>
      )}
    </Banner>
  );
}

/**
 * The way out of a warning: the same question, on the screen that can narrow.
 */
export function BoardLink({ board }: { board: { href: string; label: string } }) {
  const { navigate } = useRouter();
  return (
    <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
      <a
        className="cp-chip"
        href={board.href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          navigate(board.href);
        }}
      >
        <Icons.columns size={12} />
        <span className="u-truncate">Open the board for {board.label}</span>
      </a>
    </p>
  );
}

/* ------------------------------- breakdowns ------------------------------- */

/**
 * A by-stage breakdown, checked against the columns the board actually draws.
 *
 * When every bucket is one column of one pipeline the figures are shown, with
 * the pipeline each belongs to. When they are not — thirteen open columns
 * arriving as eight buckets, four of them sums across pipelines under a caption
 * that belongs to one of them or to none — the figures are put away and the
 * disagreement is shown instead. A number captioned with the wrong stage is
 * worse than no number, because it will be quoted.
 */
export function BreakdownPanel({ report, pipeline }: { report: BreakdownReport; pipeline: string | null }) {
  // A breakdown of something that is not a stage — tickets by category, revenue
  // by month — is not the board's business, and holding it against the board's
  // columns put "Onboarding is not a column on this board at all" over a
  // correct answer about support tickets.
  if (!report.aboutStages) {
    return (
      <div className="cp-breakdown">
        <div className="cp-chips__label">Breakdown</div>
        <ul className="cp-breakdown__list cp-breakdown__list--plain">
          {report.buckets.map((verdict) => (
            <li key={verdict.bucket.label}>
              <span className="u-truncate">{verdict.bucket.label}</span>
              <span className="cp-breakdown__figure">{verdict.bucket.figure}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (report.reconciles) {
    return (
      <div className="cp-breakdown">
        <div className="cp-chips__label">By stage</div>
        <ul className="cp-breakdown__list">
          {report.buckets.map((verdict) => (
            <li key={verdict.bucket.label}>
              <span className="u-truncate">{verdict.stages[0]?.label ?? verdict.bucket.label}</span>
              <Badge size="sm" tone="neutral">{verdict.stages[0]?.pipelineLabel ?? '—'}</Badge>
              <span className="cp-breakdown__figure">{verdict.bucket.figure}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const merged = report.buckets.filter((v) => v.merged);
  const mislabelled = report.buckets.filter((v) => v.mislabelled && !v.merged);
  const unknown = report.buckets.filter((v) => v.unknown);

  return (
    <Banner tone="warning" title="This breakdown does not line up with the board" bar>
      <p>
        The board draws {report.columnsOnBoard} open {report.columnsOnBoard === 1 ? 'column' : 'columns'}
        {pipeline ? ' in this pipeline' : ' across the deal pipelines'}; the answer came back with{' '}
        {report.buckets.length}. The figures are held back rather than shown under captions that
        name the wrong column.
      </p>
      <ul className="cp-scope__reasons">
        {merged.map((verdict) => (
          <li key={`m:${verdict.bucket.label}`}>
            <strong>{verdict.bucket.label}</strong> is one figure over{' '}
            {verdict.stages.map((stage) => `${stage.pipelineLabel} · ${stage.label}`).join(' + ')} — separate
            columns on the board.
          </li>
        ))}
        {mislabelled.map((verdict) => (
          <li key={`l:${verdict.bucket.label}`}>
            <strong>{verdict.bucket.label}</strong> is not what the board calls that column; it is{' '}
            {verdict.stages.map((stage) => `${stage.pipelineLabel} · ${stage.label}`).join(', ')}.
          </li>
        ))}
        {unknown.map((verdict) => (
          <li key={`u:${verdict.bucket.label}`}>
            <strong>{verdict.bucket.label}</strong> is not a column on this board at all.
          </li>
        ))}
      </ul>
      <details className="cp-details" style={{ marginTop: 'var(--space-3)' }}>
        <summary>Show the figures the engine returned, unreconciled</summary>
        <ul className="cp-breakdown__list" style={{ marginTop: 'var(--space-3)' }}>
          {report.buckets.map((verdict) => (
            <li key={`raw:${verdict.bucket.label}`}>
              <span className="u-truncate">{verdict.bucket.label}</span>
              <Badge size="sm" tone={verdict.merged || verdict.unknown ? 'warning' : 'neutral'}>
                {verdict.unknown ? 'no column' : verdict.merged ? `${verdict.stages.length} columns` : verdict.stages[0]?.pipelineLabel ?? '—'}
              </Badge>
              <span className="cp-breakdown__figure">{verdict.bucket.figure}</span>
            </li>
          ))}
        </ul>
      </details>
    </Banner>
  );
}
