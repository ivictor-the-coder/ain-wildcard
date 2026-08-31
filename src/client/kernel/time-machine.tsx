/**
 * The time machine, one click from every screen.
 *
 * Advancing the workspace clock runs every job that becomes due on the way —
 * renewals, dunning retries, credit expiry, scheduled agent runs — so an
 * operator can watch a year of billing play out and then come straight back.
 * Whenever the clock is not real time the top bar says so, in amber, with a
 * one-click way back.
 *
 * Moving the clock is also the one control in the product that can break the
 * session it was issued from, so every move here is read back before it is
 * called a success, and a rewind that the server punished once is never offered
 * again without saying so first.
 */
import { useRef, useState } from 'react';
import {
  Banner, Button, ChevronsRightIcon, DatePicker, Divider, Icons, Popover, RotateCcwIcon,
  useFormat, useLocalStorage, useToast,
} from '../design';
import { TIME_JUMPS, clockOutcome, describeOffset, type ClockAftermath } from './shell-core';
import { useTimeMachine, type ClockMove } from './platform';
import { ApiClientError } from './api';
import { DAY } from '../../shared/time';

export interface TimeMachineProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace time right now — already carries the offset. */
  now: number;
  offsetMs: number;
  /** `virtual` on a workspace whose clock can be moved; `real` otherwise. */
  clockKind: string;
  canAdvance: boolean;
  /**
   * True when the workspace has not answered since — the chip is then showing
   * the last date it was told, which after a failed move is exactly the number
   * an operator would otherwise trust.
   */
  stale?: boolean;
  /** Re-read everything on screen once the clock has moved. */
  onSettled: () => void;
}

/** What the server did to this workspace the last time its clock ran backwards. */
interface RewindRefusal {
  at: number;
  status: number;
  message: string;
  requestId: string | null;
}

const roundDays = (ms: number): number => Math.round(ms / DAY);

export const aftermathOf = (move: ClockMove): ClockAftermath | null =>
  move.aftermath
    ? { status: move.aftermath.status, message: move.aftermath.message, requestId: move.aftermath.body?.request_id ?? null }
    : null;

export function TimeMachine({ open, onOpenChange, now, offsetMs, clockKind, canAdvance, stale, onSettled }: TimeMachineProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [confirmRewind, setConfirmRewind] = useState(false);
  const [refusal, setRefusal] = useLocalStorage<RewindRefusal | null>('ain.clock.rewind_refused', null);
  const f = useFormat();
  const toast = useToast();
  const { advance, reset, busy } = useTimeMachine(onSettled);
  const shifted = Math.abs(offsetMs) > 60_000;
  const virtual = clockKind === 'virtual';

  const report = (move: ClockMove, label: string) => {
    const outcome = clockOutcome({
      movedTo: f.date(move.now),
      label,
      jobsRun: move.jobsRun,
      jobsFailed: move.jobsFailed,
      aftermath: aftermathOf(move),
    });
    const raise = outcome.tone === 'success' ? toast.success : toast.error;
    raise(outcome.title, outcome.description, outcome.pinned ? { duration: 0 } : undefined);
    return outcome;
  };

  const failed = (title: string, error: unknown) => {
    const message = error instanceof ApiClientError
      ? `${error.body.message}${error.body.request_id ? ` · ${error.body.request_id}` : ''}`
      : error instanceof Error ? error.message : 'The server refused the request.';
    toast.error(title, message, { duration: 0 });
  };

  const jump = async (to: number, label: string) => {
    try {
      const move = await advance({ to });
      onOpenChange(false);
      setChosen(null);
      report(move, label);
    } catch (error) {
      failed('The clock did not move', error);
    }
  };

  const back = async () => {
    setConfirmRewind(false);
    try {
      const move = await reset();
      onOpenChange(false);
      const aftermath = aftermathOf(move);
      // A rewind that the server punishes is a property of this build, not of
      // this click. Remember it so the control never surprises anyone twice —
      // and forget it the moment a rewind lands cleanly again.
      if (aftermath && aftermath.status === 429) {
        setRefusal({ at: Date.now(), status: aftermath.status, message: aftermath.message, requestId: aftermath.requestId });
      } else if (!aftermath && refusal) {
        setRefusal(null);
      }
      if (!aftermath) {
        toast.success('Back to real time', `The workspace clock reads ${f.dateTime(move.now)} again.`);
      } else {
        report(move, 'Returned to real time');
      }
    } catch (error) {
      failed('Could not return to real time', error);
    }
  };

  const rewindDisabled = !virtual || !canAdvance || busy || !shifted;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`shell-clock${shifted ? ' is-shifted' : ''}${stale ? ' is-stale' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        title={stale
          ? 'The workspace has not answered since this was last read — this date may no longer be current'
          : shifted ? `Simulated time — ${describeOffset(offsetMs)}` : 'Workspace time'}
      >
        {shifted ? <span className="shell-clock__dot" aria-hidden /> : <Icons.clock size={14} />}
        <span>{f.date(now, { withYear: false })}</span>
        {stale ? <span>· not confirmed</span> : shifted ? <span>· simulated</span> : null}
      </button>

      <Popover
        open={open}
        onClose={() => { onOpenChange(false); setConfirmRewind(false); }}
        anchor={anchor}
        placement="bottom-end"
        ariaLabel="Time machine"
        title="Time machine"
      >
        <div className="tm">
          <div className="tm__now">
            <span className="tm__label">Workspace time</span>
            <span className="tm__value">{f.dateTime(now)}</span>
            <span className="tm__sub">
              {stale
                ? 'Last read before the API started refusing — not confirmed'
                : shifted ? describeOffset(offsetMs) : 'In step with real time'} · {f.timeZone.replace(/_/g, ' ')}
            </span>
          </div>

          {!virtual && (
            <Banner tone="neutral" compact title="This workspace runs on the real clock">
              Start the server with a virtual clock to replay renewals and dunning on demand.
            </Banner>
          )}
          {virtual && !canAdvance && (
            <Banner tone="neutral" compact title="Moving the clock needs admin">
              Ask an owner or admin on this workspace to run the simulation.
            </Banner>
          )}

          <div className="tm__jumps">
            {TIME_JUMPS.map((preset) => {
              const to = preset.at(now);
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="tm__jump"
                  disabled={!virtual || !canAdvance || busy}
                  onClick={() => jump(to, `Jumped forward ${preset.label.toLowerCase()}`)}
                >
                  <span className="tm__jumpicon"><ChevronsRightIcon size={14} /></span>
                  <span className="tm__jumptext">
                    <span className="tm__jumptitle">{preset.label}</span>
                    <span className="tm__jumpdesc">{preset.description}</span>
                  </span>
                  <span className="tm__jumpwhen">{f.date(to)}</span>
                </button>
              );
            })}
          </div>

          <Divider label="or pick a date" />

          <DatePicker
            value={chosen}
            min={now + DAY}
            onChange={setChosen}
            placeholder="Jump to a specific date"
            disabled={!virtual || !canAdvance || busy}
            aria-label="Jump the workspace clock to a date"
          />
          {chosen !== null && chosen > now && (
            <Button
              variant="primary"
              block
              loading={busy}
              iconLeft={<Icons.zap size={14} />}
              onClick={() => jump(chosen, `Jumped ${roundDays(chosen - now)} days forward`)}
            >
              Run {roundDays(chosen - now)} days of work
            </Button>
          )}

          {confirmRewind && refusal && (
            <Banner
              tone="warning"
              compact
              title="Last time, this rewind took the workspace offline"
              actions={
                <>
                  <Button size="sm" variant="danger" loading={busy} onClick={back}>Rewind anyway</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRewind(false)}>Keep the simulated clock</Button>
                </>
              }
            >
              The API meters its rate limit against the workspace clock, so winding the clock back
              spends the request budget forward: on {f.date(refusal.at)} every call after the rewind
              came back {refusal.status}
              {refusal.requestId ? <> · <span className="u-mono">{refusal.requestId}</span></> : null}. Jumping
              forward is unaffected.
            </Banner>
          )}

          <div className="tm__foot">
            <span className="tm__sub" style={{ flex: '1 1 auto' }}>
              Every job that comes due is executed for real.
            </span>
            <Button
              size="sm"
              variant={shifted ? 'secondary' : 'ghost'}
              disabled={rewindDisabled}
              loading={busy && !confirmRewind}
              iconLeft={<RotateCcwIcon size={13} />}
              onClick={() => { if (refusal) setConfirmRewind(true); else void back(); }}
            >
              Return to now
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}
