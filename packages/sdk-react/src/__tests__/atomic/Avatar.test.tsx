import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { Avatar } from '../../components/atomic/Avatar';

describe('Avatar', () => {
  it('renders initials when no src is provided', () => {
    const { getByText, getByRole } = render(<Avatar name="John Doe" />);
    expect(getByText('JD')).toBeDefined();
    expect(getByRole('img')).toHaveAttribute('aria-label', 'Avatar for John Doe');
  });

  it('renders an image when src is provided', () => {
    const { getByRole } = render(<Avatar name="John Doe" src="https://example.com/avatar.jpg" />);
    const img = getByRole('img', { name: 'John Doe' });
    expect(img).toBeDefined();
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
  });

  it('renders status indicator when status is provided', () => {
    const { container } = render(<Avatar name="John Doe" status="online" />);
    const statusIndicator = container.querySelector('span');
    expect(statusIndicator).toBeDefined();
  });

  it('applies custom size styles', () => {
    const { container } = render(<Avatar name="John Doe" size="lg" />);
    const avatar = container.firstChild as HTMLElement;
    expect(avatar.style.width).toBe('64px');
    expect(avatar.style.height).toBe('64px');
  });

  it('applies custom className', () => {
    const { container } = render(<Avatar name="John Doe" className="custom-avatar" />);
    expect(container.firstChild).toHaveClass('custom-avatar');
  });
});
