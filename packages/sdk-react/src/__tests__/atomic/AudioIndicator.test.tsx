import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { AudioIndicator } from '../../components/atomic/AudioIndicator';

describe('AudioIndicator', () => {
  it('renders icon by default', () => {
    const { getByRole } = render(<AudioIndicator />);
    expect(getByRole('status')).toBeDefined();
  });

  it('renders muted icon when muted is true', () => {
    const { getByRole } = render(<AudioIndicator muted />);
    expect(getByRole('status')).toHaveAttribute('aria-label', 'Microphone muted');
  });

  it('renders bars variant', () => {
    const { getByRole, container } = render(<AudioIndicator variant="bars" />);
    expect(getByRole('status')).toBeDefined();
    expect(container.querySelectorAll('.w-\\[3px\\]').length).toBe(3);
  });

  it('renders dot variant', () => {
    const { getByRole } = render(<AudioIndicator variant="dot" />);
    expect(getByRole('status')).toHaveClass('rounded-full');
  });

  it('applies success color when level is high', () => {
    const { container } = render(<AudioIndicator variant="dot" level={50} />);
    expect(container.firstChild).toHaveClass('bg-[var(--chalk-success)]');
  });
});
