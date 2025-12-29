import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { Badge } from '../../components/atomic/Badge';

describe('Badge', () => {
  it('renders count correctly', () => {
    const { getByText } = render(<Badge count={5} />);
    expect(getByText('5')).toBeDefined();
  });

  it('renders max+ when count exceeds max', () => {
    const { getByText } = render(<Badge count={100} max={99} />);
    expect(getByText('99+')).toBeDefined();
  });

  it('renders dot when dot prop is true', () => {
    const { container } = render(<Badge dot />);
    const badge = container.querySelector('.rounded-full');
    expect(badge).toBeDefined();
    expect(badge?.textContent).toBe('');
  });

  it('hides when count is 0 and showZero is false', () => {
    const { container } = render(<Badge count={0} />);
    expect(container.textContent).toBe('');
  });

  it('shows when count is 0 and showZero is true', () => {
    const { getByText } = render(<Badge count={0} showZero />);
    expect(getByText('0')).toBeDefined();
  });

  it('renders children with badge', () => {
    const { getByText } = render(
      <Badge count={3}>
        <button type="button">Notifications</button>
      </Badge>
    );
    expect(getByText('Notifications')).toBeDefined();
    expect(getByText('3')).toBeDefined();
  });
});
