import { ChevronDown, Copy, Inbox, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Alert, Kbd, Skeleton } from '@/components/ui/misc';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { TicketPriorityLabel, TicketStatusBadge } from '@/features/tickets/ticket-badges';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '@pulsedesk/shared';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 border-t border-border py-8 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_1fr] lg:gap-10">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

const SWATCHES: { group: string; tokens: string[] }[] = [
  {
    group: 'Surfaces',
    tokens: ['background', 'surface', 'surface-sunken', 'surface-hover', 'border', 'border-strong'],
  },
  { group: 'Text', tokens: ['foreground', 'muted-foreground', 'subtle-foreground'] },
  {
    group: 'Accent',
    tokens: ['accent', 'accent-hover', 'accent-subtle', 'accent-subtle-foreground', 'ring'],
  },
  { group: 'Status', tokens: ['success', 'warning', 'danger', 'info', 'chart-1', 'chart-2'] },
];

const TYPE_SCALE = [
  {
    token: 'text-3xl',
    sample: 'Support overview',
    className: 'text-3xl font-semibold tracking-tight',
  },
  { token: 'text-2xl', sample: 'Page title', className: 'text-2xl font-semibold tracking-tight' },
  { token: 'text-lg', sample: 'Section heading', className: 'text-lg font-semibold' },
  { token: 'text-base', sample: 'Body and card titles', className: 'text-base' },
  { token: 'text-sm', sample: 'Dense UI text, tables and controls', className: 'text-sm' },
  {
    token: 'text-xs',
    sample: 'Captions, metadata and badges',
    className: 'text-xs text-muted-foreground',
  },
];

/** Living reference for tokens, components and every interaction state. */
export function DesignSystemPage() {
  return (
    <>
      <PageHeader
        title="Design system"
        description="Tokens, components and states used throughout PulseDesk. Toggle the theme to review both modes."
      />

      <Section
        title="Color tokens"
        description="Semantic tokens; components never use raw color values."
      >
        <div className="grid gap-5">
          {SWATCHES.map(({ group, tokens }) => (
            <div key={group}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">{group}</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                {tokens.map((token) => (
                  <div
                    key={token}
                    className="overflow-hidden rounded-md border border-border bg-surface"
                  >
                    <div
                      className="h-10 border-b border-border"
                      style={{ background: `var(--${token})` }}
                    />
                    <p className="truncate px-2 py-1.5 font-mono text-2xs text-muted-foreground">
                      {token}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Typography"
        description="Geist for UI, Geist Mono for identifiers. A dense 13–14px product scale."
      >
        <div className="grid gap-3">
          {TYPE_SCALE.map(({ token, sample, className }) => (
            <div key={token} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-6">
              <span className="w-20 shrink-0 font-mono text-2xs text-subtle-foreground">
                {token}
              </span>
              <span className={className}>{sample}</span>
            </div>
          ))}
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-6">
            <span className="w-20 shrink-0 font-mono text-2xs text-subtle-foreground">
              font-mono
            </span>
            <span className="font-mono text-sm">#1042 · req_6558a911</span>
          </div>
        </div>
      </Section>

      <Section
        title="Buttons"
        description="Primary for the main action on a surface; one per view. Loading keeps the label so layout never jumps."
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button>
              <Plus aria-hidden="true" />
              Primary
            </Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">
              <Trash2 aria-hidden="true" />
              Danger
            </Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button loading>Saving</Button>
            <Button variant="secondary" loading>
              Loading
            </Button>
            <Button disabled>Disabled</Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Tooltip content="Edit">
              <Button variant="secondary" size="icon" aria-label="Edit">
                <Pencil aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content="Copy link">
              <Button variant="ghost" size="icon-sm" aria-label="Copy link">
                <Copy aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        </div>
      </Section>

      <Section
        title="Form states"
        description="Labels are always visible. Errors are linked to their field and announced by screen readers."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Full name" description="As it appears to customers.">
            {(props) => <Input placeholder="Maya Chen" {...props} />}
          </Field>
          <Field label="Work email" required error="Enter an email address like name@company.com">
            {(props) => <Input type="email" defaultValue="maya@" {...props} />}
          </Field>
          <Field label="Workspace URL" success="pulsedesk.app/brightwave is available">
            {(props) => <Input defaultValue="brightwave" {...props} />}
          </Field>
          <Field label="Organization ID" disabled description="Assigned automatically.">
            {(props) => <Input defaultValue="org_7c9e6679" {...props} />}
          </Field>
          <Field label="Internal note" className="sm:col-span-2">
            {(props) => <Textarea placeholder="Visible to agents only…" {...props} />}
          </Field>
        </div>
      </Section>

      <Section
        title="Badges"
        description="Status always pairs color with text; priority adds an icon."
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            <Badge>Neutral</Badge>
            <Badge tone="accent">Accent</Badge>
            <Badge tone="success">Success</Badge>
            <Badge tone="warning">Warning</Badge>
            <Badge tone="danger">Danger</Badge>
            <Badge tone="info">Info</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {TICKET_STATUSES.map((status) => (
              <TicketStatusBadge key={status} status={status} />
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {TICKET_PRIORITIES.map((priority) => (
              <TicketPriorityLabel key={priority} priority={priority} />
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Overlays"
        description="Dialogs trap focus and restore it on close. Menus are fully keyboard operable."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Example dialog</DialogTitle>
                <DialogDescription>
                  Dialogs confirm consequential actions. Focus moves inside and returns to the
                  trigger when closed.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Close</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">
                Open menu
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem>
                <Pencil aria-hidden="true" />
                Edit
                <DropdownMenuShortcut>E</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy aria-hidden="true" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem disabled>Archive (disabled)</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive>
                <Trash2 aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content="Tooltips label icon-only controls">
            <Button variant="ghost">Hover or focus me</Button>
          </Tooltip>
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd> opens the command menu
          </span>
        </div>
      </Section>

      <Section
        title="Feedback"
        description="Inline alerts for status; loading, empty and error states for every data view."
      >
        <div className="grid gap-3">
          <Alert tone="info" title="Heads up">
            SLA targets changed for urgent tickets.
          </Alert>
          <Alert tone="success" title="Changes saved" />
          <Alert tone="warning" title="Approaching capacity">
            Two agents are above 90% of their ticket capacity.
          </Alert>
          <Alert tone="danger" title="Couldn’t save changes">
            Check your connection and try again.
          </Alert>
          <div className="grid gap-4 pt-2 md:grid-cols-3">
            <Card aria-label="Loading example" aria-busy="true">
              <CardContent className="grid gap-3">
                <p className="sr-only">Loading…</p>
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </CardContent>
            </Card>
            <EmptyState
              icon={Inbox}
              title="No tickets"
              description="New tickets will appear here."
              className="py-8"
            />
            <ErrorState description="We couldn’t load this view." className="py-8" />
          </div>
        </div>
      </Section>

      <Section
        title="Cards & tables"
        description="Cards group related content. Tables are for scanning; they become lists on phones."
      >
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Card title</CardTitle>
              <CardDescription>Supporting description</CardDescription>
            </div>
          </CardHeader>
          <div className="mt-3 border-t border-border">
            <Table aria-label="Example team members">
              <TableHeader className="bg-surface-sunken/60">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">Maya Chen</TableCell>
                  <TableCell>Owner</TableCell>
                  <TableCell className="text-right tabular-nums">3</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Priya Nair</TableCell>
                  <TableCell>Agent</TableCell>
                  <TableCell className="text-right tabular-nums">14</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <CardFooter className="text-xs text-muted-foreground">Card footer</CardFooter>
        </Card>
      </Section>
    </>
  );
}
