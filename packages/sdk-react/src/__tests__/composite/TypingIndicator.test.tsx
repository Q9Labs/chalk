import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { TypingIndicator } from '../../components/composite/TypingIndicator';

describe('TypingIndicator', () => {
  it('renders correctly for one user', () => {
    const { getByText } = render(<TypingIndicator typingUsers={['Alice']} />);
    expect(getByText('Alice is typing')).toBeDefined();
  });

  it('renders correctly for two users', () => {
    const { getByText } = render(<TypingIndicator typingUsers={['Alice', 'Bob']} />);
    expect(getByText('Alice and Bob are typing')).toBeDefined();
  });

  it('renders correctly for many users', () => {
    const { getByText } = render(<TypingIndicator typingUsers={['A', 'B', 'C', 'D']} />);
    expect(getByText('4 people are typing')).toBeDefined();
  });

  it('returns null for empty array', () => {
    const { container } = render(<TypingIndicator typingUsers={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
