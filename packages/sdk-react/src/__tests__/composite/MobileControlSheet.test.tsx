import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { MobileControlSheet } from '../../components/composite/MobileControlSheet';

describe('MobileControlSheet', () => {
  it('renders correctly when open', () => {
    const { getByLabelText } = render(
      <MobileControlSheet isOpen={true} onClose={() => {}} />
    );
    expect(getByLabelText('Mobile controls')).toBeDefined();
    expect(getByLabelText('Mute')).toBeDefined();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <MobileControlSheet isOpen={true} onClose={onClose} />
    );
    fireEvent.click(getByLabelText('Close menu'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides when isOpen is false', () => {
    const { getByLabelText } = render(
      <MobileControlSheet isOpen={false} onClose={() => {}} />
    );
    expect(getByLabelText('Mobile controls')).toHaveClass('translate-y-full');
  });
});
