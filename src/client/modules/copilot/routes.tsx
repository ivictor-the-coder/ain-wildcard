/**
 * The copilot surface: the conversation, the run log, and one run's full trace.
 */
import type { CommandDef, NavItem, RouteDef, WidgetDef } from '@/client/kernel/registry-types';
import { useRouter } from '@/client/kernel/router';
import { Badge, Button, Card, ErrorState, SkeletonText, useFormat } from '@/client/design';
import { CopilotPage } from './chat';
import { RunDetailPage, RunsPage } from './runs';
import { useApprovals } from './api';
import { ApprovalQueue } from './trace';
import './copilot.css';

const RunRoute = () => {
  const { params } = useRouter();
  return <RunDetailPage key={params.id} id={params.id} />;
};

/* --------------------------------- widget --------------------------------- */

/** The writes an agent has prepared and stopped on, decidable from the dashboard. */
function ApprovalsWidget() {
  const f = useFormat();
  const { navigate } = useRouter();
  const approvals = useApprovals('pending');
  const rows = approvals.data?.data ?? [];

  return (
    <Card
      title="Waiting on your approval"
      description={rows.length
        ? `${f.plural(rows.length, 'write')} an agent prepared and stopped on`
        : 'Writes an agent prepares stop here until a person decides'}
      actions={
        <Button size="sm" variant="ghost" onClick={() => navigate('/copilot/runs?tab=approvals')}>
          Open the queue
        </Button>
      }
    >
      {approvals.error && (
        <ErrorState
          title="The approval queue did not answer"
          message={approvals.error.body.message}
          code={`${approvals.error.status} /v1/ai/approvals`}
          requestId={approvals.error.body.request_id ?? null}
          action={<Button size="sm" variant="primary" onClick={approvals.refetch}>Try again</Button>}
        />
      )}
      {!approvals.error && approvals.loading && <SkeletonText lines={4} />}
      {!approvals.error && approvals.data && (
        <ApprovalQueue approvals={rows.slice(0, 2)} onDecided={approvals.refetch} />
      )}
      {rows.length > 2 && (
        <p className="cp-note" style={{ marginTop: 'var(--space-4)' }}>
          <Badge size="sm" tone="warning">{rows.length - 2} more</Badge> in the queue.
        </p>
      )}
    </Card>
  );
}

/* ------------------------------ registration ------------------------------ */

export const routes: RouteDef[] = [
  { path: '/copilot', element: CopilotPage, title: 'Copilot' },
  { path: '/copilot/runs', element: RunsPage, title: 'Runs and traces' },
  { path: '/copilot/runs/:id', element: RunRoute, title: 'Run' },
];

export const nav: NavItem[] = [
  {
    id: 'copilot',
    label: 'Copilot',
    to: '/copilot',
    group: 'automation',
    order: 10,
    icon: 'sparkles',
    children: [
      { id: 'copilot.threads', label: 'Conversations', to: '/copilot' },
      { id: 'copilot.runs', label: 'Runs & traces', to: '/copilot/runs' },
    ],
  },
];

export const commands: CommandDef[] = [
  {
    id: 'copilot.open',
    title: 'Copilot',
    subtitle: 'Ask the workspace a question and get cited answers',
    group: 'Go to',
    keywords: ['ai', 'ask', 'assistant', 'chat', 'breeze', 'agent'],
    icon: 'sparkles',
    run: (go) => go('/copilot'),
  },
  {
    id: 'copilot.new',
    title: 'New copilot conversation',
    subtitle: 'Start a fresh thread',
    group: 'Create',
    keywords: ['ai', 'ask', 'chat', 'question'],
    icon: 'sparkles',
    run: (go) => go('/copilot?new=1'),
  },
  {
    id: 'copilot.draft',
    title: 'Draft with the copilot',
    subtitle: 'Write a follow-up from a deal’s own facts, then log it',
    group: 'Create',
    keywords: ['ai', 'draft', 'email', 'write', 'follow up', 'compose'],
    icon: 'edit',
    run: (go) => go('/copilot?draft=1'),
  },
  {
    id: 'copilot.runs',
    title: 'Agent runs and traces',
    subtitle: 'Every run, its steps, timings and cost',
    group: 'Go to',
    keywords: ['ai', 'observability', 'trace', 'tokens', 'debug'],
    icon: 'activity',
    run: (go) => go('/copilot/runs'),
  },
  {
    id: 'copilot.approvals',
    title: 'Writes waiting for approval',
    subtitle: 'Approve or decline what an agent prepared',
    group: 'Go to',
    keywords: ['ai', 'approve', 'approval', 'safety', 'guardrail'],
    icon: 'shield',
    run: (go) => go('/copilot/runs?tab=approvals'),
  },
];

export const widgets: WidgetDef[] = [
  {
    id: 'copilot.approvals',
    title: 'Waiting on your approval',
    description: 'Writes an agent prepared and stopped on',
    span: 4,
    component: ApprovalsWidget,
    group: 'automation',
  },
];
