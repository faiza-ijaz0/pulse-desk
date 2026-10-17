import { CircleAlert, CircleCheck } from 'lucide-react';
import { Label as LabelPrimitive } from 'radix-ui';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-sm font-medium text-foreground select-none', className)}
      {...props}
    />
  );
}

/** Props a Field hands to its control so label, help text and errors are wired for assistive tech. */
export type FieldControlProps = {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  required: boolean | undefined;
  disabled: boolean | undefined;
};

type FieldProps = {
  label: ReactNode;
  description?: ReactNode;
  /** Validation message. Marks the control invalid and is announced via aria-describedby. */
  error?: ReactNode;
  /** Confirmation message, e.g. after a successful availability check. */
  success?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
};

export function Field({
  label,
  description,
  error,
  success,
  required,
  disabled,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const messageId = error || success ? `${id}-message` : undefined;
  const describedBy = [descriptionId, messageId].filter(Boolean).join(' ') || undefined;

  return (
    // Disabled styling lives on the control itself; the label and help text stay at full
    // contrast because they often explain why the field can't be edited.
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-0.5 text-danger-foreground" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required,
        disabled,
      })}
      {description && !error && (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {error ? (
        <p
          id={messageId}
          className="flex items-center gap-1.5 text-xs font-medium text-danger-foreground"
        >
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : (
        success && (
          <p
            id={messageId}
            className="flex items-center gap-1.5 text-xs font-medium text-success-foreground"
          >
            <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
            {success}
          </p>
        )
      )}
    </div>
  );
}
