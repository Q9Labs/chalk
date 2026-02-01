import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { StatusBadge } from '../../components/atomic/StatusBadge';

describe('StatusBadge', () => {
  it('renders recording status', () => {
    const { getByText, getByRole } = render(<StatusBadge status="recording" />);
    expect(getByText('REC')).toBeDefined();
    expect(getByRole('status')).toHaveAttribute('aria-label', 'recording');
  });

  it('renders live status', () => {
    const { getByText } = render(<StatusBadge status="live" />);
    expect(getByText('LIVE')).toBeDefined();
  });

  it('renders transcribing status', () => {
    const { getByText } = render(<StatusBadge status="transcribing" />);
    expect(getByText('CC')).toBeDefined();
  });

  it('renders connecting status', () => {
    const { getByText } = render(<StatusBadge status="connecting" />);
    expect(getByText('CONNECTING...')).toBeDefined();
  });

  it('applies pulse animation when pulse is true', () => {
    const { container } = render(<StatusBadge status="recording" pulse />);
    expect(container.firstChild).toHaveClass('animate-pulse');
  });

  it('applies custom size classes', () => {
    const { container } = render(<StatusBadge status="recording" size="sm" />);
    expect(container.firstChild).toHaveClass('px-1.5');
  });
});
