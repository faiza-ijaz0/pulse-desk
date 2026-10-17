import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VolumeChart } from '@/features/dashboard/volume-chart';
import { TooltipProvider } from './tooltip';
import { Button } from './button';
import { Field } from './field';
import { Input } from './input';
import { Table, TableBody, TableCell, TableRow } from './table';

describe('Button', () => {
  it('blocks interaction and announces busy state while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('defaults to type="button" so it never submits forms by accident', () => {
    render(<Button>Plain</Button>);
    expect(screen.getByRole('button', { name: 'Plain' })).toHaveAttribute('type', 'button');
  });
});

describe('Field', () => {
  it('associates label and description with the control', () => {
    render(
      <Field label="Full name" description="As it appears to customers.">
        {(props) => <Input {...props} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Full name' });
    expect(input).toHaveAccessibleDescription('As it appears to customers.');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('marks the control invalid and describes it with the error message', () => {
    render(
      <Field label="Work email" required error="Enter a valid email address">
        {(props) => <Input type="email" {...props} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: /work email/i });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toBeRequired();
    expect(input).toHaveAccessibleDescription('Enter a valid email address');
  });

  it('passes disabled through to the control', () => {
    render(
      <Field label="Organization ID" disabled>
        {(props) => <Input {...props} />}
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Organization ID' })).toBeDisabled();
  });
});

describe('VolumeChart', () => {
  const data = [
    { day: 'Mon', created: 10, solved: 7 },
    { day: 'Tue', created: 12, solved: 15 },
  ];

  it('describes each day for assistive tech', () => {
    render(
      <TooltipProvider>
        <VolumeChart data={data} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('img', { name: 'Mon: 10 created, 7 solved' })).toBeInTheDocument();
    expect(screen.getByText('22 created · 22 solved in the last 7 days')).toBeInTheDocument();
  });

  it('switches to an accessible table view with exact values', async () => {
    render(
      <TooltipProvider>
        <VolumeChart data={data} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));

    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent('Tue1215');
  });
});

describe('Table', () => {
  afterEach(() => vi.unstubAllGlobals());

  function renderTable(scrollWidth: number) {
    // jsdom has no layout: report fixed widths. The hook measures once on mount, so the
    // ResizeObserver only needs to exist.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    render(
      <Table aria-label="Agents">
        <TableBody>
          <TableRow>
            <TableCell>Maya</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
  }

  it('makes an overflowing table a focusable, labelled scroll region', () => {
    renderTable(900);
    const region = screen.getByRole('region', { name: 'Agents' });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('adds no extra tab stop when the table fits', () => {
    renderTable(400);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
