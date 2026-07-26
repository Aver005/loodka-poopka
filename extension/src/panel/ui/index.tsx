import { Switch as BaseSwitch } from '@base-ui-components/react/switch';
import { Tooltip as BaseTooltip } from '@base-ui-components/react/tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn, usePortalContainer } from '../../lib/utils';

/*
  Компоненты в духе shadcn: код лежит в проекте и правится напрямую.
  Именно поэтому проброс `container` в порталы делается один раз здесь,
  а не при каждом использовании.
*/

// ── Button ────────────────────────────────────────────────────────────────────
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-medium ' +
    'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants:
    {
      variant:
      {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        outline: 'border border-border bg-transparent hover:bg-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
      },
      size: { default: 'h-8 px-3', sm: 'h-7 px-2', icon: 'size-8' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>)
{
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

// ── Card ──────────────────────────────────────────────────────────────────────
export const Card = ({ className, ...p }: ComponentProps<'section'>) => (
  <section className={cn('rounded-lg border border-border bg-card', className)} {...p} />
);

export const CardHeader = ({ className, ...p }: ComponentProps<'header'>) => (
  <header
    className={cn('flex items-center gap-2 border-b border-border px-3 py-2', className)}
    {...p}
  />
);

export const CardTitle = ({ className, ...p }: ComponentProps<'h2'>) => (
  <h2 className={cn('text-xs font-semibold tracking-tight', className)} {...p} />
);

export const CardBody = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('px-3 py-2', className)} {...p} />
);

// ── Input ─────────────────────────────────────────────────────────────────────
export const Input = ({ className, ...p }: ComponentProps<'input'>) => (
  <input
    className={cn(
      'h-7 w-full rounded-md border border-border bg-input px-2 text-xs tabular-nums',
      'outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring',
      className,
    )}
    {...p}
  />
);

// ── Badge ─────────────────────────────────────────────────────────────────────
const badgeVariants = cva(
  'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
  {
    variants:
    {
      tone:
      {
        muted: 'bg-muted text-muted-foreground',
        good: 'bg-good/15 text-good',
        warn: 'bg-warn/15 text-warn',
        bad: 'bg-bad/15 text-bad',
        a: 'bg-tier-a/15 text-tier-a',
        b: 'bg-tier-b/15 text-tier-b',
        c: 'bg-tier-c/15 text-tier-c line-through opacity-70',
      },
    },
    defaultVariants: { tone: 'muted' },
  },
);

export const Badge = ({
  className,
  tone,
  ...p
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) => (
  <span className={cn(badgeVariants({ tone }), className)} {...p} />
);

// ── Table ─────────────────────────────────────────────────────────────────────
export const Table = ({ className, ...p }: ComponentProps<'table'>) => (
  <div className="overflow-x-auto">
    <table className={cn('w-full border-collapse text-xs', className)} {...p} />
  </div>
);

export const Th = ({ className, ...p }: ComponentProps<'th'>) => (
  <th
    className={cn(
      'border-b border-border px-2 py-1 text-left font-medium text-muted-foreground',
      className,
    )}
    {...p}
  />
);

export const Td = ({ className, ...p }: ComponentProps<'td'>) => (
  <td className={cn('border-b border-border/50 px-2 py-1 tabular-nums', className)} {...p} />
);

// ── Switch ────────────────────────────────────────────────────────────────────
export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: ReactNode;
})
{
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v)}
        className={cn(
          'relative h-4 w-7 shrink-0 rounded-full border border-border transition-colors outline-none',
          'data-checked:bg-primary data-unchecked:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <BaseSwitch.Thumb
          className={cn(
            'block size-3 rounded-full bg-foreground transition-transform',
            'data-checked:translate-x-3.5 data-unchecked:translate-x-0.5',
          )}
        />
      </BaseSwitch.Root>
    </label>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
/** Задержка показа настраивается на провайдере, а не на каждом тултипе. */
export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <BaseTooltip.Provider delay={200}>{children}</BaseTooltip.Provider>
);

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode })
{
  // Тот самый один раз: контейнер портала берётся из контекста, а не задаётся при вызове.
  const container = usePortalContainer();
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger
        render={<span className="cursor-help underline decoration-dotted underline-offset-2" />}
      >
        {children}
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal container={container}>
        <BaseTooltip.Positioner sideOffset={6}>
          <BaseTooltip.Popup className="max-w-70 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] leading-snug text-card-foreground shadow-lg">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
