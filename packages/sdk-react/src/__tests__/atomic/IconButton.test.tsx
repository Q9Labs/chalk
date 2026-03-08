import { beforeEach, describe, expect, it, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { IconButton } from '../../components/atomic/IconButton';

describe('IconButton', () => {
  const icon = <span>Icon</span>;
  const label = 'Close';
  const vibrateSpy = vi.spyOn(navigator, 'vibrate');

  beforeEach(() => {
    vibrateSpy.mockClear();
  });

  it('renders correctly', () => {
    const { getByRole, getByText } = render(<IconButton icon={icon} aria-label={label} />);
    expect(getByRole('button', { name: label })).toBeDefined();
    expect(getByText('Icon')).toBeDefined();
  });

  it('handles click events', () => {
    const onClick = vi.fn();
    const { getByRole } = render(<IconButton icon={icon} aria-label={label} onClick={onClick} />);
    fireEvent.click(getByRole('button', { name: label }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalledTimes(1);
  });

  it('can disable haptics per button', () => {
    const { getByRole } = render(
      <IconButton icon={icon} aria-label={label} haptic={false} />
    );
    fireEvent.click(getByRole('button', { name: label }));
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it('applies variant classes', () => {
    const { getByRole, rerender } = render(<IconButton icon={icon} aria-label={label} variant="ghost" />);
    expect(getByRole('button', { name: label })).toHaveClass('bg-transparent');

    rerender(<IconButton icon={icon} aria-label={label} variant="outline" />);
    expect(getByRole('button', { name: label })).toHaveClass('border');
  });

  it('can be disabled', () => {
    const onClick = vi.fn();
    const { getByRole } = render(<IconButton icon={icon} aria-label={label} disabled onClick={onClick} />);
    const button = getByRole('button', { name: label });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(vibrateSpy).not.toHaveBeenCalled();
  });
});
