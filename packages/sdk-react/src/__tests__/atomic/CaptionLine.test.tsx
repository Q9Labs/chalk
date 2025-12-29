import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { CaptionLine } from '../../components/atomic/CaptionLine';

describe('CaptionLine', () => {
  it('renders text correctly', () => {
    const { getByText } = render(<CaptionLine text="Hello world" />);
    expect(getByText('Hello world')).toBeDefined();
  });

  it('renders speaker name', () => {
    const { getByText } = render(<CaptionLine text="Hello world" speaker="John" />);
    expect(getByText('John:')).toBeDefined();
  });

  it('returns null when no text is provided', () => {
    const { container } = render(<CaptionLine text="" />);
    expect(container.firstChild).toBeNull();
  });

  it('applies position classes', () => {
    const { container, rerender } = render(<CaptionLine text="test" position="top" />);
    expect(container.firstChild).toHaveClass('top-[10%]');

    rerender(<CaptionLine text="test" position="bottom" />);
    expect(container.firstChild).toHaveClass('bottom-[10%]');
  });
});
