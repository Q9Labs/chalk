import { describe, it, expect, vi } from 'bun:test';
import { render } from '@testing-library/react';
import { ReactionBubble } from '../../components/atomic/ReactionBubble';

describe('ReactionBubble', () => {
  it('renders emoji', () => {
    const { getByText } = render(<ReactionBubble emoji="🔥" />);
    expect(getByText('🔥')).toBeDefined();
  });

  it('calls onComplete after duration', async () => {
    const onComplete = vi.fn();
    render(<ReactionBubble emoji="🔥" onComplete={onComplete} duration={100} />);
    
    await new Promise(r => setTimeout(r, 150));
    
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('hides after duration', async () => {
    const { queryByText } = render(<ReactionBubble emoji="🔥" duration={100} />);
    expect(queryByText('🔥')).toBeDefined();
    
    await new Promise(r => setTimeout(r, 150));
    
    expect(queryByText('🔥')).toBeNull();
  });
});
