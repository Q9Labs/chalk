import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { Skeleton } from '../../components/atomic/Skeleton';

describe('Skeleton', () => {
  it('renders correctly', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toBeDefined();
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies custom dimensions', () => {
    const { container } = render(<Skeleton width={100} height={20} />);
    const element = container.firstChild as HTMLElement;
    expect(element.style.width).toBe('100px');
    expect(element.style.height).toBe('20px');
  });

  it('applies variant classes', () => {
    const { container } = render(<Skeleton variant="circular" />);
    expect(container.firstChild).toHaveClass('rounded-full');
  });

  it('applies animation classes', () => {
    const { container } = render(<Skeleton animation="pulse" />);
    expect(container.firstChild).toHaveClass('chalk-animate-pulse');
  });
});
