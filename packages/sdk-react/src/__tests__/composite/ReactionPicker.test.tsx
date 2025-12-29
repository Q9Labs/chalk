import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { ReactionPicker } from '../../components/composite/ReactionPicker';

describe('ReactionPicker', () => {
  it('renders when open', () => {
    const { getByLabelText } = render(
      <ReactionPicker isOpen={true} onClose={() => {}} onSelect={() => {}} />
    );
    expect(getByLabelText('Reaction picker')).toBeDefined();
  });

  it('calls onSelect when emoji clicked', () => {
    const onSelect = vi.fn();
    const { getByLabelText } = render(
      <ReactionPicker isOpen={true} onClose={() => {}} onSelect={onSelect} />
    );
    fireEvent.click(getByLabelText('React with 👍'));
    expect(onSelect).toHaveBeenCalledWith('👍');
  });

  it('shows recent reactions', () => {
    const { getByText } = render(
      <ReactionPicker isOpen={true} onClose={() => {}} onSelect={() => {}} recentReactions={['🔥']} />
    );
    expect(getByText('Recent')).toBeDefined();
    expect(getByText('🔥')).toBeDefined();
  });

  it('returns null when closed', () => {
    const { container } = render(
      <ReactionPicker isOpen={false} onClose={() => {}} onSelect={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });
});
