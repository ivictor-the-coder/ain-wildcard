import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { cx } from './layout';
import { Icons } from './icons';
import { Button, IconButton } from './controls';
import { Spinner } from './feedback';
import {
  dismissToast, getToasts, holdToast, registerViewport, resumeToast, setToastAutoMount,
  subscribeToasts, type ToastRecord, type ToastTone,
} from './toast-store';
import './toast.css';

const ICONS: Record<ToastTone, keyof typeof Icons> = {
  default: 'info', success: 'check-circle', warning: 'alert-triangle',
  danger: 'alert-octagon', info: 'info', loading: 'refresh',
};

function ToastCard({ toast }: { toast: ToastRecord }) {
  const Icon = Icons[ICONS[toast.tone]];
  return (
    <div
      className={cx('ain-toast', `ain-toast--${toast.tone}`)}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
      onPointerEnter={() => holdToast(toast.id)}
      onPointerLeave={() => resumeToast(toast.id)}
    >
      <span className="ain-toast__icon">
        {toast.tone === 'loading' ? <Spinner size={16} /> : <Icon size={16} />}
      </span>
      <div className="ain-toast__content">
        <div className="ain-toast__title">{toast.title}</div>
        {toast.description && <div className="ain-toast__desc">{toast.description}</div>}
        {toast.action && (
          <Button
            className="ain-toast__action"
            variant="link"
            size="sm"
            onClick={() => { toast.action?.onClick(); dismissToast(toast.id); }}
          >
            {toast.action.label}
          </Button>
        )}
      </div>
      <IconButton
        className="ain-toast__close"
        size="sm"
        label="Dismiss notification"
        icon={<Icons.x size={13} />}
        onClick={() => dismissToast(toast.id)}
      />
    </div>
  );
}

/** The viewport. Mount it once — <ToastProvider> does that for you. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  useEffect(() => registerViewport(), []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="ain-toaster" aria-label="Notifications" role="region">
      {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />)}
    </div>,
    document.body,
  );
}

export function ToastProvider({ children }: { children?: React.ReactNode }) {
  return <>{children}<Toaster /></>;
}

/**
 * If something raises a toast before any viewport is mounted, mount one. It
 * keeps `useToast()` honest in modules that forgot the provider.
 */
if (typeof document !== 'undefined') {
  let mounted = false;
  setToastAutoMount(() => {
    if (mounted) return;
    mounted = true;
    const host = document.createElement('div');
    host.setAttribute('data-ain-toaster', '');
    document.body.appendChild(host);
    createRoot(host).render(<Toaster />);
  });
}

export { pushToast, dismissToast, clearToasts } from './toast-store';
