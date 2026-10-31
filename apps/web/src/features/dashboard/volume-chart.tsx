import { BarChart3, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { VolumePoint } from './sample-data';

// `color` is the solid swatch (legend, tooltip); `bar` adds a gentle lift towards the top.
const SERIES = [
  {
    key: 'created',
    label: 'Created',
    color: 'bg-chart-1',
    bar: 'bg-linear-to-t from-chart-1 to-chart-1/75',
  },
  {
    key: 'solved',
    label: 'Solved',
    color: 'bg-chart-2',
    bar: 'bg-linear-to-t from-chart-2 to-chart-2/75',
  },
] as const;

function niceMax(value: number): number {
  const step = value > 100 ? 50 : 20;
  return Math.ceil(value / step) * step;
}

function ViewToggle({
  view,
  onChange,
}: {
  view: 'chart' | 'table';
  onChange: (view: 'chart' | 'table') => void;
}) {
  const options = [
    { value: 'chart', label: 'Chart', icon: BarChart3 },
    { value: 'table', label: 'Table', icon: Table2 },
  ] as const;
  return (
    <div
      role="group"
      aria-label="Display as"
      className="inline-flex rounded-lg border border-border bg-surface-sunken p-0.5"
    >
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
            view === value
              ? 'bg-surface text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Grouped columns: created vs solved per day. One shared y-axis; identity via legend + tooltip + table. */
export function VolumeChart({ data }: { data: VolumePoint[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const max = niceMax(Math.max(...data.flatMap((d) => [d.created, d.solved])));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const totals = data.reduce(
    (acc, d) => ({ created: acc.created + d.created, solved: acc.solved + d.solved }),
    { created: 0, solved: 0 },
  );

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div>
          <CardTitle id="volume-title">Ticket volume</CardTitle>
          <CardDescription>
            {totals.created} created · {totals.solved} solved in the last 7 days
          </CardDescription>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {view === 'table' ? (
          <Table aria-labelledby="volume-title">
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="text-right">Solved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((d) => (
                <TableRow key={d.day}>
                  <TableCell className="h-9">{d.day}</TableCell>
                  <TableCell className="h-9 text-right tabular-nums">{d.created}</TableCell>
                  <TableCell className="h-9 text-right tabular-nums">{d.solved}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <figure className="flex flex-1 flex-col" aria-labelledby="volume-title">
            <div
              className="mb-3 flex items-center gap-4 text-xs text-muted-foreground"
              aria-hidden="true"
            >
              {SERIES.map((s) => (
                <span key={s.key} className="inline-flex items-center gap-1.5">
                  <span className={cn('size-2.5 rounded-[3px]', s.color)} />
                  {s.label}
                </span>
              ))}
            </div>
            <div className="relative flex min-h-48 flex-1 pl-8">
              {/* Hairline gridlines + y-axis ticks (recessive). */}
              <div
                className="pointer-events-none absolute inset-y-0 right-0 left-8"
                aria-hidden="true"
              >
                {ticks.map((tick) => (
                  <div
                    key={tick}
                    className="absolute inset-x-0 border-t border-border"
                    style={{ bottom: `${(tick / max) * 100}%` }}
                  >
                    <span className="absolute -top-2 -left-8 w-6 text-right text-2xs text-subtle-foreground tabular-nums">
                      {tick}
                    </span>
                  </div>
                ))}
              </div>
              <div className="relative flex flex-1 items-end justify-around">
                {data.map((d) => (
                  <Tooltip
                    key={d.day}
                    content={
                      <span className="grid gap-1 py-0.5">
                        <span className="font-semibold">{d.day}</span>
                        {SERIES.map((s) => (
                          <span key={s.key} className="flex items-center gap-2 font-normal">
                            <span className={cn('size-2 rounded-[2px]', s.color)} />
                            {s.label}
                            <span className="ml-auto pl-3 font-medium tabular-nums">
                              {d[s.key]}
                            </span>
                          </span>
                        ))}
                      </span>
                    }
                  >
                    <div
                      role="img"
                      aria-label={`${d.day}: ${d.created} created, ${d.solved} solved`}
                      className="group flex h-full flex-1 items-end justify-center gap-0.5 rounded-sm hover:bg-surface-hover/70"
                    >
                      {SERIES.map((s) => (
                        <div
                          key={s.key}
                          className={cn(
                            'w-full max-w-6 rounded-t-md transition-opacity group-hover:opacity-90',
                            s.bar,
                          )}
                          style={{ height: `${(d[s.key] / max) * 100}%` }}
                        />
                      ))}
                    </div>
                  </Tooltip>
                ))}
              </div>
            </div>
            <div
              className="flex justify-around pt-2 pl-8 text-xs text-muted-foreground"
              aria-hidden="true"
            >
              {data.map((d) => (
                <span key={d.day} className="flex-1 text-center">
                  {d.day}
                </span>
              ))}
            </div>
            <figcaption className="sr-only">
              Tickets created and solved per day for the last 7 days. Use the Table view for exact
              values.
            </figcaption>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}
