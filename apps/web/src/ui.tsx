/** 共享表单、反馈与资源状态组件。统一忙碌状态、可访问标签与错误显示；只负责渲染，不执行持久化或微信操作。 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  CircleNotch,
  X,
  WarningCircle,
  CheckCircle,
  ArrowClockwise,
  Tray,
  CaretLeft,
  CaretRight,
} from '@phosphor-icons/react';

export function Button({
  children,
  busy = false,
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className={`button ${variant} ${className}`}
      aria-busy={busy || undefined}
    >
      {busy && <CircleNotch size={18} className="spin" />}
      {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}
export function Feedback({ error, success }: { error?: string; success?: string }) {
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          <WarningCircle size={20} />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="notice success" role="status">
          <CheckCircle size={20} />
          <span>{success}</span>
        </div>
      )}
    </>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <WarningCircle size={20} />
      <span>{children}</span>
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Tray size={30} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
export function ResourceState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  if (error)
    return (
      <div className="resource-state">
        <Feedback error={error} />
        <Button onClick={retry}>
          <ArrowClockwise size={17} />
          重试
        </Button>
      </div>
    );
  if (loading)
    return (
      <p className="loading" role="status">
        <CircleNotch size={18} className="spin" />
        正在读取…
      </p>
    );
  return null;
}
export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'good' | 'warn' | 'neutral' | 'accent';
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  busy = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  busy?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  return (
    <nav className="pagination" aria-label="分页">
      <div className="pagination-summary">
        共 {total.toLocaleString()} 条{' '}
        <label>
          · 每页{' '}
          {onPageSize ? (
            <select
              aria-label="每页条数"
              value={pageSize}
              disabled={busy}
              onChange={(e) => onPageSize(Number(e.target.value))}
            >
              {[20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ) : (
            pageSize
          )}{' '}
          条
        </label>
      </div>
      <div className="pagination-pages">
        <button aria-label="上一页" disabled={page <= 1 || busy} onClick={() => onPage(page - 1)}>
          <CaretLeft size={18} />
        </button>
        {Array.from({ length: Math.min(5, pages) }, (_, i) => start + i).map((n) => (
          <button
            key={n}
            aria-label={`第 ${n} 页`}
            aria-current={n === page ? 'page' : undefined}
            disabled={busy}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        ))}
        <button
          aria-label="下一页"
          disabled={page >= pages || busy}
          onClick={() => onPage(page + 1)}
        >
          <CaretRight size={18} />
        </button>
        <span className="pagination-position">
          {page} / {pages}
        </span>
      </div>
    </nav>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    heading = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''}`}
      aria-labelledby={heading}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-header">
        <h2 id={heading}>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭对话框">
          <X size={22} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Confirm({
  title,
  children,
  confirm = '确认',
  onConfirm,
  onClose,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  confirm?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal title={title} onClose={close}>
      <p className="confirm-copy">{children}</p>
      <Feedback error={error} />
      <div className="dialog-actions">
        <Button disabled={busy} onClick={close}>
          取消
        </Button>
        <Button
          busy={busy}
          variant={danger ? 'danger' : 'primary'}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirm}
        </Button>
      </div>
    </Modal>
  );
}
