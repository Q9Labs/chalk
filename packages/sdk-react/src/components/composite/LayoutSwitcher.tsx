import { Grid3X3, Square, LayoutTemplate } from 'lucide-react';
import { cn } from '../../utils/cn';
import { IconButton, Tooltip } from '../atomic';

export interface LayoutSwitcherProps {
  layout: 'grid' | 'spotlight' | 'sidebar';
  onChange: (layout: 'grid' | 'spotlight' | 'sidebar') => void;
  disabled?: boolean;
  className?: string;
}

export const LayoutSwitcher = ({
  layout,
  onChange,
  disabled,
  className,
}: LayoutSwitcherProps) => {
  return (
    <div className={cn("flex items-center gap-1 p-1 bg-background-secondary rounded-lg border border-border", className)}>
      <Tooltip content="Grid View" position="top">
        <IconButton
          icon={<Grid3X3 size={20} />}
          variant={layout === 'grid' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onChange('grid')}
          disabled={disabled}
          aria-label="Switch to grid layout"
        />
      </Tooltip>

      <Tooltip content="Spotlight View" position="top">
        <IconButton
          icon={<Square size={20} />}
          variant={layout === 'spotlight' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onChange('spotlight')}
          disabled={disabled}
          aria-label="Switch to spotlight layout"
        />
      </Tooltip>

      <Tooltip content="Sidebar View" position="top">
        <IconButton
          icon={<LayoutTemplate size={20} />}
          variant={layout === 'sidebar' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onChange('sidebar')}
          disabled={disabled}
          aria-label="Switch to sidebar layout"
        />
      </Tooltip>
    </div>
  );
};
