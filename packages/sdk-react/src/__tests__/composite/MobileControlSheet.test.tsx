import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { MobileControlSheet } from '../../components/composite/MobileControlSheet';

describe('MobileControlSheet', () => {
  it('renders correctly when open', () => {
    const { getByLabelText, getByText } = render(
      <MobileControlSheet isOpen={true} onClose={() => {}} />
    );
    expect(getByText('More controls')).toBeDefined();
    expect(getByLabelText('Mute')).toBeDefined();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<MobileControlSheet isOpen={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides when isOpen is false', () => {
    const { queryByText } = render(
      <MobileControlSheet isOpen={false} onClose={() => {}} />
    );
    expect(queryByText('More controls')).toBeNull();
  });

  it('renders picture in picture control when enabled', () => {
    const onTogglePictureInPicture = vi.fn();
    const { getByLabelText } = render(
      <MobileControlSheet
        isOpen={true}
        onClose={() => {}}
        enablePictureInPicture={true}
        onTogglePictureInPicture={() => {
          void onTogglePictureInPicture();
        }}
      />
    );

    fireEvent.click(getByLabelText('Open PiP'));
    expect(onTogglePictureInPicture).toHaveBeenCalledTimes(1);
  });
});
