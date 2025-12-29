import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { Toggle } from '../../components/atomic/Toggle';

describe('Toggle', () => {
  it('renders correctly with label', () => {
    const { getByRole } = render(<Toggle checked={false} onChange={() => {}} label="Enable feature" />);
    const toggle = getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange when clicked', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<Toggle checked={false} onChange={onChange} />);
    fireEvent.click(getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('handles keyboard events', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<Toggle checked={true} onChange={onChange} />);
    const button = getByRole('switch');
    fireEvent.keyDown(button, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('can be disabled', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<Toggle checked={false} onChange={onChange} disabled />);
    const button = getByRole('switch');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
  });
});
