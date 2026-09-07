import { Button } from './controls';
import { ErrorState } from './feedback';
import { Icons } from './icons';

/** What a failed call looks like by the time a screen holds it: the status, and the server's own error body. */
export interface FailedRequest {
  status: number;
  body: { message: string; request_id?: string | null };
}

export interface SectionErrorProps {
  error: FailedRequest;
  /** The request that failed — `GET /v1/invoices` — printed under the message so the reader can quote it. */
  path: string;
  onRetry: () => void;
  className?: string;
}

/**
 * One panel of a screen that did not load, with the way back: the server's
 * message, the request it refused, its request id, and a primary retry.
 * Billing, revenue and settings each drew their own; a reader moving between
 * them met three phrasings of the same failure.
 */
export function SectionError({ error, path, onRetry, className }: SectionErrorProps) {
  return (
    <ErrorState
      className={className}
      title="That did not load"
      message={error.body.message}
      code={`${error.status} ${path}`}
      requestId={error.body.request_id ?? null}
      action={<Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={onRetry}>Try again</Button>}
    />
  );
}
