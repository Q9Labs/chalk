import React from 'react';
import { GridIcon, SquareIcon, LayoutTableIcon } from '../../utils/icons';
import { cn } from '../../utils/cn';
import { IconButton, Tooltip } from '../atomic';

export interface LayoutSwitcherProps {
  layout: 'grid' | 'spotlight' | 'sidebar';
  onChange: (layout: 'grid' | 'spotlight' | 'sidebar') => void;
  disabled?: boolean;
  className?: string;
}

export const LayoutSwitcher = React.memo(({
  layout,
  onChange,
  disabled,
  className,
}: LayoutSwitcherProps) => {
  return (
    <div className={cn("flex items-center gap-1 p-1 bg-background-secondary rounded-lg border border-border", className)}>
      <Tooltip content="Grid View" position="top">
        <IconButton
          icon={<GridIcon size={20} />}
          variant={layout === 'grid' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onChange('grid')}
          disabled={disabled}
          aria-label="Switch to grid layout"
        />
      </Tooltip>

      <Tooltip content="Spotlight View" position="top">
        <IconButton
          icon={<SquareIcon size={20} />}
          variant={layout === 'spotlight' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onChange('spotlight')}
          disabled={disabled}
          aria-label="Switch to spotlight layout"
        />
      </Tooltip>

      <Tooltip content="Sidebar View" position="top">
        <IconButton
          icon={<LayoutTableIcon size={20} />}
          variant={layout === 'sidebar' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onChange('sidebar')}
          disabled={disabled}
          aria-label="Switch to sidebar layout"
        />
      </Tooltip>
    </div>
  );
});

LayoutSwitcher.displayName = 'LayoutSwitcher';
