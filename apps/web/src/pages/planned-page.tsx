import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import type { NavItem } from '@/app/navigation';
import { EmptyState, PageHeader } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * Honest placeholder for a feature that is designed but not built. It describes what
 * the page will do and when — it never renders inert controls that look functional.
 */
export function PlannedPage({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader
        title={item.label}
        meta={<Badge tone="neutral">Planned · {item.phase ?? 'later phase'}</Badge>}
      />
      <EmptyState
        icon={item.icon}
        title={`${item.label} isn’t built yet`}
        description={item.summary}
      >
        <Button asChild variant="secondary" size="sm">
          <Link to="/dashboard">
            <ArrowLeft aria-hidden="true" />
            Back to dashboard
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link to="/design-system">View the design system</Link>
        </Button>
      </EmptyState>
    </>
  );
}
